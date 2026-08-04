import treeCatalog from "../../../assets/rewards/trees/catalog.json" with { type: "json" };
import { CONFIG } from "../../config.js";

/**
 * @typedef {Object} GardenPlant
 * @property {string} id
 * @property {string} speciesId
 * @property {string} stage
 * @property {number} pointsInvested
 * @property {?string} plotId
 * @property {?{x:number,y:number}} cell
 * @property {number} plantedAt
 * @property {?number} completedAt
 * @property {?string} sourceDocumentId
 * @property {?string} sourceDocumentType
 * @property {string} sessionId
 * @property {?string} reflectionId
 */

/**
 * @typedef {Object} GardenPlot
 * @property {string} id
 * @property {string} name
 * @property {number} rows
 * @property {number} columns
 * @property {number} createdAt
 * @property {number} updatedAt
 */

const STAGES = Object.freeze([
    Object.freeze({ id: "seed", threshold: 0, label: "Seed" }),
    Object.freeze({ id: "sprout", threshold: 0.2, label: "Sprout" }),
    Object.freeze({ id: "young", threshold: 0.45, label: "Young plant" }),
    Object.freeze({ id: "flowering", threshold: 0.75, label: "Flowering plant" }),
    Object.freeze({ id: "mature", threshold: 1, label: "Mature plant" }),
]);

const plant = (definition) => Object.freeze({ ...definition, stages: STAGES });

export const AUTOMATIC_TREE_DEFINITIONS = Object.freeze(
    treeCatalog.trees.map((definition) => plant({
        ...definition,
        automatic: true,
        durationMinutes: CONFIG.REWARDS.treePlantingIntervalMinutes,
        requiredPoints: Number(definition.requiredPoints) || 15,
        unlockPoints: 0,
    })),
);

const LEGACY_PLANT_DEFINITIONS = [
    plant({ id: "daisy-patch", name: "Daisy Patch", rarity: "common", requiredPoints: 15, unlockPoints: 0, palette: ["#fffaf0", "#f6b93b", "#4d9b62"] }),
    plant({ id: "lavender", name: "Lavender", rarity: "common", requiredPoints: 18, unlockPoints: 20, palette: ["#9b87db", "#6554a4", "#4f8d64"] }),
    plant({ id: "fern", name: "Silver Fern", rarity: "uncommon", requiredPoints: 20, unlockPoints: 45, palette: ["#9ed49a", "#3f8158", "#285b45"] }),
    plant({ id: "sunflower", name: "Sunwheel", rarity: "uncommon", requiredPoints: 24, unlockPoints: 75, palette: ["#f8c74f", "#7d532a", "#4c9660"] }),
    plant({ id: "hydrangea", name: "Cloud Hydrangea", rarity: "rare", requiredPoints: 28, unlockPoints: 120, palette: ["#77a9dd", "#a683cc", "#477957"] }),
    plant({ id: "flowering-tree", name: "Blossom Lantern Tree", rarity: "rare", requiredPoints: 34, unlockPoints: 180, palette: ["#f3a7ba", "#815b45", "#39704c"] }),
];

export const PLANT_DEFINITIONS = Object.freeze([
    ...AUTOMATIC_TREE_DEFINITIONS,
    ...LEGACY_PLANT_DEFINITIONS,
]);

export function getPlantDefinition(speciesId) {
    return PLANT_DEFINITIONS.find((definition) => definition.id === speciesId) || PLANT_DEFINITIONS[0];
}

export function getPlantStage(speciesId, pointsInvested, progressOverride = null) {
    const definition = getPlantDefinition(speciesId);
    const hasProgressOverride =
        progressOverride !== null &&
        progressOverride !== undefined &&
        Number.isFinite(Number(progressOverride));
    const rawProgress = hasProgressOverride
        ? Number(progressOverride)
        : (Number(pointsInvested) || 0) / definition.requiredPoints;
    const progress = Math.max(0, Math.min(1, rawProgress));
    let stage = definition.stages[0];
    for (const candidate of definition.stages) {
        if (progress >= candidate.threshold) stage = candidate;
    }
    return { ...stage, progress, percent: Math.floor(progress * 100) };
}

export function getAutomaticTreeDurationSeconds(plants = []) {
    const automaticSpecies = new Set(AUTOMATIC_TREE_DEFINITIONS.map((definition) => definition.id));
    const completedTrees = plants.filter(
        (candidate) => automaticSpecies.has(candidate.speciesId) && candidate.stage === "mature",
    ).length;
    const baseSeconds = Math.max(
        1,
        Math.round(Number(CONFIG.REWARDS.treePlantingIntervalMinutes) * 60),
    );
    const incrementSeconds = Math.max(
        0,
        Number(CONFIG.REWARDS.treePlantingIncrementSeconds) || 0,
    );
    const configuredMaximumSeconds = Number(CONFIG.REWARDS.treePlantingMaximumMinutes) * 60;
    const maximumSeconds = Number.isFinite(configuredMaximumSeconds) && configuredMaximumSeconds > 0
        ? Math.max(baseSeconds, configuredMaximumSeconds)
        : Number.POSITIVE_INFINITY;
    return Math.min(maximumSeconds, baseSeconds + (completedTrees * incrementSeconds));
}

function withCurrentAutomaticDuration(definition, plants) {
    const durationSeconds = getAutomaticTreeDurationSeconds(plants);
    return Object.freeze({
        ...definition,
        durationSeconds,
        durationMinutes: durationSeconds / 60,
    });
}

/**
 * Select the first tree tier whose configured completion requirement has not
 * yet been met. The last tier repeats indefinitely when its requirement is null.
 */
export function getAutomaticTreeTier(plants = []) {
    for (let index = 0; index < AUTOMATIC_TREE_DEFINITIONS.length; index++) {
        const definition = AUTOMATIC_TREE_DEFINITIONS[index];
        const completed = plants.filter(
            (candidate) => candidate.speciesId === definition.id && candidate.stage === "mature",
        ).length;
        const required = Number(definition.requiredCompletions);
        if (!Number.isFinite(required) || required <= 0 || completed < required) {
            const activeDefinition = withCurrentAutomaticDuration(definition, plants);
            return {
                definition: activeDefinition,
                index,
                completed,
                required: Number.isFinite(required) && required > 0 ? required : null,
                remaining: Number.isFinite(required) && required > 0 ? Math.max(0, required - completed) : null,
                next: AUTOMATIC_TREE_DEFINITIONS[index + 1] || null,
            };
        }
    }
    const definition = withCurrentAutomaticDuration(AUTOMATIC_TREE_DEFINITIONS.at(-1), plants);
    return { definition, index: AUTOMATIC_TREE_DEFINITIONS.length - 1, completed: 0, required: null, remaining: null, next: null };
}

export function availablePlantDefinitions(totalEarnedPoints, unlocks = []) {
    const unlocked = new Set(unlocks);
    return PLANT_DEFINITIONS.map((definition) => ({
        ...definition,
        locked: definition.unlockPoints > totalEarnedPoints && !unlocked.has(definition.id),
    }));
}
