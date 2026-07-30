import { uuid } from "./rewardDefinitions.js";

function persistentTabOwnerId(storage = globalThis.sessionStorage) {
    const key = "localreader.readingSessionOwner";
    try {
        const existing = storage?.getItem?.(key);
        if (existing) return existing;
        const created = uuid();
        storage?.setItem?.(key, created);
        return created;
    } catch {
        return uuid();
    }
}

/** Renewable single-session lease shared by browser tabs. */
export class CrossTabSessionLock {
    constructor({
        storage = globalThis.localStorage,
        BroadcastChannelClass = globalThis.BroadcastChannel,
        now = Date.now,
        setIntervalFn = globalThis.setInterval,
        clearIntervalFn = globalThis.clearInterval,
        key = "localreader.readingSessionLock",
        leaseMs = 15000,
        ownerId,
    } = {}) {
        this.storage = storage;
        this.now = now;
        this.setIntervalFn = setIntervalFn;
        this.clearIntervalFn = clearIntervalFn;
        this.key = key;
        this.leaseMs = leaseMs;
        this.ownerId = ownerId || persistentTabOwnerId();
        this.sessionId = null;
        this.heartbeat = null;
        this.channel = BroadcastChannelClass ? new BroadcastChannelClass("localreader-reading-session") : null;
        this.channel?.addEventListener?.("message", (event) => {
            if (event.data?.type === "lock-request" && this.sessionId) this._broadcast();
        });
    }

    read() {
        try {
            const parsed = JSON.parse(this.storage?.getItem?.(this.key) || "null");
            return parsed && typeof parsed === "object" ? parsed : null;
        } catch {
            return null;
        }
    }

    acquire(sessionId) {
        const now = this.now();
        const existing = this.read();
        if (existing && existing.ownerId !== this.ownerId && existing.expiresAt > now) return false;
        this.sessionId = sessionId;
        this._write();
        const confirmed = this.read();
        if (confirmed?.ownerId !== this.ownerId || confirmed?.sessionId !== sessionId) {
            this.sessionId = null;
            return false;
        }
        this.channel?.postMessage?.({ type: "lock-request", ownerId: this.ownerId });
        this.heartbeat = this.setIntervalFn(() => this._write(), Math.max(1000, Math.floor(this.leaseMs / 3)));
        return true;
    }

    release() {
        if (this.heartbeat) this.clearIntervalFn(this.heartbeat);
        this.heartbeat = null;
        const existing = this.read();
        if (existing?.ownerId === this.ownerId) {
            try {
                this.storage?.removeItem?.(this.key);
            } catch (error) {
                console.warn("[CrossTabSessionLock] Unable to release local lock", error);
            }
        }
        this.channel?.postMessage?.({ type: "lock-release", ownerId: this.ownerId });
        this.sessionId = null;
    }

    destroy() {
        this.release();
        this.channel?.close?.();
    }

    _write() {
        if (!this.sessionId) return;
        const lock = {
            ownerId: this.ownerId,
            sessionId: this.sessionId,
            expiresAt: this.now() + this.leaseMs,
        };
        try {
            this.storage?.setItem?.(this.key, JSON.stringify(lock));
            this._broadcast(lock);
        } catch (error) {
            console.warn("[CrossTabSessionLock] Unable to checkpoint local lock", error);
        }
    }

    _broadcast(lock = this.read()) {
        this.channel?.postMessage?.({ type: "lock-held", lock });
    }
}
