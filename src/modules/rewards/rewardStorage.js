import { createInitialRewardState, migrateRewardState } from "./rewardMigrations.js";

function newestById(left = [], right = []) {
    const entities = new Map();
    for (const entity of [...left, ...right]) {
        if (!entity?.id) continue;
        const previous = entities.get(entity.id);
        if (!previous || Number(entity.updatedAt || entity.timestamp || 0) >= Number(previous.updatedAt || previous.timestamp || 0)) {
            entities.set(entity.id, structuredCloneSafe(entity));
        }
    }
    return [...entities.values()];
}

function structuredCloneSafe(value) {
    return typeof structuredClone === "function"
        ? structuredClone(value)
        : JSON.parse(JSON.stringify(value));
}

export function mergeRewardStates(localInput, remoteInput, config = {}, now = Date.now()) {
    const local = migrateRewardState(localInput, config, now);
    const remote = migrateRewardState(remoteInput, config, now);
    const ledger = new Map();
    for (const transaction of [...local.rewardLedger, ...remote.rewardLedger]) {
        if (transaction?.id && !ledger.has(transaction.id)) ledger.set(transaction.id, structuredCloneSafe(transaction));
    }
    const rewardLedger = [...ledger.values()].sort(
        (left, right) => Number(left.timestamp) - Number(right.timestamp) || left.id.localeCompare(right.id),
    );
    const plants = newestById(local.plants, remote.plants);
    const gardenPlots = newestById(local.gardenPlots, remote.gardenPlots);
    relocateGardenConflicts(plants, gardenPlots);
    const currentSessionCandidates = [local.currentSession, remote.currentSession].filter(Boolean);
    const currentSession = currentSessionCandidates.sort(
        (left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0),
    )[0] || null;

    return migrateRewardState({
        ...local,
        updatedAt: Math.max(Number(local.updatedAt) || 0, Number(remote.updatedAt) || 0, now),
        totalActiveReadingMs: Math.max(
            Number(local.totalActiveReadingMs) || 0,
            Number(remote.totalActiveReadingMs) || 0,
        ),
        activeTimeByDay: mergeMaxMap(local.activeTimeByDay, remote.activeTimeByDay),
        activeTimeByDocument: mergeMaxMap(local.activeTimeByDocument, remote.activeTimeByDocument),
        timeRewardRemainderMs: Math.max(
            Number(local.timeRewardRemainderMs) || 0,
            Number(remote.timeRewardRemainderMs) || 0,
        ),
        rewardLedger,
        sessions: newestById(local.sessions, remote.sessions),
        currentSession,
        gardenPlots,
        plants,
        plantUnlocks: [...new Set([...local.plantUnlocks, ...remote.plantUnlocks])],
        weeklyConsistency: mergeWeekly(local.weeklyConsistency, remote.weeklyConsistency),
        reflections: newestById(local.reflections, remote.reflections),
        // This is corrected by RewardEngine after merge from ledger allocations.
        unallocatedGrowthPoints: Math.max(
            Number(local.unallocatedGrowthPoints) || 0,
            Number(remote.unallocatedGrowthPoints) || 0,
        ),
        lastValidReadingTimestamp: Math.max(
            Number(local.lastValidReadingTimestamp) || 0,
            Number(remote.lastValidReadingTimestamp) || 0,
        ) || null,
        dailyRewardCaps: mergeDailyCaps(local.dailyRewardCaps, remote.dailyRewardCaps),
    }, config, now);
}

function mergeMaxMap(left, right) {
    const result = {};
    for (const key of new Set([...Object.keys(left || {}), ...Object.keys(right || {})])) {
        result[key] = Math.max(Number(left?.[key]) || 0, Number(right?.[key]) || 0);
    }
    return result;
}

function mergeDailyCaps(left, right) {
    const result = {};
    for (const key of new Set([...Object.keys(left || {}), ...Object.keys(right || {})])) {
        result[key] = {
            time: Math.max(Number(left?.[key]?.time) || 0, Number(right?.[key]?.time) || 0),
            engagement: Math.max(Number(left?.[key]?.engagement) || 0, Number(right?.[key]?.engagement) || 0),
        };
    }
    return result;
}

function mergeWeekly(left, right) {
    const result = {};
    for (const key of new Set([...Object.keys(left || {}), ...Object.keys(right || {})])) {
        const leftWeek = left?.[key] || {};
        const rightWeek = right?.[key] || {};
        result[key] = {
            days: [...new Set([...(leftWeek.days || []), ...(rightWeek.days || [])])].sort(),
            awardedTierDays: Math.max(Number(leftWeek.awardedTierDays) || 0, Number(rightWeek.awardedTierDays) || 0),
            updatedAt: Math.max(Number(leftWeek.updatedAt) || 0, Number(rightWeek.updatedAt) || 0),
        };
    }
    return result;
}

export function relocateGardenConflicts(plants, plots) {
    const plotMap = new Map(plots.map((plot) => [plot.id, plot]));
    const occupied = new Map();
    const sorted = [...plants].sort(
        (left, right) => Number(left.completedAt || left.plantedAt || 0) - Number(right.completedAt || right.plantedAt || 0) || left.id.localeCompare(right.id),
    );
    for (const plant of sorted) {
        if (!plant.cell || !plant.plotId) continue;
        const plot = plotMap.get(plant.plotId);
        if (!plot) {
            plant.cell = null;
            continue;
        }
        const used = occupied.get(plot.id) || new Set();
        const requested = `${plant.cell.x}:${plant.cell.y}`;
        if (isValidCell(plant.cell, plot) && !used.has(requested)) {
            used.add(requested);
            occupied.set(plot.id, used);
            continue;
        }
        const next = firstAvailableCell(plot, used);
        plant.cell = next;
        if (next) used.add(`${next.x}:${next.y}`);
        occupied.set(plot.id, used);
    }
}

function isValidCell(cell, plot) {
    return Number.isInteger(cell?.x) && Number.isInteger(cell?.y) &&
        cell.x >= 0 && cell.y >= 0 && cell.x < plot.columns && cell.y < plot.rows;
}

function firstAvailableCell(plot, occupied) {
    for (let diagonal = 0; diagonal <= plot.rows + plot.columns - 2; diagonal++) {
        for (let y = 0; y < plot.rows; y++) {
            const x = diagonal - y;
            if (x < 0 || x >= plot.columns) continue;
            if (!occupied.has(`${x}:${y}`)) return { x, y };
        }
    }
    return null;
}

/**
 * Versioned local reward persistence. Writes are serialized so session commits
 * cannot interleave within one tab.
 */
export class RewardStorage {
    constructor({ storage = globalThis.localStorage, storageKey, config = {}, now = Date.now } = {}) {
        this.storage = storage;
        this.storageKey = storageKey || "localreader.readingRewards";
        this.config = config;
        this.now = now;
        this.state = null;
        this.writeQueue = Promise.resolve();
    }

    async load() {
        let parsed = null;
        try {
            const raw = this.storage?.getItem?.(this.storageKey);
            parsed = raw ? JSON.parse(raw) : null;
        } catch (error) {
            console.warn("[RewardStorage] Malformed reward data; a safe state was restored", error);
        }
        this.state = migrateRewardState(parsed, this.config, this.now());
        await this.save(this.state);
        return structuredCloneSafe(this.state);
    }

    getSnapshot() {
        if (!this.state) this.state = createInitialRewardState(this.config, this.now());
        return structuredCloneSafe(this.state);
    }

    async transaction(mutator) {
        let result;
        this.writeQueue = this.writeQueue.then(async () => {
            const draft = this.getSnapshot();
            result = await mutator(draft);
            draft.updatedAt = this.now();
            this.state = migrateRewardState(draft, this.config, this.now());
            await this.save(this.state);
        });
        await this.writeQueue;
        return result;
    }

    async replace(snapshot) {
        return this.transaction((draft) => {
            const migrated = migrateRewardState(snapshot, this.config, this.now());
            for (const key of Object.keys(draft)) delete draft[key];
            Object.assign(draft, migrated);
        });
    }

    async merge(remoteSnapshot) {
        const merged = mergeRewardStates(this.getSnapshot(), remoteSnapshot, this.config, this.now());
        await this.replace(merged);
        return this.getSnapshot();
    }

    async save(state) {
        try {
            this.storage?.setItem?.(this.storageKey, JSON.stringify(state));
        } catch (error) {
            console.error("[RewardStorage] Reward checkpoint could not be persisted", error);
            throw error;
        }
    }
}
