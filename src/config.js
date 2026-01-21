// Centralized configuration constants extracted from original render.js
export const CONFIG = {
    VERSION_MAJOR: 0,
    VERSION_MINOR: 9,
    VERSION_PATCH: 0,
    VERSION_BUILD: 3,

    // Rendering
    ENABLE_WORD_HIGHLIGHT: true,
    ENABLE_LIVE_WORD_REGION: true,
    LIVE_WORD_REGION_ID: "live-word",
    LIVE_STATUS_REGION_ID: "live-status",
    DEFAULT_VIEW_MODE: "full", // render entire pdf file

    // Audio
    MAKE_WAV_COPY: false,
    STORE_DECODED_ONLY: true,
    FADE_IN_SEC: 0.03,
    FADE_OUT_SEC: 0.08,
    MIN_GAIN: 0.001,
    AUDIO_CONTEXT_OPTIONS: { latencyHint: "playback" },

    // Sentence processing
    BREAK_ON_LINE: false,
    SPLIT_ON_LINE_GAP: true,
    LINE_GAP_THRESHOLD: 2,
    // Multiplier applied to the current line height (in PDF unscaled units) to detect large horizontal gaps
    // (e.g. multi-column layouts). Using a relative threshold keeps sentence splitting consistent across
    // devices, zoom levels, and different BASE_WIDTH_CSS scales.
    WORD_GAP_THRESHOLD_EM: 2.5,
    SENTENCE_END: [".", "?", "!", ":", ".\""],

    // TTS
    PREFETCH_AHEAD: 10,
    MAX_CONCURRENT_SYNTH: navigator.hardwareConcurrency - 1 || 1,
    WORD_BOUNDARY_CHUNK_SIZE: 40,
    YIELD_AFTER_MS: 32,
    PIPER_VOICES: [
        "en_US-lessac-medium",
        "pt_BR-faber-medium",
        "en_GB-cori-medium",
        "de_DE-thorsten-medium",
        "es_ES-davefx-medium",
        "fr_FR-siwis-medium",
        "zh_CN-huayan-medium",
        "en_US-lessac-high",
    ],
    DEFAULT_PIPER_VOICE: "en_US-lessac-medium",

    // Responsive
    MOBILE_BREAKPOINT: 680,
    HORIZONTAL_MOBILE_MARGIN: 16,
    SCROLL_MARGIN: 120,

    // Storage
    VIEW_MODE_STORAGE_KEY: "pdfViewMode",
    PROGRESS_STORAGE_KEY: "charlesneimog.github.io/pdfReaderProgressMap",
    HIGHLIGHTS_STORAGE_KEY: "charlesneimog.github.io/pdfReaderHighlightsMap",

    // UI dynamic computed
    BASE_WIDTH_CSS: () => Math.max(360, Math.min(window.innerWidth, 1400)),
    VIEWPORT_HEIGHT_CSS: () => Math.max(260, window.innerHeight * 0.82),
    MARGIN_TOP: () => (window.innerWidth < 700 ? 50 : 100),

    MS_ON_FOCUS_TO_RENDER: 150,

    // Header detection
    TOLERANCE: 50, // pixels around detection boxes to tolerate small misalignments
};
