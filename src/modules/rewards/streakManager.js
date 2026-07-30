import { localDateKey, startOfLocalWeek, WEEKLY_TIERS } from "./rewardDefinitions.js";

export function recordReadingDay(state, timestamp, weekStartsOn = 1) {
    const weekKey = startOfLocalWeek(timestamp, weekStartsOn);
    const dateKey = localDateKey(timestamp);
    const week = state.weeklyConsistency[weekKey] || { days: [], awardedTierDays: 0, updatedAt: timestamp };
    week.days = [...new Set([...week.days, dateKey])].sort();
    week.updatedAt = timestamp;
    state.weeklyConsistency[weekKey] = week;
    return { weekKey, week };
}

export function highestWeeklyTier(dayCount, tiers = WEEKLY_TIERS) {
    return tiers.find((tier) => dayCount >= tier.days) || null;
}

/** Local-calendar weekly consistency calculator. */
export class StreakManager {
    constructor({ weekStartsOn = 1 } = {}) {
        this.weekStartsOn = weekStartsOn;
    }

    record(state, timestamp) {
        const { weekKey, week } = recordReadingDay(state, timestamp, this.weekStartsOn);
        const tier = highestWeeklyTier(week.days.length);
        if (!tier || tier.days <= week.awardedTierDays) return { weekKey, week, award: null };
        const previous = WEEKLY_TIERS.find((candidate) => candidate.days === week.awardedTierDays);
        const award = {
            tierDays: tier.days,
            // Award only the incremental difference so the highest tier total is
            // exactly 5/10/12 points for the week.
            points: tier.points - (previous?.points || 0),
        };
        week.awardedTierDays = tier.days;
        return { weekKey, week, award };
    }

    current(state, timestamp = Date.now()) {
        const weekKey = startOfLocalWeek(timestamp, this.weekStartsOn);
        return state.weeklyConsistency[weekKey] || { days: [], awardedTierDays: 0 };
    }
}
