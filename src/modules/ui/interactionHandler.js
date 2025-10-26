import { mapClientPointToPdf, hitTestSentence } from "../utils/coordinates.js";

export class InteractionHandler {
    constructor(app) {
        this.app = app;
        this._pdfListenersAttached = false;
        this._pdfListeners = [];
    }

    setHoveredSentence(idx) {
        const { state } = this.app;
        if (idx === state.hoveredSentenceIndex) return;
        state.hoveredSentenceIndex = idx;
        if (state.currentDocumentType === "epub") {
            this.app.epubRenderer?.renderHoverHighlightFullDoc?.();
            return;
        }
        if (state.viewMode === "single") {
            this.app.pdfRenderer.renderSentence(state.currentSentenceIndex);
        } else {
            this.app.pdfRenderer.renderHoverHighlightFullDoc();
        }
    }

    handlePointerMove(e) {
        const { state } = this.app;
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

    async handlePointerClick(e) {
        const { state } = this.app;

        const mapped = mapClientPointToPdf(e, state, this.app.config);
        if (!mapped) return;
        const idx = hitTestSentence(state, mapped.pageNumber, mapped.xDisplay, mapped.yDisplay);
        if (idx >= 0) {
            const wasPlaying = state.isPlaying;
            this.app.audioManager.stopPlayback(true);
            state.autoAdvanceActive = false;
            if (idx !== state.hoveredSentenceIndex) {
                this.setHoveredSentence(idx);
            }
            await this.app.pdfRenderer.renderSentence(idx);
            if (wasPlaying) {
                await this.app.audioManager.playCurrentSentence();
            }
        }
    }

    setupInteractionListeners() {
        if (this.app.state.currentDocumentType === "epub") {
            this._detachPdfListeners();
            this.app.epubRenderer?.setupInteractionListeners?.();
            return;
        }

        this._attachPdfListeners();
    }

    _attachPdfListeners() {
        const pdfCanvas = document.getElementById("pdf-canvas");
        const pdfDocContainer = document.getElementById("pdf-doc-container");

        this._detachPdfListeners();
        const listeners = [];

        if (pdfCanvas) {
            const mouseMove = (e) => this.handlePointerMove(e);
            const mouseLeave = () => this.setHoveredSentence(-1);
            const click = (e) => this.handlePointerClick(e);
            const touchStart = (e) => {
                if (e.touches && e.touches[0]) {
                    const touch = e.touches[0];
                    const synthetic = {
                        clientX: touch.clientX,
                        clientY: touch.clientY,
                        target: document.elementFromPoint(touch.clientX, touch.clientY),
                    };
                    this.handlePointerClick(synthetic);
                }
            };
            const touchMove = (e) => {
                if (e.touches && e.touches[0]) {
                    const touch = e.touches[0];
                    const synthetic = {
                        clientX: touch.clientX,
                        clientY: touch.clientY,
                        target: document.elementFromPoint(touch.clientX, touch.clientY),
                    };
                    this.handlePointerMove(synthetic);
                }
            };
            const touchEnd = () => {
                this.setHoveredSentence(-1);
            };

            listeners.push({ element: pdfCanvas, type: "mousemove", handler: mouseMove });
            listeners.push({ element: pdfCanvas, type: "mouseleave", handler: mouseLeave });
            listeners.push({ element: pdfCanvas, type: "click", handler: click });
            listeners.push({ element: pdfCanvas, type: "touchstart", handler: touchStart, options: { passive: true } });
            listeners.push({ element: pdfCanvas, type: "touchmove", handler: touchMove, options: { passive: true } });
            listeners.push({ element: pdfCanvas, type: "touchend", handler: touchEnd, options: { passive: true } });
        }

        if (pdfDocContainer) {
            const mouseMove = (e) => this.handlePointerMove(e);
            const mouseLeave = () => this.setHoveredSentence(-1);
            const click = (e) => this.handlePointerClick(e);
            const touchStart = (e) => {
                if (e.touches && e.touches[0]) {
                    const touch = e.touches[0];
                    const synthetic = {
                        clientX: touch.clientX,
                        clientY: touch.clientY,
                        target: document.elementFromPoint(touch.clientX, touch.clientY),
                    };
                    this.handlePointerClick(synthetic);
                }
            };
            const touchMove = (e) => {
                if (e.touches && e.touches[0]) {
                    const touch = e.touches[0];
                    const synthetic = {
                        clientX: touch.clientX,
                        clientY: touch.clientY,
                        target: document.elementFromPoint(touch.clientX, touch.clientY),
                    };
                    this.handlePointerMove(synthetic);
                }
            };
            const touchEnd = () => {
                this.setHoveredSentence(-1);
            };

            listeners.push({ element: pdfDocContainer, type: "mousemove", handler: mouseMove });
            listeners.push({ element: pdfDocContainer, type: "mouseleave", handler: mouseLeave });
            listeners.push({ element: pdfDocContainer, type: "click", handler: click });
            listeners.push({ element: pdfDocContainer, type: "touchstart", handler: touchStart, options: { passive: true } });
            listeners.push({ element: pdfDocContainer, type: "touchmove", handler: touchMove, options: { passive: true } });
            listeners.push({ element: pdfDocContainer, type: "touchend", handler: touchEnd, options: { passive: true } });
        }

        for (const { element, type, handler, options } of listeners) {
            if (element) {
                element.addEventListener(type, handler, options);
            }
        }

        this._pdfListeners = listeners;
        this._pdfListenersAttached = listeners.length > 0;
    }

    _detachPdfListeners() {
        if (!this._pdfListenersAttached) return;
        for (const { element, type, handler, options } of this._pdfListeners) {
            if (element) {
                element.removeEventListener(type, handler, options);
            }
        }
        this._pdfListeners = [];
        this._pdfListenersAttached = false;
    }
}
