export class HighlightManager {
    constructor(app) {
        this.app = app;
    }

    saveCurrentSentenceHighlight(color = null) {
        const { state } = this.app;
        if (!state) return;
        const activeIndex =
            typeof state.playingSentenceIndex === "number" && state.playingSentenceIndex >= 0
                ? state.playingSentenceIndex
                : state.currentSentenceIndex;
        if (activeIndex < 0 || activeIndex >= state.sentences.length) return;
        let highlightColor = color || state.selectedHighlightColor || "#FFF176"; // default amarelo
        const selectedButton = document.querySelector(".highlight-color-option.selected");
        if (!color && selectedButton) {
            highlightColor = selectedButton.getAttribute("data-highlight-color");
        }
        const currentIndex = activeIndex;
        const existingHighlight = state.savedHighlights.get(currentIndex);

        state.selectedHighlightColor = highlightColor;

        if (existingHighlight?.color === highlightColor) {
            state.savedHighlights.delete(currentIndex);
            this.app.highlightsStorage.saveHighlightsForPdf({ allowEmpty: true });
            if (state.currentDocumentType === "epub") {
                this.app.epubRenderer.updateHighlightDisplay();
            } else {
                // Immediate visual feedback on PDF: redraw active sentence overlay.
                this.app.pdfRenderer.updateHighlightFullDoc();
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
            // Immediate visual feedback on PDF: redraw active sentence overlay.
            this.app.pdfRenderer.updateHighlightFullDoc();
        }
        this.app.controlsManager?.reflectSelectedHighlightColor?.();
    }

    setSelectedHighlightColor(color) {
        const { state } = this.app;
        if (!state || !color) return;
        state.selectedHighlightColor = color;
        if (state.currentDocumentType === "epub") {
            this.app.epubRenderer.updateHighlightDisplay();
        } else {
            this.app.pdfRenderer.updateHighlightFullDoc();
        }
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
        if (state.currentDocumentType === "epub") {
            this.app.epubRenderer.updateHighlightDisplay();
        } else {
            this.app.pdfRenderer.updateHighlightFullDoc();
        }
        this.app.ui.showInfo("Highlight Saved");
    }
}
