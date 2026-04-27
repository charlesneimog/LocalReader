export class HighlightsStorage {
    constructor(app) {
        this.app = app;
    }

    getHighlightsMap() {
        const { config } = this.app;
        try {
            return JSON.parse(localStorage.getItem(config.HIGHLIGHTS_STORAGE_KEY) || "{}");
        } catch {
            return {};
        }
    }
    setHighlightsMap(map) {
        const { config } = this.app;
        try {
            localStorage.setItem(config.HIGHLIGHTS_STORAGE_KEY, JSON.stringify(map));
        } catch (e) {
            console.warn("Failed to write highlights:", e);
        }
    }
    loadSavedHighlights(pdfKey) {
        if (!pdfKey) return new Map();
        const all = this.getHighlightsMap();
        const pdfHighlights = all[pdfKey] || {};
        const highlightsMap = new Map();
        for (const [sentenceIndex, data] of Object.entries(pdfHighlights)) {
            highlightsMap.set(parseInt(sentenceIndex), data);
        }
        return highlightsMap;
    }

    _getCurrentHighlightKey() {
        const { state } = this.app;
        if (!state) return null;
        if (state.currentDocumentType === "epub") return state.currentEpubKey;
        return state.currentPdfKey;
    }

    _refreshCurrentDocumentHighlights() {
        const { state } = this.app;
        if (!state) return;
        if (state.currentDocumentType === "epub") {
            this.app.epubRenderer?.updateHighlightDisplay?.();
            return;
        }
        this.app.pdfRenderer?.updateHighlightDisplay?.();
    }

    saveHighlightsForCurrentDocument({ allowEmpty = false } = {}) {
        const { state } = this.app;
        const key = this._getCurrentHighlightKey();
        if (!key) return;

        const all = this.getHighlightsMap();
        const existing = all[key] || {};
        const hasExisting = Object.keys(existing).length > 0;

        if (!allowEmpty && state.savedHighlights.size === 0 && hasExisting) {
            for (const [sentenceIndex, data] of Object.entries(existing)) {
                state.savedHighlights.set(parseInt(sentenceIndex, 10), data);
            }
            this._refreshCurrentDocumentHighlights();
            return;
        }

        const docHighlights = {};
        for (const [sentenceIndex, data] of state.savedHighlights.entries()) {
            docHighlights[sentenceIndex] = data;
        }

        if (!allowEmpty && hasExisting && Object.keys(docHighlights).length === 0) {
            return;
        }

        all[key] = docHighlights;
        this.setHighlightsMap(all);

        // Sync to server if enabled
        if (this.app.serverSync?.isEnabled()) {
            this.app.serverSync
                .syncHighlights(key, this.app.state.savedHighlights)
                .then((ok) => {
                    if (!ok) {
                        console.warn("[HighlightsStorage] Server highlights sync returned false", { key });
                    }
                })
                .catch((err) => {
                    console.warn("[HighlightsStorage] Server sync failed:", err);
                });
        }
    }

    saveHighlightsForPdf({ allowEmpty = false } = {}) {
        this.saveHighlightsForCurrentDocument({ allowEmpty });
    }

    saveHighlights(key, highlights, { merge = false } = {}) {
        if (!key) return;

        const all = this.getHighlightsMap();
        const existing = all[key] || {};
        const next = merge ? { ...existing } : {};

        if (highlights instanceof Map) {
            for (const [sentenceIndex, data] of highlights.entries()) {
                next[String(sentenceIndex)] = data;
            }
        } else if (highlights && typeof highlights === "object") {
            // Accept plain object maps too.
            for (const [sentenceIndex, data] of Object.entries(highlights)) {
                next[String(sentenceIndex)] = data;
            }
        }

        all[key] = next;
        this.setHighlightsMap(all);
    }
    listSavedHighlights() {
        return this.getHighlightsMap();
    }
    clearPdfHighlights(key) {
        const map = this.getHighlightsMap();
        if (map[key]) {
            delete map[key];
            this.setHighlightsMap(map);
            if (key === this.app.state.currentPdfKey) {
                this.app.state.savedHighlights.clear();
                this.app.pdfRenderer.updateHighlightDisplay();
            }
        }
    }
}