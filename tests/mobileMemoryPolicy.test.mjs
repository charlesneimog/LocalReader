import assert from "node:assert/strict";
import test from "node:test";

import { isIOSLike, isMobile } from "../src/modules/utils/helpers.js";
import { PDFHeaderFooterDetector } from "../src/modules/pdf/pdfHeaderFooterDetector.js";

globalThis.window = globalThis.window || {};
const { TTSEngine } = await import("../src/modules/tts/ttsEngine.js");

function withNavigator(value, callback) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const restore = () => {
        if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
        else delete globalThis.navigator;
    };
    Object.defineProperty(globalThis, "navigator", { configurable: true, value });
    try {
        const result = callback();
        if (result && typeof result.finally === "function") return result.finally(restore);
        restore();
        return result;
    } catch (error) {
        restore();
        throw error;
    }
}

test("recognizes an iPad using the desktop-class Safari user agent", () => {
    withNavigator(
        {
            userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15",
            maxTouchPoints: 5,
        },
        () => {
            assert.equal(isIOSLike(), true);
            assert.equal(isMobile(), true);
        },
    );
});

test("does not classify a regular Mac as an iOS device", () => {
    withNavigator(
        {
            userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15",
            maxTouchPoints: 0,
        },
        () => {
            assert.equal(isIOSLike(), false);
            assert.equal(isMobile(), false);
        },
    );
});

test("iPad low-memory mode does not create the layout AI worker", async () => {
    await withNavigator(
        {
            userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15",
            maxTouchPoints: 5,
        },
        async () => {
            const detector = new PDFHeaderFooterDetector({
                config: {},
                state: { layoutDetectionCache: new Map(), layoutCacheVersion: 1 },
                ui: { showInfo: () => {} },
            });
            assert.equal(detector.lowMemoryMode, true);
            assert.equal(detector.worker, null);
            assert.deepEqual(await detector.detectHeadersAndFooters(2), [
                {
                    pageNumber: 2,
                    label: "text",
                    score: 1,
                    normalized: { left: 0, top: 0, right: 1, bottom: 1 },
                    lowMemoryFallback: true,
                },
            ]);
        },
    );
});

test("iPad retains only the current and next phrase audio", () => {
    withNavigator(
        {
            userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)",
            maxTouchPoints: 5,
        },
        () => {
            const sentences = Array.from({ length: 4 }, () => ({
                audioBuffer: {},
                audioBlob: {},
                audioReady: true,
                wordBoundaries: [{}],
                ttsPhraseTimings: [{}],
            }));
            const engine = Object.create(TTSEngine.prototype);
            engine.app = {
                state: { sentences, audioCache: new Map([["cached", {}]]) },
                ttsQueue: { queue: [0, 1, 2, 3] },
            };

            engine._pruneAudioForLowMemory(1);

            assert.equal(sentences[0].audioBuffer, null);
            assert.notEqual(sentences[1].audioBuffer, null);
            assert.notEqual(sentences[2].audioBuffer, null);
            assert.equal(sentences[3].audioBuffer, null);
            assert.deepEqual(engine.app.ttsQueue.queue, [1, 2]);
            assert.equal(engine.app.state.audioCache.size, 0);
        },
    );
});
