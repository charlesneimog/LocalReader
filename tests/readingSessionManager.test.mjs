import test from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../src/core/eventBus.js";
import { CrossTabSessionLock } from "../src/modules/rewards/crossTabSessionLock.js";
import { GardenManager } from "../src/modules/rewards/gardenManager.js";
import { ReadingSessionManager } from "../src/modules/rewards/readingSessionManager.js";
import { RewardEngine } from "../src/modules/rewards/rewardEngine.js";
import { RewardStorage } from "../src/modules/rewards/rewardStorage.js";
import { StreakManager } from "../src/modules/rewards/streakManager.js";

const config = {
    defaultGardenRows: 2, defaultGardenColumns: 2,
    automaticTreesEnabled: true,
    sessionGoalsMinutes: [10], timeRewardIntervalMinutes: 5, timeRewardPoints: 1,
    dailyTimeRewardCap: 12, dailyEngagementRewardCap: 10, sessionCompletionPoints: 4,
    reflectionPoints: 5, annotationWithNotePoints: 3, questionPoints: 3,
    recoveryAfterDays: 7, recoveryPoints: 5, weekStartsOn: 1,
};
class MemoryStorage {
    getItem(key) { return this.values?.get(key) || null; }
    setItem(key, value) { (this.values ||= new Map()).set(key, value); }
    removeItem(key) { this.values?.delete(key); }
}
class Tracker {
    start() {}
    stop() {}
    checkpoint() {}
    setPaused(value) { this.paused = value; }
}

async function fixture(backing = new MemoryStorage()) {
    let id = 0;
    const storage = new RewardStorage({ storage: backing, storageKey: "rewards", config });
    await storage.load();
    const gardenManager = new GardenManager({ randomUUID: () => `plant-${++id}` });
    const engine = new RewardEngine({
        storage, gardenManager, streakManager: new StreakManager(),
        eventBus: new EventBus(), config, randomUUID: () => `tx-${++id}`,
    });
    const tracker = new Tracker();
    const lock = { sessionId: null, acquire(sessionId) { this.sessionId = sessionId; return true; }, release() { this.sessionId = null; } };
    const manager = new ReadingSessionManager({
        storage, rewardEngine: engine, gardenManager, tracker, lock,
        eventBus: new EventBus(), config,
        getDocument: () => ({ id: "doc", type: "pdf", title: "Book", currentLocation: 0, progress: 0 }),
        randomUUID: () => `session-${++id}`,
    });
    return { backing, storage, engine, tracker, lock, manager };
}

test("pause/resume, completion, and completion bonus lifecycle", async () => {
    const item = await fixture();
    const started = await item.manager.start({ goalMinutes: 10, speciesId: "daisy-patch" });
    assert.equal(started.state, "active");
    await item.manager.pause();
    assert.equal(item.manager.getCurrentSession().state, "paused");
    await item.manager.resume();
    assert.equal(item.manager.getCurrentSession().state, "active");
    await item.engine.recordActiveReading({ milliseconds: 600000, sessionId: started.id, documentId: "doc" });
    const completed = await item.manager.complete();
    assert.equal(completed.session.state, "completed");
    assert.equal(item.storage.getSnapshot().rewardLedger.some((entry) => entry.rewardType === "session-completion"), true);
});

test("abandoned sessions retain active rewards but receive no completion bonus", async () => {
    const item = await fixture();
    const session = await item.manager.start({ goalMinutes: 10, speciesId: "daisy-patch" });
    await item.engine.recordActiveReading({ milliseconds: 300000, sessionId: session.id, documentId: "doc" });
    const abandoned = await item.manager.abandon();
    assert.equal(abandoned.state, "abandoned");
    assert.equal(item.storage.getSnapshot().rewardLedger.some((entry) => entry.rewardType === "active-time"), true);
    assert.equal(item.storage.getSnapshot().rewardLedger.some((entry) => entry.rewardType === "session-completion"), false);
});

test("application restart restores an unfinished active session as paused", async () => {
    const first = await fixture();
    await first.manager.start({ goalMinutes: 10, speciesId: "daisy-patch" });
    const second = await fixture(first.backing);
    const restored = await second.manager.restore();
    assert.equal(restored.state, "paused");
    assert.equal(restored.pauseReason, "restore");
});

test("an explicit pause remains paused during automatic checks and records no time", async () => {
    const item = await fixture();
    const session = await item.manager.ensureAutomatic();
    await item.manager.pause();
    const pausedAt = item.manager.getCurrentSession().activeReadingMs;

    item.tracker.onDelta(60000);
    await item.manager.deltaQueue;
    const automaticCheck = await item.manager.ensureAutomatic();

    assert.equal(automaticCheck.id, session.id);
    assert.equal(automaticCheck.state, "paused");
    assert.equal(automaticCheck.pauseReason, "explicit");
    assert.equal(automaticCheck.activeReadingMs, pausedAt);
    assert.equal(item.tracker.paused, true);
});

test("an explicit pause survives application restart until Resume is selected", async () => {
    const first = await fixture();
    await first.manager.ensureAutomatic();
    await first.manager.pause();

    const second = await fixture(first.backing);
    const restored = await second.manager.restore();
    const automaticCheck = await second.manager.ensureAutomatic();

    assert.equal(restored.pauseReason, "explicit");
    assert.equal(automaticCheck.state, "paused");
    assert.equal(automaticCheck.pauseReason, "explicit");
    assert.equal(second.tracker.paused, true);
});

test("cross-tab storage lock excludes another owner until release", () => {
    const backing = new MemoryStorage();
    const intervals = [];
    const options = {
        storage: backing, BroadcastChannelClass: null, now: () => 1000,
        setIntervalFn: (callback) => { intervals.push(callback); return intervals.length; },
        clearIntervalFn: () => {},
    };
    const first = new CrossTabSessionLock({ ...options, ownerId: "one" });
    const second = new CrossTabSessionLock({ ...options, ownerId: "two" });
    assert.equal(first.acquire("session-one"), true);
    assert.equal(second.acquire("session-two"), false);
    first.release();
    assert.equal(second.acquire("session-two"), true);
});

test("cross-tab lock keeps native timer functions bound to the global timer host", () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const receivers = [];
    try {
        globalThis.setInterval = function () {
            receivers.push(this);
            return 42;
        };
        globalThis.clearInterval = function () {
            receivers.push(this);
        };
        const lock = new CrossTabSessionLock({
            storage: new MemoryStorage(),
            BroadcastChannelClass: null,
            ownerId: "timer-owner",
        });
        assert.equal(lock.acquire("timer-session"), true);
        lock.release();
        assert.deepEqual(receivers, [globalThis, globalThis]);
    } finally {
        globalThis.setInterval = originalSetInterval;
        globalThis.clearInterval = originalClearInterval;
    }
});

test("automatic reading starts a one-minute tree without setup and matures it at the goal", async () => {
    const item = await fixture();
    const session = await item.manager.ensureAutomatic();
    assert.equal(session.automatic, true);
    assert.equal(session.goalMs, 60000);
    const initialPlant = item.storage.getSnapshot().plants.find((plant) => plant.id === session.plantId);
    assert.equal(initialPlant.speciesId, "minute-sprout");

    await item.engine.recordActiveReading({
        milliseconds: session.goalMs,
        sessionId: session.id,
        documentId: "doc",
    });
    const completed = await item.manager.complete();
    assert.equal(completed.plant.stage, "mature");
    assert.equal(completed.placement.placed, true);
});

test("automatic sessions adopt catalog changes without manual reset", async () => {
    const item = await fixture();
    await item.manager.start({
        goalMinutes: 5,
        speciesId: "minute-sprout",
        automatic: true,
    });

    const synchronized = await item.manager.ensureAutomatic();
    assert.equal(synchronized.plantId, item.manager.getCurrentSession().plantId);
    assert.equal(synchronized.goalMs, 60000);
});
