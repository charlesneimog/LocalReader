const CACHE_NAME = "pdf-reader-cache-v1";

const urlsToCache = [
    "/",
    "/index.html",
    "/threads.js",
    "/render.js",
    "/manifest.webmanifest",

    // Assets
    "/assets/icons/icon-1024.png",
    "/assets/icons/icon-512.png",
    "/assets/icons/icon-192.png",
    "/assets/screenshots/screenshot1.png",

    // Src
    "/src/app.js",
    "/src/config.js",

    // Constants
    "/src/constants/cacheManager.js",
    "/src/constants/events.js",

    // Core
    "/src/core/cacheManager.js",
    "/src/core/eventBus.js",
    "/src/core/stateManager.js",

    // CSS
    "/src/css/input.css",
    "/src/css/output.css",
    "/src/css/style.css",

    // Modules
    "/src/modules/index.js",

    // Login
    "/src/modules/login/auth.js",

    // PDF
    "/src/modules/pdf/pdfHeaderFooterDetector.js",
    "/src/modules/pdf/pdfLoader.js",
    "/src/modules/pdf/pdfRenderer.js",
    "/src/modules/pdf/sentenceParser.js",
    "/src/modules/pdf/ts.js",

    // Storage
    "/src/modules/storage/exportManager.js",
    "/src/modules/storage/highlightsStorage.js",
    "/src/modules/storage/progressManager.js",

    // TTS
    "/src/modules/tts/audioManager.js",
    "/src/modules/tts/index.html",
    "/src/modules/tts/piper-client.js",
    "/src/modules/tts/piper.worker.js",
    "/src/modules/tts/synthesisQueue.js",
    "/src/modules/tts/ttsEngine.js",
    "/src/modules/tts/wordHighlighter.js",

    // Piper
    "/src/modules/tts/piper/piper-o91UDS6e.js",
    "/src/modules/tts/piper/piper_phonemize.js",
    "/src/modules/tts/piper/piper_phonemize.wasm",
    "/src/modules/tts/piper/piper_phonemize.data",

    // UI
    "/src/modules/ui/controlsManager.js",
    "/src/modules/ui/highlightManager.js",
    "/src/modules/ui/interactionHandler.js",
    "/src/modules/ui/uiService.js",

    // Utils
    "/src/modules/utils/ariaManager.js",
    "/src/modules/utils/coordinates.js",
    "/src/modules/utils/helpers.js",
    "/src/modules/utils/responsive.js",

    // Thirdparty
    "/thirdparty/ort.js",
    "/thirdparty/ort-wasm-simd.wasm",
    "/thirdparty/ort-wasm-simd-threaded.jsep.mjs",
    "/thirdparty/ort-wasm-simd-threaded.jsep.wasm",

    // Thirdparty PDF
    "/thirdparty/pdf/pdf-lib.js",
    "/thirdparty/pdf/pdf.js",
    "/thirdparty/pdf/pdf.worker.js",
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
    event.respondWith(
        caches.match(event.request).then((response) => {
            return response || fetch(event.request);
        }),
    );
});
