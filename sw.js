const APP_VERSION = "0.9.8+1";
const PRECACHE = `LocalReader-v${APP_VERSION}`;
const RUNTIME = `LocalReader-runtime-v${APP_VERSION}`;

// Base path helper (supports GitHub Pages /LocalReader/ and self-hosted /)
const getBasePath = () => (self.location.pathname.includes("/LocalReader/") ? "/LocalReader" : "");
const BASE_PATH = getBasePath();
const resolvePath = (path) => (path.startsWith("http") ? path : BASE_PATH + path);

// Same-origin assets to precache (no redirects, no opaque)
const PRECACHE_URLS = [
    "/",
    "/index.html",
    "/manifest.webmanifest",
    "/threads.js",
    "/sw.js",

    // Assets
    "/assets/icons/favicon-16x16.png",
    "/assets/icons/favicon-32x32.png",
    "/assets/icons/favicon.svg",
    "/assets/icons/icon-192.png",
    "/assets/icons/icon-512.png",
    "/assets/icons/icon-1024.png",
    "/assets/icons/logo.png",
    "/assets/icons/logo.svg",
    "/assets/icons/mask-512.png",
    "/assets/icons/mask.svg",
    "/assets/images/default-user.png",
    "/assets/screenshots/screenshot1.png",
    "/assets/screenshots/screenshot2.png",

    // CSS
    "/src/css/style.css",
    "/src/css/input.css",
    "/src/css/output.css",

    // JS (core)
    "/src/app.js",
    "/src/config.js",
    "/src/constants/cacheManager.js",
    "/src/constants/events.js",
    "/src/core/cacheManager.js",
    "/src/core/eventBus.js",
    "/src/core/stateManager.js",
    "/src/modules/index.js",

    // Modules
    "/src/modules/login/auth.js",
    "/src/modules/pdf/pdfLoader.js",
    "/src/modules/pdf/pdfRenderer.js",
    "/src/modules/pdf/pdfHeaderFooterDetector.js",
    "/src/modules/pdf/sentenceParser.js",
    "/src/modules/pdf/ts.js",
    "/src/modules/storage/exportManager.js",
    "/src/modules/storage/highlightsStorage.js",
    "/src/modules/storage/progressManager.js",
    "/src/modules/tts/audioManager.js",
    "/src/modules/tts/piper-client.js",
    "/src/modules/tts/piper.worker.js",
    "/src/modules/tts/synthesisQueue.js",
    "/src/modules/tts/ttsEngine.js",
    "/src/modules/tts/wordHighlighter.js",
    "/src/modules/ui/controlsManager.js",
    "/src/modules/ui/highlightManager.js",
    "/src/modules/ui/interactionHandler.js",
    "/src/modules/ui/uiService.js",
    "/src/modules/utils/ariaManager.js",
    "/src/modules/utils/coordinates.js",
    "/src/modules/utils/helpers.js",
    "/src/modules/utils/responsive.js",
    "/src/modules/utils/viewport.js",

    // Third-party (core)
    "/thirdparty/ort/ort.js",
    "/thirdparty/ort/ort-wasm-simd.wasm",
    "/thirdparty/ort/ort-wasm-simd-threaded.jsep.mjs",
    "/thirdparty/ort/ort-wasm-simd-threaded.jsep.wasm",
    "/thirdparty/pdf/pdf.js",
    "/thirdparty/pdf/pdf.worker.js",
    "/thirdparty/pdf/pdf-lib.js",
    "/thirdparty/piper/piper-o91UDS6e.js",
    "/thirdparty/piper/piper_phonemize.data",
    "/thirdparty/piper/piper_phonemize.js",
    "/thirdparty/piper/piper_phonemize.wasm",
    "/thirdparty/transformers/transformers.js",

    // Fonts
    "/thirdparty/fonts/Inter.css",
    "/thirdparty/fonts/Material-symbols-outlined.css",
    "/thirdparty/fonts/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa0ZL7SUc.woff2",
    "/thirdparty/fonts/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7.woff2",
    "/thirdparty/fonts/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1pL7SUc.woff2",
    "/thirdparty/fonts/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa25L7SUc.woff2",
    "/thirdparty/fonts/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa2JL7SUc.woff2",
    "/thirdparty/fonts/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa2ZL7SUc.woff2",
    "/thirdparty/fonts/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa2pL7SUc.woff2",
    "/thirdparty/fonts/font.woff2",
].map(resolvePath);

// Explicitly allowed cross-origin runtime cache
const EXTERNAL_CACHE_PREFIXES = [
    "https://fonts.googleapis.com",
    "https://fonts.gstatic.com",
    "https://cdn.jsdelivr.net/npm/@huggingface/transformers",
    "https://huggingface.co/",
    "https://cdn.jsdelivr.net/npm/@kinde-oss/kinde-auth-pkce-js@4.3.0/",
];
const isAllowedExternal = (url) => EXTERNAL_CACHE_PREFIXES.some((p) => url.startsWith(p));

const textResponse = (status, statusText, body) =>
    new Response(body || "", {
        status,
        statusText,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
    });

const isWasmRequest = (request, urlObj) =>
    request.destination === "wasm" || urlObj.pathname.endsWith(".wasm");

const isBinaryAsset = (request, urlObj) =>
    isWasmRequest(request, urlObj) ||
    request.destination === "font" ||
    request.destination === "worker" ||
    urlObj.pathname.endsWith(".woff2") ||
    urlObj.pathname.endsWith(".woff") ||
    urlObj.pathname.endsWith(".ttf") ||
    urlObj.pathname.endsWith(".otf");

// ─────────────────────────────────────────────────────────────
// Install/activate
// ─────────────────────────────────────────────────────────────
self.addEventListener("install", (event) => {
    event.waitUntil(
        (async () => {
            const cache = await caches.open(PRECACHE);
            // Precache uses addAll() with cache:"reload" and redirect:"error".
            // If any single URL fails, fall back to a resilient per-request add.
            const requests = PRECACHE_URLS.map(
                (u) => new Request(u, { cache: "reload", redirect: "error" }),
            );
            try {
                await cache.addAll(requests);
            } catch (err) {
                // Resilient mode: don't fail install due to one missing asset
                await Promise.allSettled(
                    requests.map(async (req) => {
                        const res = await fetch(req);
                        if (res.ok && res.type !== "opaque" && !res.redirected) {
                            await cache.put(req, res);
                        }
                    }),
                );
            }
            await self.skipWaiting();
        })(),
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        (async () => {
            const names = await caches.keys();
            await Promise.all(
                names
                    .filter((n) => n !== PRECACHE && n !== RUNTIME)
                    .map((n) => caches.delete(n)),
            );
            await self.clients.claim();
        })(),
    );
});

// ─────────────────────────────────────────────────────────────
// Fetch strategies
//
// - navigate  -> network-first, offline HTML fallback
// - script/worker/style/font/wasm -> cache-first (exact match)
// - API or non-GET -> network-only
// - cross-origin -> pass-through unless explicitly whitelisted (then SWR)
// ─────────────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
    const request = event.request;
    const url = request.url;

    event.respondWith(
        (async () => {
            const urlObj = new URL(url);
            const isSameOrigin = urlObj.origin === self.location.origin;

            // API / non-GET: never cache, never fallback to HTML
            if (request.method !== "GET" || urlObj.pathname.startsWith("/api/")) {
                try {
                    return await fetch(request);
                } catch {
                    return textResponse(502, "Bad Gateway", "Network error");
                }
            }

            // Cross-origin: pass-through unless explicitly allowed
            if (!isSameOrigin) {
                if (!isAllowedExternal(url)) {
                    try {
                        return await fetch(request);
                    } catch {
                        return textResponse(504, "Gateway Timeout", "Upstream unavailable");
                    }
                }

                // Allowed external: stale-while-revalidate, cache only ok responses
                const cache = await caches.open(RUNTIME);
                const cached = await cache.match(request);
                const update = fetch(request)
                    .then((res) => {
                        if (res && res.ok) cache.put(request, res.clone());
                        return res;
                    })
                    .catch(() => null);

                // Keep cache warm in background when we already have a cached copy
                if (cached) event.waitUntil(update);
                return cached || (await update) || textResponse(504, "Gateway Timeout", "Upstream unavailable");
            }

            // Navigation: network-first with offline HTML fallback
            if (request.mode === "navigate") {
                try {
                    const res = await fetch(request);
                    // Keep the entrypoint fresh for offline
                    if (res && res.ok && res.type === "basic") {
                        const cache = await caches.open(PRECACHE);
                        cache.put(resolvePath("/index.html"), res.clone());
                    }
                    return res;
                } catch {
                    const cache = await caches.open(PRECACHE);
                    const offline = await cache.match(resolvePath("/index.html"));
                    return offline || textResponse(503, "Service Unavailable", "Offline");
                }
            }

            // Typed assets: cache-first (exact match), never return HTML
            const isTypedAsset =
                request.destination === "script" ||
                request.destination === "worker" ||
                request.destination === "style" ||
                request.destination === "font" ||
                isWasmRequest(request, urlObj) ||
                urlObj.pathname.endsWith(".js") ||
                urlObj.pathname.endsWith(".mjs") ||
                urlObj.pathname.endsWith(".css");

            if (isTypedAsset || urlObj.pathname.startsWith("/thirdparty/")) {
                const cache = await caches.open(PRECACHE);
                // Some hosts add `Vary: Accept-Encoding` (or similar) which can make
                // Cache.match() miss a valid precached response on some Android WebView/Chrome builds.
                // For static assets (fonts/icons/wasm/css/js), ignoring Vary is safe and more reliable.
                const cached = await cache.match(request, { ignoreSearch: false, ignoreVary: true });
                if (cached) return cached;

                try {
                    const res = await fetch(request);
                    // Never cache errors, redirects, or opaque responses
                    if (res && res.ok && res.type === "basic" && !res.redirected) {
                        cache.put(request, res.clone());
                    }
                    return res;
                } catch {
                    // For typed assets, return a valid non-HTML response
                    if (isBinaryAsset(request, urlObj)) {
                        return textResponse(503, "Service Unavailable", "Offline");
                    }
                    return textResponse(503, "Service Unavailable", "Offline");
                }
            }

            // Other same-origin GET (images, json, etc.): cache-first with network fallback
            const cache = await caches.open(PRECACHE);
            const cached = await cache.match(request, { ignoreSearch: false, ignoreVary: true });
            if (cached) return cached;
            try {
                const res = await fetch(request);
                if (res && res.ok && res.type === "basic" && !res.redirected) {
                    cache.put(request, res.clone());
                }
                return res;
            } catch {
                return textResponse(503, "Service Unavailable", "Offline");
            }
        })(),
    );
});

self.addEventListener("message", (event) => {
    const { data } = event || {};
    if (!data || !data.type) return;
    if (data.type === "SKIP_WAITING") self.skipWaiting();
});
