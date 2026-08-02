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

test("initializes both Piper workers before synthesis begins", async () => {
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

    const workers = MockWorker.instances.slice(firstNewWorker);
    assert.equal(workers.length, 2);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(modelLoads, ["secondary"]);
    const initCalls = workers.map((worker) => worker.messages[0].message);
    assert.ok(initCalls.every((message) => message.type === "init"));
    assert.ok(initCalls.every((message) => message.payload.maxThreads === 2));
    for (let index = 0; index < workers.length; index++) {
        workers[index].onmessage({
            data: { id: initCalls[index].id, type: "init-ok", backend: "wasm", ortVersion: "1.27.0", threads: 2 },
        });
    }
    const runtime = await initialization;
    assert.equal(runtime.workers, 2);
    assert.equal(runtime.configuredWorkers, 2);
    assert.equal(runtime.threadsPerWorker, 2);

    const first = pool.synthesize("first", 1, undefined, { createBlob: false });
    const second = pool.synthesize("second", 1, undefined, { createBlob: false });
    const firstCall = workers[0].messages.at(-1).message;
    const secondCall = workers[1].messages.at(-1).message;
    assert.equal(firstCall.payload.text, "first");
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

test("voice changes update both initialized workers", async () => {
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
    const workers = MockWorker.instances.slice(firstNewWorker);
    await new Promise((resolve) => setImmediate(resolve));
    const initCalls = workers.map((worker) => worker.messages[0].message);
    assert.ok(initCalls.every((message) => message.payload.ortJsUrl === "/ort/ort.js"));
    assert.ok(initCalls.every((message) => message.payload.phonemizerDataUrl === "/piper/phonemizer.data"));
    assert.ok(initCalls.every((message) => message.payload.maxThreads === 2));
    for (let index = 0; index < workers.length; index++) {
        workers[index].onmessage({
            data: { id: initCalls[index].id, type: "init-ok", backend: "wasm", threads: 2 },
        });
    }
    await initialization;

    const voiceChange = pool.changeVoice({
        modelBuffer: new ArrayBuffer(20),
        modelBufferFactory: async () => new ArrayBuffer(20),
        voiceConfig: { voice: "new" },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const changeCalls = workers.map((worker) => worker.messages.at(-1).message);
    assert.ok(changeCalls.every((message) => message.type === "change-voice"));
    assert.ok(changeCalls.every((message) => message.payload.voiceConfig.voice === "new"));
    for (let index = 0; index < workers.length; index++) {
        workers[index].onmessage({
            data: { id: changeCalls[index].id, type: "change-voice-ok", backend: "wasm" },
        });
    }
    await voiceChange;
    pool.terminate();
});
