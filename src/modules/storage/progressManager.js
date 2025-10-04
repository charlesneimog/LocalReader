export class ProgressManager {
    constructor(app) {
        this.app = app;
    }
    getProgressMap() {
        const { config } = this.app;
        try {
            return JSON.parse(localStorage.getItem(config.PROGRESS_STORAGE_KEY) || "{}");
        } catch {
            return {};
        }
    }
    setProgressMap(map) {
        const { config } = this.app;
        try {
            localStorage.setItem(config.PROGRESS_STORAGE_KEY, JSON.stringify(map));
        } catch (e) {
            console.warn("Failed to write progress map:", e);
        }
    }
    loadSavedPosition(pdfKey) {
        return this.getProgressMap()[pdfKey] || null;
    }
    saveProgress() {
        const { state } = this.app;
        if (!state.sentences.length || state.currentSentenceIndex < 0 || !state.currentPdfKey) return;
        const map = this.getProgressMap();
        map[state.currentPdfKey] = {
            sentenceIndex: state.currentSentenceIndex,
            totalSentences: state.sentences.length,
            updated: Date.now()
        };
        this.setProgressMap(map);
    }
    listSavedProgress() {
        return this.getProgressMap();
    }
    clearPdfProgress(key) {
        const map = this.getProgressMap();
        if (map[key]) {
            delete map[key];
            this.setProgressMap(map);
        }
    }
}