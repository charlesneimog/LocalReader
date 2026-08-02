import test from "node:test";
import assert from "node:assert/strict";

import { CONFIG, INFERENCE_BACKENDS, normalizeInferenceBackend } from "../src/config.js";

test("exposes only WASM and WebGPU inference backend values", () => {
    assert.deepEqual(Object.values(INFERENCE_BACKENDS), ["wasm", "webgpu"]);
    assert.equal(normalizeInferenceBackend("wasm"), "wasm");
    assert.equal(normalizeInferenceBackend("webgpu"), "webgpu");
    assert.equal(normalizeInferenceBackend("invalid"), "wasm");
    assert.equal(normalizeInferenceBackend("invalid", "webgpu"), "webgpu");
});

test("configures TTS and layout detection with explicit inference backends", () => {
    assert.ok(Object.values(INFERENCE_BACKENDS).includes(CONFIG.TTS_BACKEND));
    assert.ok(Object.values(INFERENCE_BACKENDS).includes(CONFIG.LAYOUT_DETECTION_BACKEND));
    assert.equal(CONFIG.TTS_BACKEND, INFERENCE_BACKENDS.WASM);
    assert.equal(CONFIG.LAYOUT_DETECTION_BACKEND, INFERENCE_BACKENDS.WASM);
});

test("uses one Piper lane with a two-phrase startup buffer", () => {
    assert.equal(CONFIG.MAX_CONCURRENT_SYNTH, 1);
    assert.equal(CONFIG.PIPER_WORKERS, 1);
    assert.equal(CONFIG.PIPER_MAX_THREADS, 1);
    assert.equal(CONFIG.TTS_START_BUFFER_PHRASES, 2);
});
