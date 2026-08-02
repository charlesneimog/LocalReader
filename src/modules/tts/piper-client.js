/* PiperWorkerClient
   - Manages the Piper WebWorker
   - Lets you pass ONNX ArrayBuffer and voiceConfig JSON to the worker
   - Provides synthesize(text, speed) => Blob('audio/wav')
   - Provides speak(text, speed) for convenience

   Also includes IndexedDB caching helpers for model/config retrieval.
*/

"use strict";

export class PiperWorkerClient {
    constructor(options = {}) {
        this.workerUrl = options.workerUrl || "piper.worker.js";
        this.worker = new Worker(this.workerUrl);
        this._reqId = 1;
        this._pending = new Map();
        this.backend = null;
        this.onBackendChange = typeof options.onBackendChange === "function" ? options.onBackendChange : null;

        this.worker.onmessage = (e) => {
            const { id, type } = e.data || {};
            if (type === "backend-change") {
                this.backend = e.data.backend || null;
                console.warn(`[TTS] Piper backend changed to ${this.backend}`, e.data.reason || "");
                this.onBackendChange?.({ backend: this.backend, reason: e.data.reason || "" });
                return;
            }
            const pending = this._pending.get(id);
            if (!pending) return;

            if (type === "error") {
                this._pending.delete(id);
                pending.reject(new Error(e.data.error || "Worker error"));
                return;
            }

            // Resolve based on operation
            if (type === "init-ok") {
                this._pending.delete(id);
                this.backend = e.data.backend || null;
                pending.resolve({
                    backend: this.backend,
                    ortVersion: e.data.ortVersion || null,
                    threads: e.data.threads,
                    simd: e.data.simd,
                });
                return;
            }

            if (type === "change-voice-ok") {
                this._pending.delete(id);
                this.backend = e.data.backend || this.backend;
                pending.resolve({ backend: this.backend });
                return;
            }

            if (type === "synthesize-ok") {
                this._pending.delete(id);
                const wavBuffer = e.data.wavBuffer;
                const sampleRate = e.data.sampleRate;
                pending.resolve({ sampleRate, wavBuffer });
                return;
            }

            // Unknown
            this._pending.delete(id);
            pending.reject(new Error(`Unknown worker response type: ${type}`));
        };

        this.worker.onerror = (e) => {
            const err = new Error(e.message || "Worker error");
            for (const [, pending] of this._pending.entries()) {
                pending.reject(err);
            }
            this._pending.clear();
        };
    }

    _call(type, payload = {}, transfers = []) {
        return new Promise((resolve, reject) => {
            const id = this._reqId++;
            this._pending.set(id, { resolve, reject });
            this.worker.postMessage({ id, type, payload }, transfers);
        });
    }

    freeUserTimeLimit() {
        this._call("limit-user-time", {});
    }

    async init({
        modelBuffer,
        voiceConfig,
        espeakVoice,
        ortJsUrl,
        ortWasmRoot,
        phonemizerJsUrl,
        phonemizerWasmUrl,
        phonemizerDataUrl,
        logLevel = "error",
        transferModel = true,
        maxThreads = 4,
        useWebGpu = false,
    }) {
        if (!(modelBuffer instanceof ArrayBuffer)) {
            throw new Error("modelBuffer must be an ArrayBuffer");
        }
        if (!voiceConfig) throw new Error("voiceConfig JSON object is required");

        const transfers = transferModel ? [modelBuffer] : [];
        return this._call(
            "init",
            {
                ortJsUrl,
                ortWasmRoot,
                phonemizerJsUrl,
                phonemizerWasmUrl,
                phonemizerDataUrl,
                modelBuffer,
                voiceConfig,
                espeakVoice,
                logLevel,
                maxThreads,
                useWebGpu,
            },
            transfers,
        );
    }

    async changeVoice({ modelBuffer, voiceConfig, transferModel = true }) {
        if (!(modelBuffer instanceof ArrayBuffer)) {
            throw new Error("modelBuffer must be an ArrayBuffer");
        }
        if (!voiceConfig) throw new Error("voiceConfig JSON object is required");

        const transfers = transferModel ? [modelBuffer] : [];
        return this._call("change-voice", { modelBuffer, voiceConfig }, transfers);
    }

    async synthesize(text, speed = 1.0, espeakVoice, { createBlob = true } = {}) {
        if (!text || !text.trim()) throw new Error("text is required");
        const result = await this._call("synthesize", { text, speed, espeakVoice });
        if (!result.wavBuffer) throw new Error("Worker did not return audio data");
        if (createBlob) {
            result.blob = new Blob([result.wavBuffer], { type: "audio/wav" });
        }
        return result;
    }

    async speak(text, speed = 1.0, espeakVoice) {
        const { blob } = await this.synthesize(text, speed, espeakVoice);
        const url = URL.createObjectURL(blob);
        try {
            const audio = new Audio(url);
            await audio.play();
            await new Promise((res, rej) => {
                audio.onended = () => res();
                audio.onerror = (e) => rej(e);
            });
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    terminate() {
        this.worker.terminate();
        for (const [, pending] of this._pending.entries()) {
            pending.reject(new Error("Worker terminated"));
        }
        this._pending.clear();
    }
}

export class PiperWorkerPoolClient {
    constructor(options = {}) {
        this.size = Math.max(1, Number(options.size) || 2);
        this.workerUrl = options.workerUrl;
        this.onBackendChange = options.onBackendChange;
        this._active = [];
        this._ready = [];
        this._cursor = 0;
        this.clients = [];
        this._lazyWorkerInitPromise = null;
        this._lazyWorkerOptions = null;
        this._lazyModelBuffer = null;
        this._modelBufferFactory = null;
        this._availabilityWaiters = [];
        this._terminated = false;
        this.availableVoices = null;

        // Only the primary worker belongs on the cold-start critical path. Extra
        // synthesis lanes are created after the primary starts doing useful work.
        this._appendClient();
    }

    get backend() {
        const backends = [
            ...new Set(
                this.clients
                    .filter((_, index) => this._ready[index])
                    .map((client) => client.backend)
                    .filter(Boolean),
            ),
        ];
        return backends.length === 1 ? backends[0] : backends.length ? "mixed" : null;
    }

    _appendClient() {
        const client = new PiperWorkerClient({
            workerUrl: this.workerUrl,
            onBackendChange: this.onBackendChange,
        });
        this.clients.push(client);
        this._active.push(0);
        this._ready.push(false);
        return this.clients.length - 1;
    }

    _configureLazyWorkers(options) {
        const { modelBuffer, modelBufferFactory, ...workerOptions } = options;
        if (!(modelBuffer instanceof ArrayBuffer)) throw new Error("modelBuffer must be an ArrayBuffer");

        this._lazyWorkerOptions = { ...(this._lazyWorkerOptions || {}), ...workerOptions };
        this._modelBufferFactory = typeof modelBufferFactory === "function" ? modelBufferFactory : null;
        this._lazyModelBuffer =
            this.clients.length < this.size && !this._modelBufferFactory ? modelBuffer.slice(0) : null;
    }

    _runtimeResult(result) {
        const readyWorkers = this._ready.filter(Boolean).length;
        return {
            ...result,
            backend: this.backend || result?.backend || null,
            workers: readyWorkers,
            configuredWorkers: this.size,
            threadsPerWorker: result?.threads || 1,
        };
    }

    async _getLazyModelBuffer() {
        if (this._modelBufferFactory) {
            const modelBuffer = await this._modelBufferFactory();
            if (!(modelBuffer instanceof ArrayBuffer)) {
                throw new Error("modelBufferFactory must resolve to an ArrayBuffer");
            }
            return modelBuffer;
        }

        const modelBuffer = this._lazyModelBuffer;
        if (!(modelBuffer instanceof ArrayBuffer)) {
            throw new Error("No model buffer is available for the lazy Piper worker");
        }
        this._lazyModelBuffer = null;
        return modelBuffer;
    }

    _initializeNextWorker() {
        if (this._terminated || this.clients.length >= this.size) return null;
        if (this._lazyWorkerInitPromise) return this._lazyWorkerInitPromise;

        const workerIndex = this._appendClient();
        const client = this.clients[workerIndex];
        this._lazyWorkerInitPromise = (async () => {
            const modelBuffer = await this._getLazyModelBuffer();
            if (this._terminated) throw new Error("Piper worker pool is terminated");

            // Preserve one copy only when a pool larger than two still has another
            // deferred lane and no IndexedDB-backed factory can provide it later.
            if (!this._modelBufferFactory && this.clients.length < this.size) {
                this._lazyModelBuffer = modelBuffer.slice(0);
            }

            const result = await client.init({
                ...this._lazyWorkerOptions,
                modelBuffer,
                transferModel: true,
            });
            this._ready[workerIndex] = true;
            this._notifyWorkerAvailable();
            console.info(`[TTS] Lazy Piper worker ${workerIndex + 1}/${this.size} ready`);
            return result;
        })()
            .catch((error) => {
                client.terminate();
                this.clients.splice(workerIndex, 1);
                this._active.splice(workerIndex, 1);
                this._ready.splice(workerIndex, 1);
                console.warn(`[TTS] Lazy Piper worker ${workerIndex + 1}/${this.size} failed to initialize`, error);
                throw error;
            })
            .finally(() => {
                this._lazyWorkerInitPromise = null;
                this._notifyWorkerAvailable();
            });

        return this._lazyWorkerInitPromise;
    }

    _waitForWorkerAvailability() {
        const hasIdleWorker = this.clients.some((_, index) => this._ready[index] && this._active[index] === 0);
        if (hasIdleWorker || !this._lazyWorkerInitPromise) return null;
        return new Promise((resolve) => this._availabilityWaiters.push(resolve));
    }

    _notifyWorkerAvailable() {
        const waiters = this._availabilityWaiters.splice(0);
        for (const resolve of waiters) resolve();
    }

    async _changeVoiceOnReadyWorkers(options) {
        const modelBuffer = options.modelBuffer;
        if (!(modelBuffer instanceof ArrayBuffer)) throw new Error("modelBuffer must be an ArrayBuffer");

        const readyIndices = this.clients.map((_, index) => index).filter((index) => this._ready[index]);
        const results = await Promise.all(
            readyIndices.map((clientIndex, index) => {
                const workerModel = index === readyIndices.length - 1 ? modelBuffer : modelBuffer.slice(0);
                return this.clients[clientIndex].changeVoice({
                    ...options,
                    modelBuffer: workerModel,
                    transferModel: true,
                });
            }),
        );
        return this._runtimeResult(results[0] || {});
    }

    async init(options) {
        if (this._terminated) throw new Error("Piper worker pool is terminated");
        this._configureLazyWorkers(options);
        const result = await this.clients[0].init({ ...options, transferModel: true });
        this._ready[0] = true;
        return this._runtimeResult(result);
    }

    async changeVoice(options) {
        if (this._terminated) throw new Error("Piper worker pool is terminated");

        // Do not let an older voice finish initializing after the active workers
        // have already switched to the new voice.
        if (this._lazyWorkerInitPromise) {
            await this._lazyWorkerInitPromise.catch(() => {});
        }
        this._configureLazyWorkers(options);
        return this._changeVoiceOnReadyWorkers(options);
    }

    _nextWorkerIndex() {
        const readyIndices = this.clients.map((_, index) => index).filter((index) => this._ready[index]);
        if (!readyIndices.length) throw new Error("Piper worker pool is not initialized");

        let selected = readyIndices[this._cursor % readyIndices.length];
        for (const candidate of readyIndices) {
            if (this._active[candidate] < this._active[selected]) selected = candidate;
        }
        this._cursor = (readyIndices.indexOf(selected) + 1) % readyIndices.length;
        return selected;
    }

    async synthesize(text, speed = 1.0, espeakVoice, options = {}) {
        const availabilityPromise = this._waitForWorkerAvailability();
        if (availabilityPromise) await availabilityPromise;

        const workerIndex = this._nextWorkerIndex();
        const startedAt = performance.now();
        this._active[workerIndex] += 1;
        console.info(`[TTS] Worker ${workerIndex + 1}/${this.size} start: ${JSON.stringify(text)}`);

        // Start the next lane without delaying this synthesis. Calls arriving while
        // it initializes continue using ready workers; later prefetch work can use
        // the new lane as soon as it reports ready.
        this._initializeNextWorker()?.catch(() => {});
        try {
            return await this.clients[workerIndex].synthesize(text, speed, espeakVoice, options);
        } finally {
            this._active[workerIndex] = Math.max(0, this._active[workerIndex] - 1);
            this._notifyWorkerAvailable();
            console.info(
                `[TTS] Worker ${workerIndex + 1}/${this.size} done (${Math.round(performance.now() - startedAt)} ms)`,
            );
        }
    }

    freeUserTimeLimit() {
        for (const client of this.clients) client.freeUserTimeLimit();
    }

    terminate() {
        this._terminated = true;
        for (const client of this.clients) client.terminate();
        this._active.fill(0);
        this._ready.fill(false);
        this._lazyWorkerOptions = null;
        this._lazyModelBuffer = null;
        this._modelBufferFactory = null;
        this._notifyWorkerAvailable();
    }
}

/* IndexedDB caching helpers (as provided) */
function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open("voice-models-db", 1);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains("models")) {
                db.createObjectStore("models");
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}
function saveModel(key, buffer) {
    return openDB().then((db) => {
        return new Promise((resolve, reject) => {
            const tx = db.transaction("models", "readwrite");
            const store = tx.objectStore("models");
            store.put(buffer, key);
            tx.oncomplete = () => {
                db.close();
                resolve();
            };
            tx.onerror = () => {
                db.close();
                reject(tx.error);
            };
        });
    });
}
function loadModel(key) {
    return openDB().then((db) => {
        return new Promise((resolve, reject) => {
            const tx = db.transaction("models", "readonly");
            const store = tx.objectStore("models");
            const request = store.get(key);
            request.onsuccess = () => {
                db.close();
                resolve(request.result);
            };
            request.onerror = () => {
                db.close();
                reject(request.error);
            };
        });
    });
}
export async function getCachedModel(key, url, options) {
    let buffer = await loadModel(key);
    if (buffer) {
        // console.log("Loaded model from cache.");
        return buffer;
    }
    console.log("Fetching model from network...");

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to load model: ${response.status}`);

    const contentLengthHeader = response.headers.get("Content-Length");
    const totalBytes = contentLengthHeader ? Number(contentLengthHeader) : NaN;

    const onProgress =
        typeof options === "function"
            ? options
            : options && typeof options.onProgress === "function"
              ? options.onProgress
              : null;

    // If we can stream + know total size, report progress.
    if (response.body && Number.isFinite(totalBytes) && totalBytes > 0) {
        const reader = response.body.getReader();
        const chunks = [];
        let receivedBytes = 0;

        let lastPctEmitted = -1;
        let lastEmitAt = 0;
        const emit = (pct) => {
            if (!onProgress) return;
            const now = performance.now ? performance.now() : Date.now();
            const pctRounded = Math.max(0, Math.min(100, pct));

            // Throttle UI updates to avoid spamming the message area.
            const pctFloor = Math.floor(pctRounded);
            if (pctFloor === lastPctEmitted && now - lastEmitAt < 250) return;

            lastPctEmitted = pctFloor;
            lastEmitAt = now;
            onProgress(pctRounded);
        };

        emit(0);
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
                chunks.push(value);
                receivedBytes += value.byteLength;
                emit((receivedBytes / totalBytes) * 100);
            }
        }

        const out = new Uint8Array(receivedBytes);
        let offset = 0;
        for (const chunk of chunks) {
            out.set(chunk, offset);
            offset += chunk.byteLength;
        }
        buffer = out.buffer;
        emit(100);
    } else {
        if (onProgress) onProgress(0);
        buffer = await response.arrayBuffer();
        if (onProgress) onProgress(100);
    }

    await saveModel(key, buffer);
    return buffer;
}

function saveJSON(key, obj) {
    const jsonString = JSON.stringify(obj);
    return saveModel(key, jsonString);
}

async function loadJSON(key) {
    const cached = await loadModel(key);
    if (!cached) return null;
    if (typeof cached === "object") return cached;
    try {
        return JSON.parse(cached);
    } catch (error) {
        console.warn(`Ignoring invalid cached voice config: ${key}`, error);
        return null;
    }
}

export async function getCachedJSON(key, url) {
    let data = await loadJSON(key);
    if (data) {
        // console.log("Loaded config from cache.");
        return data;
    }
    console.log("Fetching config from network...");
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to load config: ${response.status}`);
    data = await response.json();
    await saveJSON(key, data);
    console.log("Config cached.");
    return data;
}

export async function getUncachedModel(url, options) {
    console.log("Fetching uncached model from network...");

    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`Failed to load model: ${response.status}`);

    const contentLengthHeader = response.headers.get("Content-Length");
    const totalBytes = contentLengthHeader ? Number(contentLengthHeader) : NaN;
    const onProgress =
        typeof options === "function"
            ? options
            : options && typeof options.onProgress === "function"
              ? options.onProgress
              : null;

    if (response.body && Number.isFinite(totalBytes) && totalBytes > 0) {
        const reader = response.body.getReader();
        const chunks = [];
        let receivedBytes = 0;
        let lastPctEmitted = -1;
        let lastEmitAt = 0;
        const emit = (pct) => {
            if (!onProgress) return;
            const now = performance.now ? performance.now() : Date.now();
            const pctRounded = Math.max(0, Math.min(100, pct));
            const pctFloor = Math.floor(pctRounded);
            if (pctFloor === lastPctEmitted && now - lastEmitAt < 250) return;

            lastPctEmitted = pctFloor;
            lastEmitAt = now;
            onProgress(pctRounded);
        };

        emit(0);
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            chunks.push(value);
            receivedBytes += value.byteLength;
            emit((receivedBytes / totalBytes) * 100);
        }

        const out = new Uint8Array(receivedBytes);
        let offset = 0;
        for (const chunk of chunks) {
            out.set(chunk, offset);
            offset += chunk.byteLength;
        }
        emit(100);
        return out.buffer;
    }

    if (onProgress) onProgress(0);
    const buffer = await response.arrayBuffer();
    if (onProgress) onProgress(100);
    return buffer;
}

export async function getUncachedJSON(url) {
    console.log("Fetching uncached config from network...");
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`Failed to load config: ${response.status}`);
    return response.json();
}

// Export for browser
window.PiperWorkerClient = PiperWorkerClient;
window.PiperWorkerPoolClient = PiperWorkerPoolClient;
window.getCachedModel = getCachedModel;
window.getCachedJSON = getCachedJSON;
window.getUncachedModel = getUncachedModel;
window.getUncachedJSON = getUncachedJSON;
