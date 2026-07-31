import test from "node:test";
import assert from "node:assert/strict";
import { deterministicAvailableCell, GardenManager } from "../src/modules/rewards/gardenManager.js";
import {
    AUTOMATIC_TREE_DEFINITIONS,
    getAutomaticTreeTier,
    getPlantStage,
} from "../src/modules/rewards/plantDefinitions.js";
import {
    migrateRewardState,
    REWARD_SCHEMA_VERSION,
} from "../src/modules/rewards/rewardMigrations.js";
import { mergeRewardStates, relocateGardenConflicts } from "../src/modules/rewards/rewardStorage.js";
import { gardenPlantsForPeriod } from "../src/modules/ui/gardenDialog.js";

const config = { defaultGardenRows: 2, defaultGardenColumns: 2 };

test("plant stages transition at explicit thresholds and preserve excess points", () => {
    const manager = new GardenManager({ randomUUID: () => "plant-1" });
    const plant = manager.createPlant({
        speciesId: "daisy-patch",
        sessionId: "session",
        document: { id: "doc", type: "pdf" },
        timestamp: 1,
    });
    assert.equal(getPlantStage(plant.speciesId, 0).id, "seed");
    assert.equal(manager.invest(plant, 3).stage.id, "sprout");
    assert.equal(manager.invest(plant, 4).stage.id, "young");
    const final = manager.invest(plant, 20);
    assert.equal(final.stage.id, "mature");
    assert.equal(final.excess, 12);
    assert.equal(plant.pointsInvested, 15);
});

test("deterministic placement never overwrites and reports a full garden", () => {
    const plot = { id: "garden", rows: 2, columns: 2 };
    const plants = [
        { plotId: "garden", cell: { x: 0, y: 0 } },
        { plotId: "garden", cell: { x: 1, y: 0 } },
        { plotId: "garden", cell: { x: 0, y: 1 } },
    ];
    assert.deepEqual(deterministicAvailableCell(plot, plants), { x: 1, y: 1 });
    plants.push({ plotId: "garden", cell: { x: 1, y: 1 } });
    assert.equal(deterministicAvailableCell(plot, plants), null);
});

test("new trees use stable scattered garden positions", () => {
    const plot = { id: "garden", rows: 5, columns: 5 };
    const positions = Array.from({ length: 8 }, (_, index) =>
        deterministicAvailableCell(plot, [], `plant-${index}`),
    );
    assert.deepEqual(
        deterministicAvailableCell(plot, [], "plant-3"),
        deterministicAvailableCell(plot, [], "plant-3"),
    );
    assert.ok(new Set(positions.map((cell) => `${cell.x}:${cell.y}`)).size > 1);
});

test("sync cell conflicts relocate deterministically", () => {
    const plants = [
        { id: "a", plotId: "garden", cell: { x: 0, y: 0 }, completedAt: 1 },
        { id: "b", plotId: "garden", cell: { x: 0, y: 0 }, completedAt: 2 },
    ];
    relocateGardenConflicts(plants, [{ id: "garden", rows: 2, columns: 2 }]);
    assert.deepEqual(plants[0].cell, { x: 0, y: 0 });
    assert.deepEqual(plants[1].cell, { x: 1, y: 0 });
});

test("reward ledger merges by transaction ID without duplication", () => {
    const base = migrateRewardState(null, config, 1);
    const transaction = { id: "tx", rewardType: "active-time", points: 1, timestamp: 1, localDate: "2026-01-01", sessionId: "s", documentId: "d", deduplicationKey: "dedup", metadata: {} };
    const merged = mergeRewardStates(
        { ...base, rewardLedger: [transaction] },
        { ...base, rewardLedger: [transaction] },
        config,
        2,
    );
    assert.equal(merged.rewardLedger.length, 1);
    assert.equal(merged.gardenPlots.length, 1);
});

test("cross-device merge keeps one garden and both devices' trees", () => {
    const tree = (id, plotId, timestamp) => ({
        id,
        speciesId: "reading-sapling",
        stage: "mature",
        plotId,
        cell: { x: 0, y: 0 },
        plantedAt: timestamp,
        completedAt: timestamp,
        updatedAt: timestamp,
    });
    const merged = mergeRewardStates(
        {
            gardenPlots: [{ id: "local-garden", rows: 2, columns: 2, createdAt: 1 }],
            plants: [tree("local-tree", "local-garden", 1)],
        },
        {
            gardenPlots: [{ id: "remote-garden", rows: 2, columns: 2, createdAt: 2 }],
            plants: [tree("remote-tree", "remote-garden", 2)],
        },
        config,
        3,
    );
    assert.equal(merged.gardenPlots.length, 1);
    assert.equal(merged.plants.length, 2);
    assert.equal(merged.plants.every((plant) => plant.plotId === merged.gardenPlots[0].id), true);
    assert.equal(new Set(merged.plants.map((plant) => `${plant.cell.x}:${plant.cell.y}`)).size, 2);
});

test("schema migration repairs malformed persisted collections", () => {
    const migrated = migrateRewardState({
        schemaVersion: 0,
        rewardLedger: "bad",
        sessions: null,
        plants: [{ nope: true }],
        unallocatedGrowthPoints: -9,
    }, config, 1);
    assert.equal(migrated.schemaVersion, REWARD_SCHEMA_VERSION);
    assert.deepEqual(migrated.rewardLedger, []);
    assert.deepEqual(migrated.plants, []);
    assert.equal(migrated.unallocatedGrowthPoints, 0);
});

test("schema migration consolidates old plots into one garden without losing placed trees", () => {
    const migrated = migrateRewardState({
        schemaVersion: 1,
        gardenPlots: [
            { id: "garden-a", rows: 2, columns: 2, createdAt: 1, updatedAt: 1 },
            { id: "garden-b", rows: 2, columns: 2, createdAt: 2, updatedAt: 2 },
        ],
        plants: [
            { id: "tree-a", speciesId: "reading-sapling", stage: "mature", plotId: "garden-a", cell: { x: 0, y: 0 }, plantedAt: 1, completedAt: 2 },
            { id: "tree-b", speciesId: "reading-sapling", stage: "mature", plotId: "garden-b", cell: { x: 0, y: 0 }, plantedAt: 3, completedAt: 4 },
        ],
    }, config, 10);

    assert.equal(migrated.gardenPlots.length, 1);
    assert.equal(migrated.plants.every((plant) => plant.plotId === migrated.gardenPlots[0].id), true);
    assert.equal(new Set(migrated.plants.map((plant) => `${plant.cell.x}:${plant.cell.y}`)).size, 2);
});

test("garden manager never creates a second user garden", () => {
    const manager = new GardenManager({ randomUUID: () => "garden-new" });
    const state = migrateRewardState(null, config, 1);
    const original = state.gardenPlots[0];
    const result = manager.createPlot(state, {
        name: "Another garden",
        rows: 10,
        columns: 10,
        timestamp: 2,
    });
    assert.equal(result.id, original.id);
    assert.equal(state.gardenPlots.length, 1);
});

test("garden period views use local week, month, and year boundaries", () => {
    const now = new Date(2026, 6, 30, 12).getTime();
    const plants = [
        { id: "week", stage: "mature", completedAt: new Date(2026, 6, 27, 12).getTime() },
        { id: "month", stage: "mature", completedAt: new Date(2026, 6, 2, 12).getTime() },
        { id: "year", stage: "mature", completedAt: new Date(2026, 0, 5, 12).getTime() },
        { id: "past", stage: "mature", completedAt: new Date(2025, 11, 31, 12).getTime() },
    ];
    assert.deepEqual(gardenPlantsForPeriod(plants, "week", now, 1).map((plant) => plant.id), ["week"]);
    assert.deepEqual(gardenPlantsForPeriod(plants, "month", now, 1).map((plant) => plant.id), ["month", "week"]);
    assert.deepEqual(gardenPlantsForPeriod(plants, "year", now, 1).map((plant) => plant.id), ["year", "month", "week"]);
});

test("automatic tree catalog advances once per tree through consecutive minute goals", () => {
    const minuteTree = {
        id: "minute-1",
        speciesId: "minute-sprout",
        stage: "mature",
    };
    const sapling = {
        id: "sapling-1",
        speciesId: "reading-sapling",
        stage: "mature",
    };
    assert.equal(getAutomaticTreeTier([]).definition.durationMinutes, 1);
    assert.equal(getAutomaticTreeTier([minuteTree]).definition.durationMinutes, 5);
    const nextTier = getAutomaticTreeTier([minuteTree, sapling]);
    assert.equal(nextTier.definition.id, "aurora-pine");
    assert.equal(nextTier.definition.durationMinutes, 6);
    assert.deepEqual(
        AUTOMATIC_TREE_DEFINITIONS.slice(1).map((definition) => definition.durationMinutes),
        Array.from({ length: 24 }, (_, index) => index + 5),
    );
});

test("the final automatic tree keeps increasing its reading goal", () => {
    const completedEarlierTiers = AUTOMATIC_TREE_DEFINITIONS.slice(0, -1).map((definition, index) => ({
        id: `tree-${index}`,
        speciesId: definition.id,
        stage: "mature",
    }));
    const buriti = {
        id: "buriti-1",
        speciesId: "buriti-sun-palm",
        stage: "mature",
    };
    const secondBuriti = { ...buriti, id: "buriti-2" };
    const thirdBuriti = { ...buriti, id: "buriti-3" };

    assert.equal(getAutomaticTreeTier(completedEarlierTiers).definition.durationMinutes, 28);
    assert.equal(getAutomaticTreeTier([...completedEarlierTiers, buriti]).definition.durationMinutes, 29);
    assert.equal(getAutomaticTreeTier([...completedEarlierTiers, buriti, secondBuriti]).definition.durationMinutes, 30);
    assert.equal(
        getAutomaticTreeTier([...completedEarlierTiers, buriti, secondBuriti, thirdBuriti]).definition.durationMinutes,
        30,
    );
});
