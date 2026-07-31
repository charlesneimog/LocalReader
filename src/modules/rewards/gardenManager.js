import { getPlantDefinition, getPlantStage } from "./plantDefinitions.js";
import { uuid } from "./rewardDefinitions.js";

export function deterministicAvailableCell(plot, plants) {
    const occupied = new Set(
        plants
            .filter((plant) => plant.plotId === plot.id && plant.cell)
            .map((plant) => `${plant.cell.x}:${plant.cell.y}`),
    );
    for (let diagonal = 0; diagonal <= plot.rows + plot.columns - 2; diagonal++) {
        for (let y = 0; y < plot.rows; y++) {
            const x = diagonal - y;
            if (x >= 0 && x < plot.columns && !occupied.has(`${x}:${y}`)) return { x, y };
        }
    }
    return null;
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
        const cell = plot ? deterministicAvailableCell(plot, state.plants) : null;
        if (cell) {
            plant.plotId = plot.id;
            plant.cell = cell;
            plant.updatedAt = timestamp;
            return { placed: true, plotId: plot.id, cell };
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
