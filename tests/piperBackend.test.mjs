import test from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis.window || {};

class MockWorker {
    constructor() {
        this.messages = [];
        this.terminated = false;
        MockWorker.instance = this;
        MockWorker.instances.push(this);
    }

    postMessage(message, transfers) {
        this.messages.push({ message, transfers });
    }

    terminate() {
        this.terminated = true;
    }
}

MockWorker.instances = [];

globalThis.Worker = MockWorker;

const { PiperWorkerClient, PiperWorkerPoolClient } = await import("../src/modules/tts/piper-client.js");

test("defaults Piper initialization to WASM", async () => {
    const client = new PiperWorkerClient({ workerUrl: "piper.worker.js" });
    const initialization = client.init({
        modelBuffer: new ArrayBuffer(8),
        voiceConfig: { audio: { sample_rate: 22050 } },
    });

    const [{ message }] = MockWorker.instance.messages;
    assert.equal(message.payload.useWebGpu, false);
    MockWorker.instance.onmessage({
        data: { id: message.id, type: "init-ok", backend: "wasm", ortVersion: "1.27.0", threads: 1 },
    });
    await initialization;
    client.terminate();
});

test("requests WebGPU for Piper and reports the active TTS backend", async () => {
    const client = new PiperWorkerClient({ workerUrl: "piper.worker.js" });
    const modelBuffer = new ArrayBuffer(8);
    const initialization = client.init({
        modelBuffer,
        voiceConfig: { audio: { sample_rate: 22050 } },
        useWebGpu: true,
    });

    const [{ message }] = MockWorker.instance.messages;
    assert.equal(message.type, "init");
    assert.equal(message.payload.useWebGpu, true);

    MockWorker.instance.onmessage({
        data: {
            id: message.id,
            type: "init-ok",
            backend: "webgpu",
            ortVersion: "1.27.0",
            threads: 1,
            simd: true,
        },
    });

    const runtime = await initialization;
    assert.equal(runtime.backend, "webgpu");
    assert.equal(runtime.ortVersion, "1.27.0");
    assert.equal(client.backend, "webgpu");
});

test("tracks a runtime recovery from WebGPU to WASM", () => {
    let backendChange = null;
    const client = new PiperWorkerClient({
        workerUrl: "piper.worker.js",
        onBackendChange: (event) => {
            backendChange = event;
        },
    });

    MockWorker.instance.onmessage({
        data: { type: "backend-change", backend: "wasm", reason: "GPU device lost" },
    });

    assert.equal(client.backend, "wasm");
    assert.deepEqual(backendChange, { backend: "wasm", reason: "GPU device lost" });
});

test("initializes only one Piper worker until synthesis makes it busy", async () => {
    const firstNewWorker = MockWorker.instances.length;
    const pool = new PiperWorkerPoolClient({ size: 2, workerUrl: "piper.worker.js" });
    const modelLoads = [];
    const initialization = pool.init({
        modelBuffer: new ArrayBuffer(16),
        modelBufferFactory: async () => {
            modelLoads.push("secondary");
            return new ArrayBuffer(16);
        },
        voiceConfig: { audio: { sample_rate: 22050 } },
        useWebGpu: false,
        maxThreads: 2,
    });

    let workers = MockWorker.instances.slice(firstNewWorker);
    assert.equal(workers.length, 1);
    const primaryInit = workers[0].messages[0].message;
    assert.equal(primaryInit.payload.maxThreads, 2);
    workers[0].onmessage({
        data: { id: primaryInit.id, type: "init-ok", backend: "wasm", ortVersion: "1.27.0", threads: 2 },
    });
    const runtime = await initialization;
    assert.equal(runtime.workers, 1);
    assert.equal(runtime.configuredWorkers, 2);
    assert.equal(runtime.threadsPerWorker, 2);

    const first = pool.synthesize("first", 1, undefined, { createBlob: false });
    workers = MockWorker.instances.slice(firstNewWorker);
    assert.equal(workers.length, 2);
    assert.deepEqual(modelLoads, ["secondary"]);

    const firstCall = workers[0].messages.at(-1).message;
    assert.equal(firstCall.payload.text, "first");

    // Complete lazy initialization while the first synthesis is still active.
    await new Promise((resolve) => setImmediate(resolve));
    const secondaryInit = workers[1].messages[0].message;
    assert.equal(secondaryInit.type, "init");
    assert.equal(secondaryInit.payload.maxThreads, 2);

    const second = pool.synthesize("second", 1, undefined, { createBlob: false });
    assert.equal(workers[0].messages.at(-1).message.payload.text, "first");
    assert.equal(workers[1].messages.length, 1);

    workers[1].onmessage({
        data: { id: secondaryInit.id, type: "init-ok", backend: "wasm", ortVersion: "1.27.0", threads: 2 },
    });
    await pool._lazyWorkerInitPromise;
    await Promise.resolve();

    const secondCall = workers[1].messages.at(-1).message;
    assert.equal(secondCall.payload.text, "second");

    workers[0].onmessage({
        data: { id: firstCall.id, type: "synthesize-ok", wavBuffer: new ArrayBuffer(4), sampleRate: 22050 },
    });
    workers[1].onmessage({
        data: { id: secondCall.id, type: "synthesize-ok", wavBuffer: new ArrayBuffer(4), sampleRate: 22050 },
    });
    await Promise.all([first, second]);
    pool.terminate();
    assert.ok(workers.every((worker) => worker.terminated));
});

test("a deferred worker initializes with the latest voice and original runtime options", async () => {
    const firstNewWorker = MockWorker.instances.length;
    const pool = new PiperWorkerPoolClient({ size: 2, workerUrl: "piper.worker.js" });
    const initialization = pool.init({
        modelBuffer: new ArrayBuffer(16),
        modelBufferFactory: async () => new ArrayBuffer(16),
        voiceConfig: { voice: "old" },
        ortJsUrl: "/ort/ort.js",
        ortWasmRoot: "/ort/",
        phonemizerJsUrl: "/piper/phonemizer.js",
        phonemizerWasmUrl: "/piper/phonemizer.wasm",
        phonemizerDataUrl: "/piper/phonemizer.data",
        maxThreads: 2,
        useWebGpu: false,
    });
    let workers = MockWorker.instances.slice(firstNewWorker);
    const primaryInit = workers[0].messages[0].message;
    workers[0].onmessage({
        data: { id: primaryInit.id, type: "init-ok", backend: "wasm", threads: 2 },
    });
    await initialization;

    const voiceChange = pool.changeVoice({
        modelBuffer: new ArrayBuffer(20),
        modelBufferFactory: async () => new ArrayBuffer(20),
        voiceConfig: { voice: "new" },
    });
    const primaryChange = workers[0].messages.at(-1).message;
    assert.equal(primaryChange.type, "change-voice");
    workers[0].onmessage({
        data: { id: primaryChange.id, type: "change-voice-ok", backend: "wasm" },
    });
    await voiceChange;

    const synthesis = pool.synthesize("first with new voice", 1, undefined, { createBlob: false });
    workers = MockWorker.instances.slice(firstNewWorker);
    await new Promise((resolve) => setImmediate(resolve));
    const secondaryInit = workers[1].messages[0].message;
    assert.equal(secondaryInit.payload.ortJsUrl, "/ort/ort.js");
    assert.equal(secondaryInit.payload.phonemizerDataUrl, "/piper/phonemizer.data");
    assert.equal(secondaryInit.payload.maxThreads, 2);
    assert.deepEqual(secondaryInit.payload.voiceConfig, { voice: "new" });

    workers[1].onmessage({
        data: { id: secondaryInit.id, type: "init-ok", backend: "wasm", threads: 2 },
    });
    const synthesisCall = workers[0].messages.at(-1).message;
    workers[0].onmessage({
        data: { id: synthesisCall.id, type: "synthesize-ok", wavBuffer: new ArrayBuffer(4), sampleRate: 22050 },
    });
    await Promise.all([synthesis, pool._lazyWorkerInitPromise]);
    pool.terminate();
});
