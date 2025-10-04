export class ViewManager {
    constructor(app) {
        this.app = app;
    }
    applyViewModeUI() {
        const { state } = this.app;
        const toggleBtn = document.getElementById("toggle-view-mode");
        const viewerWrapper = document.getElementById("viewer-wrapper");
        const pdfDocContainer = document.getElementById("pdf-doc-container");
        if (!toggleBtn) return;
        const label = toggleBtn.querySelector(".label");
        if (state.viewMode === "full") {
            if (label) label.textContent = "View: Full Doc";
            if (pdfDocContainer) pdfDocContainer.style.display = "block";
            if (viewerWrapper) viewerWrapper.style.display = "none";
        } else {
            if (label) label.textContent = "View: Single Page";
            if (pdfDocContainer) pdfDocContainer.style.display = "none";
            if (viewerWrapper) viewerWrapper.style.display = "flex";
        }
    }
    async toggleViewMode() {
        const { state, config } = this.app;
        state.viewMode = state.viewMode === "full" ? "single" : "full";
        localStorage.setItem(config.VIEW_MODE_STORAGE_KEY, state.viewMode);
        this.applyViewModeUI();
        if (state.viewMode === "full") {
            await this.app.pdfRenderer.renderFullDocumentIfNeeded();
            this.app.pdfRenderer.renderSentence(state.currentSentenceIndex);
        } else {
            this.app.pdfRenderer.clearFullDocHighlights();
            this.app.pdfRenderer.renderSentence(state.currentSentenceIndex);
        }
    }
}

