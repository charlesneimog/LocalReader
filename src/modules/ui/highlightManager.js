export class HighlightManager {
    constructor(app) {
        this.app = app;
    }

    saveCurrentSentenceHighlight(color = null) {
        const { state } = this.app;
        if (!state) return;
        if (state.currentSentenceIndex < 0 || state.currentSentenceIndex >= state.sentences.length) return;
        let highlightColor = color || state.selectedHighlightColor || "#FFF176"; // default amarelo
        const selectedButton = document.querySelector(".highlight-color-option.selected");
        if (!color && selectedButton) {
            highlightColor = selectedButton.getAttribute("data-highlight-color");
        }
        const currentIndex = state.currentSentenceIndex;
        const existingHighlight = state.savedHighlights.get(currentIndex);

        state.selectedHighlightColor = highlightColor;

        if (existingHighlight?.color === highlightColor) {
            state.savedHighlights.delete(currentIndex);
            this.app.highlightsStorage.saveHighlightsForPdf({ allowEmpty: true });
            if (state.currentDocumentType === "epub") {
                this.app.epubRenderer.updateHighlightDisplay();
            } else {
                this.app.pdfRenderer.updateHighlightDisplay();
            }
            this.app.controlsManager?.reflectSelectedHighlightColor?.();
            return;
        }

        state.savedHighlights.set(currentIndex, {
            color: highlightColor,
            timestamp: Date.now(),
            sentenceText: state.sentences[currentIndex].text,
        });

        this.app.highlightsStorage.saveHighlightsForPdf();
        if (state.currentDocumentType === "epub") {
            this.app.epubRenderer.updateHighlightDisplay();
        } else {
            this.app.pdfRenderer.updateHighlightDisplay();
        }
        this.app.controlsManager?.reflectSelectedHighlightColor?.();
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
        if (!state.pdf) {
            this.app.ui.showInfo("Load a document before highlight something.");
            return;
        }
        state.savedHighlights.delete(sentenceIndex);
        this.app.highlightsStorage.saveHighlightsForPdf({ allowEmpty: true });
        this.app.pdfRenderer.updateHighlightDisplay();
        this.app.ui.showInfo("Highlight Saved");
    }
}
