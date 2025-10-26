import { CONFIG } from "./config.js";
import { EventBus } from "./core/eventBus.js";
import { StateManager } from "./core/stateManager.js";
import { CacheManager } from "./core/cacheManager.js";

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

import { Login } from "./modules/login/auth.js";

export class PDFTTSApp {
    constructor() {
        this.auth = new Login(this);
        this.auth.init();

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

        // Utilities
        this.helpers = helperFns;
        this.viewportManager = viewportHeightManager;
        this._handleViewportHeightChange = this._handleViewportHeightChange.bind(this);

        // Storage / Persistence
        this.progressManager = new ProgressManager(this);
        this.highlightsStorage = new HighlightsStorage(this);
        this.exportManager = new ExportManager(this);
        this.pdfThumbnailCache = new PDFThumbnailCache(this);

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
        const icon = document.querySelector("#play-toggle span.material-symbols-outlined");
        if (icon) {
            icon.textContent = "hourglass_empty";
            icon.classList.add("animate-spin");
        }

        this.viewportManager.addListener(this._handleViewportHeightChange);
        this.viewportManager.start();
        this._handleViewportHeightChange(this.viewportManager.getCurrentHeight());

        await this._ensureAriaRegions();
        await this._loadInitialPDF();
        await this.ttsEngine.ensurePiper(this.config.DEFAULT_PIPER_VOICE);

        if (icon) {
            icon.textContent = this.state.isPlaying ? "pause" : "play_arrow";
            icon.classList.remove("animate-spin");
        }
    }

    // Public API methods preserving original signatures:
    async loadPDF(file = null, options = {}) {
        if (file !== null) {
            const nopdf = document.getElementById("no-pdf-overlay");
            nopdf.style.display = "none";
        }
        return this.pdfLoader.loadPDF(file, options);
    }

    async loadEPUB(file = null, options = {}) {
        if (file !== null) {
            const overlay = document.getElementById("no-pdf-overlay");
            if (overlay) overlay.style.display = "none";
        }
        return this.epubLoader.loadEPUB(file, options);
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
        const icon = document.querySelector("#play-toggle span.material-symbols-outlined");
        if (!icon) return;

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
