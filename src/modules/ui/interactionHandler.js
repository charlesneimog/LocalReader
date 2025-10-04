import { mapClientPointToPdf, hitTestSentence } from "../utils/coordinates.js";

export class InteractionHandler {
    constructor(app) {
        this.app = app;
    }

    setHoveredSentence(idx) {
        const { state } = this.app;
        if (idx === state.hoveredSentenceIndex) return;
        state.hoveredSentenceIndex = idx;
        if (state.viewMode === "single") {
            this.app.pdfRenderer.renderSentence(state.currentSentenceIndex);
        } else {
            this.app.pdfRenderer.renderHoverHighlightFullDoc();
        }
    }

    handlePointerMove(e) {
        const { state, config } = this.app;
        state.lastPointerEvent = e;
        if (state.hoverRafScheduled) return;
        state.hoverRafScheduled = true;
        requestAnimationFrame(() => {
            state.hoverRafScheduled = false;
            if (!state.lastPointerEvent) return;
            const mapped = mapClientPointToPdf(state.lastPointerEvent, state, this.app.config);
            if (!mapped) {
                this.setHoveredSentence(-1);
                return;
            }
            const idx = hitTestSentence(state, mapped.pageNumber, mapped.xDisplay, mapped.yDisplay);
            this.setHoveredSentence(idx);
        });
    }

    handlePointerClick(e) {
        const { state } = this.app;
        const mapped = mapClientPointToPdf(e, state, this.app.config);
        if (!mapped) return;
        const idx = hitTestSentence(state, mapped.pageNumber, mapped.xDisplay, mapped.yDisplay);
        if (idx >= 0) {
            const wasPlaying = state.isPlaying;
            this.app.audioManager.stopPlayback(true);
            this.app.pdfRenderer.renderSentence(idx);
            if (wasPlaying) this.app.audioManager.playCurrentSentence();
        }
    }

    setupInteractionListeners() {
        const pdfCanvas = document.getElementById("pdf-canvas");
        const pdfDocContainer = document.getElementById("pdf-doc-container");

        if (pdfCanvas) {
            pdfCanvas.addEventListener("mousemove", e => this.handlePointerMove(e));
            pdfCanvas.addEventListener("mouseleave", () => this.setHoveredSentence(-1));
            pdfCanvas.addEventListener("click", e => this.handlePointerClick(e));
            pdfCanvas.addEventListener("touchstart", (e) => {
                if (e.touches && e.touches[0]) {
                    const touch = e.touches[0];
                    const synthetic = {
                        clientX: touch.clientX,
                        clientY: touch.clientY,
                        target: document.elementFromPoint(touch.clientX, touch.clientY)
                    };
                    this.handlePointerClick(synthetic);
                }
            });
        }

        if (pdfDocContainer) {
            pdfDocContainer.addEventListener("mousemove", e => this.handlePointerMove(e));
            pdfDocContainer.addEventListener("mouseleave", () => this.setHoveredSentence(-1));
            pdfDocContainer.addEventListener("click", e => this.handlePointerClick(e));
            pdfDocContainer.addEventListener("touchstart", (e) => {
                if (e.touches && e.touches[0]) {
                    const touch = e.touches[0];
                    const synthetic = {
                        clientX: touch.clientX,
                        clientY: touch.clientY,
                        target: document.elementFromPoint(touch.clientX, touch.clientY)
                    };
                    this.handlePointerClick(synthetic);
                }
            });
        }
    }
}