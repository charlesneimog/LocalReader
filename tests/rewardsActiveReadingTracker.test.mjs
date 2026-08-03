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
    const documentObject = { visibilityState: "visible" };
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

test("hidden tabs reset continuity and stop counting", () => {
    const item = fixture();
    assert.equal(item.advance(1000), 1000);
    assert.deepEqual(item.interruptions, []);

    item.documentObject.visibilityState = "hidden";
    item.tracker.visibilityHandler();
    assert.equal(item.advance(1000), 0);
    assert.deepEqual(item.interruptions, [{ reason: "tab-hidden" }]);
});

test("visible playback keeps counting", () => {
    const item = fixture();

    assert.equal(item.advance(1000), 1000);
    assert.deepEqual(item.interruptions, []);
});

test("hiding the PWA requests TTS pause and returning does not resume it", () => {
    let hiddenCount = 0;
    let now = 0;
    const documentObject = {
        visibilityState: "visible",
        addEventListener() {},
        removeEventListener() {},
    };
    let tracker;
    tracker = new ActiveReadingTracker({
        config,
        onHidden: () => {
            hiddenCount++;
            tracker.setTtsPlaying(false);
        },
        performanceNow: () => now,
        documentObject,
        windowObject: { addEventListener() {}, removeEventListener() {} },
        setIntervalFn: () => 1,
        clearIntervalFn: () => {},
    });
    tracker.setPaused(false);
    tracker.setTtsPlaying(true);
    tracker.start();

    documentObject.visibilityState = "hidden";
    tracker.visibilityHandler();
    assert.equal(hiddenCount, 1);

    documentObject.visibilityState = "visible";
    tracker.visibilityHandler();
    assert.equal(hiddenCount, 1);
    assert.equal(tracker.ttsPlaying, false);
});

test("visible mobile reading keeps counting", () => {
    let now = 0;
    const interruptions = [];
    const documentObject = {
        visibilityState: "visible",
        addEventListener() {},
        removeEventListener() {},
    };
    const windowObject = {
        addEventListener() {},
        removeEventListener() {},
    };
    const tracker = new ActiveReadingTracker({
        config,
        onInterrupted: (interruption) => interruptions.push(interruption),
        performanceNow: () => now,
        documentObject,
        windowObject,
        setIntervalFn: () => 1,
        clearIntervalFn: () => {},
    });
    tracker.setDocumentOpen(true);
    tracker.setReadingScreen(true);
    tracker.setPaused(false);
    tracker.start();
    tracker.setTtsPlaying(true);

    now += 1000;
    assert.equal(tracker.tick(now), 1000);
    assert.deepEqual(interruptions, []);

    documentObject.visibilityState = "hidden";
    tracker.visibilityHandler();
    assert.deepEqual(interruptions, [{ reason: "tab-hidden" }]);
    now += 1000;
    assert.equal(tracker.tick(now), 0);
});

test("live player state is authoritative when browser event ordering is stale", () => {
    let now = 0;
    let playbackActive = true;
    const deltas = [];
    const tracker = new ActiveReadingTracker({
        config,
        getPlaybackActive: () => playbackActive,
        onDelta: (delta) => deltas.push(delta),
        performanceNow: () => now,
        documentObject: { visibilityState: "visible" },
        setIntervalFn: () => 1,
        clearIntervalFn: () => {},
    });
    tracker.setDocumentOpen(true);
    tracker.setReadingScreen(true);
    tracker.setPaused(false);
    tracker.start();

    // No synthetic TTS event is required: the live player is already active.
    now += 1000;
    assert.equal(tracker.tick(now), 1000);
    playbackActive = false;
    now += 1000;
    assert.equal(tracker.tick(now), 0);
    assert.deepEqual(deltas, [1000]);
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

    assert.equal(item.advance(1000), 0);
    assert.deepEqual(item.interruptions, []);

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

test("reader overlays do not override active TTS eligibility", () => {
    const item = fixture();
    item.tracker.setReadingScreen(false);
    assert.equal(item.advance(1000), 1000);
    item.tracker.setDocumentOpen(false);
    assert.equal(item.advance(1000), 1000);
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
