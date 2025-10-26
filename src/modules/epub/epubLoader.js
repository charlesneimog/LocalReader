import "./../../../thirdparty/foliate-js/view.js";
import { Overlayer } from "./../../../thirdparty/foliate-js/overlayer.js";
import { EVENTS } from "../../constants/events.js";
import { compare as compareCFI } from "./../../../thirdparty/foliate-js/epubcfi.js";

const ACTIVE_SENTENCE_COLOR = "rgb(120, 190, 255)";
const HOVER_SENTENCE_COLOR = "rgb(148, 206, 255)";

const DEFAULT_READER_SETTINGS = Object.freeze({
    spacing: 1.5,
    justify: true,
    hyphenate: true,
});

const buildReaderCSS = ({ spacing, justify, hyphenate }) => `
    @namespace epub "http://www.idpf.org/2007/ops";
    html {
        color-scheme: light dark;
    }
    @media (prefers-color-scheme: dark) {
        a:link {
            color: lightblue;
        }
    }
    p, li, blockquote, dd {
        line-height: ${spacing};
        text-align: ${justify ? "justify" : "start"};
        -webkit-hyphens: ${hyphenate ? "auto" : "manual"};
        hyphens: ${hyphenate ? "auto" : "manual"};
        -webkit-hyphenate-limit-before: 3;
        -webkit-hyphenate-limit-after: 2;
        -webkit-hyphenate-limit-lines: 2;
        hanging-punctuation: allow-end last;
        widows: 2;
    }
    [align="left"] { text-align: left; }
    [align="right"] { text-align: right; }
    [align="center"] { text-align: center; }
    [align="justify"] { text-align: justify; }
    pre {
        white-space: pre-wrap !important;
    }
    aside[epub|type~="endnote"],
    aside[epub|type~="footnote"],
    aside[epub|type~="note"],
    aside[epub|type~="rearnote"] {
        display: none;
    }
`;

export class EPUBLoader {
    constructor(app) {
        this.app = app;
        this.view = null;
        this._viewWrapper = null;
        this._container = null;
        this._currentObjectURL = null;
        this._readerSettings = { ...DEFAULT_READER_SETTINGS };
        this._boundResize = this._resizeContainer.bind(this);
        this._boundRelocate = null;
        this._boundHighlight = null;
        this._boundLoad = null;
        this._boundDrawAnnotation = null;
        this._activeDocs = new Set();
        this._onKeydown = this._handleDirectionalKeydown.bind(this);
        this._globalKeysBound = false;
        this._playbarRoot = null;
        this._playbarOriginalParent = null;
        this._playbarOriginalNextSibling = null;
        this._playbarOriginalStyles = null;
        this._sentencesReady = false;
        this._sentencesPromise = null;
        this._sectionSentenceMap = new Map();
        this._docListeners = [];
        this._activeAnnotationValue = null;
        this._hoverAnnotationValue = null;
        this._activeHighlightColor = ACTIVE_SENTENCE_COLOR;
        this._hoverHighlightColor = HOVER_SENTENCE_COLOR;
        this._localeHint = null;
        this.app.epubRenderer = this;
        window.addEventListener("resize", this._boundResize, { passive: true });
    }

    // Ensure the container used to host the foliate view exists.
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

    // Resize the container so the view fills the remaining viewport.
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

    _configurePlaybarForEpub() {
        if (!this._container) return;
        const toggle = document.getElementById("play-toggle");
        const root = toggle?.closest("div.fixed");
        if (!root) return;

        if (!this._playbarOriginalParent) {
            this._playbarOriginalParent = root.parentElement;
            this._playbarOriginalNextSibling = root.nextSibling;
            this._playbarOriginalStyles = {
                position: root.style.position,
                top: root.style.top,
                right: root.style.right,
                bottom: root.style.bottom,
                left: root.style.left,
                inset: root.style.inset,
                width: root.style.width,
                transform: root.style.transform,
                zIndex: root.style.zIndex,
                pointerEvents: root.style.pointerEvents,
            };
        }

        if (root.parentElement !== this._container) {
            this._container.appendChild(root);
        }

        root.style.position = "absolute";
        root.style.left = "50%";
        root.style.right = "auto";
        root.style.top = "";
        root.style.bottom = "1rem";
        root.style.transform = "translateX(-50%)";
        root.style.width = "auto";
        root.style.zIndex = "30";
        root.style.pointerEvents = "auto";

        this._playbarRoot = root;
    }

    _restorePlaybar() {
        if (!this._playbarRoot) return;
        const root = this._playbarRoot;
        const parent = this._playbarOriginalParent;
        const next = this._playbarOriginalNextSibling;
        if (parent) {
            if (next && next.parentNode === parent) parent.insertBefore(root, next);
            else parent.appendChild(root);
        } else if (root.parentNode !== document.body) {
            document.body.appendChild(root);
        }

        const styles = this._playbarOriginalStyles || {};
        root.style.position = styles.position ?? "";
        root.style.top = styles.top ?? "";
        root.style.right = styles.right ?? "";
        root.style.bottom = styles.bottom ?? "";
        root.style.left = styles.left ?? "";
        root.style.inset = styles.inset ?? "";
        root.style.width = styles.width ?? "";
        root.style.transform = styles.transform ?? "";
        root.style.zIndex = styles.zIndex ?? "";
        root.style.pointerEvents = styles.pointerEvents ?? "";

        this._playbarRoot = null;
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

    _handleDirectionalKeydown(event) {
        if (!this.view) return;
        const tag = event.target?.tagName || "";
        if (/^(INPUT|TEXTAREA|SELECT)$/i.test(tag)) return;

        if (event.key === "ArrowLeft" || event.key === "h") {
            event.preventDefault();
            this.view.goLeft();
        } else if (event.key === "ArrowRight" || event.key === "l") {
            event.preventDefault();
            this.view.goRight();
        }
    }

    _handleViewLoad(event) {
        const doc = event?.detail?.doc;
        if (!doc || this._activeDocs.has(doc)) return;
        doc.addEventListener("keydown", this._onKeydown, { passive: false });
        this._activeDocs.add(doc);
        this.setupInteractionListeners();
    }

    _handleDrawAnnotation(event) {
        const detail = event?.detail;
        if (!detail?.draw) return;
        const annotationColor = detail.annotation?.color;
        const color = annotationColor || this._activeHighlightColor;
        let opacity = null;
        if (annotationColor === this._activeHighlightColor) {
            opacity = "0.18";
        } else if (annotationColor === this._hoverHighlightColor) {
            opacity = "0.12";
        }
        const drawHighlight = (rects, options = {}) => {
            const el = Overlayer.highlight(rects, options);
            if (opacity !== null) {
                el.style.opacity = opacity;
            }
            return el;
        };
        try {
            detail.draw(drawHighlight, { color });
        } catch (error) {
            console.warn("[EPUBLoader] Failed to draw annotation", error);
        }
    }

    _applyReaderStyles() {
        if (!this.view?.renderer) return;
        if (typeof this.view.renderer.setStyles === "function") {
            this.view.renderer.setStyles(buildReaderCSS(this._readerSettings));
        }
        if (!this.view.renderer.hasAttribute("flow")) {
            this.view.renderer.setAttribute("flow", "paginated");
        }
        if (typeof this.view.renderer.next === "function") {
            this.view.renderer.next();
        }
    }

    // Dispose of any previous foliate view instance.
    reset() {
        this._unbindGlobalKeys();
        for (const doc of this._activeDocs) {
            try {
                doc.removeEventListener("keydown", this._onKeydown);
            } catch (e) {}
        }
        this._activeDocs.clear();
        this._detachInteractionListeners();

        if (this.view && this._activeAnnotationValue) {
            try {
                this.view.deleteAnnotation({ value: this._activeAnnotationValue });
            } catch (e) {}
        }
        this._activeAnnotationValue = null;
        if (this.view && this._hoverAnnotationValue) {
            try {
                this.view.deleteAnnotation({ value: this._hoverAnnotationValue });
            } catch (e) {}
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
            this._restorePlaybar();
            this._container.innerHTML = "";
            this._container.style.display = "none";
            this._container.style.height = "";
        }
        this._releaseObjectURL();
        this._sentencesReady = false;
        this._sentencesPromise = null;
        this._sectionSentenceMap.clear();
    }

    // Convert supported inputs into something foliate-js can open.
    async _resolveSource(input) {
        if (!input) {
            throw new Error("No EPUB source provided.");
        }
        if (input instanceof File) {
            this._currentObjectURL = URL.createObjectURL(input);
            return this._currentObjectURL;
        }
        if (input instanceof ArrayBuffer) {
            const blob = new Blob([input], { type: "application/epub+zip" });
            this._currentObjectURL = URL.createObjectURL(blob);
            return this._currentObjectURL;
        }
        if (typeof input === "string") {
            this._currentObjectURL = null;
            return input;
        }
        if (input?.data instanceof ArrayBuffer) {
            const blob = new Blob([input.data], { type: "application/epub+zip" });
            this._currentObjectURL = URL.createObjectURL(blob);
            return this._currentObjectURL;
        }
        throw new Error("Unsupported EPUB source type.");
    }

    // Revoke object URLs to avoid leaking Blob references.
    _releaseObjectURL() {
        if (this._currentObjectURL) {
            URL.revokeObjectURL(this._currentObjectURL);
            this._currentObjectURL = null;
        }
    }

    // Load the EPUB file and render it into the container using foliate-js.
    async loadEPUB(input, _options = {}) {
        const icon = document.querySelector("#play-toggle span.material-symbols-outlined");
        try {
            this.app?.ui?.showInfo?.("Loading EPUB...");
            if (icon) {
                icon.textContent = "hourglass_empty";
                icon.classList.add("animate-spin");
            }

            const pdfDocContainer = document.getElementById("pdf-doc-container");
            if (pdfDocContainer) {
                pdfDocContainer.style.display = "none";
            }
            const viewerWrapper = document.getElementById("viewer-wrapper");
            if (viewerWrapper) {
                viewerWrapper.style.display = "none";
            }

            const state = this.app?.state;
            if (this.app?.audioManager?.stopPlayback) {
                try {
                    await this.app.audioManager.stopPlayback(true);
                } catch (e) {}
            }
            this.app?.ttsQueue?.reset?.();
            if (state) {
                state.audioCache?.clear?.();
                state.currentSource = null;
                state.currentGain = null;
                state.isPlaying = false;
                state.autoAdvanceActive = false;
                state.playingSentenceIndex = -1;
                state.sentences = [];
                state.pageSentencesIndex?.clear?.();
                state.hoveredSentenceIndex = -1;
                state.currentSentenceIndex = -1;
            }

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

            const source = await this._resolveSource(input);

            const view = document.createElement("foliate-view");
            view.classList.add("flex-1");
            view.style.width = "100%";
            view.style.height = "100%";
            view.style.display = "block";
            view.style.flex = "1 1 auto";
            wrapper.appendChild(view);

            document.getElementById("previous-pdf-header")?.classList.add("hidden");

            this.view = view;

            this._boundLoad = (event) => this._handleViewLoad(event);
            this._boundRelocate = (event) => {
                const detail = event?.detail ?? {};
                if (this.app?.state) {
                    this.app.state.epubProgress = detail;
                }
                const fraction = typeof detail.fraction === "number" ? detail.fraction.toFixed(2) : "?";
                this.app?.ui?.showInfo?.(`EPUB position: ${fraction}`);
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

            await view.open(source);

            this._applyReaderStyles();
            this._resizeContainer();
            this._configurePlaybarForEpub();

            if (state) {
                state.currentDocumentType = "epub";
                state.pdf = null;
                state.sentences = [];
                state.currentSentenceIndex = -1;
                state.playingSentenceIndex = -1;
                state.hoveredSentenceIndex = -1;
                state.autoAdvanceActive = false;
                state.generationEnabled = false;
                state.pagesCache?.clear?.();
                state.viewportDisplayByPage?.clear?.();
                state.fullPageRenderCache?.clear?.();
                state.currentPdfKey = null;
                state.currentPdfDescriptor = null;
                state.epub = view.book ?? null;
                state.epubBook = view.book ?? null;
                state.epubMetadata = view.book?.metadata ?? null;
                state.epubSpine = view.book?.spine ?? null;
                state.epubNavigation = view.book?.toc ?? null;
                state.chapterCount = Array.isArray(view.book?.sections) ? view.book.sections.length : 0;
                state.chapterTitles = Array.isArray(view.book?.toc)
                    ? view.book.toc.map((item) => item?.label).filter(Boolean)
                    : [];
                if (input instanceof File) {
                    state.currentEpubDescriptor = {
                        type: "file",
                        name: input.name,
                        size: input.size,
                        lastModified: input.lastModified,
                    };
                } else if (typeof input === "string") {
                    state.currentEpubDescriptor = { type: "url", name: input };
                } else {
                    state.currentEpubDescriptor = { type: "buffer" };
                }
            }

            this.app?.eventBus?.emit?.(EVENTS.EPUB_LOADED, {
                metadata: state?.epubMetadata ?? null,
                chapters: state?.chapterCount ?? 0,
            });

            await this._buildSentences();

            if (state?.sentences?.length) {
                const firstIndex = Math.max(0, state.currentSentenceIndex ?? 0);
                await this.renderSentence(firstIndex, { suppressScroll: true });
            } else {
                this.app?.ui?.showInfo?.("No readable text detected in EPUB.");
            }

            this.setupInteractionListeners();
            this.app?.interactionHandler?.setupInteractionListeners?.();

            this.app?.audioManager?.updatePlayButton?.();
            this.app?.ui?.showInfo?.("EPUB loaded successfully.");
        } catch (error) {
            console.error("EPUB load error", error);
            this.app?.ui?.showInfo?.(`Error loading EPUB: ${error.message}`);
            this.reset();
        } finally {
            if (icon) {
                icon.textContent = this.app?.state?.isPlaying ? "pause" : "play_arrow";
                icon.classList.remove("animate-spin");
            }
        }
    }

    async _buildSentences() {
        if (this._sentencesReady && this.app?.state?.sentences?.length) return;
        if (this._sentencesPromise) return this._sentencesPromise;
        this._sentencesPromise = this._doBuildSentences()
            .catch((error) => {
                console.error("[EPUBLoader] Failed to build sentences", error);
            })
            .finally(() => {
                this._sentencesPromise = null;
            });
        await this._sentencesPromise;
    }

    async _doBuildSentences() {
        if (!this.view?.book || !this.app?.state) {
            this._sentencesReady = false;
            return;
        }

        const { state } = this.app;
        const book = this.view.book;
        const cooperativeYield = this.app?.helpers?.cooperativeYield;
        const locale = this._resolveLocaleHint(book);

        const sentences = [];
        this._sectionSentenceMap.clear();
        state.pageSentencesIndex?.clear?.();

        let globalIndex = 0;
        const sections = Array.isArray(book.sections) ? book.sections : [];
        for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
            const section = sections[sectionIndex];
            if (!section?.createDocument) continue;

            let doc = null;
            try {
                doc = await section.createDocument();
            } catch (error) {
                console.warn("[EPUBLoader] Unable to load section", sectionIndex, error);
                continue;
            }

            const extracted = this._extractSentencesFromDocument(doc, sectionIndex, locale);
            if (extracted.length) {
                if (!this._sectionSentenceMap.has(sectionIndex)) {
                    this._sectionSentenceMap.set(sectionIndex, []);
                }
                const pageNumber = sectionIndex + 1;
                if (!state.pageSentencesIndex.has(pageNumber)) {
                    state.pageSentencesIndex.set(pageNumber, []);
                }

                for (const sentence of extracted) {
                    sentence.index = globalIndex++;
                    sentences.push(sentence);
                    this._sectionSentenceMap.get(sectionIndex).push(sentence.index);
                    state.pageSentencesIndex.get(pageNumber).push(sentence.index);
                }
            }

            section?.unload?.();
            if (typeof cooperativeYield === "function") {
                try {
                    await cooperativeYield();
                } catch (e) {}
            }
        }

        state.sentences = sentences;
        state.currentSentenceIndex = sentences.length ? 0 : -1;
        state.hoveredSentenceIndex = -1;
        this._sentencesReady = sentences.length > 0;
        this._activeHighlightColor = ACTIVE_SENTENCE_COLOR;
        this._hoverHighlightColor = HOVER_SENTENCE_COLOR;

        this.app?.eventBus?.emit?.(EVENTS.SENTENCES_PARSED, sentences);
    }

    _extractSentencesFromDocument(doc, sectionIndex, locale) {
        const entries = [];
        const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
        let cursor = 0;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const value = node.nodeValue ?? "";
            if (!value.length) continue;
            const start = cursor;
            cursor += value.length;
            entries.push({ node, start, end: cursor });
        }

        if (!entries.length) return [];

        const fullText = entries.map((entry) => entry.node.nodeValue).join("");
        if (!fullText.trim()) return [];

        const segmenter = this._getSentenceSegmenter(locale);
        const segments = segmenter ? segmenter(fullText) : this._fallbackSegment(fullText);
        if (!segments.length) return [];

        const sentences = [];
        for (const { text, start, end } of segments) {
            const range = this._createRangeFromOffsets(doc, entries, start, end);
            if (!range) continue;

            let cfi = null;
            try {
                cfi = this.view.getCFI(sectionIndex, range);
            } catch (error) {
                console.warn("[EPUBLoader] Failed to obtain CFI for sentence", error);
                continue;
            }

            const sentence = this._createSentenceObject({ text, sectionIndex, cfi });
            sentences.push(sentence);
        }
        return sentences;
    }

    _getSentenceSegmenter(locale) {
        if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") return null;
        try {
            const segmenter = new Intl.Segmenter(locale || "en", { granularity: "sentence" });
            return (text) => {
                const segments = [];
                for (const { segment, index } of segmenter.segment(text)) {
                    const leading = segment.match(/^\s*/)?.[0]?.length ?? 0;
                    const trailing = segment.match(/\s*$/)?.[0]?.length ?? 0;
                    const trimmed = segment.replace(/\s+/g, " ").trim();
                    if (!trimmed) continue;
                    const start = index + leading;
                    const end = index + segment.length - trailing;
                    if (end <= start) continue;
                    segments.push({ text: trimmed, start, end });
                }
                return segments;
            };
        } catch (error) {
            console.warn("[EPUBLoader] Intl.Segmenter unavailable", error);
            return null;
        }
    }

    _fallbackSegment(text) {
        const segments = [];
        const regex = /[^.!?]+[.!?]*\s*/g;
        let match;
        while ((match = regex.exec(text))) {
            const chunk = match[0];
            const trimmed = chunk.replace(/\s+/g, " ").trim();
            if (!trimmed) continue;
            const leading = chunk.match(/^\s*/)?.[0]?.length ?? 0;
            const trailing = chunk.match(/\s*$/)?.[0]?.length ?? 0;
            const start = match.index + leading;
            let end = match.index + chunk.length - trailing;
            if (end <= start) continue;
            segments.push({ text: trimmed, start, end });
        }

        if (!segments.length) {
            const fallback = text.replace(/\s+/g, " ").trim();
            if (fallback) segments.push({ text: fallback, start: 0, end: text.length });
        }
        return segments;
    }

    _createRangeFromOffsets(doc, entries, start, end) {
        const startPos = this._locateDomPosition(entries, start);
        const endPos = this._locateDomPosition(entries, end);
        if (!startPos || !endPos) return null;
        const range = doc.createRange();
        range.setStart(startPos.node, startPos.offset);
        range.setEnd(endPos.node, endPos.offset);
        return range;
    }

    _locateDomPosition(entries, offset) {
        if (!entries.length) return null;
        if (offset <= 0) {
            const first = entries[0];
            return { node: first.node, offset: Math.max(0, Math.min(first.node.nodeValue?.length ?? 0, offset)) };
        }

        for (const entry of entries) {
            if (offset < entry.end) {
                const nodeLength = entry.node.nodeValue?.length ?? 0;
                const relative = Math.min(nodeLength, Math.max(0, offset - entry.start));
                return { node: entry.node, offset: relative };
            }
        }

        const last = entries[entries.length - 1];
        const lastLength = last.node.nodeValue?.length ?? 0;
        return { node: last.node, offset: Math.min(lastLength, Math.max(0, offset - last.start)) };
    }

    _createSentenceObject({ text, sectionIndex, cfi }) {
        return {
            index: -1,
            sectionIndex,
            pageNumber: sectionIndex + 1,
            chapterIndex: sectionIndex,
            cfi,
            text,
            originalText: text,
            readableText: text,
            words: [],
            originalWords: [],
            readableWords: [],
            bbox: null,
            audioBlob: null,
            wavBlob: null,
            audioBuffer: null,
            audioReady: false,
            audioInProgress: false,
            audioError: null,
            lastVoice: null,
            lastSpeed: null,
            prefetchQueued: false,
            normalizedText: null,
            wordBoundaries: [],
            playbackWordTimers: [],
            layoutProcessed: true,
            isTextToRead: true,
            layoutProcessingPromise: null,
        };
    }

    _resolveLocaleHint(book) {
        if (this._localeHint) return this._localeHint;
        const metaLang = book?.metadata?.language;
        if (Array.isArray(metaLang) && metaLang.length && typeof metaLang[0] === "string") {
            this._localeHint = metaLang[0];
        } else if (typeof metaLang === "string" && metaLang.trim()) {
            this._localeHint = metaLang;
        } else {
            this._localeHint = document.documentElement.lang || navigator.language || "en";
        }
        return this._localeHint;
    }

    _detachInteractionListeners() {
        if (!Array.isArray(this._docListeners) || !this._docListeners.length) return;
        for (const { doc, type, handler, options } of this._docListeners) {
            try {
                doc?.removeEventListener(type, handler, options);
            } catch (e) {}
        }
        this._docListeners = [];
    }

    setupInteractionListeners() {
        this._detachInteractionListeners();
        if (!this.view?.renderer?.getContents) return;
        const contents = this.view.renderer.getContents();
        for (const entry of contents) {
            const doc = entry?.doc;
            if (!doc) continue;
            const clickHandler = (event) => this._handleDocumentClick(event, entry.index);
            const mouseMoveHandler = (event) => this._handleDocumentPointerMove(event, entry.index);
            const mouseLeaveHandler = () => this._setHoveredSentence(-1);
            const touchStartHandler = (event) => this._handleDocumentTouchMove(event, entry.index, doc);
            const touchMoveHandler = (event) => this._handleDocumentTouchMove(event, entry.index, doc);
            const touchEndHandler = () => this._setHoveredSentence(-1);
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
            this._docListeners.push({ doc: hoverSurface, type: "mouseleave", handler: mouseLeaveHandler, options: { passive: true } });
            this._docListeners.push({ doc, type: "touchstart", handler: touchStartHandler, options: { passive: true } });
            this._docListeners.push({ doc, type: "touchmove", handler: touchMoveHandler, options: { passive: true } });
            this._docListeners.push({ doc, type: "touchend", handler: touchEndHandler, options: { passive: true } });
            this._docListeners.push({ doc, type: "touchcancel", handler: touchEndHandler, options: { passive: true } });
        }
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
        } catch (e) {}
        if (this.app?.state) {
            this.app.state.autoAdvanceActive = false;
        }

        //this._setHoveredSentence(sentenceIndex);

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
            console.debug("[EPUBLoader] CFI resolution error", error);
            return -1;
        }

        return this._findSentenceIndexInSection(sectionIndex, cfi);
    }

    _handleDocumentPointerMove(event, sectionIndex, docOverride) {
        if (!this.app?.state?.sentences?.length) return;
        const doc = docOverride || event.currentTarget;
        if (!doc) return;
        if (event?.target?.closest?.("a[href]")) {
            this._setHoveredSentence(-1);
            return;
        }
        const idx = this._resolveSentenceIndexFromEvent(doc, event, sectionIndex);
        if (idx >= 0) this._setHoveredSentence(idx);
        else this._setHoveredSentence(-1);
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

    _findSentenceIndexInSection(sectionIndex, cfi) {
        const indices = this._sectionSentenceMap.get(sectionIndex);
        if (!indices || !indices.length) return -1;
        let candidate = -1;
        for (const idx of indices) {
            const sentence = this.app?.state?.sentences?.[idx];
            if (!sentence?.cfi) continue;
            try {
                const cmp = compareCFI(cfi, sentence.cfi);
                if (cmp === 0) {
                    return idx;
                }
                if (cmp > 0) {
                    candidate = idx;
                    continue;
                }
                if (candidate >= 0) return candidate;
                return idx;
            } catch (e) {}
        }
        if (candidate >= 0) return candidate;
        return indices[0];
    }

    async _applySentenceHighlight(cfi) {
        if (!this.view || !cfi) return;
        if (this._activeAnnotationValue) {
            try {
            await this.view.deleteAnnotation({ value: this._activeAnnotationValue });
            } catch (e) {}
        }

        const { index, anchor } = await this.view.resolveNavigation(cfi);
        
        try {
            //await this.view.addAnnotation({ value: cfi, color: this._activeHighlightColor });
            this._activeAnnotationValue = cfi;
        } catch (error) {
            console.warn("[EPUBLoader] Failed to apply highlight", error);
            this._activeAnnotationValue = null;
        }
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
            console.debug("[EPUBLoader] Failed to apply hover highlight", error);
            if (this._hoverAnnotationValue === cfi) {
                this._hoverAnnotationValue = null;
            }
        });
    }

    _setHoveredSentence(idx) {
        const { state } = this.app;
        if (!state) return;
        if (state.hoveredSentenceIndex === idx) return;
        state.hoveredSentenceIndex = idx;
        this.renderHoverHighlightFullDoc();
    }

    updateHighlightFullDoc(sentence) {
        const targetCfi = sentence?.cfi || this.app?.state?.currentSentence?.cfi || this._activeAnnotationValue;
        if (targetCfi) {
            this._applySentenceHighlight(targetCfi);
        }
        this.renderHoverHighlightFullDoc();
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
                console.warn("[EPUBLoader] Navigation error", error);
            }
            await this._applySentenceHighlight(sentence.cfi);
            if (!options?.suppressScroll) {
                this.scrollSentenceIntoView(sentence);
            }
        }

        //this.renderHoverHighlightFullDoc();

        if (!options?.autoAdvance && state.generationEnabled) {
            this.app.ttsQueue.add(idx, true);
            const ahead = this.app.config?.PREFETCH_AHEAD ?? 0;
            for (let i = 1; i <= ahead; i++) {
                const target = idx + i;
                if (target < state.sentences.length) this.app.ttsQueue.add(target);
            }
            this.app.ttsQueue.run();
        }

        return sentence;
    }

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
            if (range) this.view.renderer.scrollToAnchor(range, true);
        } catch (error) {
            console.debug("[EPUBLoader] Unable to scroll into view", error);
        }
    }

    // Clean up listeners and DOM references when the loader is destroyed.
    destroy() {
        window.removeEventListener("resize", this._boundResize);
        this.reset();
        this._unbindGlobalKeys();
        this._container = null;
        this._releaseObjectURL();
    }

    async ensureLayoutFilteringReady() {
        await this._buildSentences();
        if (this.app?.state) {
            this.app.state.layoutFilteringReady = true;
        }
    }

    handleViewportHeightChange() {
        this._resizeContainer();
        const current = this.app?.state?.currentSentence;
        if (current) this.scrollSentenceIntoView(current);
    }
}
