import test from "node:test";
import assert from "node:assert/strict";
import { deterministicAvailableCell, GardenManager } from "../src/modules/rewards/gardenManager.js";
import { getPlantStage } from "../src/modules/rewards/plantDefinitions.js";
import { migrateRewardState } from "../src/modules/rewards/rewardMigrations.js";
import { mergeRewardStates, relocateGardenConflicts } from "../src/modules/rewards/rewardStorage.js";

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
});

test("schema migration repairs malformed persisted collections", () => {
    const migrated = migrateRewardState({
        schemaVersion: 0,
        rewardLedger: "bad",
        sessions: null,
        plants: [{ nope: true }],
        unallocatedGrowthPoints: -9,
    }, config, 1);
    assert.equal(migrated.schemaVersion, 1);
    assert.deepEqual(migrated.rewardLedger, []);
    assert.deepEqual(migrated.plants, []);
    assert.equal(migrated.unallocatedGrowthPoints, 0);
});
