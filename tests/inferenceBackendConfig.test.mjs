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
});
