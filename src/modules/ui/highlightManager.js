export class HighlightManager {
    constructor(app) {
        this.app = app;
    }

    _persistHighlights({ allowEmpty = false } = {}) {
        this.app.highlightsStorage?.saveHighlightsForCurrentDocument?.({ allowEmpty });
    }

    _getActiveSentenceIndex() {
        const { state } = this.app;
        if (!state?.sentences?.length) return -1;
        const idx =
            typeof state.playingSentenceIndex === "number" && state.playingSentenceIndex >= 0
                ? state.playingSentenceIndex
                : state.currentSentenceIndex;
        if (!Number.isFinite(idx) || idx < 0 || idx >= state.sentences.length) return -1;
        return idx;
    }

    _refreshHighlightsForCurrentDocument() {
        const { state } = this.app;
        if (state.currentDocumentType === "epub") {
            this.app.epubRenderer?.updateHighlightDisplay?.();
        } else {
            this.app.pdfRenderer?.updateHighlightFullDoc?.();
        }
        this.app.controlsManager?.reflectSelectedHighlightColor?.();
    }

    toggleCurrentSentenceHighlight({ color = null, showMessage = true } = {}) {
        const { state } = this.app;
        if (!state) return false;

        const activeIndex = this._getActiveSentenceIndex();
        if (activeIndex < 0) return false;

        const existingHighlight = state.savedHighlights.get(activeIndex);
        if (existingHighlight?.color) {
            state.savedHighlights.delete(activeIndex);
            this._persistHighlights({ allowEmpty: true });
            this._refreshHighlightsForCurrentDocument();
            if (showMessage) this.app.ui?.showInfo?.("Highlight removed");
            return false;
        }

        let highlightColor = color || state.selectedHighlightColor || "#FFF176";
        const selectedButton = document.querySelector(".highlight-color-option.selected");
        if (!color && selectedButton) {
            highlightColor = selectedButton.getAttribute("data-highlight-color");
        }

        state.selectedHighlightColor = highlightColor;
        const sentenceText = state.sentences[activeIndex]?.text || "";
        state.savedHighlights.set(activeIndex, {
            color: highlightColor,
            timestamp: Date.now(),
            text: sentenceText,
            sentenceText,
        });

        this._persistHighlights();
        this._refreshHighlightsForCurrentDocument();
        if (showMessage) this.app.ui?.showInfo?.("Highlight saved");
        return true;
    }

    async editCurrentSentenceComment() {
        const { state } = this.app;
        if (!state) return;
        const activeIndex =
            typeof state.playingSentenceIndex === "number" && state.playingSentenceIndex >= 0
                ? state.playingSentenceIndex
                : state.currentSentenceIndex;
        if (activeIndex < 0 || activeIndex >= state.sentences.length) return;

        const existing = state.savedHighlights.get(activeIndex) || null;
        const existingComment = typeof existing?.comment === "string" ? existing.comment : "";

        const res = await this.app.ui?.showCommentPopup?.({
            title: "Comment",
            initialText: existingComment,
            allowRemove: existingComment.trim().length > 0,
        });
        if (!res) return; // cancelled

        if (res.action === "remove") {
            if (existing && "comment" in existing) {
                const next = { ...existing };
                delete next.comment;
                state.savedHighlights.set(activeIndex, next);
                this._persistHighlights();
                if (state.currentDocumentType === "epub") {
                    this.app.epubRenderer?.updateHighlightDisplay?.();
                } else {
                    this.app.pdfRenderer?.updateHighlightFullDoc?.();
                }
                this.app.ui?.showInfo?.("Comment removed");
            }
            return;
        }

        const nextComment = typeof res.text === "string" ? res.text.trim() : "";
        const sentenceText = state.sentences[activeIndex]?.text || "";

        if (!nextComment) return;

        const highlightColor = existing?.color || state.selectedHighlightColor || "#FFF176";
        state.savedHighlights.set(activeIndex, {
            color: highlightColor,
            timestamp: existing?.timestamp || Date.now(),
            text: existing?.text || sentenceText,
            sentenceText: existing?.sentenceText || sentenceText,
            comment: nextComment,
        });

        this._persistHighlights();
        if (state.currentDocumentType === "epub") {
            this.app.epubRenderer?.updateHighlightDisplay?.();
        } else {
            this.app.pdfRenderer?.updateHighlightFullDoc?.();
        }
        this.app.ui?.showInfo?.("Comment saved");
    }

    saveCurrentSentenceHighlight(color = null) {
        const { state } = this.app;
        if (!state) return;
        const activeIndex = this._getActiveSentenceIndex();
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
            this._persistHighlights({ allowEmpty: true });
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
            ...(existingHighlight || {}),
            color: highlightColor,
            timestamp: Date.now(),
            text: state.sentences[currentIndex].text,
            sentenceText: state.sentences[currentIndex].text,
        });

        this._persistHighlights();
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
        this._persistHighlights({ allowEmpty: true });
        if (state.currentDocumentType === "epub") {
            this.app.epubRenderer.updateHighlightDisplay();
        } else {
            this.app.pdfRenderer.updateHighlightFullDoc();
        }
        this.app.ui.showInfo("Highlight Saved");
    }
}
