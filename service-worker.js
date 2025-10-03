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
  "/thirdparty/piper/piper-voices/en_US-hfc_female-medium.onnx",
  "/thirdparty/piper/piper-voices/en_US-hfc_female-medium.onnx.json",
  "/thirdparty/piper/piper-voices/pt_BR-faber-medium.onnx",
  "/thirdparty/piper/piper-voices/pt_BR-faber-medium.onnx.json",

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
  "/thirdparty/font-awesome/fa-v4compatibility.ttf"
];

// Instalação: faz o cache inicial
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(urlsToCache);
    })
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
        })
      )
    )
  );
});

// Intercepta requisições e serve do cache quando disponível
self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});

