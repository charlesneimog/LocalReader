const CACHE_NAME = "pdf-reader-cache-v1";

const urlsToCache = [
    "/",
    "/index.html",
    "/render.js",
    "/threads.js",

    // ONNX Runtime
    "/thirdparty/ort.min.js",
    "/thirdparty/ort-wasm-simd.wasm",

    // Piper TTS
    "/thirdparty/piper/piper-tts-proper.js",
    "/thirdparty/piper/piper-o91UDS6e.js",
    "/thirdparty/piper/piper_phonemize.js",
    "/thirdparty/piper/piper_phonemize.wasm",
    "/thirdparty/piper/piper_phonemize.data",

    // PDF.js
    "/thirdparty/pdf/pdf.js",
    "/thirdparty/pdf/pdf.worker.js",

    // Font Awesome
    "/thirdparty/font-awesome/all.css",
    "/thirdparty/font-awesome/fa-regular-400.woff2",
    "/thirdparty/font-awesome/fa-regular-400.ttf",
    "/thirdparty/font-awesome/fa-solid-900.woff2",
    "/thirdparty/font-awesome/fa-solid-900.ttf",
    "/thirdparty/font-awesome/fa-brands-400.woff2",
    "/thirdparty/font-awesome/fa-brands-400.ttf",
    "/thirdparty/font-awesome/fa-v4compatibility.woff2",
    "/thirdparty/font-awesome/fa-v4compatibility.ttf",
];

// Instalação: faz o cache inicial
self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(urlsToCache);
        }),
    );
});

// Ativação: remove caches antigos se mudar a versão
self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys.map((key) => {
                    if (key !== CACHE_NAME) {
                        return caches.delete(key);
                    }
                }),
            ),
        ),
    );
});

// Intercepta requisições e serve do cache quando disponível
self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);
    const cacheExtensions = [".onnx", ".onnx.json", ".wasm", ".data", ".js", ".json", ".html"];

    if (cacheExtensions.some((ext) => url.pathname.endsWith(ext))) {
        event.respondWith(
            caches.open(CACHE_NAME).then(async (cache) => {
                const cachedResponse = await cache.match(event.request);
                if (cachedResponse) {
                    return cachedResponse;
                }
                try {
                    const fetchResponse = await fetch(event.request);
                    if (fetchResponse.ok) {
                        cache.put(event.request, fetchResponse.clone()).catch((e) => {
                            console.warn("[SW] Failed to cache resource:", event.request.url, e);
                        });
                    }
                    return fetchResponse;
                } catch (err) {
                    console.warn("[SW] Fetch failed, serving fallback if available:", event.request.url, err);
                    const fallback = await cache.match(event.request);
                    return fallback || new Response("Resource unavailable", { status: 503 });
                }
            }),
        );
    } else {
        console.warn("Cache miss:", event.request.url);
        event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
    }
});
