const APP_VERSION = 1;
const cacheName = `PDFCastia-v${APP_VERSION}`;
const staticFiles = ["/index.html"];

// routes to cache
const routes = ["/", "/src"];
const filesToCache = [...routes, ...staticFiles];
const requestsToRetryWhenOffline = [];
const IDBConfig = {
    name: "web-app-db",
    version: APP_VERSION,
    stores: {
        requestStore: {
            name: `request-store`,
            keyPath: "timestamp",
        },
    },
};

//╭─────────────────────────────────────╮
//│            For requests             │
//╰─────────────────────────────────────╯
const isOffline = () => !self.navigator.onLine;
const isRequestEligibleForRetry = ({ url, method }) => {
    return ["POST", "PUT", "DELETE"].includes(method) || requestsToRetryWhenOffline.includes(url);
};

const createIndexedDB = ({ name, stores }) => {
    const request = self.indexedDB.open(name, 1);
    return new Promise((resolve, reject) => {
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            Object.keys(stores).forEach((store) => {
                const { name, keyPath } = stores[store];
                if (!db.objectStoreNames.contains(name)) {
                    db.createObjectStore(name, { keyPath });
                    console.log("create objectstore", name);
                }
            });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
};

const getStoreFactory =
    (dbName) =>
    ({ name }, mode = "readonly") => {
        return new Promise((resolve, reject) => {
            const request = self.indexedDB.open(dbName, IDB_VERSION);
            request.onsuccess = (e) => {
                const db = request.result;
                const transaction = db.transaction(name, mode);
                const store = transaction.objectStore(name);
                const storeProxy = new Proxy(store, {
                    get(target, prop) {
                        if (typeof target[prop] === "function") {
                            return (...args) =>
                                new Promise((resolve, reject) => {
                                    const req = target[prop].apply(target, args);
                                    req.onsuccess = () => resolve(req.result);
                                    req.onerror = (err) => reject(err);
                                });
                        }
                        return target[prop];
                    },
                });
                return resolve(storeProxy);
            };
            request.onerror = (_) => reject(request.error);
        });
    };

const openStore = getStoreFactory(IDBConfig.name);

const serializeHeaders = (headers) =>
    [...headers.entries()].reduce(
        (acc, [key, value]) => ({
            ...acc,
            [key]: value,
        }),
        {},
    );

const storeRequest = async ({ url, method, body, headers, mode, credentials }) => {
    const serializedHeaders = serializeHeaders(headers);
    try {
        let storedBody = body;
        if (body && body instanceof ReadableStream) {
            const clonedBody = body.tee()[0];
            storedBody = await new Response(clonedBody).arrayBuffer();
        }

        const timestamp = Date.now();
        const store = await openStore(IDBConfig.stores.requestStore, "readwrite");

        await store.add({
            timestamp,
            url,
            method,
            ...(storedBody && { body: storedBody }),
            headers: serializedHeaders,
            mode,
            credentials,
        });

        if ("sync" in self.registration) {
            console.log("register sync for retry request");
            await self.registration.sync.register(`retry-request`);
        }
    } catch (error) {
        console.log("idb error", error);
    }
};

const getCacheStorageNames = async () => {
    const cacheNames = (await caches.keys()) || [];
    const outdatedCacheNames = cacheNames.filter((name) => !name.includes(cacheName));
    const latestCacheName = cacheNames.find((name) => name.includes(cacheName));
    return { latestCacheName, outdatedCacheNames };
};

const updateLastCache = async () => {
    const { latestCacheName, outdatedCacheNames } = await getCacheStorageNames();
    if (!latestCacheName || !outdatedCacheNames?.length) {
        return null;
    }
    const latestCache = await caches.open(latestCacheName);
    const latestCacheEntries = (await latestCache?.keys())?.map((c) => c.url) || [];
    for (const outdatedCacheName of outdatedCacheNames) {
        const outdatedCache = await caches.open(outdatedCacheName);
        for (const entry of latestCacheEntries) {
            const latestCacheResponse = await latestCache.match(entry);
            await outdatedCache.put(entry, latestCacheResponse.clone());
        }
    }
};

const getRequests = async () => {
    try {
        const store = await openStore(IDBConfig.stores.requestStore, "readwrite");
        return await store.getAll();
    } catch (err) {
        return err;
    }
};

const retryRequests = async () => {
    const reqs = await getRequests();
    const requests = reqs.map(({ url, method, headers: serializedHeaders, body, mode, credentials }) => {
        const headers = new Headers(serializedHeaders);
        return fetch(url, { method, headers, body, mode, credentials });
    });

    const responses = await Promise.allSettled(requests);
    const requestStore = await openStore(IDBConfig.stores.requestStore, "readwrite");
    const { keyPath } = IDBConfig.stores.requestStore;

    responses.forEach((response, index) => {
        const key = reqs[index][keyPath];

        // remove the request from IndexedDB if the response was successful
        if (response.status === "fulfilled") {
            requestStore.delete(key);
        } else {
            console.log(`retrying response with ${keyPath} ${key} failed: ${response.reason}`);
        }
    });
};

const installHandler = (e) => {
    e.waitUntil(
        caches
            .open(cacheName)
            .then((cache) =>
                Promise.all([
                    cache.addAll(filesToCache.map((file) => new Request(file, { cache: "no-cache" }))),
                    createIndexedDB(IDBConfig),
                ]),
            )
            .catch((err) => console.error("install error", err)),
    );
};

// delete any outdated caches when the Service Worker is activated
const activateHandler = (e) => {
    e.waitUntil(
        caches
            .keys()
            .then((names) =>
                Promise.all(names.filter((name) => name !== cacheName).map((name) => caches.delete(name))),
            ),
    );
};

const cleanRedirect = async (response) => {
    const clonedResponse = response.clone();
    const { headers, status, statusText } = clonedResponse;

    return new Response(clonedResponse.body, {
        headers,
        status,
        statusText,
    });
};

const fetchHandler = async (e) => {
    const { request } = e;
    e.respondWith(
        (async () => {
            try {
                if (isOffline() && isRequestEligibleForRetry(request)) {
                    await storeRequest(request);
                    return await caches.match("/index.html");
                }
                const response = await caches.match(request, { ignoreVary: true, ignoreSearch: true });
                if (response) {
                    return response.redirected ? cleanRedirect(response) : response;
                }

                // if not in the cache, try to fetch the response from the network
                const fetchResponse = await fetch(e.request);
                if (fetchResponse) {
                    return fetchResponse;
                }
            } catch (err) {
                return await caches.match("/index.html");
            }
        })(),
    );
};

const messageHandler = async ({ data }) => {
    const { type } = data;
    switch (type) {
        case "SKIP_WAITING": {
            const clients = await self.clients.matchAll({
                includeUncontrolled: true,
            });
            if (clients.length < 2) {
                await self.skipWaiting();
                await self.clients.claim();
            }
            break;
        }
        case "PREPARE_CACHES_FOR_UPDATE": {
            await updateLastCache();
            break;
        }
        case "retry-requests": {
            if (!("sync" in self.registration)) {
                console.log("retry requests when Background Sync is not supported");
                await retryRequests();
            }
            break;
        }
    }
};

const syncHandler = async (e) => {
    console.log("sync event with tag:", e.tag);
    const { tag } = e;
    switch (tag) {
        case "retry-request":
            e.waitUntil(retryRequests());
            break;
    }
};

//╭─────────────────────────────────────╮
//│              Listener               │
//╰─────────────────────────────────────╯
self.addEventListener("install", installHandler);
self.addEventListener("activate", activateHandler);
self.addEventListener("fetch", fetchHandler);
self.addEventListener("message", messageHandler);
self.addEventListener("sync", syncHandler);
