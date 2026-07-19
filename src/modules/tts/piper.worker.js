/* Piper TTS WebWorker
   Loads:
   - onnxruntime-web (WebGPU with WASM recovery) inside the worker
   - Piper phonemizer (Emscripten WASM) inside the worker
   Accepts:
   - modelBuffer (ArrayBuffer of ONNX)
   - voiceConfig (JSON object from *.onnx.json)
   Provides:
   - synthesize(text, speed) -> WAV ArrayBuffer
*/

"use strict";

let ortLoaded = false;
let session = null;
let modelBytes = null;
let voiceConfig = null;
let activeBackend = null;
let preferWebGpu = true;

// Piper's duration predictor uses INT64 indices for these GatherND nodes.
// WebGPU shaders cannot represent INT64, so ONNX Runtime keeps only these
// nodes on CPU while the rest of the model remains on WebGPU.
const PIPER_INT64_GATHER_ND_NODES = [3, 5, 7].flatMap((flow) =>
    ["", "_1", "_2", "_3", "_4"].map((suffix) => `/dp/flows.${flow}/GatherND${suffix}`),
);

let createPiperPhonemizeWorker = null;
let phonemizerModule = null;
let currentPhonemizeResolve = null;
let currentPhonemizeReject = null;
let phonemizeQueue = Promise.resolve();
let limitUserTime = false;

function respond(id, type, payload) {
    self.postMessage({ id, type, ...payload });
}

function respondError(id, op, error) {
    const message = error && error.message ? error.message : String(error);
    self.postMessage({ id, type: "error", op, error: message });
}

function normalizeAssetUrl(url) {
    if (!url) return url;
    try {
        const u = new URL(String(url), self.location && self.location.href ? self.location.href : undefined);
        if (u.pathname.includes("/index.html/")) {
            u.pathname = u.pathname.replace("/index.html/", "/");
        }
        return u.href;
    } catch (_) {
        // If it's not a valid URL, best-effort string fix.
        return String(url).replace("/index.html/", "/");
    }
}

async function loadOrt(ortJsUrl, wasmRoot, logLevel = "error", maxThreads = 4) {
    if (ortLoaded) return;

    ortJsUrl = normalizeAssetUrl(ortJsUrl);
    wasmRoot = normalizeAssetUrl(wasmRoot);

    // Load ORT script in the worker
    importScripts(ortJsUrl);

    // Configure ORT
    const threadsDefault =
        self.navigator && self.navigator.hardwareConcurrency ? self.navigator.hardwareConcurrency : 1;
    const canUseThreads = self.crossOriginIsolated === true; // needed for SharedArrayBuffer
    const threadCap = Math.max(1, Number(maxThreads) || 1);
    const threads = canUseThreads ? Math.min(threadsDefault, threadCap) : 1;

    self.ort.env.wasm.wasmPaths = wasmRoot;
    self.ort.env.wasm.simd = true;
    self.ort.env.wasm.numThreads = threads;
    self.ort.env.logLevel = logLevel;

    ortLoaded = true;
}

async function loadPhonemizerJS(phonemizerJsUrl) {
    phonemizerJsUrl = normalizeAssetUrl(phonemizerJsUrl);
    // The ESM file exports createPiperPhonemize. We patch it into the worker global.
    const resp = await fetch(phonemizerJsUrl);
    if (!resp.ok) throw new Error(`Failed to fetch phonemizer JS: ${resp.status}`);
    const jsText = await resp.text();
    const patched = jsText.replace(
        /export\s*{\s*createPiperPhonemize\s*};?/,
        "self.__createPiperPhonemize = createPiperPhonemize;",
    );

    const blobUrl = URL.createObjectURL(new Blob([patched], { type: "text/javascript" }));
    try {
        importScripts(blobUrl);
    } finally {
        URL.revokeObjectURL(blobUrl);
    }

    if (!self.__createPiperPhonemize) {
        throw new Error("createPiperPhonemize not found after loading phonemizer JS");
    }

    createPiperPhonemizeWorker = self.__createPiperPhonemize;
    delete self.__createPiperPhonemize;
}

async function ensurePhonemizer(phonemizerWasmUrl, phonemizerDataUrl) {
    if (phonemizerModule) return;

    phonemizerWasmUrl = normalizeAssetUrl(phonemizerWasmUrl);
    phonemizerDataUrl = normalizeAssetUrl(phonemizerDataUrl);

    if (!createPiperPhonemizeWorker) {
        throw new Error("Phonemizer JS has not been loaded");
    }

    phonemizerModule = await createPiperPhonemizeWorker({
        print: (data) => {
            if (currentPhonemizeResolve) {
                try {
                    const obj = JSON.parse(data);
                    if (obj && obj.phoneme_ids) {
                        const resolve = currentPhonemizeResolve;
                        currentPhonemizeResolve = null;
                        currentPhonemizeReject = null;
                        resolve(obj.phoneme_ids);
                    }
                } catch (_) {
                    // ignore non-JSON lines
                }
            }
        },
        printErr: (msg) => {
            if (currentPhonemizeReject) {
                const reject = currentPhonemizeReject;
                currentPhonemizeResolve = null;
                currentPhonemizeReject = null;
                reject(new Error(msg));
            }
        },
        locateFile: (url) => {
            if (url.endsWith(".wasm")) return phonemizerWasmUrl;
            if (url.endsWith(".data")) return phonemizerDataUrl;
            return url;
        },
    });
}

function phonemizeOnce(text, espeakVoice, timeoutMs = 5000) {
    if (!phonemizerModule) throw new Error("Phonemizer module is not initialized");

    return new Promise((resolve, reject) => {
        let finished = false;

        currentPhonemizeResolve = (ids) => {
            if (finished) return;
            finished = true;
            resolve(ids);
        };

        currentPhonemizeReject = (err) => {
            if (finished) return;
            finished = true;
            reject(err);
        };

        const input = JSON.stringify([{ text: String(text || "").trim() }]);
        const voice = espeakVoice || (voiceConfig && voiceConfig.espeak && voiceConfig.espeak.voice) || "en-us";

        try {
            phonemizerModule.callMain(["-l", voice, "--input", input, "--espeak_data", "/espeak-ng-data"]);
        } catch (e) {
            if (!finished) {
                finished = true;
                reject(e);
            }
        }

        setTimeout(() => {
            if (!finished) {
                finished = true;
                currentPhonemizeResolve = null;
                currentPhonemizeReject = null;
                reject(new Error("Phonemizer timeout"));
            }
        }, timeoutMs);
    });
}

function phonemize(text, espeakVoice, timeoutMs = 5000) {
    // The Emscripten phonemizer exposes one global stdout callback. Serialize
    // only this short stage so two overlapping sentence requests cannot steal
    // each other's result; their ONNX inference can still overlap afterward.
    const task = phonemizeQueue
        .catch(() => {})
        .then(() => phonemizeOnce(text, espeakVoice, timeoutMs));
    phonemizeQueue = task.catch(() => {});
    return task;
}

async function releaseSession() {
    if (!session) return;
    const previousSession = session;
    session = null;
    try {
        await previousSession.release?.();
    } catch (error) {
        console.warn("[TTS] Failed to release Piper ONNX session", error);
    }
}

async function createSession(modelBuffer, useWebGpu = preferWebGpu) {
    if (!ortLoaded) throw new Error("ONNX Runtime is not loaded");

    modelBytes = modelBuffer instanceof Uint8Array ? modelBuffer : new Uint8Array(modelBuffer);
    await releaseSession();

    const threads = self.ort.env.wasm.numThreads || 1;
    const commonOptions = {
        graphOptimizationLevel: "all",
        enableCpuMemArena: true,
        enableMemPattern: true,
        executionMode: "sequential",
        intraOpNumThreads: threads,
        interOpNumThreads: Math.max(1, Math.floor(threads / 2)),
    };

    if (useWebGpu && self.navigator?.gpu) {
        try {
            console.info(
                `[TTS] Piper WebGPU hybrid mode; ${PIPER_INT64_GATHER_ND_NODES.length} INT64 GatherND nodes on CPU`,
            );
            session = await self.ort.InferenceSession.create(modelBytes, {
                ...commonOptions,
                executionProviders: [
                    {
                        name: "webgpu",
                        forceCpuNodeNames: PIPER_INT64_GATHER_ND_NODES,
                    },
                    "wasm",
                ],
            });
            activeBackend = "webgpu";
            return;
        } catch (error) {
            console.warn("[TTS] Piper WebGPU initialization failed; using WASM", error);
            preferWebGpu = false;
        }
    }

    session = await self.ort.InferenceSession.create(modelBytes, {
        ...commonOptions,
        executionProviders: ["wasm"],
    });
    activeBackend = "wasm";
}

async function switchToWasm(error) {
    if (activeBackend === "wasm") throw error;
    console.warn("[TTS] Piper WebGPU synthesis failed; retrying with WASM", error);
    preferWebGpu = false;
    await createSession(modelBytes, false);
    self.postMessage({ type: "backend-change", backend: activeBackend, reason: error?.message || String(error) });
}

function floatToWavPCM16(float32Array, sampleRate) {
    const length = float32Array.length;
    const buffer = new ArrayBuffer(44 + length * 2);
    const view = new DataView(buffer);

    const writeString = (offset, str) => {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };

    writeString(0, "RIFF");
    view.setUint32(4, 36 + length * 2, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, "data");
    view.setUint32(40, length * 2, true);

    let offset = 44;
    for (let i = 0; i < length; i++) {
        const s = Math.max(-1, Math.min(1, float32Array[i]));
        view.setInt16(offset, s * 0x7fff, true);
        offset += 2;
    }

    return buffer;
}

async function runSynthesis(phonemeIds, speed) {
    const inputs = {
        input: new self.ort.Tensor("int64", new BigInt64Array(phonemeIds.map((v) => BigInt(v))), [
            1,
            phonemeIds.length,
        ]),
        input_lengths: new self.ort.Tensor("int64", new BigInt64Array([BigInt(phonemeIds.length)]), [1]),
        scales: new self.ort.Tensor("float32", new Float32Array([0.667, speed || 1.0, 0.8]), [3]),
    };

    return session.run(inputs);
}

async function synthesize(text, speed = 1.0, espeakVoice) {
    if (!session) throw new Error("Inference session not initialized");
    if (!voiceConfig) throw new Error("voiceConfig is missing");

    const phonemeIds = await phonemize(text, espeakVoice);
    let results;
    try {
        results = await runSynthesis(phonemeIds, speed);
    } catch (error) {
        await switchToWasm(error);
        results = await runSynthesis(phonemeIds, speed);
    }
    const outTensor = results.output || results[Object.keys(results)[0]];
    if (!outTensor || !outTensor.data) throw new Error("No output audio tensor");

    const audioData = outTensor.data; // Float32Array
    const sampleRate = (voiceConfig.audio && voiceConfig.audio.sample_rate) || 22050;
    const wavBuffer = floatToWavPCM16(audioData, sampleRate);

    return { wavBuffer, sampleRate };
}

self.onmessage = async (event) => {
    const { id, type, payload } = event.data || {};
    try {
        if (type === "init") {
            const {
                ortJsUrl,
                ortWasmRoot,
                phonemizerJsUrl,
                phonemizerWasmUrl,
                phonemizerDataUrl,
                modelBuffer,
                voiceConfig: cfg,
                logLevel,
                maxThreads,
                useWebGpu,
            } = payload;

            await loadOrt(ortJsUrl, ortWasmRoot, logLevel || "error", maxThreads);
            await loadPhonemizerJS(phonemizerJsUrl);
            await ensurePhonemizer(phonemizerWasmUrl, phonemizerDataUrl);

            voiceConfig = cfg;
            preferWebGpu = useWebGpu !== false;
            await createSession(modelBuffer, preferWebGpu);

            respond(id, "init-ok", {
                backend: activeBackend,
                ortVersion: self.ort.env?.versions?.web || null,
                threads: self.ort.env.wasm.numThreads,
                simd: !!self.ort.env.wasm.simd,
            });
            return;
        }

        if (type === "change-voice") {
            const { modelBuffer, voiceConfig: cfg } = payload;
            voiceConfig = cfg;
            await createSession(modelBuffer, preferWebGpu);
            respond(id, "change-voice-ok", { backend: activeBackend });
            return;
        }

        if (type === "synthesize") {
            if (limitUserTime) {
                throw new Error("Free limit reached");
            }
            const { text, speed, espeakVoice } = payload;
            const { wavBuffer, sampleRate } = await synthesize(text, speed, espeakVoice);
            // Transfer the WAV buffer to avoid copying
            self.postMessage({ id, type: "synthesize-ok", wavBuffer, sampleRate }, [wavBuffer]);
            return;
        }

        if (type === "limit-user-time") {
            limitUserTime = true;
        }

        respondError(id, type || "unknown", "Unknown message type");
    } catch (err) {
        respondError(id, type || "unknown", err);
    }
};
