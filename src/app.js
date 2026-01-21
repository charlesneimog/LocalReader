import { CONFIG } from "./config.js";
import { EventBus } from "./core/eventBus.js";
import { StateManager } from "./core/stateManager.js";
import { CacheManager } from "./core/cacheManager.js";
import { EVENTS } from "./constants/events.js";

import * as helperFns from "./modules/utils/helpers.js";
import { ensureAriaRegions } from "./modules/utils/ariaManager.js";
import { viewportHeightManager } from "./modules/utils/viewport.js";

import { PDFLoader } from "./modules/pdf/pdfLoader.js";
import { PDFRenderer } from "./modules/pdf/pdfRenderer.js";
import { PDFHeaderFooterDetector } from "./modules/pdf/pdfHeaderFooterDetector.js";
import { SentenceParser } from "./modules/pdf/sentenceParser.js";

import { EPUBLoader } from "./modules/epub/epubLoader.js";

import { TTSEngine } from "./modules/tts/ttsEngine.js";
import { AudioManager } from "./modules/tts/audioManager.js";
import { TTSQueueManager } from "./modules/tts/synthesisQueue.js";
import { WordHighlighter } from "./modules/tts/wordHighlighter.js";

import { InteractionHandler } from "./modules/ui/interactionHandler.js";
import { ControlsManager } from "./modules/ui/controlsManager.js";
import { HighlightManager } from "./modules/ui/highlightManager.js";
import { UIService } from "./modules/ui/uiService.js";

import { ProgressManager } from "./modules/storage/progressManager.js";
import { HighlightsStorage } from "./modules/storage/highlightsStorage.js";
import { ExportManager } from "./modules/storage/exportManager.js";
import { PDFThumbnailCache } from "./modules/storage/pdfThumbnailCache.js";
import { ServerSync } from "./modules/storage/serverSync.js";

export class PDFTTSApp {
    constructor() {
        // UI
        this.ui = new UIService(this);
        this.interactionHandler = new InteractionHandler(this);
        this.controlsManager = new ControlsManager(this);
        this.highlightManager = new HighlightManager(this);

        // config
        this.config = CONFIG;
        this.state = new StateManager(this);
        this.eventBus = new EventBus();
        this.cache = new CacheManager(this.state);

        // Runtime settings
        this._autoTranslateCache = new Map();
        this._autoTranslateInFlight = new Set();
        this._loadRuntimeSettings();

        // Utilities
        this.helpers = helperFns;
        this.viewportManager = viewportHeightManager;
        this._handleViewportHeightChange = this._handleViewportHeightChange.bind(this);

        // Storage / Persistence
        this.progressManager = new ProgressManager(this);
        this.highlightsStorage = new HighlightsStorage(this);
        this.exportManager = new ExportManager(this);
        this.pdfThumbnailCache = new PDFThumbnailCache(this);
        this.serverSync = new ServerSync(this);

        // PDF / Text
        this.pdfLoader = new PDFLoader(this);
        this.epubLoader = new EPUBLoader(this);
        this.epubRenderer = this.epubLoader.renderer;
        this._pdfRenderer = new PDFRenderer(this);
        this.pdfRenderer = this._createRendererProxy();
        this.pdfHeaderFooterDetector = new PDFHeaderFooterDetector(this);
        this.sentenceParser = new SentenceParser(this);

        // TTS / Audio
        this.ttsEngine = new TTSEngine(this);
        this.audioManager = new AudioManager(this);
        this.ttsQueue = new TTSQueueManager(this);
        this.wordHighlighter = new WordHighlighter(this);

        this._setupAutoTranslate();

        this.showSavedPDFs();

        // app version
        document.getElementById("appversion").textContent =
            `v${this.config.VERSION_MAJOR}.${this.config.VERSION_MINOR}.${this.config.VERSION_PATCH}+${this.config.VERSION_BUILD}`;
        document.getElementById("appversion-p").textContent =
            `v${this.config.VERSION_MAJOR}.${this.config.VERSION_MINOR}.${this.config.VERSION_PATCH}+${this.config.VERSION_BUILD}`;
    }

    _createRendererProxy() {
        const getRenderer = () => {
            if (this.state.currentDocumentType === "epub") {
                return this.epubRenderer ?? this.epubLoader?.renderer ?? this.epubLoader;
            }
            return this._pdfRenderer;
        };

        return new Proxy(
            {},
            {
                get: (_target, prop) => {
                    if (prop === "getUnderlyingRenderer") return getRenderer;
                    const renderer = getRenderer();
                    const value = renderer[prop];
                    return typeof value === "function" ? value.bind(renderer) : value;
                },
                set: (_target, prop, value) => {
                    const renderer = getRenderer();
                    renderer[prop] = value;
                    return true;
                },
                has: (_target, prop) => {
                    const renderer = getRenderer();
                    return prop in renderer;
                },
            },
        );
    }

    getActiveRenderer() {
        return this.state.currentDocumentType === "epub" ? this.epubRenderer : this._pdfRenderer;
    }

    async translateCurrentSentence() {
        const { state } = this;
        if (!state?.sentences?.length) {
            this.ui?.showInfo?.("Load a document first");
            return;
        }

        const idx =
            typeof state.playingSentenceIndex === "number" && state.playingSentenceIndex >= 0
                ? state.playingSentenceIndex
                : state.currentSentenceIndex;
        const sentence = state.sentences[idx];
        const text = (sentence?.text || "").trim();
        if (!text) return;

        if (!this.serverSync?.isEnabled?.()) {
            this.ui?.showInfo?.("⚠️ Configure Server Link to translate");
            return;
        }

        this.ui?.showInfo?.("Translating...");
        const result = await this.serverSync.translateText(text);
        if (!result) return;

        await this.ui?.showTranslatePopup?.({
            originalText: text,
            translatedText: result.translatedText || "",
            target: result.target || "",
            detectedSource: result.detectedSource || "",
        });
    }

    _loadRuntimeSettings() {
        const raw = localStorage.getItem("config.autoTranslate");
        const enabled = raw === "1" || raw === "true";
        this.state.autoTranslateEnabled = enabled;
        this.controlsManager?.reflectAutoTranslateToggle?.(enabled);
    }

    setAutoTranslateEnabled(enabled) {
        const value = !!enabled;
        this.state.autoTranslateEnabled = value;
        localStorage.setItem("config.autoTranslate", value ? "1" : "0");
        this.controlsManager?.reflectAutoTranslateToggle?.(value);
        if (!value) this._resetAutoTranslateCache();
        if (value) this._kickAutoTranslatePrefetch();
    }

    isAutoTranslateEnabled() {
        return !!this.state.autoTranslateEnabled;
    }

    _setupAutoTranslate() {
        const resetOnDocChange = () => {
            this._resetAutoTranslateCache();
            if (this.isAutoTranslateEnabled()) this._kickAutoTranslatePrefetch();
        };

        this.eventBus.on(EVENTS.PDF_LOADED, resetOnDocChange);
        this.eventBus.on(EVENTS.EPUB_LOADED, resetOnDocChange);
        this.eventBus.on(EVENTS.SENTENCES_PARSED, resetOnDocChange);

        this.eventBus.on(EVENTS.AUDIO_PLAYBACK_START, ({ index } = {}) => {
            if (!this.isAutoTranslateEnabled()) return;
            if (!Number.isFinite(index)) return;
            this._handleAutoTranslatePlaybackStart(index);
        });
    }

    _resetAutoTranslateCache() {
        this._autoTranslateCache.clear();
        this._autoTranslateInFlight.clear();
    }

    _kickAutoTranslatePrefetch() {
        const { state } = this;
        const baseIdx =
            typeof state.playingSentenceIndex === "number" && state.playingSentenceIndex >= 0
                ? state.playingSentenceIndex
                : state.currentSentenceIndex;
        if (!Number.isFinite(baseIdx) || baseIdx < 0) return;

        const nextIdx = this._getNextTranslatableSentenceIndex(baseIdx);
        if (Number.isFinite(nextIdx)) this._prefetchSentenceTranslation(nextIdx);
    }

    _handleAutoTranslatePlaybackStart(index) {
        // Show cached translation for the sentence that just started.
        const cached = this._autoTranslateCache.get(index);
        if (cached) {
            this.ui?.showTranslatePopup?.(cached).catch(() => {});
        }

        // Prefetch translation for the *next* sentence.
        const nextIdx = this._getNextTranslatableSentenceIndex(index);
        if (Number.isFinite(nextIdx)) this._prefetchSentenceTranslation(nextIdx);
    }

    _getNextTranslatableSentenceIndex(fromIndex) {
        const { state } = this;
        const start = Math.max(-1, Number(fromIndex));
        const list = state?.sentences || [];
        for (let i = start + 1; i < list.length; i++) {
            const s = list[i];
            const text = (s?.text || "").trim();
            if (!text) continue;
            // PDF readability filter (EPUB sentences won't have this flag).
            if (s && s.isTextToRead === false) continue;
            return i;
        }
        return null;
    }

    _prefetchSentenceTranslation(index) {
        if (!this.isAutoTranslateEnabled()) return;
        if (!Number.isFinite(index) || index < 0) return;
        if (this._autoTranslateCache.has(index)) return;
        if (this._autoTranslateInFlight.has(index)) return;
        if (!this.serverSync?.isEnabled?.()) return;

        const sentence = this.state?.sentences?.[index];
        const text = (sentence?.text || "").trim();
        if (!text) return;

        this._autoTranslateInFlight.add(index);
        (async () => {
            try {
                const result = await this.serverSync.translateText(text);
                if (!result) return;
                this._autoTranslateCache.set(index, {
                    originalText: text,
                    translatedText: result.translatedText || "",
                    target: result.target || "",
                    detectedSource: result.detectedSource || "",
                });
            } catch (e) {
                console.warn("[autoTranslate] prefetch failed", e);
            } finally {
                this._autoTranslateInFlight.delete(index);
            }
        })();
    }

    _getTotalPageCount() {
        if (this.state.currentDocumentType === "epub") {
            if (Number.isFinite(this.state.chapterCount) && this.state.chapterCount > 0) {
                return this.state.chapterCount;
            }
            return this.state.pagesCache.size || 0;
        }
        return this.state.pdf?.numPages || 0;
    }

    async _ensureAriaRegions() {
        ensureAriaRegions(this.config);
    }

    async _loadInitialPDF() {
        await this.loadPDF();
    }

    async initialize() {
        this.viewportManager.addListener(this._handleViewportHeightChange);
        this.viewportManager.start();
        this._handleViewportHeightChange(this.viewportManager.getCurrentHeight());
        await this._ensureAriaRegions();
        await this._loadInitialPDF();
        await this.ttsEngine.ensurePiper(this.config.DEFAULT_PIPER_VOICE);
    }

    // Public API methods preserving original signatures:
    async loadPDF(file = null, options = {}) {
        if (file !== null) {
            const nopdf = document.getElementById("no-pdf-overlay");
            nopdf.style.display = "none";
        }
        const result = await this.pdfLoader.loadPDF(file, options);
        this.serverSync?.startAutoSync();
        return result;
    }

    async loadEPUB(file = null, options = {}) {
        if (file !== null) {
            const overlay = document.getElementById("no-pdf-overlay");
            if (overlay) overlay.style.display = "none";
        }
        const result = await this.epubLoader.loadEPUB(file, options);
        this.serverSync?.startAutoSync();
        return result;
    }

    nextSentence(manual = true) {
        const { state } = this;
        if (state.currentSentenceIndex < state.sentences.length - 1) {
            this.audioManager.stopPlayback(true);
            if (manual) state.autoAdvanceActive = false;
            this.getActiveRenderer().renderSentence(state.currentSentenceIndex + 1);
        }
    }

    prevSentence(manual = true) {
        const { state } = this;
        if (state.currentSentenceIndex > 0) {
            this.audioManager.stopPlayback(true);
            if (manual) state.autoAdvanceActive = false;
            this.getActiveRenderer().renderSentence(state.currentSentenceIndex - 1);
        }
    }

    nextPageNav() {
        const { state } = this;
        const currentPage = state.currentSentence?.pageNumber || 1;
        const totalPages = this._getTotalPageCount();
        if (!totalPages) return;
        const target = Math.min(totalPages, currentPage + 1);
        const firstIdx = state.sentences.findIndex((s) => s.pageNumber === target);
        if (firstIdx >= 0) this.getActiveRenderer().renderSentence(firstIdx);
    }

    prevPageNav() {
        const { state } = this;
        const currentPage = state.currentSentence?.pageNumber || 1;
        const totalPages = this._getTotalPageCount();
        if (!totalPages) return;
        const target = Math.max(1, Math.min(totalPages, currentPage - 1));
        const firstIdx = state.sentences.findIndex((s) => s.pageNumber === target);
        if (firstIdx >= 0) this.getActiveRenderer().renderSentence(firstIdx);
    }

    togglePlay() {
        this.audioManager.togglePlay();
    }

    toggleViewMode() {
        return this.viewManager.toggleViewMode();
    }

    listSavedProgress() {
        return this.progressManager.listSavedProgress();
    }

    clearPdfProgress(key) {
        return this.progressManager.clearPdfProgress(key);
    }

    listSavedHighlights() {
        return this.highlightsStorage.listSavedHighlights();
    }

    clearPdfHighlights(key) {
        return this.highlightsStorage.clearPdfHighlights(key);
    }

    exportPdfWithHighlights() {
        return this.exportManager.exportPdfWithHighlights();
    }

    saveCurrentSentenceHighlight(color) {
        return this.highlightManager.saveCurrentSentenceHighlight(color);
    }
    async login() {
        this.auth.login();
    }
    async logout() {
        this.auth.logout();
    }
    async subscribe() {
        this.auth.subscribe();
    }

    /**
     * Close the currently open document (PDF or EPUB).
     * Stops playback, resets renderers/loaders where possible and clears state
     * so the app can show the saved PDFs view cleanly.
     */
    async closeCurrentDocument() {
        const { state } = this;

        try {
            // Stop server sync
            this.serverSync?.stopAutoSync();
        } catch (err) {
            console.debug("closeCurrentDocument: server sync stop failed", err);
        }

        try {
            // Stop audio playback (best-effort)
            if (this.audioManager && typeof this.audioManager.stopPlayback === "function") {
                // pass true to fade out and clear playback
                await this.audioManager.stopPlayback(true).catch(() => {});
            }
        } catch (err) {
            console.debug("closeCurrentDocument: audio stop failed", err);
        }

        try {
            // Reset TTS queue
            this.ttsQueue?.reset?.();
        } catch (err) {
            console.debug("closeCurrentDocument: ttsQueue.reset failed", err);
        }

        try {
            // Clear caches
            this.cache?.clearAll?.();
        } catch (err) {
            console.debug("closeCurrentDocument: cache.clearAll failed", err);
        }

        try {
            // Hide/clear PDF and EPUB containers
            const pdfDocContainer = document.getElementById("pdf-doc-container");
            const viewerWrapper = document.getElementById("viewer-wrapper");
            const pdfCanvas = document.getElementById("pdf-canvas");
            if (pdfDocContainer) {
                pdfDocContainer.style.display = "none";
                // remove heavy DOM to free memory
                try {
                    pdfDocContainer.innerHTML = "";
                } catch (e) {
                    /* ignore */
                }
            }
            if (viewerWrapper) viewerWrapper.style.display = "none";
            if (pdfCanvas) pdfCanvas.style.display = "none";
        } catch (err) {
            console.debug("closeCurrentDocument: hide containers failed", err);
        }

        try {
            // EPUB cleanup
            if (this.epubLoader && typeof this.epubLoader.reset === "function") {
                try {
                    this.epubLoader.reset();
                } catch (e) {
                    console.debug("closeCurrentDocument: epubLoader.reset failed", e);
                }
            }
        } catch (err) {
            console.debug("closeCurrentDocument: epub reset failed", err);
        }

        try {
            // PDF cleanup: clear renderer highlights and free caches
            if (this._pdfRenderer && typeof this._pdfRenderer.clearFullDocHighlights === "function") {
                try {
                    this._pdfRenderer.clearFullDocHighlights();
                } catch (e) {
                    console.debug("closeCurrentDocument: pdfRenderer.clearFullDocHighlights failed", e);
                }
            }
        } catch (err) {
            console.debug("closeCurrentDocument: pdf cleanup failed", err);
        }

        // Reset shared state fields
        if (state) {
            try {
                state.pdf = null;
                state.epub = null;
                state.pagesCache?.clear?.();
                state.viewportDisplayByPage?.clear?.();
                state.fullPageRenderCache?.clear?.();
                state.pageSentencesIndex?.clear?.();
                state.prefetchedPages?.clear?.();
                state.sentences = [];
                state.currentSentenceIndex = -1;
                state.hoveredSentenceIndex = -1;
                state.playingSentenceIndex = -1;
                state.currentDocumentType = null;
                state.currentPdfKey = null;
                state.currentPdfDescriptor = null;
                state.currentEpubKey = null;
                state.currentEpubDescriptor = null;
                state.bookTitle = null;
                state.bookCover = null;
                state.bookCoverDataUrl = null;
                state.layoutFilteringReady = false;
                state.generationEnabled = false;
            } catch (e) {
                console.debug("closeCurrentDocument: clearing state failed", e);
            }
        }
    }

    _handleViewportHeightChange(height) {
        if (!Number.isFinite(height)) return;
        if (window.__freezeViewportUpdates) return;
        // If we're waiting for user confirmation to change orientation on mobile, don't auto-adjust UI
        if (this.state.awaitingOrientationDecision) return;
        this.state.viewportHeight = height;
        if (this.pdfRenderer && typeof this.pdfRenderer.handleViewportHeightChange === "function") {
            this.pdfRenderer.handleViewportHeightChange(height);
        }
    }

    /**
     * Show saved PDFs - delegated to PDFThumbnailCache
     */
    async showSavedPDFs() {
        return this.pdfThumbnailCache.showSavedPDFs();
    }
}

// Single shared app instance
export const app = new PDFTTSApp();
