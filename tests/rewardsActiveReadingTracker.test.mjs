import test from "node:test";
import assert from "node:assert/strict";
import { ActiveReadingTracker } from "../src/modules/rewards/activeReadingTracker.js";

const config = {
    tickIntervalMs: 1000,
    idleTimeoutMs: 240000,
    maxAcceptedDeltaMs: 5000,
};

function fixture() {
    let now = 0;
    const deltas = [];
    let idleCount = 0;
    const interruptions = [];
    const documentObject = { visibilityState: "visible", hasFocus: () => true };
    const tracker = new ActiveReadingTracker({
        config,
        onDelta: (delta) => deltas.push(delta),
        onIdle: () => idleCount++,
        onInterrupted: (interruption) => interruptions.push(interruption),
        performanceNow: () => now,
        documentObject,
        setIntervalFn: () => 1,
        clearIntervalFn: () => {},
    });
    tracker.setDocumentOpen(true);
    tracker.setReadingScreen(true);
    tracker.setPaused(false);
    tracker.start();
    tracker.setTtsPlaying(true);
    return {
        tracker,
        documentObject,
        deltas,
        interruptions,
        get idleCount() { return idleCount; },
        advance(milliseconds) { now += milliseconds; return tracker.tick(now); },
    };
}

test("counts active reading but not explicit pause", () => {
    const item = fixture();
    assert.equal(item.advance(1000), 1000);
    item.tracker.setPaused(true);
    assert.equal(item.advance(1000), 0);
    item.tracker.setPaused(false);
    assert.equal(item.advance(1000), 1000);
    assert.deepEqual(item.deltas, [1000, 1000]);
});

test("hidden tabs and unfocused windows do not count", () => {
    const item = fixture();
    item.documentObject.visibilityState = "hidden";
    assert.equal(item.advance(1000), 0);
    item.documentObject.visibilityState = "visible";
    item.documentObject.hasFocus = () => false;
    assert.equal(item.advance(1000), 0);
    item.documentObject.hasFocus = () => true;
    assert.equal(item.advance(1000), 1000);
    assert.deepEqual(item.interruptions, [{ reason: "tab-hidden" }]);
});

test("idle timeout permits normal reading pauses then stops", () => {
    const item = fixture();
    item.tracker.setTtsPlaying(false);
    assert.equal(item.advance(239000), 0);
    assert.equal(item.advance(2000), 0);
    assert.equal(item.idleCount, 1);
    item.tracker.recordActivity("page-change");
    assert.equal(item.advance(1000), 0);
    item.tracker.setTtsPlaying(true);
    assert.equal(item.advance(1000), 1000);
});

test("delayed callbacks are clamped and TTS keeps one shared clock eligible", () => {
    const item = fixture();
    assert.equal(item.advance(60000), 5000);
    item.tracker.setTtsPlaying(false);
    item.advance(240001);
    assert.equal(item.tracker.isEligible(), false);
    item.tracker.setTtsPlaying(true);
    assert.equal(item.advance(1000), 1000);
});

test("loading and allowed playback pauses do not count or break tree continuity", () => {
    const item = fixture();
    item.tracker.setTtsPlaying(false);
    assert.equal(item.advance(30000), 0);
    assert.deepEqual(item.interruptions, []);

    item.documentObject.hasFocus = () => false;
    assert.equal(item.advance(1000), 0);
    assert.deepEqual(item.interruptions, []);

    item.documentObject.hasFocus = () => true;
    item.tracker.setTtsPlaying(true);
    assert.equal(item.advance(1000), 1000);
});

test("TTS cannot bypass an explicit pause", () => {
    const item = fixture();
    item.tracker.setTtsPlaying(true);
    item.tracker.setPaused(true);
    assert.equal(item.advance(1000), 0);
    assert.deepEqual(item.deltas, []);
});

test("closed documents and non-reading screens freeze progress", () => {
    const item = fixture();
    item.tracker.setReadingScreen(false);
    assert.equal(item.advance(1000), 0);
    item.tracker.setReadingScreen(true);
    item.tracker.setDocumentOpen(false);
    assert.equal(item.advance(1000), 0);
});

test("default reading-clock timers keep the native global receiver", () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const receivers = [];
    try {
        globalThis.setInterval = function () {
            receivers.push(this);
            return 7;
        };
        globalThis.clearInterval = function () {
            receivers.push(this);
        };
        const tracker = new ActiveReadingTracker({
            config,
            performanceNow: () => 0,
            documentObject: null,
        });
        tracker.start();
        tracker.stop();
        assert.deepEqual(receivers, [globalThis, globalThis]);
    } finally {
        globalThis.setInterval = originalSetInterval;
        globalThis.clearInterval = originalClearInterval;
    }
});
