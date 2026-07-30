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
    const documentObject = { visibilityState: "visible", hasFocus: () => true };
    const tracker = new ActiveReadingTracker({
        config,
        onDelta: (delta) => deltas.push(delta),
        onIdle: () => idleCount++,
        performanceNow: () => now,
        documentObject,
        setIntervalFn: () => 1,
        clearIntervalFn: () => {},
    });
    tracker.setDocumentOpen(true);
    tracker.setReadingScreen(true);
    tracker.setPaused(false);
    tracker.start();
    return {
        tracker,
        documentObject,
        deltas,
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
});

test("idle timeout permits normal reading pauses then stops", () => {
    const item = fixture();
    assert.equal(item.advance(239000), 5000);
    assert.equal(item.advance(2000), 0);
    assert.equal(item.idleCount, 1);
    item.tracker.recordActivity("page-change");
    assert.equal(item.advance(1000), 1000);
});

test("delayed callbacks are clamped and TTS keeps one shared clock eligible", () => {
    const item = fixture();
    assert.equal(item.advance(60000), 5000);
    item.advance(240001);
    assert.equal(item.tracker.isEligible(), false);
    item.tracker.setTtsPlaying(true);
    assert.equal(item.advance(1000), 1000);
});

test("closed documents and non-reading screens do not count", () => {
    const item = fixture();
    item.tracker.setReadingScreen(false);
    assert.equal(item.advance(1000), 0);
    item.tracker.setReadingScreen(true);
    item.tracker.setDocumentOpen(false);
    assert.equal(item.advance(1000), 0);
});
