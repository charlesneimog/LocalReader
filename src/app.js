import { CONFIG } from "./config.js";
import { EventBus } from "./core/eventBus.js";
import { StateManager } from "./core/stateManager.js";
import { CacheManager } from "./core/cacheManager.js";

import * as helperFns from "./modules/utils/helpers.js";
import { ensureAriaRegions } from "./modules/utils/ariaManager.js";

import { PDFLoader } from "./modules/pdf/pdfLoader.js";
import { PDFRenderer } from "./modules/pdf/pdfRenderer.js";
import { PDFHeaderFooterDetector } from "./modules/pdf/pdfHeaderFooterDetector.js";
import { SentenceParser } from "./modules/pdf/sentenceParser.js";

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

import { AutoModel, AutoProcessor, RawImage, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5";

import { Login } from "./modules/login/auth.js";

export class PDFTTSApp {
    constructor() {
        this.login = new Login(this);
        this.login.init();

        const threads = navigator.hardwareConcurrency;
        env.backends.onnx.wasm.numThreads = threads;
        env.backends.onnx.wasm.simd = true;
        env.backends.onnx.backend = "wasm";
        env.backends.onnx.logLevel = "error";
        this.transformers = {
            AutoModel,
            AutoProcessor,
            RawImage,
            env,
        };

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

        // Storage / Persistence
        this.progressManager = new ProgressManager(this);
        this.highlightsStorage = new HighlightsStorage(this);
        this.exportManager = new ExportManager(this);

        // PDF / Text
        this.pdfLoader = new PDFLoader(this);
        this.pdfRenderer = new PDFRenderer(this);
        this.pdfHeaderFooterDetector = new PDFHeaderFooterDetector(this);
        this.sentenceParser = new SentenceParser(this);

        // TTS / Audio
        this.ttsEngine = new TTSEngine(this);
        this.audioManager = new AudioManager(this);
        this.ttsQueue = new TTSQueueManager(this);
        this.wordHighlighter = new WordHighlighter(this);
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

    nextSentence(manual = true) {
        const { state } = this;
        if (state.currentSentenceIndex < state.sentences.length - 1) {
            this.audioManager.stopPlayback(true);
            if (manual) state.autoAdvanceActive = false;
            this.pdfRenderer.renderSentence(state.currentSentenceIndex + 1);
        }
    }

    prevSentence(manual = true) {
        const { state } = this;
        if (state.currentSentenceIndex > 0) {
            this.audioManager.stopPlayback(true);
            if (manual) state.autoAdvanceActive = false;
            this.pdfRenderer.renderSentence(state.currentSentenceIndex - 1);
        }
    }

    nextPageNav() {
        const { state } = this;
        const currentPage = state.currentSentence?.pageNumber || 1;
        const target = Math.min(state.pdf.numPages, currentPage + 1);
        const firstIdx = state.sentences.findIndex((s) => s.pageNumber === target);
        if (firstIdx >= 0) this.pdfRenderer.renderSentence(firstIdx);
    }

    prevPageNav() {
        const { state } = this;
        const currentPage = state.currentSentence?.pageNumber || 1;
        const target = Math.max(1, currentPage - 1);
        const firstIdx = state.sentences.findIndex((s) => s.pageNumber === target);
        if (firstIdx >= 0) this.pdfRenderer.renderSentence(firstIdx);
    }

    togglePlay() {
        const icon = document.querySelector("#play-toggle span.material-symbols-outlined");
        if (!icon) return;

        this.audioManager.togglePlay();
        icon.textContent = this.state.isPlaying ? "pause" : "play_arrow";
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
}

// Single shared app instance
export const app = new PDFTTSApp();

// Preserve global window API
window.toggleViewMode = () => app.toggleViewMode();
window.loadPDF = (file, options) => app.loadPDF(file, options);
window.nextSentence = () => app.nextSentence(true);
window.prevSentence = () => app.prevSentence(true);
window.playSentence = () => app.audioManager.playCurrentSentence();
window.togglePlay = () => app.togglePlay();

window.listSavedProgress = () => app.listSavedProgress();
window.clearPdfProgress = (key) => app.clearPdfProgress(key);

window.listSavedHighlights = () => app.listSavedHighlights();
window.clearPdfHighlights = (key) => app.clearPdfHighlights(key);
window.exportHighlights = () => app.exportPdfWithHighlights();
window.saveHighlight = () => app.saveCurrentSentenceHighlight();

window.initializePdfApp = () => app.initialize();
