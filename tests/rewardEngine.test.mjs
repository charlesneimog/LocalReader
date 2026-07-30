import test from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../src/core/eventBus.js";
import { GardenManager } from "../src/modules/rewards/gardenManager.js";
import { RewardEngine } from "../src/modules/rewards/rewardEngine.js";
import { REWARD_TYPES, elapsedLocalCalendarDays, startOfLocalWeek } from "../src/modules/rewards/rewardDefinitions.js";
import { RewardStorage } from "../src/modules/rewards/rewardStorage.js";
import { StreakManager } from "../src/modules/rewards/streakManager.js";

const config = {
    schemaVersion: 1,
    defaultGardenRows: 2,
    defaultGardenColumns: 2,
    timeRewardIntervalMinutes: 5,
    timeRewardPoints: 1,
    dailyTimeRewardCap: 12,
    dailyEngagementRewardCap: 10,
    sessionCompletionPoints: 4,
    reflectionPoints: 5,
    annotationWithNotePoints: 3,
    questionPoints: 3,
    recoveryAfterDays: 7,
    recoveryPoints: 5,
    weekStartsOn: 1,
};

class MemoryStorage {
    getItem() { return this.value || null; }
    setItem(_key, value) { this.value = value; }
}

async function fixture() {
    let sequence = 0;
    const storage = new RewardStorage({ storage: new MemoryStorage(), config, now: () => Date.now() });
    await storage.load();
    const gardenManager = new GardenManager({ randomUUID: () => `plant-${++sequence}` });
    const engine = new RewardEngine({
        storage,
        gardenManager,
        streakManager: new StreakManager({ weekStartsOn: 1 }),
        eventBus: new EventBus(),
        config,
        randomUUID: () => `tx-${++sequence}`,
    });
    const timestamp = new Date(2026, 6, 6, 12).getTime();
    await storage.transaction((state) => {
        const document = { id: "doc-1", type: "pdf", title: "Book" };
        const plant = gardenManager.createPlant({ speciesId: "daisy-patch", sessionId: "session-1", document, timestamp });
        state.plants.push(plant);
        state.sessions.push({
            id: "session-1", state: "active", goalMs: 600000, activeReadingMs: 0,
            document, plantId: plant.id, updatedAt: timestamp,
        });
        state.currentSession = { ...state.sessions[0] };
    });
    return { storage, engine, timestamp };
}

test("partial five-minute intervals persist without rounding up", async () => {
    const { storage, engine, timestamp } = await fixture();
    await engine.recordActiveReading({ milliseconds: 299999, sessionId: "session-1", documentId: "doc-1", timestamp });
    assert.equal(storage.getSnapshot().rewardLedger.length, 0);
    await engine.recordActiveReading({ milliseconds: 1, sessionId: "session-1", documentId: "doc-1", timestamp });
    assert.equal(storage.getSnapshot().rewardLedger.filter((item) => item.rewardType === REWARD_TYPES.ACTIVE_TIME).length, 1);
});

test("time rewards stop at the daily cap and duplicate facts are idempotent", async () => {
    const { storage, engine, timestamp } = await fixture();
    await engine.recordActiveReading({ milliseconds: 20 * 60 * 60000, sessionId: "session-1", documentId: "doc-1", timestamp });
    const activePoints = storage.getSnapshot().rewardLedger
        .filter((item) => item.rewardType === REWARD_TYPES.ACTIVE_TIME)
        .reduce((sum, item) => sum + item.points, 0);
    assert.equal(activePoints, 12);
    await engine.grant({ rewardType: REWARD_TYPES.QUESTION, points: 3, timestamp, sessionId: "session-1", documentId: "doc-1", deduplicationKey: "same" });
    await engine.grant({ rewardType: REWARD_TYPES.QUESTION, points: 3, timestamp, sessionId: "session-1", documentId: "doc-1", deduplicationKey: "same" });
    assert.equal(storage.getSnapshot().rewardLedger.filter((item) => item.deduplicationKey === "same").length, 1);
});

test("engagement rewards are capped and annotations/reflections deduplicate", async () => {
    const { storage, engine, timestamp } = await fixture();
    await engine.grantEngagement({ rewardType: REWARD_TYPES.REFLECTION, sessionId: "session-1", documentId: "doc-1", entityId: "reflection-1", timestamp });
    await engine.grantEngagement({ rewardType: REWARD_TYPES.REFLECTION, sessionId: "session-1", documentId: "doc-1", entityId: "reflection-1", timestamp });
    await engine.grantEngagement({ rewardType: REWARD_TYPES.ANNOTATION_WITH_NOTE, sessionId: "session-1", documentId: "doc-1", entityId: "annotation-1", timestamp });
    await engine.grantEngagement({ rewardType: REWARD_TYPES.ANNOTATION_WITH_NOTE, sessionId: "session-1", documentId: "doc-1", entityId: "annotation-1", timestamp });
    await engine.grantEngagement({ rewardType: REWARD_TYPES.QUESTION, sessionId: "session-1", documentId: "doc-1", entityId: "question-1", timestamp });
    const engagement = storage.getSnapshot().rewardLedger
        .filter((item) => [REWARD_TYPES.REFLECTION, REWARD_TYPES.ANNOTATION_WITH_NOTE, REWARD_TYPES.QUESTION].includes(item.rewardType));
    assert.equal(engagement.reduce((sum, item) => sum + item.points, 0), 10);
    assert.equal(engagement.length, 3);
});

test("weekly tiers award only incremental points and roll over", async () => {
    const { storage, engine, timestamp } = await fixture();
    for (const offset of [0, 1, 2, 3, 4, 5]) {
        await engine.recordActiveReading({
            milliseconds: 1000,
            sessionId: "session-1",
            documentId: "doc-1",
            timestamp: timestamp + offset * 86400000,
        });
    }
    const weekly = storage.getSnapshot().rewardLedger.filter((item) => item.rewardType === REWARD_TYPES.WEEKLY_CONSISTENCY);
    assert.equal(weekly.reduce((sum, item) => sum + item.points, 0), 12);
    await engine.recordActiveReading({ milliseconds: 1000, sessionId: "session-1", documentId: "doc-1", timestamp: timestamp + 7 * 86400000 });
    assert.equal(Object.keys(storage.getSnapshot().weeklyConsistency).length, 2);
});

test("local calendar calculations handle DST-style offsets and Monday weeks", () => {
    const before = new Date("2026-10-31T23:30:00-03:00").getTime();
    const after = new Date("2026-11-07T23:30:00-02:00").getTime();
    assert.equal(elapsedLocalCalendarDays(before, after), 7);
    const monday = new Date(2026, 6, 6, 12).getTime();
    assert.match(startOfLocalWeek(monday, 1), /2026-07-06/);
});

test("recovery reward is granted once after seven local calendar days", async () => {
    const { storage, engine, timestamp } = await fixture();
    const transaction = await engine.grantRecoveryIfEligible({
        sessionId: "session-1",
        documentId: "doc-1",
        previousTimestamp: timestamp - 7 * 86400000,
        timestamp,
    });
    assert.equal(transaction.points, 5);
    await engine.grantRecoveryIfEligible({
        sessionId: "session-1",
        documentId: "doc-1",
        previousTimestamp: timestamp - 8 * 86400000,
        timestamp,
    });
    assert.equal(storage.getSnapshot().rewardLedger.filter((item) => item.rewardType === REWARD_TYPES.RECOVERY).length, 1);
});
