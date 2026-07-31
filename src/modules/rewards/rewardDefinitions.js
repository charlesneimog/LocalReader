/**
 * @typedef {Object} RewardTransaction
 * @property {string} id
 * @property {string} rewardType
 * @property {number} points
 * @property {number} timestamp UTC epoch milliseconds
 * @property {string} localDate Local calendar date captured at event time
 * @property {?string} sessionId
 * @property {?string} documentId
 * @property {string} deduplicationKey
 * @property {Object} metadata
 */

/**
 * @typedef {Object} ReadingSession
 * @property {string} id
 * @property {string} state
 * @property {number} goalMs
 * @property {number} activeReadingMs
 * @property {Object} document Normalized PDF or EPUB descriptor
 * @property {string} plantId
 * @property {number} updatedAt
 */

export const REWARD_TYPES = Object.freeze({
    ACTIVE_TIME: "active-time",
    SESSION_COMPLETION: "session-completion",
    REFLECTION: "reflection",
    ANNOTATION_WITH_NOTE: "annotation-with-note",
    QUESTION: "question",
    WEEKLY_CONSISTENCY: "weekly-consistency",
    RECOVERY: "recovery",
});

export const SESSION_STATES = Object.freeze({
    IDLE: "idle",
    PREPARING: "preparing",
    ACTIVE: "active",
    PAUSED: "paused",
    IDLE_TIMEOUT: "idle-timeout",
    COMPLETED: "completed",
    ABANDONED: "abandoned",
});

export const ENGAGEMENT_REWARD_TYPES = Object.freeze([
    REWARD_TYPES.REFLECTION,
    REWARD_TYPES.ANNOTATION_WITH_NOTE,
    REWARD_TYPES.QUESTION,
]);

export const WEEKLY_TIERS = Object.freeze([
    Object.freeze({ days: 6, points: 12 }),
    Object.freeze({ days: 5, points: 10 }),
    Object.freeze({ days: 3, points: 5 }),
]);

export function uuid(randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto)) {
    if (randomUUID) return randomUUID();
    const bytes = new Uint8Array(16);
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
    else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

export function localDateKey(timestamp = Date.now()) {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

export function startOfLocalWeek(timestamp = Date.now(), weekStartsOn = 1) {
    const date = new Date(timestamp);
    date.setHours(0, 0, 0, 0);
    const offset = (date.getDay() - weekStartsOn + 7) % 7;
    date.setDate(date.getDate() - offset);
    return localDateKey(date.getTime());
}

export function localCalendarPeriodBounds(period, timestamp = Date.now(), weekStartsOn = 1) {
    const current = new Date(timestamp);
    const start = new Date(
        current.getFullYear(),
        current.getMonth(),
        current.getDate(),
    );
    if (period === "week") {
        const offset = (start.getDay() - weekStartsOn + 7) % 7;
        start.setDate(start.getDate() - offset);
    } else if (period === "month") {
        start.setDate(1);
    } else if (period === "year") {
        start.setMonth(0, 1);
    } else {
        throw new Error(`Unsupported local calendar period: ${period}`);
    }
    const end = new Date(start);
    if (period === "week") end.setDate(end.getDate() + 7);
    if (period === "month") end.setMonth(end.getMonth() + 1, 1);
    if (period === "year") end.setFullYear(end.getFullYear() + 1, 0, 1);
    return { start: start.getTime(), end: end.getTime() };
}

export function isTimestampInLocalPeriod(
    candidateTimestamp,
    period,
    timestamp = Date.now(),
    weekStartsOn = 1,
) {
    const candidate = Number(candidateTimestamp);
    if (!Number.isFinite(candidate)) return false;
    const bounds = localCalendarPeriodBounds(period, timestamp, weekStartsOn);
    return candidate >= bounds.start && candidate < bounds.end;
}

export function meaningfulCharacterCount(text) {
    return String(text || "").replace(/\s/g, "").length;
}

export function elapsedLocalCalendarDays(earlierTimestamp, laterTimestamp = Date.now()) {
    if (!Number.isFinite(earlierTimestamp) || !Number.isFinite(laterTimestamp)) return 0;
    const earlier = new Date(earlierTimestamp);
    const later = new Date(laterTimestamp);
    const earlierUtcDay = Date.UTC(earlier.getFullYear(), earlier.getMonth(), earlier.getDate());
    const laterUtcDay = Date.UTC(later.getFullYear(), later.getMonth(), later.getDate());
    return Math.max(0, Math.floor((laterUtcDay - earlierUtcDay) / 86400000));
}

export function sumLedger(ledger, predicate = () => true) {
    return (Array.isArray(ledger) ? ledger : []).reduce(
        (total, transaction) => total + (predicate(transaction) ? Number(transaction.points) || 0 : 0),
        0,
    );
}
