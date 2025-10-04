import { hexToRgb } from "../utils/helpers.js";

export class HighlightManager {
    constructor(app) {
        this.app = app;
    }

    saveCurrentSentenceHighlight(color = null) {
        const { state } = this.app;
        if (state.currentSentenceIndex < 0 || state.currentSentenceIndex >= state.sentences.length) return;
        const picker = document.getElementById("highlight-color");
        const highlightColor = color || picker?.value || "#ffeb3b";
        state.savedHighlights.set(state.currentSentenceIndex, {
            color: highlightColor,
            timestamp: Date.now(),
            sentenceText: state.sentences[state.currentSentenceIndex].text
        });
        this.app.highlightsStorage.saveHighlightsForPdf();
        this.app.pdfRenderer.updateHighlightDisplay();
    }

    clearHighlight(sentenceIndex) {
        const { state } = this.app;
        state.savedHighlights.delete(sentenceIndex);
        this.app.highlightsStorage.saveHighlightsForPdf();
        this.app.pdfRenderer.updateHighlightDisplay();
    }
}