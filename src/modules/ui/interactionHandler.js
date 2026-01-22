import { mapClientPointToPdf, hitTestSentence } from "../utils/coordinates.js";

export class InteractionHandler {
    constructor(app) {
        this.app = app;
        this._pdfListenersAttached = false;
        this._pdfListeners = [];

        this._textSelect = {
            active: false,
            pageNumber: null,
            wrapper: null,
            canvas: null,
            startClientX: 0,
            startClientY: 0,
            isDragging: false,
            selectedText: "",
            selectedTextOneLine: "",
            lineModel: null,
            selectedSentenceIndices: [],
        };
        this._suppressNextClick = false;

        this._selectionMenuEl = null;
        this._selectionMenuCleanup = null;
    }

    _normalizeSelectionText(text, { singleLine = false } = {}) {
        if (!text || typeof text !== "string") return "";
        const trimmed = text.trim();
        if (!trimmed) return "";
        if (!singleLine) return trimmed;
        return trimmed.replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim();
    }

    _getSelectionTextForCopy() {
        return this._normalizeSelectionText(this._textSelect.selectedTextOneLine || this._textSelect.selectedText, {
            singleLine: true,
        });
    }

    async _handleSelectionCopyShortcut(e) {
        const { state } = this.app;
        if (state.currentDocumentType !== "pdf") return;
        if (state.viewMode !== "full") return;

        const tag = e.target?.tagName || "";
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || e.target?.isContentEditable) return;

        const isCopy = (e.ctrlKey || e.metaKey) && (e.code === "KeyC" || e.key === "c" || e.key === "C");
        if (!isCopy) return;

        const text = this._getSelectionTextForCopy();
        if (!text) return;

        e.preventDefault();
        await this._copyTextToClipboard(text);
    }

    _clearPdfTextSelectionOverlays() {
        const container = document.getElementById("pdf-doc-container");
        if (!container) return;
        container.querySelectorAll(".pdf-text-selection").forEach((n) => n.remove());
    }

    _buildSelectedTextFromWords(words) {
        if (!Array.isArray(words) || !words.length) return "";

        // Sort by y then x to approximate reading order.
        const sorted = [...words].sort((a, b) => {
            const ay = Number.isFinite(a._selTopPx) ? a._selTopPx : 0;
            const by = Number.isFinite(b._selTopPx) ? b._selTopPx : 0;
            if (ay !== by) return ay - by;
            const ax = Number.isFinite(a._selLeftPx) ? a._selLeftPx : 0;
            const bx = Number.isFinite(b._selLeftPx) ? b._selLeftPx : 0;
            return ax - bx;
        });

        const parts = [];
        let lastTop = null;
        for (const w of sorted) {
            const t = (w?.text || "").trim();
            if (!t) continue;
            const top = Number.isFinite(w._selTopPx) ? w._selTopPx : null;
            if (lastTop != null && top != null && Math.abs(top - lastTop) > 8) {
                parts.push("\n");
            } else if (parts.length && parts[parts.length - 1] !== "\n") {
                parts.push(" ");
            }
            parts.push(t);
            lastTop = top;
        }

        return parts.join("").replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").trim();
    }

    _buildPageLineModel({ state, wrapper, canvas, pageNumber }) {
        const indices = state.pageSentencesIndex.get(pageNumber);
        if (!indices) return null;

        const { scaleX, scaleY } = this.app.pdfRenderer.getPageScaleFactors(wrapper, canvas, pageNumber);

        const items = [];
        for (const idx of indices) {
            const s = state.sentences[idx];
            if (!s) continue;
            const words = (() => {
                const readable = this.app.pdfRenderer.getReadableWords(s);
                return readable.length ? readable : s.words;
            })();
            if (!Array.isArray(words) || !words.length) continue;

            for (const w of words) {
                if (!w) continue;
                if (!Number.isFinite(w.x) || !Number.isFinite(w.y) || !Number.isFinite(w.width) || !Number.isFinite(w.height)) {
                    continue;
                }

                const correctedTop = this.app.pdfRenderer.getCorrectedVerticalPosition(w, 1, pageNumber);
                const leftPx = w.x * scaleX;
                const topPx = correctedTop * scaleY;
                const widthPx = Math.max(1, w.width * scaleX);
                const heightPx = Math.max(1, w.height * scaleY);

                const text = (w.str ?? w.text ?? "");
                items.push({ leftPx, topPx, widthPx, heightPx, text, sentenceIndex: idx });
            }
        }

        if (!items.length) return null;
        items.sort((a, b) => a.topPx - b.topPx || a.leftPx - b.leftPx);

        const yTolerance = 3;
        const lines = [];
        for (const it of items) {
            const top = it.topPx;
            const bottom = it.topPx + it.heightPx;
            const left = it.leftPx;
            const right = it.leftPx + it.widthPx;

            const last = lines[lines.length - 1];
            if (!last || Math.abs(top - last.topPx) > yTolerance) {
                lines.push({
                    topPx: top,
                    bottomPx: bottom,
                    leftPx: left,
                    rightPx: right,
                    words: [it],
                });
            } else {
                last.topPx = Math.min(last.topPx, top);
                last.bottomPx = Math.max(last.bottomPx, bottom);
                last.leftPx = Math.min(last.leftPx, left);
                last.rightPx = Math.max(last.rightPx, right);
                last.words.push(it);
            }
        }

        // Ensure words in each line are ordered left->right
        for (const line of lines) {
            line.words.sort((a, b) => a.leftPx - b.leftPx);
        }

        return { lines, scaleX, scaleY };
    }

    _findLineIndexAtY(lines, yPx) {
        if (!Array.isArray(lines) || !lines.length || !Number.isFinite(yPx)) return -1;
        // Prefer containment.
        for (let i = 0; i < lines.length; i++) {
            const l = lines[i];
            if (yPx >= l.topPx && yPx <= l.bottomPx) return i;
        }
        // Otherwise pick closest line by center.
        let bestIdx = 0;
        let bestDist = Infinity;
        for (let i = 0; i < lines.length; i++) {
            const l = lines[i];
            const center = (l.topPx + l.bottomPx) / 2;
            const d = Math.abs(center - yPx);
            if (d < bestDist) {
                bestDist = d;
                bestIdx = i;
            }
        }
        return bestIdx;
    }

    _buildSelectedTextFromLines(lines) {
        if (!Array.isArray(lines) || !lines.length) return "";
        return lines
            .map((l) =>
                l.words
                    .map((w) => (w?.text ? String(w.text).trim() : ""))
                    .filter(Boolean)
                    .join(" ")
                    .trim(),
            )
            .filter(Boolean)
            .join("\n")
            .trim();
    }

    async _copyTextToClipboard(text) {
        if (!text) return;
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                this.app.ui?.showInfo?.("Copied selection");
                return;
            }
        } catch (_) {
            // fall back
        }

        try {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            const ok = document.execCommand("copy");
            document.body.removeChild(ta);
            if (ok) this.app.ui?.showInfo?.("Copied selection");
        } catch (e) {
            console.warn("Copy failed", e);
        }
    }

    _hideSelectionMenu() {
        if (this._selectionMenuEl) {
            this._selectionMenuEl.remove();
            this._selectionMenuEl = null;
        }
        if (typeof this._selectionMenuCleanup === "function") {
            this._selectionMenuCleanup();
            this._selectionMenuCleanup = null;
        }
    }

    _showSelectionMenu({ clientX, clientY }) {
        const { state } = this.app;
        if (state.currentDocumentType !== "pdf") return;
        if (state.viewMode !== "full") return;

        const text = this._getSelectionTextForCopy();
        if (!text || !text.trim()) return;

        const sentenceIndices = Array.isArray(this._textSelect.selectedSentenceIndices)
            ? this._textSelect.selectedSentenceIndices
            : [];

        this._hideSelectionMenu();

        const menu = document.createElement("div");
        menu.className = "pdf-selection-menu";
        menu.style.left = `${Math.min(window.innerWidth - 10, Math.max(10, clientX))}px`;
        menu.style.top = `${Math.min(window.innerHeight - 10, Math.max(10, clientY))}px`;

        const copyBtn = document.createElement("button");
        copyBtn.type = "button";
        copyBtn.className = "pdf-selection-menu-btn";
        copyBtn.textContent = "Copy";
        copyBtn.addEventListener("click", async (e) => {
            e.preventDefault();
            e.stopPropagation();
            await this._copyTextToClipboard(text);
            this._hideSelectionMenu();
        });

        const highlightBtn = document.createElement("button");
        highlightBtn.type = "button";
        highlightBtn.className = "pdf-selection-menu-btn";
        highlightBtn.textContent = "Highlight";
        highlightBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();

            const color = state.selectedHighlightColor || "#FFF176";
            const now = Date.now();
            const unique = new Set(sentenceIndices);
            for (const idx of unique) {
                if (typeof idx !== "number" || idx < 0 || idx >= state.sentences.length) continue;
                const sentenceText = state.sentences[idx]?.text;
                state.savedHighlights.set(idx, {
                    color,
                    timestamp: now,
                    text: sentenceText || "",
                    sentenceText: sentenceText || "",
                });
            }

            this.app.highlightsStorage?.saveHighlightsForPdf?.();
            this.app.pdfRenderer?.updateHighlightFullDoc?.();
            this.app.controlsManager?.reflectSelectedHighlightColor?.();
            this.app.ui?.showInfo?.("Highlight Saved");
            this._hideSelectionMenu();
        });

        const commentBtn = document.createElement("button");
        commentBtn.type = "button";
        commentBtn.className = "pdf-selection-menu-btn";
        commentBtn.textContent = "Comment";
        commentBtn.addEventListener("click", async (e) => {
            e.preventDefault();
            e.stopPropagation();
            await this.promptCommentForSelection(sentenceIndices);
            this._hideSelectionMenu();
        });

        menu.appendChild(copyBtn);
        menu.appendChild(highlightBtn);
        menu.appendChild(commentBtn);
        document.body.appendChild(menu);
        this._selectionMenuEl = menu;

        const onDown = (e) => {
            if (!this._selectionMenuEl) return;
            if (e.target === this._selectionMenuEl || this._selectionMenuEl.contains(e.target)) return;
            this._hideSelectionMenu();
        };
        const onKey = (e) => {
            if (e.key === "Escape") this._hideSelectionMenu();
        };
        const onScroll = () => this._hideSelectionMenu();

        window.addEventListener("mousedown", onDown, { capture: true });
        window.addEventListener("keydown", onKey, { passive: true });
        window.addEventListener("scroll", onScroll, { passive: true, capture: true });
        this._selectionMenuCleanup = () => {
            window.removeEventListener("mousedown", onDown, { capture: true });
            window.removeEventListener("keydown", onKey);
            window.removeEventListener("scroll", onScroll, { capture: true });
        };
    }

    async promptCommentForSelection(sentenceIndicesOverride = null) {
        const { state } = this.app;
        if (state.currentDocumentType !== "pdf") return false;
        if (state.viewMode !== "full") return false;

        const sentenceIndices = Array.isArray(sentenceIndicesOverride)
            ? sentenceIndicesOverride
            : Array.isArray(this._textSelect?.selectedSentenceIndices)
                ? this._textSelect.selectedSentenceIndices
                : [];

        if (!sentenceIndices.length) return false;

        const unique = new Set(sentenceIndices);
        const firstIdx = unique.values().next().value;
        const existing = typeof firstIdx === "number" ? state.savedHighlights.get(firstIdx) : null;
        const existingComment = typeof existing?.comment === "string" ? existing.comment : "";
        const res = await this.app.ui?.showCommentPopup?.({
            title: "Comment",
            initialText: existingComment,
            allowRemove: existingComment.trim().length > 0,
        });
        if (!res) return true; // cancelled but handled

        const comment = res.action === "save" ? String(res.text || "").trim() : "";

        const color = state.selectedHighlightColor || "#FFF176";
        const now = Date.now();

        for (const idx of unique) {
            if (typeof idx !== "number" || idx < 0 || idx >= state.sentences.length) continue;
            const sentenceText = state.sentences[idx]?.text || "";
            const prev = state.savedHighlights.get(idx) || {};

            if (res.action === "remove" || !comment) {
                if (prev && typeof prev === "object" && "comment" in prev) {
                    const next = { ...prev };
                    delete next.comment;
                    if (next.color) state.savedHighlights.set(idx, next);
                }
                continue;
            }

            state.savedHighlights.set(idx, {
                ...prev,
                color: prev.color || color,
                timestamp: prev.timestamp || now,
                text: prev.text || sentenceText,
                sentenceText: prev.sentenceText || sentenceText,
                comment,
            });
        }

        this.app.highlightsStorage?.saveHighlightsForPdf?.();
        this.app.pdfRenderer?.updateHighlightFullDoc?.();
        this.app.ui?.showInfo?.(comment ? "Comment Saved" : "Comment Removed");
        return true;
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

        if (this._suppressNextClick) {
            this._suppressNextClick = false;
            return;
        }

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
            const mouseMove = (e) => {
                if (this._textSelect.active) {
                    this._updatePdfDragSelection(e);
                    return;
                }
                this.handlePointerMove(e);
            };
            const mouseLeave = () => this.setHoveredSentence(-1);
            const click = (e) => this.handlePointerClick(e);
            const mouseDown = (e) => this._startPdfDragSelection(e);
            const doubleClick = (e) => {
                if (this._textSelect.selectedText && this._textSelect.selectedText.trim()) {
                    this._showSelectionMenu({ clientX: e.clientX, clientY: e.clientY });
                }
            };
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
            listeners.push({ element: pdfDocContainer, type: "mousedown", handler: mouseDown });
            listeners.push({ element: pdfDocContainer, type: "dblclick", handler: doubleClick });
            listeners.push({ element: pdfDocContainer, type: "touchstart", handler: touchStart, options: { passive: true } });
            listeners.push({ element: pdfDocContainer, type: "touchmove", handler: touchMove, options: { passive: true } });
            listeners.push({ element: pdfDocContainer, type: "touchend", handler: touchEnd, options: { passive: true } });

            const keyDown = (e) => this._handleSelectionCopyShortcut(e);
            listeners.push({ element: window, type: "keydown", handler: keyDown, options: { capture: true } });
        }

        for (const { element, type, handler, options } of listeners) {
            if (element) {
                element.addEventListener(type, handler, options);
            }
        }

        this._pdfListeners = listeners;
        this._pdfListenersAttached = listeners.length > 0;
    }

    _startPdfDragSelection(e) {
        const { state } = this.app;
        if (state.currentDocumentType !== "pdf") return;
        if (state.viewMode !== "full") return;
        if (e.button !== 0) return;

        const wrapper = e.target?.closest?.(".pdf-page-wrapper");
        if (!wrapper) return;
        const canvas = wrapper.querySelector("canvas.page-canvas");
        if (!canvas) return;
        const pageNumber = parseInt(wrapper.dataset.pageNumber, 10);
        if (!Number.isFinite(pageNumber)) return;

        this._clearPdfTextSelectionOverlays();
        this._textSelect.active = true;
        this._textSelect.pageNumber = pageNumber;
        this._textSelect.wrapper = wrapper;
        this._textSelect.canvas = canvas;
        this._textSelect.startClientX = e.clientX;
        this._textSelect.startClientY = e.clientY;
        this._textSelect.isDragging = false;
        this._textSelect.selectedText = "";
        this._textSelect.selectedTextOneLine = "";
        this._textSelect.selectedSentenceIndices = [];
        this._hideSelectionMenu();

        // Precompute per-line model for this page to make selection line-based.
        this._textSelect.lineModel = this._buildPageLineModel({ state, wrapper, canvas, pageNumber });

        const onMove = (ev) => this._updatePdfDragSelection(ev);
        const onUp = (ev) => this._endPdfDragSelection(ev);
        window.addEventListener("mousemove", onMove, { passive: true });
        window.addEventListener("mouseup", onUp, { passive: true, once: true });
        this._textSelect._onMove = onMove;
        this._textSelect._onUp = onUp;
    }

    _updatePdfDragSelection(e) {
        const { state } = this.app;
        if (!this._textSelect.active) return;
        if (state.currentDocumentType !== "pdf" || state.viewMode !== "full") return;

        const { wrapper, canvas, pageNumber, startClientX, startClientY, lineModel } = this._textSelect;
        if (!wrapper || !canvas || !Number.isFinite(pageNumber)) return;

        const dx = e.clientX - startClientX;
        const dy = e.clientY - startClientY;
        if (!this._textSelect.isDragging && Math.hypot(dx, dy) > 4) {
            this._textSelect.isDragging = true;
            this._suppressNextClick = true;
        }
        if (!this._textSelect.isDragging) return;

        const wrapperRect = wrapper.getBoundingClientRect();
        const canvasRect = canvas.getBoundingClientRect();
        const originLeft = canvasRect.left;
        const originTop = canvasRect.top;

        const startY = startClientY - originTop;
        const curY = e.clientY - originTop;

        const offsetTop = canvasRect.top - wrapperRect.top;
        const offsetLeft = canvasRect.left - wrapperRect.left;

        const model = lineModel || this._buildPageLineModel({ state, wrapper, canvas, pageNumber });
        if (!model?.lines?.length) return;

        const startLineIdx = this._findLineIndexAtY(model.lines, startY);
        const endLineIdx = this._findLineIndexAtY(model.lines, curY);
        if (startLineIdx < 0 || endLineIdx < 0) return;

        const lo = Math.min(startLineIdx, endLineIdx);
        const hi = Math.max(startLineIdx, endLineIdx);
        const selectedLines = model.lines.slice(lo, hi + 1);

        wrapper.querySelectorAll(".pdf-text-selection").forEach((n) => n.remove());
        for (const line of selectedLines) {
            const div = document.createElement("div");
            div.className = "pdf-text-selection";
            div.style.left = offsetLeft + line.leftPx + "px";
            div.style.top = offsetTop + line.topPx + "px";
            div.style.width = Math.max(1, line.rightPx - line.leftPx) + "px";
            div.style.height = Math.max(1, line.bottomPx - line.topPx) + "px";
            wrapper.appendChild(div);
        }

        this._textSelect.selectedText = this._buildSelectedTextFromLines(selectedLines);
        this._textSelect.selectedTextOneLine = this._normalizeSelectionText(this._textSelect.selectedText, { singleLine: true });
        const indices = new Set();
        for (const line of selectedLines) {
            for (const w of line.words) {
                if (typeof w.sentenceIndex === "number") indices.add(w.sentenceIndex);
            }
        }
        this._textSelect.selectedSentenceIndices = [...indices].sort((a, b) => a - b);
    }

    async _endPdfDragSelection(_e) {
        if (!this._textSelect.active) return;

        if (this._textSelect._onMove) {
            window.removeEventListener("mousemove", this._textSelect._onMove);
        }
        this._textSelect._onMove = null;
        this._textSelect._onUp = null;
        this._textSelect.active = false;
        this._textSelect.lineModel = null;
    }

    _detachPdfListeners() {
        if (!this._pdfListenersAttached) return;
        this._hideSelectionMenu();
        for (const { element, type, handler, options } of this._pdfListeners) {
            if (element) {
                element.removeEventListener(type, handler, options);
            }
        }
        this._pdfListeners = [];
        this._pdfListenersAttached = false;
    }
}
