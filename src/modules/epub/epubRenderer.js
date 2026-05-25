import "./../../../thirdparty/foliate-js/view.js";
import { Overlayer } from "./../../../thirdparty/foliate-js/overlayer.js";

const ACTIVE_SENTENCE_COLOR = "rgb(120, 190, 255)";
const HOVER_SENTENCE_COLOR = "rgb(148, 255, 206)";

const DEFAULT_READER_SETTINGS = Object.freeze({
    spacing: 1.5,
    justify: true,
    hyphenate: true,
    fontSize: 100, // percentage: 50-200
});

export class EPUBRenderer {
    constructor(app, loader) {
        this.app = app;
        this.loader = loader;

        this.view = null;
        this._container = null;
        this._viewWrapper = null;

        this._boundResize = this._resizeContainer.bind(this);
        this._boundRelocate = null;
        this._boundHighlight = null;
        this._boundLoad = null;
        this._boundDrawAnnotation = null;
        this._boundZoomKeydown = null;
        this._boundTouchStart = null;
        this._initialTouchDistance = 0;

        this._activeDocs = new Set();
        this._docListeners = [];

        this._onKeydown = this._handleDirectionalKeydown.bind(this);
        this._globalKeysBound = false;

        this._activeAnnotationValue = null;
        this._hoverAnnotationValue = null;
        this._activeHighlightColor = ACTIVE_SENTENCE_COLOR;
        this._hoverHighlightColor = HOVER_SENTENCE_COLOR;

        this._readerSettings = { ...DEFAULT_READER_SETTINGS };

        // Font size constraints
        this._MIN_FONT_SIZE = 50;
        this._MAX_FONT_SIZE = 200;
        this._FONT_SIZE_STEP = 10;

        this._playbarRoot = null;
        this._playbarOriginalParent = null;
        this._playbarOriginalNextSibling = null;
        this._playbarOriginalStyles = null;

        // Track persistent annotation values we created for saved highlights
        this._persistentAnnotationValues = new Set();

        this._boundZoomKeydown = this._handleZoomKeydown.bind(this);
        this._boundTouchStart = this._handleTouchStart.bind(this);
        this._boundTouchMove = this._handleTouchMove.bind(this);
        this._boundTouchEnd = this._handleTouchEnd.bind(this);

        window.addEventListener("resize", this._boundResize, { passive: true });
    }

    /**
     * Update persistent and hover highlights for EPUB view.
     * This mirrors PDFRenderer.updateHighlightDisplay by rendering saved highlights
     * and hover highlights. Also keep a backward-compatible alias `pdateHighlightDisplay`.
     */
    async updateHighlightDisplay() {
        const { state } = this.app;
        if (!this.view || !state) return;

        const activeCfi =
            state.currentSentence?.cfi ||
            state.sentences?.[
                typeof state.playingSentenceIndex === "number" && state.playingSentenceIndex >= 0
                    ? state.playingSentenceIndex
                    : state.currentSentenceIndex
            ]?.cfi ||
            this._activeAnnotationValue ||
            null;

        // Remove any previously created persistent annotations
        if (this._persistentAnnotationValues && this._persistentAnnotationValues.size) {
            for (const val of Array.from(this._persistentAnnotationValues)) {
                try {
                    // view.deleteAnnotation may reject; ignore errors
                    this.view.deleteAnnotation({ value: val }).catch(() => {});
                } catch (e) {
                    /* ignore */
                }
            }
            this._persistentAnnotationValues.clear();
        }

        // Render saved highlights from application state
        try {
            const saved = state.savedHighlights ?? new Map();
            for (const [sentenceIndex, highlightData] of saved.entries()) {
                try {
                    const sentence = state.sentences?.[sentenceIndex];
                    const cfi = sentence?.cfi;
                    if (!cfi) continue;
                    // Active sentence is drawn separately by _applySentenceHighlight.
                    if (activeCfi && cfi === activeCfi) continue;
                    const color = highlightData?.color || null;
                    // Add annotation for saved highlight; don't await to keep UI responsive
                    this.view.addAnnotation({ value: cfi, color }).catch(() => {});
                    // Track it so we can remove later
                    this._persistentAnnotationValues.add(cfi);
                } catch (e) {
                    console.debug("[EPUBRenderer] Failed to apply saved highlight", e);
                }
            }
        } catch (e) {
            console.debug("[EPUBRenderer] updateHighlightDisplay failed to render saved highlights", e);
        }

        // Re-apply hover/active highlights
        try {
            // Prefer to update active sentence highlight first
            const active = state.currentSentence ?? null;
            if (active && active.cfi) await this.updateHighlightFullDoc(active);
        } catch (e) {
            // non-fatal
        }

        try {
            this.renderHoverHighlightFullDoc();
        } catch (e) {
            // non-fatal
        }
    }

    // Alias requested: pdateHighlightDisplay
    pdateHighlightDisplay() {
        return this.updateHighlightDisplay();
    }

    /**
     * Increase font size by step
     */
    increaseFontSize() {
        this.setFontSize(this._readerSettings.fontSize + this._FONT_SIZE_STEP);
    }

    /**
     * Decrease font size by step
     */
    decreaseFontSize() {
        this.setFontSize(this._readerSettings.fontSize - this._FONT_SIZE_STEP);
    }

    /**
     * Set font size with constraints
     * @param {number} size - Font size as percentage (50-200)
     */
    setFontSize(size) {
        size = Math.max(this._MIN_FONT_SIZE, Math.min(this._MAX_FONT_SIZE, size));
        this._readerSettings.fontSize = size;
        this._applyReaderStyles();
    }

    /**
     * Get current font size
     */
    getFontSize() {
        return this._readerSettings.fontSize;
    }

    setReaderSettings(settings = {}) {
        this._readerSettings = { ...DEFAULT_READER_SETTINGS, ...settings };
    }

    getReaderSettings() {
        return { ...this._readerSettings };
    }

    async open(source) {
        this.reset();

        const container = this._ensureContainer();
        container.style.display = "block";
        container.style.height = "";
        container.innerHTML = "";

        const wrapper = document.createElement("div");
        wrapper.classList.add("relative", "flex-1", "w-full");
        wrapper.style.position = "relative";
        wrapper.style.height = "100%";
        wrapper.style.width = "100%";
        wrapper.style.flex = "1 1 auto";
        container.appendChild(wrapper);
        this._viewWrapper = wrapper;

        const view = document.createElement("foliate-view");
        view.classList.add("flex-1");
        view.style.width = "100%";
        view.style.height = "100%";
        view.style.display = "block";
        view.style.flex = "1 1 auto";
        wrapper.appendChild(view);

        this.view = view;

        this._boundLoad = (event) => this._handleViewLoad(event);
        this._boundRelocate = (event) => {
            const detail = event?.detail ?? {};
            if (this.app?.state) {
                this.app.state.epubProgress = detail;
            }
        };
        this._boundHighlight = (event) => {
            console.debug("foliate highlight", event?.detail);
        };
        this._boundDrawAnnotation = (event) => this._handleDrawAnnotation(event);

        view.addEventListener("load", this._boundLoad);
        view.addEventListener("relocate", this._boundRelocate);
        view.addEventListener("highlight", this._boundHighlight);
        view.addEventListener("draw-annotation", this._boundDrawAnnotation);

        this._bindGlobalKeys();
        this._bindZoomListeners();

        await view.open(source);

        this._applyReaderStyles();
        this._resizeContainer();

        return view;
    }

    reset() {
        this._unbindGlobalKeys();
        this._unbindZoomListeners();

        for (const doc of this._activeDocs) {
            try {
                doc.removeEventListener("keydown", this._onKeydown);
            } catch (error) {
                console.debug("[EPUBRenderer] Unable to remove doc keydown listener", error);
            }
        }
        this._activeDocs.clear();
        this._detachInteractionListeners();
        this._removeActivePhraseActions();

        if (this.view && this._activeAnnotationValue) {
            try {
                this.view.deleteAnnotation({ value: this._activeAnnotationValue });
            } catch (error) {
                console.debug("[EPUBRenderer] Unable to remove active annotation", error);
            }
        }
        this._activeAnnotationValue = null;

        if (this.view && this._hoverAnnotationValue) {
            try {
                this.view.deleteAnnotation({ value: this._hoverAnnotationValue });
            } catch (error) {
                console.debug("[EPUBRenderer] Unable to remove hover annotation", error);
            }
        }
        this._hoverAnnotationValue = null;

        if (this.view) {
            if (this._boundLoad) {
                this.view.removeEventListener("load", this._boundLoad);
                this._boundLoad = null;
            }
            if (this._boundRelocate) {
                this.view.removeEventListener("relocate", this._boundRelocate);
                this._boundRelocate = null;
            }
            if (this._boundHighlight) {
                this.view.removeEventListener("highlight", this._boundHighlight);
                this._boundHighlight = null;
            }
            if (this._boundDrawAnnotation) {
                this.view.removeEventListener("draw-annotation", this._boundDrawAnnotation);
                this._boundDrawAnnotation = null;
            }
            this.view.remove();
            this.view = null;
        }

        if (this._viewWrapper) {
            this._viewWrapper.remove();
            this._viewWrapper = null;
        }

        if (this._container) {
            this._container.innerHTML = "";
            this._container.style.display = "none";
            this._container.style.height = "";
        }
    }

    destroy() {
        window.removeEventListener("resize", this._boundResize);
        this.reset();
        this._container = null;
    }

    // setupInteractionListeners() {
    //     this._detachInteractionListeners();
    //     if (!this.view?.renderer?.getContents) return;
    //     const contents = this.view.renderer.getContents();
    //     for (const entry of contents) {
    //         const doc = entry?.doc;
    //         if (!doc) continue;
    //         const clickHandler = (event) => this._handleDocumentClick(event, entry.index);
    //         const mouseMoveHandler = (event) => this._handleDocumentPointerMove(event, entry.index);
    //         const mouseLeaveHandler = () => this._setHoveredSentence(-1);
    //         const touchStartHandler = (event) => this._handleDocumentTouchMove(event, entry.index, doc);
    //         const touchMoveHandler = (event) => this._handleDocumentTouchMove(event, entry.index, doc);
    //         const touchEndHandler = () => this._setHoveredSentence(-1);
    //         const hoverSurface = doc.documentElement || doc;
    //
    //         doc.addEventListener("click", clickHandler, { passive: false });
    //         doc.addEventListener("mousemove", mouseMoveHandler, { passive: true });
    //         hoverSurface.addEventListener("mouseleave", mouseLeaveHandler, { passive: true });
    //         doc.addEventListener("touchstart", touchStartHandler, { passive: true });
    //         doc.addEventListener("touchmove", touchMoveHandler, { passive: true });
    //         doc.addEventListener("touchend", touchEndHandler, { passive: true });
    //         doc.addEventListener("touchcancel", touchEndHandler, { passive: true });
    //
    //         this._docListeners.push({ doc, type: "click", handler: clickHandler, options: { passive: false } });
    //         this._docListeners.push({ doc, type: "mousemove", handler: mouseMoveHandler, options: { passive: true } });
    //         this._docListeners.push({
    //             doc: hoverSurface,
    //             type: "mouseleave",
    //             handler: mouseLeaveHandler,
    //             options: { passive: true },
    //         });
    //         this._docListeners.push({
    //             doc,
    //             type: "touchstart",
    //             handler: touchStartHandler,
    //             options: { passive: true },
    //         });
    //         this._docListeners.push({ doc, type: "touchmove", handler: touchMoveHandler, options: { passive: true } });
    //         this._docListeners.push({ doc, type: "touchend", handler: touchEndHandler, options: { passive: true } });
    //         this._docListeners.push({ doc, type: "touchcancel", handler: touchEndHandler, options: { passive: true } });
    //     }
    // }
    setupInteractionListeners() {
        this._detachInteractionListeners();
        if (!this.view?.renderer?.getContents) return;
        const contents = this.view.renderer.getContents();
        for (const entry of contents) {
            const doc = entry?.doc;
            if (!doc) continue;

            const clickHandler = (event) => this._handleDocumentClick(event, entry.index);
            const mouseMoveHandler = (event) => this._handleDocumentPointerMove(event, entry.index);
            const touchStartHandler = (event) => this._handleDocumentTouchMove(event, entry.index, doc);
            const touchMoveHandler = (event) => this._handleDocumentTouchMove(event, entry.index, doc);

            // --- Update exit handlers to pass 'doc' ---
            const mouseLeaveHandler = () => this._setHoveredSentence(-1, doc);
            const touchEndHandler = () => this._setHoveredSentence(-1, doc);

            const hoverSurface = doc.documentElement || doc;

            doc.addEventListener("click", clickHandler, { passive: false });
            doc.addEventListener("mousemove", mouseMoveHandler, { passive: true });
            hoverSurface.addEventListener("mouseleave", mouseLeaveHandler, { passive: true });
            doc.addEventListener("touchstart", touchStartHandler, { passive: true });
            doc.addEventListener("touchmove", touchMoveHandler, { passive: true });
            doc.addEventListener("touchend", touchEndHandler, { passive: true });
            doc.addEventListener("touchcancel", touchEndHandler, { passive: true });

            this._docListeners.push({ doc, type: "click", handler: clickHandler, options: { passive: false } });
            this._docListeners.push({ doc, type: "mousemove", handler: mouseMoveHandler, options: { passive: true } });
            this._docListeners.push({
                doc: hoverSurface,
                type: "mouseleave",
                handler: mouseLeaveHandler,
                options: { passive: true },
            });
            this._docListeners.push({
                doc,
                type: "touchstart",
                handler: touchStartHandler,
                options: { passive: true },
            });
            this._docListeners.push({ doc, type: "touchmove", handler: touchMoveHandler, options: { passive: true } });
            this._docListeners.push({ doc, type: "touchend", handler: touchEndHandler, options: { passive: true } });
            this._docListeners.push({ doc, type: "touchcancel", handler: touchEndHandler, options: { passive: true } });
        }
    }

    _removeActivePhraseActions() {
        if (this._activePhraseActionsEl) {
            this._activePhraseActionsEl.remove();
            this._activePhraseActionsEl = null;
        }
    }

    // OLD
    // _renderActivePhraseActions(highlightEl, sentenceIndex, highlighted, hasComment) {
    //     if (!highlightEl || !highlightEl.isConnected) return;
    //     this._removeActivePhraseActions();
    //
    //     const container = this._container;
    //     if (!container) return;
    //
    //     // Get bounding rect of the first line of the highlight
    //     const firstChild = highlightEl.firstElementChild || highlightEl;
    //     const anchorRect = firstChild.getBoundingClientRect();
    //
    //     // Calculate absolute position considering EPUB iframes
    //     const frame = highlightEl.ownerDocument?.defaultView?.frameElement;
    //     let frameOffsetX = 0;
    //     let frameOffsetY = 0;
    //     if (frame) {
    //         const frameRect = frame.getBoundingClientRect();
    //         frameOffsetX = frameRect.left;
    //         frameOffsetY = frameRect.top;
    //     }
    //
    //     const containerRect = container.getBoundingClientRect();
    //     const absLeft = anchorRect.left + frameOffsetX;
    //     const absTop = anchorRect.top + frameOffsetY;
    //
    //     const left = absLeft - containerRect.left;
    //     const top = absTop - containerRect.top - 34; // 34px offset for the popup
    //
    //     const panel = document.createElement("div");
    //     // Reuse PDF classes for consistent styling
    //     panel.className = "pdf-active-phrase-actions epub-active-phrase-actions";
    //     panel.style.position = "absolute";
    //     panel.style.left = `${Math.max(6, left)}px`;
    //     panel.style.top = `${Math.max(6, top)}px`;
    //     panel.style.zIndex = "100"; // Ensure it sits above foliate content
    //
    //     const stopBubble = (e) => {
    //         e.preventDefault();
    //         e.stopPropagation();
    //     };
    //     const stopPropagationOnly = (e) => {
    //         e.stopPropagation();
    //     };
    //     const guardPointerEvents = (el) => {
    //         if (!el) return;
    //         el.addEventListener("pointerdown", stopPropagationOnly);
    //         el.addEventListener("pointerup", stopPropagationOnly);
    //         el.addEventListener("mousedown", stopPropagationOnly);
    //         el.addEventListener("mouseup", stopPropagationOnly);
    //         el.addEventListener("touchstart", stopPropagationOnly, { passive: true });
    //         el.addEventListener("touchend", stopPropagationOnly, { passive: true });
    //     };
    //
    //     guardPointerEvents(panel);
    //
    //     const copyBtn = document.createElement("button");
    //     copyBtn.type = "button";
    //     copyBtn.className = "pdf-active-phrase-btn";
    //     copyBtn.title = "Copy current phrase";
    //     copyBtn.setAttribute("aria-label", "Copy current phrase");
    //     copyBtn.innerHTML = '<span class="material-symbols-outlined">content_copy</span>';
    //     guardPointerEvents(copyBtn);
    //     copyBtn.addEventListener("click", async (e) => {
    //         stopBubble(e);
    //         await this.app.interactionHandler?.copyCurrentPhraseToClipboard?.({
    //             successMessage: "Current phrase copied",
    //         });
    //     });
    //
    //     const highlightBtn = document.createElement("button");
    //     highlightBtn.type = "button";
    //     highlightBtn.className = "pdf-active-phrase-btn";
    //     if (highlighted) highlightBtn.classList.add("is-active");
    //     highlightBtn.setAttribute("aria-pressed", highlighted ? "true" : "false");
    //     highlightBtn.title = highlighted ? "Remove highlight" : "Toggle highlight";
    //     highlightBtn.setAttribute("aria-label", highlighted ? "Remove highlight" : "Toggle highlight");
    //     highlightBtn.innerHTML = '<span class="material-symbols-outlined">format_ink_highlighter</span>';
    //     guardPointerEvents(highlightBtn);
    //     highlightBtn.addEventListener("click", (e) => {
    //         stopBubble(e);
    //         this.app.highlightManager?.toggleCurrentSentenceHighlight?.({ showMessage: true });
    //     });
    //
    //     const commentBtn = document.createElement("button");
    //     commentBtn.type = "button";
    //     commentBtn.className = "pdf-active-phrase-btn";
    //     if (hasComment) commentBtn.classList.add("is-active");
    //     commentBtn.setAttribute("aria-pressed", hasComment ? "true" : "false");
    //     commentBtn.title = hasComment ? "Edit comment" : "Add comment";
    //     commentBtn.setAttribute("aria-label", hasComment ? "Edit comment" : "Add comment");
    //     commentBtn.innerHTML = '<span class="material-symbols-outlined">comment</span>';
    //     guardPointerEvents(commentBtn);
    //     commentBtn.addEventListener("click", async (e) => {
    //         stopBubble(e);
    //         await this.app.interactionHandler?.promptCommentForSelection?.([sentenceIndex]);
    //     });
    //
    //     panel.appendChild(copyBtn);
    //     panel.appendChild(highlightBtn);
    //     panel.appendChild(commentBtn);
    //     container.appendChild(panel);
    //     this._activePhraseActionsEl = panel;
    //
    //     // --- Prevent right overflow ---
    //     requestAnimationFrame(() => {
    //         if (!panel.isConnected) return;
    //         const pRect = panel.getBoundingClientRect();
    //         if (pRect.right > window.innerWidth) {
    //             const shift = pRect.right - window.innerWidth + 8;
    //             panel.style.left = `${parseFloat(panel.style.left) - shift}px`;
    //         }
    //     });
    // }
    _renderActivePhraseActions(highlightEl, sentenceIndex, highlighted, hasComment) {
        if (!highlightEl || !highlightEl.isConnected) return;
        this._removeActivePhraseActions();

        const container = this._container;
        if (!container) return;

        // Get bounding rect of the first line of the highlight
        const firstChild = highlightEl.firstElementChild || highlightEl;
        const anchorRect = firstChild.getBoundingClientRect();

        // Calculate absolute position considering EPUB iframes
        const frame = highlightEl.ownerDocument?.defaultView?.frameElement;
        let frameOffsetX = 0;
        let frameOffsetY = 0;
        if (frame) {
            const frameRect = frame.getBoundingClientRect();
            frameOffsetX = frameRect.left;
            frameOffsetY = frameRect.top;
        }

        const containerRect = container.getBoundingClientRect();

        // Target the horizontal center of the highlighted phrase
        const absLeft = anchorRect.left + frameOffsetX + anchorRect.width / 2;
        const absTop = anchorRect.top + frameOffsetY;

        const left = absLeft - containerRect.left;
        const top = absTop - containerRect.top - 34; // 34px offset for the popup

        const panel = document.createElement("div");
        panel.className = "pdf-active-phrase-actions epub-active-phrase-actions";
        panel.style.position = "absolute";
        panel.style.left = `${left}px`;
        panel.style.top = `${Math.max(6, top)}px`;
        panel.style.transform = "translateX(-50%)"; // Center visually
        panel.style.zIndex = "100";

        const stopBubble = (e) => {
            e.preventDefault();
            e.stopPropagation();
        };
        const stopPropagationOnly = (e) => {
            e.stopPropagation();
        };
        const guardPointerEvents = (el) => {
            if (!el) return;
            el.addEventListener("pointerdown", stopPropagationOnly);
            el.addEventListener("pointerup", stopPropagationOnly);
            el.addEventListener("mousedown", stopPropagationOnly);
            el.addEventListener("mouseup", stopPropagationOnly);
            el.addEventListener("touchstart", stopPropagationOnly, { passive: true });
            el.addEventListener("touchend", stopPropagationOnly, { passive: true });
        };

        guardPointerEvents(panel);

        const copyBtn = document.createElement("button");
        copyBtn.type = "button";
        copyBtn.className = "pdf-active-phrase-btn";
        copyBtn.title = "Copy current phrase";
        copyBtn.setAttribute("aria-label", "Copy current phrase");
        copyBtn.innerHTML = '<span class="material-symbols-outlined">content_copy</span>';
        guardPointerEvents(copyBtn);
        copyBtn.addEventListener("click", async (e) => {
            stopBubble(e);
            await this.app.interactionHandler?.copyCurrentPhraseToClipboard?.({
                successMessage: "Current phrase copied",
            });
        });

        const highlightBtn = document.createElement("button");
        highlightBtn.type = "button";
        highlightBtn.className = "pdf-active-phrase-btn";
        if (highlighted) highlightBtn.classList.add("is-active");
        highlightBtn.setAttribute("aria-pressed", highlighted ? "true" : "false");
        highlightBtn.title = highlighted ? "Remove highlight" : "Toggle highlight";
        highlightBtn.setAttribute("aria-label", highlighted ? "Remove highlight" : "Toggle highlight");
        highlightBtn.innerHTML = '<span class="material-symbols-outlined">format_ink_highlighter</span>';
        guardPointerEvents(highlightBtn);
        highlightBtn.addEventListener("click", (e) => {
            stopBubble(e);
            this.app.highlightManager?.toggleCurrentSentenceHighlight?.({ showMessage: true });
        });

        const commentBtn = document.createElement("button");
        commentBtn.type = "button";
        commentBtn.className = "pdf-active-phrase-btn";
        if (hasComment) commentBtn.classList.add("is-active");
        commentBtn.setAttribute("aria-pressed", hasComment ? "true" : "false");
        commentBtn.title = hasComment ? "Edit comment" : "Add comment";
        commentBtn.setAttribute("aria-label", hasComment ? "Edit comment" : "Add comment");
        commentBtn.innerHTML = '<span class="material-symbols-outlined">comment</span>';
        guardPointerEvents(commentBtn);
        commentBtn.addEventListener("click", async (e) => {
            stopBubble(e);
            await this.app.interactionHandler?.promptCommentForSelection?.([sentenceIndex]);
        });

        panel.appendChild(copyBtn);
        panel.appendChild(highlightBtn);
        panel.appendChild(commentBtn);
        container.appendChild(panel);
        this._activePhraseActionsEl = panel;

        // --- Prevent both left and right overflow ---
        requestAnimationFrame(() => {
            if (!panel.isConnected) return;
            const pRect = panel.getBoundingClientRect();

            if (pRect.right > window.innerWidth) {
                // If bleeding off the right side
                const shift = pRect.right - window.innerWidth + 8;
                panel.style.left = `${parseFloat(panel.style.left) - shift}px`;
            } else if (pRect.left < 0) {
                // If bleeding off the left side
                const shift = Math.abs(pRect.left) + 8;
                panel.style.left = `${parseFloat(panel.style.left) + shift}px`;
            }
        });
    }

    // OLD
    // _handleDrawAnnotation(event) {
    //     const detail = event?.detail;
    //     if (!detail?.draw) return;
    //     const annotationColor = detail.annotation?.color;
    //     const cfi = detail.annotation?.value;
    //     const color = annotationColor || this._activeHighlightColor;
    //
    //     let opacity = null;
    //     let isActive = false;
    //
    //     // Detect if this annotation belongs to the active sentence
    //     if (
    //         annotationColor === this._activeHighlightColor ||
    //         (!annotationColor && this._activeAnnotationValue === cfi)
    //     ) {
    //         opacity = "0.18";
    //         isActive = true;
    //     } else if (annotationColor === this._hoverHighlightColor) {
    //         opacity = "0.12";
    //     }
    //
    //     const drawHighlight = (rects, options = {}) => {
    //         const el = Overlayer.highlight(rects, options);
    //         if (opacity !== null) {
    //             el.style.opacity = opacity;
    //         }
    //
    //         // Only attach the action popup to the active sentence
    //         if (isActive && rects.length > 0) {
    //             const state = this.app.state;
    //             const sentenceIndex = state.sentences?.findIndex((s) => s.cfi === cfi) ?? -1;
    //
    //             if (sentenceIndex >= 0) {
    //                 const savedData = state.savedHighlights?.get(sentenceIndex);
    //                 const isHighlighted = !!savedData;
    //                 const hasComment = typeof savedData?.comment === "string" && savedData.comment.trim().length > 0;
    //
    //                 // Defer UI placement briefly to ensure Foliate has attached 'el' to the DOM
    //                 requestAnimationFrame(() => {
    //                     this._renderActivePhraseActions(el, sentenceIndex, isHighlighted, hasComment);
    //                 });
    //             }
    //         }
    //         return el;
    //     };
    //
    //     try {
    //         detail.draw(drawHighlight, { color });
    //     } catch (error) {
    //         console.warn("[EPUBRenderer] Failed to draw annotation", error);
    //     }
    // }
    _handleDrawAnnotation(event) {
        const detail = event?.detail;
        if (!detail?.draw) return;
        const annotationColor = detail.annotation?.color;
        const cfi = detail.annotation?.value;
        const color = annotationColor || this._activeHighlightColor;

        let opacity = null;
        let isActive = false;

        // Detect if this annotation belongs to the active sentence
        if (this._activeAnnotationValue && this._activeAnnotationValue === cfi) {
            opacity = "0.18";
            isActive = true;
        } else if (annotationColor === this._hoverHighlightColor) {
            opacity = "0.12";
        }

        const drawHighlight = (rects, options = {}) => {
            const el = Overlayer.highlight(rects, options);

            // --- CRITICAL FIX: Prevent the highlight overlay from swallowing mouse events ---
            el.style.pointerEvents = "none";

            if (opacity !== null) {
                el.style.opacity = opacity;
            }

            // Only attach the action popup to the active sentence
            if (isActive && rects.length > 0) {
                const state = this.app.state;
                const sentenceIndex = state.sentences?.findIndex((s) => s.cfi === cfi) ?? -1;

                if (sentenceIndex >= 0) {
                    const savedData = state.savedHighlights?.get(sentenceIndex);
                    const isHighlighted = !!savedData;
                    const hasComment = typeof savedData?.comment === "string" && savedData.comment.trim().length > 0;

                    // Defer UI placement briefly to ensure Foliate has attached 'el' to the DOM
                    requestAnimationFrame(() => {
                        this._renderActivePhraseActions(el, sentenceIndex, isHighlighted, hasComment);
                    });
                }
            }
            return el;
        };

        try {
            detail.draw(drawHighlight, { color });
        } catch (error) {
            console.warn("[EPUBRenderer] Failed to draw annotation", error);
        }
    }

    renderHoverHighlightFullDoc() {
        const { state } = this.app;
        if (!this.view || !state?.sentences?.length) {
            this._applyHoverHighlight(null);
            return;
        }

        const hoveredIdx = state.hoveredSentenceIndex;
        const activeIdx = state.playingSentenceIndex >= 0 ? state.playingSentenceIndex : state.currentSentenceIndex;

        if (hoveredIdx == null || hoveredIdx < 0 || hoveredIdx >= state.sentences.length || hoveredIdx === activeIdx) {
            this._applyHoverHighlight(null);
            return;
        }

        const sentence = state.sentences[hoveredIdx];
        if (!sentence?.cfi) {
            this._applyHoverHighlight(null);
            return;
        }

        this._applyHoverHighlight(sentence.cfi);
    }

    updateHighlightFullDoc(sentence) {
        const targetCfi = sentence?.cfi || this.app?.state?.currentSentence?.cfi || this._activeAnnotationValue;
        if (targetCfi) {
            this._applySentenceHighlight(targetCfi);
        }
        this.renderHoverHighlightFullDoc();
    }

    async renderSentence(idx, options = {}) {
        const { state } = this.app;
        if (!state?.sentences?.length) return null;
        if (idx == null || idx < 0 || idx >= state.sentences.length) return null;

        const sentence = state.sentences[idx];
        state.currentSentenceIndex = idx;

        if (sentence?.cfi && this.view) {
            try {
                await this.view.goTo(sentence.cfi);
            } catch (error) {
                console.warn("[EPUBRenderer] Navigation error", error);
            }
            await this._applySentenceHighlight(sentence.cfi);
            this._clearTextSelections();
        }

        if (!options?.autoAdvance && state.generationEnabled) {
            this.app.ttsQueue.add(idx, {
                priority: "critical",
                force: true,
            });
            this.app.ttsEngine.schedulePrefetch();
        }

        this.app.progressManager.saveProgress();

        return sentence;
    }

    // OLD
    // scrollSentenceIntoView(sentence) {
    //     if (!sentence?.cfi || !this.view?.resolveCFI || !this.view?.renderer?.scrollToAnchor) return;
    //     try {
    //         const resolved = this.view.resolveCFI(sentence.cfi);
    //         if (!resolved?.anchor) return;
    //         const contents = this.view.renderer.getContents?.() ?? [];
    //         const target = contents.find((entry) => entry.index === resolved.index);
    //         const doc = target?.doc;
    //         if (!doc) return;
    //         const range = resolved.anchor(doc);
    //         if (range) {
    //             this.view.renderer.scrollToAnchor(range, true);
    //             this._clearTextSelections();
    //         }
    //     } catch (error) {
    //         console.debug("[EPUBRenderer] Unable to scroll into view", error);
    //     }
    // }
    scrollSentenceIntoView(sentence) {
        if (!sentence?.cfi || !this.view?.resolveCFI || !this.view?.renderer?.scrollToAnchor) return;
        try {
            const resolved = this.view.resolveCFI(sentence.cfi);
            if (!resolved?.anchor) return;
            const contents = this.view.renderer.getContents?.() ?? [];
            const target = contents.find((entry) => entry.index === resolved.index);
            const doc = target?.doc;
            if (!doc) return;

            const range = resolved.anchor(doc);
            if (range) {
                // If we are in scrolled mode, force the element to the center of the viewport
                if (this.view.renderer.getAttribute("flow") === "scrolled") {
                    const el =
                        range.startContainer.nodeType === 3 /* Node.TEXT_NODE */
                            ? range.startContainer.parentElement
                            : range.startContainer;

                    if (el && typeof el.scrollIntoView === "function") {
                        el.scrollIntoView({ behavior: "smooth", block: "center" });
                        this._clearTextSelections();
                        return;
                    }
                }

                // Fallback for paginated or if scrollIntoView fails
                this.view.renderer.scrollToAnchor(range, true);
                this._clearTextSelections();
            }
        } catch (error) {
            console.debug("[EPUBRenderer] Unable to scroll into view", error);
        }
    }

    handleViewportHeightChange() {
        this._resizeContainer();
        const current = this.app?.state?.currentSentence;
        if (current) this.scrollSentenceIntoView(current);
    }

    _ensureContainer() {
        if (!this._container || !document.body.contains(this._container)) {
            this._container = document.getElementById("epub-doc-container");
        }
        if (!this._container) {
            throw new Error("EPUB container element not found.");
        }
        this._container.classList.add("relative", "flex", "flex-col", "w-full");
        this._container.classList.remove("hidden");
        this._container.style.position = this._container.style.position || "relative";
        return this._container;
    }

    _resizeContainer() {
        if (!this._container) return;
        const rect = this._container.getBoundingClientRect();
        const availableHeight = Math.max(window.innerHeight - rect.top, 0);
        this._container.style.height = `${availableHeight}px`;
        if (this._viewWrapper) {
            this._viewWrapper.style.height = "100%";
        }
        if (this.view) {
            this.view.style.height = "100%";
        }
    }

    _bindGlobalKeys() {
        if (this._globalKeysBound) return;
        window.addEventListener("keydown", this._onKeydown, { passive: false });
        this._globalKeysBound = true;
    }

    _unbindGlobalKeys() {
        if (!this._globalKeysBound) return;
        window.removeEventListener("keydown", this._onKeydown);
        this._globalKeysBound = false;
    }

    _bindZoomListeners() {
        if (!this._container) return;
        window.addEventListener("keydown", this._boundZoomKeydown, { passive: false });
        this._container.addEventListener("touchstart", this._boundTouchStart, { passive: true });
        this._container.addEventListener("touchmove", this._boundTouchMove, { passive: false });
        this._container.addEventListener("touchend", this._boundTouchEnd, { passive: true });
    }

    _unbindZoomListeners() {
        if (!this._container) return;
        window.removeEventListener("keydown", this._boundZoomKeydown);
        this._container.removeEventListener("touchstart", this._boundTouchStart);
        this._container.removeEventListener("touchmove", this._boundTouchMove);
        this._container.removeEventListener("touchend", this._boundTouchEnd);
    }

    _handleDirectionalKeydown(event) {
        if (!this.view) return;
        const tag = event.target?.tagName || "";
        if (/^(INPUT|TEXTAREA|SELECT)$/i.test(tag)) return;

        if (event.key === "ArrowLeft") {
            event.preventDefault();
            this.view.goLeft();
        } else if (event.key === "ArrowRight" || event.key === "l") {
            event.preventDefault();
            this.view.goRight();
        }
    }

    _handleZoomKeydown(event) {
        if (!this.view) return;
        const tag = event.target?.tagName || "";
        if (/^(INPUT|TEXTAREA|SELECT)$/i.test(tag)) return;

        // Ctrl/Cmd + Plus or Ctrl/Cmd + Equals (zoom in)
        if ((event.ctrlKey || event.metaKey) && (event.key === "+" || event.key === "=")) {
            event.preventDefault();
            this.increaseFontSize();
        }
        // Ctrl/Cmd + Minus (zoom out)
        else if ((event.ctrlKey || event.metaKey) && event.key === "-") {
            event.preventDefault();
            this.decreaseFontSize();
        }
        // Ctrl/Cmd + 0 (reset to default)
        else if ((event.ctrlKey || event.metaKey) && event.key === "0") {
            event.preventDefault();
            this.setFontSize(100);
        }
    }

    _handleTouchStart(event) {
        if (event.touches.length !== 2) {
            this._initialTouchDistance = 0;
            return;
        }
        const touch1 = event.touches[0];
        const touch2 = event.touches[1];
        const dx = touch1.clientX - touch2.clientX;
        const dy = touch1.clientY - touch2.clientY;
        this._initialTouchDistance = Math.sqrt(dx * dx + dy * dy);
    }

    _handleTouchMove(event) {
        if (event.touches.length !== 2 || this._initialTouchDistance === 0) return;
        event.preventDefault();

        const touch1 = event.touches[0];
        const touch2 = event.touches[1];
        const dx = touch1.clientX - touch2.clientX;
        const dy = touch1.clientY - touch2.clientY;
        const currentDistance = Math.sqrt(dx * dx + dy * dy);

        // Calculate zoom delta
        const delta = currentDistance - this._initialTouchDistance;
        if (Math.abs(delta) > 10) {
            // Only trigger if significant pinch
            if (delta > 0) {
                this.increaseFontSize();
            } else {
                this.decreaseFontSize();
            }
            this._initialTouchDistance = currentDistance;
        }
    }

    _handleTouchEnd(event) {
        this._initialTouchDistance = 0;
    }

    _handleViewLoad(event) {
        const doc = event?.detail?.doc;
        if (!doc || this._activeDocs.has(doc)) return;
        doc.addEventListener("keydown", this._onKeydown, { passive: false });
        this._activeDocs.add(doc);
        this.setupInteractionListeners();
    }

    _clearTextSelections() {
        if (typeof this.view?.deselect === "function") {
            try {
                this.view.deselect();
            } catch (error) {
                console.debug("[EPUBRenderer] Unable to use view.deselect", error);
            }
        }
        if (!this.view?.renderer?.getContents) return;
        const contents = this.view.renderer.getContents();
        for (const entry of contents) {
            const doc = entry?.doc;
            if (!doc) continue;
            try {
                const winSelection = doc.defaultView?.getSelection?.();
                if (winSelection?.rangeCount) winSelection.removeAllRanges();
            } catch (error) {
                console.debug("[EPUBRenderer] Unable to clear window selection", error);
            }
            try {
                const docSelection = doc.getSelection?.();
                if (docSelection?.rangeCount) docSelection.removeAllRanges();
            } catch (error) {
                console.debug("[EPUBRenderer] Unable to clear document selection", error);
            }
        }
    }

    // OLD
    // _applyReaderStyles() {
    //     if (!this.view?.renderer) return;
    //     if (typeof this.view.renderer.setStyles === "function") {
    //         // this.view.renderer.setStyles(buildReaderCSS(this._readerSettings));
    //     }
    //     if (!this.view.renderer.hasAttribute("flow")) {
    //         this.view.renderer.setAttribute("flow", "paginated");
    //     }
    //     if (typeof this.view.renderer.next === "function") {
    //         this.view.renderer.next();
    //     }
    // }
    //
    _applyReaderStyles() {
        if (!this.view?.renderer) return;
        
        // Build CSS with font size
        const fontSize = this._readerSettings.fontSize || 100;
        const css = `
            * { font-size: calc(1em * ${fontSize / 100}) !important; }
        `;
        
        if (typeof this.view.renderer.setStyles === "function") {
            try {
                this.view.renderer.setStyles(css);
            } catch (error) {
                console.debug("[EPUBRenderer] Error applying styles", error);
            }
        }
        
        // Switch from "paginated" to "scrolled" to prevent phrases from splitting across pages
        if (!this.view.renderer.hasAttribute("flow")) {
            this.view.renderer.setAttribute("flow", "scrolled");
        }
        if (typeof this.view.renderer.next === "function") {
            this.view.renderer.next();
        }
    }

    _detachInteractionListeners() {
        if (!Array.isArray(this._docListeners) || !this._docListeners.length) return;
        for (const { doc, type, handler, options } of this._docListeners) {
            try {
                doc?.removeEventListener(type, handler, options);
            } catch (error) {
                console.debug("[EPUBRenderer] Unable to remove document listener", error);
            }
        }
        this._docListeners = [];
    }

    async _handleDocumentClick(event, sectionIndex) {
        if (!this.app?.state?.sentences?.length) return;
        const doc = event.currentTarget;
        if (event.defaultPrevented) return;
        if (event.target?.closest?.("a[href]")) return;

        const sentenceIndex = this._resolveSentenceIndexFromEvent(doc, event, sectionIndex);
        if (sentenceIndex < 0) return;

        const wasPlaying = !!this.app?.state?.isPlaying;
        try {
            await this.app?.audioManager?.stopPlayback?.(true);
        } catch (error) {
            console.debug("[EPUBRenderer] Failed to stop playback", error);
        }
        if (this.app?.state) {
            this.app.state.autoAdvanceActive = false;
        }

        await this.renderSentence(sentenceIndex);

        if (wasPlaying) {
            await this.app.audioManager.playCurrentSentence();
        }

        event.preventDefault();
        event.stopPropagation();
    }

    _rangeFromPoint(doc, event) {
        if (!doc) return null;
        const point = event.touches?.[0] ?? event;
        const x = point?.clientX;
        const y = point?.clientY;
        if (typeof x !== "number" || typeof y !== "number") return null;

        let range = null;
        if (typeof doc.caretRangeFromPoint === "function") {
            range = doc.caretRangeFromPoint(x, y);
        }
        if (!range && typeof doc.caretPositionFromPoint === "function") {
            const pos = doc.caretPositionFromPoint(x, y);
            if (pos) {
                range = doc.createRange();
                range.setStart(pos.offsetNode, pos.offset);
            }
        }
        if (!range) return null;

        if (range.collapsed) {
            const node = range.startContainer;
            if (node?.nodeType === Node.TEXT_NODE) {
                const length = node.nodeValue?.length ?? 0;
                const start = range.startOffset;
                const end = start < length ? start + 1 : start;
                range.setEnd(node, Math.min(length, end));
            }
        }
        return range;
    }

    _resolveSentenceIndexFromEvent(doc, event, sectionIndex) {
        if (!this.view || !doc) return -1;
        const selection = doc.defaultView?.getSelection?.();
        if (selection && selection.toString().length) return -1;

        const range = this._rangeFromPoint(doc, event);
        if (!range) return -1;

        let cfi;
        try {
            cfi = this.view.getCFI(sectionIndex, range);
        } catch (error) {
            console.debug("[EPUBRenderer] CFI resolution error", error);
            return -1;
        }

        return this.loader?.findSentenceIndexInSection(sectionIndex, cfi) ?? -1;
    }

    // _handleDocumentPointerMove(event, sectionIndex, docOverride) {
    //     if (!this.app?.state?.sentences?.length) return;
    //     const doc = docOverride || event.currentTarget;
    //     if (!doc) return;
    //     if (event?.target?.closest?.("a[href]")) {
    //         this._setHoveredSentence(-1);
    //         return;
    //     }
    //     const idx = this._resolveSentenceIndexFromEvent(doc, event, sectionIndex);
    //     if (idx >= 0) this._setHoveredSentence(idx);
    //     else this._setHoveredSentence(-1);
    // }
    _handleDocumentPointerMove(event, sectionIndex, docOverride) {
        if (!this.app?.state?.sentences?.length) return;
        const doc = docOverride || event.currentTarget;
        if (!doc) return;
        if (event?.target?.closest?.("a[href]")) {
            this._setHoveredSentence(-1, doc);
            return;
        }
        const idx = this._resolveSentenceIndexFromEvent(doc, event, sectionIndex);

        // Pass the resolved index and the document
        this._setHoveredSentence(idx >= 0 ? idx : -1, doc);
    }

    _handleDocumentTouchMove(event, sectionIndex, doc) {
        const touch = event.touches?.[0] ?? event.changedTouches?.[0];
        if (!touch) return;
        const target = doc?.elementFromPoint?.(touch.clientX, touch.clientY) ?? event.target;
        const syntheticEvent = {
            clientX: touch.clientX,
            clientY: touch.clientY,
            target,
            type: event.type,
        };
        this._handleDocumentPointerMove(syntheticEvent, sectionIndex, doc);
    }

    async _applySentenceHighlight(cfi) {
        if (!this.view || !cfi) return;
        const previousValue = this._activeAnnotationValue;
        if (this._activeAnnotationValue) {
            try {
                await this.view.deleteAnnotation({ value: this._activeAnnotationValue });
            } catch (error) {
                console.debug("[EPUBRenderer] Unable to delete previous annotation", error);
            }
            this._removeActivePhraseActions();
        }

        // Restore previous active sentence as a persistent saved highlight when applicable.
        if (previousValue && previousValue !== cfi) {
            const previousSavedColor = this._getSavedHighlightColorByCfi(previousValue);
            if (previousSavedColor) {
                this.view.addAnnotation({ value: previousValue, color: previousSavedColor }).catch(() => {});
                this._persistentAnnotationValues.add(previousValue);
            }
        }

        const activeSavedColor = this._getSavedHighlightColorByCfi(cfi);
        const activeColor = activeSavedColor || this._activeHighlightColor;

        try {
            await this.view.addAnnotation({ value: cfi, color: activeColor });
            this._activeAnnotationValue = cfi;
            this._clearTextSelections();
        } catch (error) {
            console.warn("[EPUBRenderer] Failed to apply highlight", error);
            this._activeAnnotationValue = null;
        }
    }

    _getSavedHighlightColorByCfi(cfi) {
        if (!cfi) return null;
        const state = this.app?.state;
        const saved = state?.savedHighlights;
        if (!state || !(saved instanceof Map) || !saved.size || !Array.isArray(state.sentences)) return null;

        for (const [sentenceIndex, highlightData] of saved.entries()) {
            if (!highlightData?.color) continue;
            const sentenceCfi = state.sentences?.[sentenceIndex]?.cfi;
            if (sentenceCfi === cfi) return highlightData.color;
        }

        return null;
    }

    _applyHoverHighlight(cfi) {
        if (!this.view) {
            if (!cfi) this._hoverAnnotationValue = null;
            return;
        }
        if (!cfi) {
            if (this._hoverAnnotationValue) {
                const value = this._hoverAnnotationValue;
                this.view.deleteAnnotation({ value }).catch(() => {});
            }
            this._hoverAnnotationValue = null;
            return;
        }

        if (this._hoverAnnotationValue === cfi) return;
        const previous = this._hoverAnnotationValue;
        this._hoverAnnotationValue = cfi;
        if (previous && previous !== cfi) {
            this.view.deleteAnnotation({ value: previous }).catch(() => {});
        }

        this.view.addAnnotation({ value: cfi, color: this._hoverHighlightColor }).catch((error) => {
            console.debug("[EPUBRenderer] Failed to apply hover highlight", error);
            if (this._hoverAnnotationValue === cfi) {
                this._hoverAnnotationValue = null;
            }
        });
    }

    // _setHoveredSentence(idx) {
    //     const { state } = this.app;
    //     if (!state) return;
    //     if (state.hoveredSentenceIndex === idx) return;
    //     state.hoveredSentenceIndex = idx;
    //     this.renderHoverHighlightFullDoc();
    // }
    _setHoveredSentence(idx, doc = null) {
        const { state } = this.app;
        if (!state) return;

        // --- NEW: Visual feedback to show the phrase is clickable ---
        if (doc && doc.body) {
            doc.body.style.cursor = idx >= 0 ? "pointer" : "";
        }

        if (state.hoveredSentenceIndex === idx) return;
        state.hoveredSentenceIndex = idx;
        this.renderHoverHighlightFullDoc();
    }
}
