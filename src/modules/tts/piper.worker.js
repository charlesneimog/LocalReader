/* Piper TTS WebWorker
   Loads:
   - onnxruntime-web (WASM) inside the worker
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
let voiceConfig = null;

let createPiperPhonemizeWorker = null;
let phonemizerModule = null;
let currentPhonemizeResolve = null;
let currentPhonemizeReject = null;
let limitUserTime = false;

function respond(id, type, payload) {
    self.postMessage({ id, type, ...payload });
}

function respondError(id, op, error) {
    const message = error && error.message ? error.message : String(error);
    self.postMessage({ id, type: "error", op, error: message });
}

async function loadOrt(ortJsUrl, wasmRoot, logLevel = "error") {
    if (ortLoaded) return;

    // Load ORT script in the worker
    importScripts(ortJsUrl);

    // Configure ORT
    const threadsDefault =
        self.navigator && self.navigator.hardwareConcurrency ? self.navigator.hardwareConcurrency : 1;
    const canUseThreads = self.crossOriginIsolated === true; // needed for SharedArrayBuffer
    const threads = canUseThreads ? threadsDefault : 1;

    self.ort.env.wasm.wasmPaths = wasmRoot;
    self.ort.env.wasm.simd = true;
    self.ort.env.wasm.numThreads = threads;
    self.ort.env.logLevel = logLevel;

    ortLoaded = true;
}

async function loadPhonemizerJS(phonemizerJsUrl) {
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

function phonemize(text, espeakVoice, timeoutMs = 5000) {
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

async function createSession(modelBuffer) {
    if (!ortLoaded) throw new Error("ONNX Runtime is not loaded");

    // Session options
    const threads = self.ort.env.wasm.numThreads || 1;
    const sessionOptions = {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
        enableCpuMemArena: true,
        enableMemPattern: true,
        executionMode: "sequential",
        intraOpNumThreads: threads,
        interOpNumThreads: Math.max(1, Math.floor(threads / 2)),
    };

    // onnxruntime-web accepts ArrayBuffer or Uint8Array
    const model = modelBuffer instanceof Uint8Array ? modelBuffer : new Uint8Array(modelBuffer);
    session = await self.ort.InferenceSession.create(model, sessionOptions);
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

async function synthesize(text, speed = 1.0, espeakVoice) {
    if (!session) throw new Error("Inference session not initialized");
    if (!voiceConfig) throw new Error("voiceConfig is missing");

    const phonemeIds = await phonemize(text, espeakVoice);

    const inputs = {
        input: new self.ort.Tensor("int64", new BigInt64Array(phonemeIds.map((v) => BigInt(v))), [
            1,
            phonemeIds.length,
        ]),
        input_lengths: new self.ort.Tensor("int64", new BigInt64Array([BigInt(phonemeIds.length)]), [1]),
        scales: new self.ort.Tensor("float32", new Float32Array([0.667, speed || 1.0, 0.8]), [3]),
    };

    const results = await session.run(inputs);
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
            } = payload;

            await loadOrt(ortJsUrl, ortWasmRoot, logLevel || "error");
            await loadPhonemizerJS(phonemizerJsUrl);
            await ensurePhonemizer(phonemizerWasmUrl, phonemizerDataUrl);

            voiceConfig = cfg;
            await createSession(modelBuffer);

            respond(id, "init-ok", { threads: self.ort.env.wasm.numThreads, simd: !!self.ort.env.wasm.simd });
            return;
        }

        if (type === "change-voice") {
            const { modelBuffer, voiceConfig: cfg } = payload;
            voiceConfig = cfg;
            await createSession(modelBuffer);
            respond(id, "change-voice-ok", {});
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
