import { getPlantDefinition, getPlantStage } from "./plantDefinitions.js";
import { uuid } from "./rewardDefinitions.js";

function stableHash(value) {
    let hash = 2166136261;
    for (const character of String(value || "")) {
        hash ^= character.codePointAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

/**
 * Selects an available cell from a stable shuffled order.
 *
 * A plant ID is used as the seed so newly completed trees are visually
 * distributed around the garden while placement remains reproducible after
 * reloads and synchronization.
 */
export function deterministicAvailableCell(plot, plants, seed = "") {
    const occupied = new Set(
        plants
            .filter((plant) => !plant.deletedAt && plant.plotId === plot.id && plant.cell)
            .map((plant) => `${plant.cell.x}:${plant.cell.y}`),
    );
    const available = [];
    for (let diagonal = 0; diagonal <= plot.rows + plot.columns - 2; diagonal++) {
        for (let y = 0; y < plot.rows; y++) {
            const x = diagonal - y;
            if (x >= 0 && x < plot.columns && !occupied.has(`${x}:${y}`)) available.push({ x, y });
        }
    }
    if (!available.length) return null;
    if (!seed) return available[0];
    available.sort((left, right) => {
        const leftOrder = stableHash(`${seed}:${left.x}:${left.y}`);
        const rightOrder = stableHash(`${seed}:${right.x}:${right.y}`);
        return leftOrder - rightOrder || left.y - right.y || left.x - right.x;
    });
    return available[0];
}

/** Pure garden entity creation, investment, and deterministic placement API. */
export class GardenManager {
    constructor({ randomUUID } = {}) {
        this.randomUUID = randomUUID;
    }

    createPlant({ speciesId, sessionId, document, timestamp = Date.now() }) {
        const definition = getPlantDefinition(speciesId);
        return {
            id: uuid(this.randomUUID),
            speciesId: definition.id,
            rarity: definition.rarity,
            requiredPoints: definition.requiredPoints,
            durationMinutes: Number(definition.durationMinutes) || null,
            stage: "seed",
            pointsInvested: 0,
            growthProgress: definition.automatic ? 0 : null,
            plotId: null,
            cell: null,
            plantedAt: timestamp,
            completedAt: null,
            sourceDocumentId: document?.id || null,
            sourceDocumentType: document?.type || null,
            sessionId,
            reflectionId: null,
            updatedAt: timestamp,
        };
    }

    invest(plant, points, timestamp = Date.now()) {
        const definition = getPlantDefinition(plant.speciesId);
        const capacity = Math.max(0, definition.requiredPoints - plant.pointsInvested);
        const invested = Math.min(capacity, Math.max(0, Number(points) || 0));
        plant.pointsInvested += invested;
        const previousStage = plant.stage;
        const stage = getPlantStage(plant.speciesId, plant.pointsInvested, plant.growthProgress);
        plant.stage = stage.id;
        plant.updatedAt = timestamp;
        if (stage.id === "mature" && !plant.completedAt) plant.completedAt = timestamp;
        return {
            invested,
            excess: Math.max(0, (Number(points) || 0) - invested),
            stage,
            stageChanged: previousStage !== stage.id,
            matured: stage.id === "mature",
        };
    }

    placeMaturePlant(state, plant, timestamp = Date.now()) {
        if (plant.stage !== "mature") return { placed: false, reason: "not-mature" };
        if (plant.cell) return { placed: true, plotId: plant.plotId, cell: plant.cell };
        const plot = state.gardenPlots[0];
        if (!plot) return { placed: false, reason: "missing-garden" };
        let cell = deterministicAvailableCell(plot, state.plants, plant.id);
        let expanded = false;
        if (!cell) {
            // Preserve the garden width and add the smallest useful unit: one
            // row. This keeps every mature tree visible without imposing a
            // fixed maximum capacity.
            plot.rows = Math.max(1, Number(plot.rows) || 1) + 1;
            plot.updatedAt = timestamp;
            expanded = true;
            cell = deterministicAvailableCell(plot, state.plants, plant.id);
        }
        if (cell) {
            plant.plotId = plot.id;
            plant.cell = cell;
            plant.updatedAt = timestamp;
            return { placed: true, plotId: plot.id, cell, expanded };
        }
        return { placed: false, reason: "garden-full" };
    }

    createPlot(state, { name, rows, columns, timestamp = Date.now() }) {
        if (state.gardenPlots[0]) return state.gardenPlots[0];
        const plot = {
            id: "garden-1",
            name: String(name || "Reading Garden"),
            rows: Math.max(1, Math.floor(rows)),
            columns: Math.max(1, Math.floor(columns)),
            createdAt: timestamp,
            updatedAt: timestamp,
        };
        state.gardenPlots = [plot];
        return plot;
    }
}
