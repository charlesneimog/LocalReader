export class HighlightManager {
    constructor(app) {
        this.app = app;
    }

    saveCurrentSentenceHighlight(color = null) {
    const { state } = this.app;
    if (!state) return;
        if (state.currentSentenceIndex < 0 || state.currentSentenceIndex >= state.sentences.length) return;
        const highlightColor = color || state.selectedHighlightColor || "#fff8b0";
        state.savedHighlights.set(state.currentSentenceIndex, {
            color: highlightColor,
            timestamp: Date.now(),
            sentenceText: state.sentences[state.currentSentenceIndex].text,
        });
        state.selectedHighlightColor = highlightColor;
        this.app.highlightsStorage.saveHighlightsForPdf();
        this.app.pdfRenderer.updateHighlightDisplay();
        this.app.controlsManager.reflectSelectedHighlightColor();
    }

    setSelectedHighlightColor(color) {
    const { state } = this.app;
    if (!state || !color) return;
    state.selectedHighlightColor = color;
        this.app.pdfRenderer.updateHighlightDisplay();
        this.app.controlsManager?.reflectSelectedHighlightColor?.();
    }

    clearHighlight(sentenceIndex) {
        const { state } = this.app;
        state.savedHighlights.delete(sentenceIndex);
        this.app.highlightsStorage.saveHighlightsForPdf();
        this.app.pdfRenderer.updateHighlightDisplay();
    }
}

