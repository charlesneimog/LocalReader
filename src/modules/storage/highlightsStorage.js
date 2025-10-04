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
    saveHighlightsForPdf() {
        const { state } = this.app;
        if (!state.currentPdfKey) return;
        const all = this.getHighlightsMap();
        const pdfHighlights = {};
        for (const [sentenceIndex, data] of state.savedHighlights.entries()) {
            pdfHighlights[sentenceIndex] = data;
        }
        all[state.currentPdfKey] = pdfHighlights;
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