import test from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis.window || {};

class MockWorker {
    constructor() {
        this.messages = [];
        MockWorker.instance = this;
        MockWorker.instances.push(this);
    }

    postMessage(message, transfers) {
        this.messages.push({ message, transfers });
    }

    terminate() {}
}

MockWorker.instances = [];

globalThis.Worker = MockWorker;

const { PiperWorkerClient, PiperWorkerPoolClient } = await import("../src/modules/tts/piper-client.js");

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

test("uses two independent Piper workers for parallel synthesis", async () => {
    const firstNewWorker = MockWorker.instances.length;
    const pool = new PiperWorkerPoolClient({ size: 2, workerUrl: "piper.worker.js" });
    const workers = MockWorker.instances.slice(firstNewWorker);
    const initialization = pool.init({
        modelBuffer: new ArrayBuffer(16),
        voiceConfig: { audio: { sample_rate: 22050 } },
        useWebGpu: false,
        maxThreads: 2,
    });

    assert.equal(workers.length, 2);
    for (const worker of workers) {
        const { message } = worker.messages[0];
        assert.equal(message.payload.maxThreads, 2);
        worker.onmessage({
            data: { id: message.id, type: "init-ok", backend: "wasm", ortVersion: "1.27.0", threads: 2 },
        });
    }
    const runtime = await initialization;
    assert.equal(runtime.workers, 2);
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
});
