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
        this.playingSentenceIndex = -1;
        this.deviceScale = window.devicePixelRatio || 1;

        this.currentDocumentType = "pdf";
        this.epubSpine = null;
        this.epubNavigation = null;
        this.epubMetadata = null;
        this.chapterCache = new Map();
        this.prefetchedChapters = new Set();
        this.chapterTitles = [];
        this.chapterCount = 0;

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

        // Multi-PDF identity
        this.currentPdfKey = null;
        this.currentPdfDescriptor = null;
        this.currentEpubKey = null;
        this.currentEpubDescriptor = null;

        // Caches
        this.audioCache = new Map();

        // TTS engine
        this.piperInstance = null;
        this.currentPiperVoice = null;
        this.piperLoading = false;

        // View
        // TODO: Disable single view and remove code
        this.viewMode = this.app.config.DEFAULT_VIEW_MODE;

        // Highlights
        this.savedHighlights = new Map();
        this.autoHighlightEnabled = false;
        this.selectedHighlightColor = "#fff8b0";

        // Layout Detection Cache
        this.layoutDetectionCache = new Map(); // pageNumber → { detections, validWordIndices, timestamp }
        this.layoutCacheVersion = 1; // increment to invalidate
        this.layoutDetectionInProgress = new Map(); // pageNumber → Promise
        this.layoutFilteringReady = false;
        this.layoutFilteringPromise = null;

        // Prefetch tracking
        this.prefetchedPages = new Set();

        // Other runtime
        this.CURRENT_SPEED = 1.0;
        this.audioCtx = null;
        this.viewportHeight = window.visualViewport ? Math.round(window.visualViewport.height) : window.innerHeight;
        this.awaitingOrientationDecision = false;

        this.playerState = Object.freeze({
            PLAY: "play",
            PAUSE: "pause",
            STOP: "stop",
            LOADING: "loading",
            DONE: "done",
        });
    }

    get currentSentence() {
        return this.sentences[this.currentSentenceIndex];
    }
}
