import test from "node:test";
import assert from "node:assert/strict";

import {
    isSmartphoneEnvironment,
    resolveTtsWebGpuPreference,
} from "../src/modules/tts/ttsBackendPreference.js";

test("disables TTS WebGPU on smartphones", () => {
    assert.equal(
        resolveTtsWebGpuPreference({
            userAgent: "Mozilla/5.0 (Linux; Android 15) Chrome/150 Mobile Safari/537.36",
            viewportWidth: 384,
            coarsePointer: true,
        }),
        false,
    );
});

test("enables TTS WebGPU by default on desktop", () => {
    assert.equal(
        resolveTtsWebGpuPreference({
            userAgent: "Mozilla/5.0 (X11; Linux x86_64) Firefox/152.0",
            viewportWidth: 1440,
        }),
        true,
    );
});

test("automatic selection is unaffected by retired saved preferences", () => {
    const phone = {
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile Safari/604.1",
        viewportWidth: 390,
        coarsePointer: true,
    };
    assert.equal(resolveTtsWebGpuPreference({ ...phone, storedValue: "1" }), false);
    assert.equal(resolveTtsWebGpuPreference({ storedValue: "0", viewportWidth: 1440 }), true);
});

test("recognizes a small coarse-pointer screen without relying on user agent", () => {
    assert.equal(
        isSmartphoneEnvironment({ viewportWidth: 412, coarsePointer: true, userAgent: "Unknown" }),
        true,
    );
});
