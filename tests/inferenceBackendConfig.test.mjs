import test from "node:test";
import assert from "node:assert/strict";

import { CONFIG, INFERENCE_BACKENDS, normalizeInferenceBackend } from "../src/config.js";
import { getInferenceConcurrencyProfile } from "../src/modules/utils/helpers.js";

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

test("uses two eager Piper lanes with a two-phrase startup buffer", () => {
    assert.equal(CONFIG.MAX_CONCURRENT_SYNTH, 2);
    assert.equal(CONFIG.PIPER_WORKERS, 2);
    assert.equal(CONFIG.PIPER_MAX_THREADS, 4);
    assert.equal(CONFIG.TTS_START_BUFFER_PHRASES, 2);
});

test("adapts the shared inference budget to the computer", () => {
    const highCore = getInferenceConcurrencyProfile(CONFIG, {
        userAgent: "Desktop",
        maxTouchPoints: 0,
        hardwareConcurrency: 22,
    });
    assert.deepEqual(highCore, {
        hardwareThreads: 22,
        piperWorkers: 2,
        piperThreads: 4,
        layoutThreads: 4,
    });

    const ordinaryDesktop = getInferenceConcurrencyProfile(CONFIG, {
        userAgent: "Desktop",
        maxTouchPoints: 0,
        hardwareConcurrency: 8,
    });
    assert.deepEqual(ordinaryDesktop, {
        hardwareThreads: 8,
        piperWorkers: 2,
        piperThreads: 2,
        layoutThreads: 2,
    });

    const iPad = getInferenceConcurrencyProfile(CONFIG, {
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)",
        maxTouchPoints: 5,
        hardwareConcurrency: 10,
    });
    assert.deepEqual(iPad, {
        hardwareThreads: 1,
        piperWorkers: 1,
        piperThreads: 1,
        layoutThreads: 1,
    });
});
