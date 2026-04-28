import { EVENTS } from "../constants/events.js";

export class OfflineNetworkError extends Error {
    constructor(message = "Offline mode: network requests are disabled.") {
        super(message);
        this.name = "OfflineNetworkError";
        this.code = "OFFLINE";
    }
}

export class NetworkService {
    constructor(app) {
        this.app = app;
        this._offline = this._readNavigatorOffline();
        this._listenersAttached = false;

        this._handleOnline = this._handleOnline.bind(this);
        this._handleOffline = this._handleOffline.bind(this);

        this._applyState(this._offline, { emit: false });
    }

    _readNavigatorOffline() {
        try {
            return typeof navigator !== "undefined" && navigator.onLine === false;
        } catch {
            return false;
        }
    }

    _handleOnline() {
        this._applyState(false, { emit: true });
    }

    _handleOffline() {
        this._applyState(true, { emit: true });
    }

    _applyState(isOffline, { emit } = {}) {
        if (this._offline === isOffline) return;
        this._offline = isOffline;
        if (this.app?.state) {
            this.app.state.isOffline = isOffline;
        }
        if (emit && this.app?.eventBus) {
            this.app.eventBus.emit(isOffline ? EVENTS.NETWORK_OFFLINE : EVENTS.NETWORK_ONLINE, {
                offline: isOffline,
            });
        }
    }

    start() {
        if (this._listenersAttached) return;
        if (typeof window !== "undefined" && window.addEventListener) {
            window.addEventListener("online", this._handleOnline);
            window.addEventListener("offline", this._handleOffline);
        }
        this._listenersAttached = true;
    }

    stop() {
        if (!this._listenersAttached) return;
        if (typeof window !== "undefined" && window.removeEventListener) {
            window.removeEventListener("online", this._handleOnline);
            window.removeEventListener("offline", this._handleOffline);
        }
        this._listenersAttached = false;
    }

    refreshStatus({ emit = false } = {}) {
        const next = this._readNavigatorOffline();
        this._applyState(next, { emit });
        return this._offline;
    }

    isOffline() {
        return this._offline;
    }

    assertOnline(message) {
        if (this.isOffline()) {
            throw new OfflineNetworkError(message);
        }
    }

    async fetch(url, options = {}, { allowOfflineCache = false, cacheOnly = false } = {}) {
        if (this.isOffline()) {
            if (allowOfflineCache || cacheOnly) {
                const cached = await this.fetchFromCache(url, options);
                if (cached) return cached;
                throw new OfflineNetworkError("Offline mode: resource not available in cache.");
            }
            throw new OfflineNetworkError();
        }

        return fetch(url, options);
    }

    async fetchFromCache(url, options = {}) {
        if (typeof caches === "undefined") return null;
        try {
            const request = url instanceof Request ? url : new Request(url, { ...options, method: "GET" });
            if (request.method && request.method.toUpperCase() !== "GET") return null;
            const response = await caches.match(request, { ignoreVary: true, ignoreSearch: false });
            return response || null;
        } catch {
            return null;
        }
    }

    async fetchJson(url, options = {}, config = {}) {
        const response = await this.fetch(url, options, config);
        return await response.json();
    }

    async fetchText(url, options = {}, config = {}) {
        const response = await this.fetch(url, options, config);
        return await response.text();
    }

    static isOfflineError(error) {
        return !!error && (error.code === "OFFLINE" || error.name === "OfflineNetworkError");
    }
}
