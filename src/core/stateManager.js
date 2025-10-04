export class StateManager {
    constructor(app) {
        this.app = app;
        // Original state variables
        this.pdf = null;
        this.pagesCache = new Map();
        this.viewportDisplayByPage = new Map();
        this.fullPageRenderCache = new Map();
        this.sentences = [];
        this.currentSentenceIndex = -1;
        this.deviceScale = window.devicePixelRatio || 1;

        this.currentSource = null;
        this.currentGain = null;
        this.isPlaying = false;
        this.autoAdvanceActive = false;
        this.stopRequested = false;
        this.generationEnabled = false;

        // Phrase / interaction
        this.hoveredSentenceIndex = -1;
        this.pageSentencesIndex = new Map();
        this.hoverRafScheduled = false;
        this.lastPointerEvent = null;
        this.currentSingleViewOffsetY = 0;
        this.currentSingleViewPageNumber = 1;

        // Multi-PDF identity
        this.currentPdfKey = null;
        this.currentPdfDescriptor = null;

        // Caches
        this.audioCache = new Map();

        // TTS engine
        this.piperInstance = null;
        this.currentPiperVoice = null;
        this.piperLoading = false;

        // View
        this.viewMode = this.app.config.DEFAULT_VIEW_MODE;

        // Highlights
        this.savedHighlights = new Map();
        this.autoHighlightEnabled = false;

        // Other runtime
        this.CURRENT_SPEED = 1.0;
        this.audioCtx = null;
    }

    get currentSentence() {
        return this.sentences[this.currentSentenceIndex];
    }
}

