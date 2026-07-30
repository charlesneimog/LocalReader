import { localDateKey } from "./rewardDefinitions.js";

export const REWARD_SCHEMA_VERSION = 1;

export function createInitialRewardState(config = {}, now = Date.now()) {
    const rows = Math.max(1, Number(config.defaultGardenRows) || 5);
    const columns = Math.max(1, Number(config.defaultGardenColumns) || 5);
    return {
        schemaVersion: REWARD_SCHEMA_VERSION,
        migrationVersion: REWARD_SCHEMA_VERSION,
        updatedAt: now,
        totalActiveReadingMs: 0,
        activeTimeByDay: {},
        activeTimeByDocument: {},
        timeRewardRemainderMs: 0,
        rewardLedger: [],
        sessions: [],
        currentSession: null,
        gardenPlots: [{
            id: "garden-1",
            name: "Reading Garden",
            rows,
            columns,
            createdAt: now,
            updatedAt: now,
        }],
        plants: [],
        currentGrowingPlantId: null,
        plantUnlocks: ["minute-sprout", "reading-sapling", "daisy-patch"],
        weeklyConsistency: {},
        reflections: [],
        unallocatedGrowthPoints: 0,
        lastValidReadingTimestamp: null,
        dailyRewardCaps: {},
        createdLocalDate: localDateKey(now),
    };
}

export function migrateRewardState(input, config = {}, now = Date.now()) {
    const fallback = createInitialRewardState(config, now);
    if (!input || typeof input !== "object" || Array.isArray(input)) return fallback;
    const result = { ...fallback, ...input };
    for (const key of ["activeTimeByDay", "activeTimeByDocument", "weeklyConsistency", "dailyRewardCaps"]) {
        if (!result[key] || typeof result[key] !== "object" || Array.isArray(result[key])) result[key] = {};
    }
    for (const key of ["rewardLedger", "sessions", "gardenPlots", "plants", "plantUnlocks", "reflections"]) {
        if (!Array.isArray(result[key])) result[key] = fallback[key];
    }
    result.rewardLedger = result.rewardLedger.filter((entry) => entry && entry.id && entry.deduplicationKey);
    result.sessions = result.sessions.filter((entry) => entry && entry.id);
    result.plants = result.plants.filter((entry) => entry && entry.id && entry.speciesId);
    result.reflections = result.reflections.filter((entry) => entry && entry.id && entry.sessionId);
    result.schemaVersion = REWARD_SCHEMA_VERSION;
    result.migrationVersion = REWARD_SCHEMA_VERSION;
    result.unallocatedGrowthPoints = Math.max(0, Number(result.unallocatedGrowthPoints) || 0);
    result.timeRewardRemainderMs = Math.max(0, Number(result.timeRewardRemainderMs) || 0);
    return result;
}
