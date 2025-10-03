// ===============================
// render.js (PDF + TTS) - Mobile scaling fixed
// ===============================

/* ------------ CONFIG ------------ */
const ENABLE_WORD_HIGHLIGHT = true;
const ENABLE_LIVE_WORD_REGION = true;
const LIVE_WORD_REGION_ID = "live-word";
const LIVE_STATUS_REGION_ID = "live-status";

const MAKE_WAV_COPY = false;
const STORE_DECODED_ONLY = true;
const FADE_IN_SEC = 0.03;
const FADE_OUT_SEC = 0.08;
const MIN_GAIN = 0.001;

const AUDIO_CONTEXT_OPTIONS = { latencyHint: "playback" };

function getBaseWidthCSS() {
    return Math.max(360, Math.min(window.innerWidth * 0.96, 1400));
}

function getViewportHeightCSS() {
    return Math.max(260, Math.min(window.innerHeight * 0.72, 650));
}

function getMarginTop() {
    return window.innerWidth < 700 ? 50 : 100;
}

const BASE_WIDTH_CSS = getBaseWidthCSS();
const VIEWPORT_HEIGHT_CSS = getViewportHeightCSS();
const MARGIN_TOP = getMarginTop();

/* Sentence building */
const BREAK_ON_LINE = false;
const SPLIT_ON_LINE_GAP = false;
const LINE_GAP_THRESHOLD = 1.6;

/* Prefetch / TTS */
const PREFETCH_AHEAD = 1;
const PIPER_VOICES = [
    // "en_US-hfc_female-medium"
    // "en_US-hfc_female-medium"
    // "en_US-hfc_female-medium"
    // "en_US-hfc_female-medium"
    "en_US-hfc_female-medium",
    "pt_BR-faber-medium", 
    "en_GB-cori-medium", 
];

const DEFAULT_PIPER_VOICE = PIPER_VOICES[0];

/* Responsive */
const MOBILE_BREAKPOINT = 680; // px
const HORIZONTAL_MOBILE_MARGIN = 16; // px side margin used in scale calculation
const SCROLL_MARGIN = 120;

/* View mode */
const VIEW_MODE_STORAGE_KEY = "pdfViewMode"; // "full" | "single"
const PROGRESS_STORAGE_KEY = "charlesneimog.github.io/pdfReaderProgressMap";
const HIGHLIGHTS_STORAGE_KEY = "charlesneimog.github.io/pdfReaderHighlightsMap";

/* ------------ STATE ------------ */
let audioCtx = null;
let CURRENT_SPEED = 1.0;

let pdf = null;
let pagesCache = new Map();
let viewportDisplayByPage = new Map();
let fullPageRenderCache = new Map();
let sentences = [];
let currentSentenceIndex = -1;
let deviceScale = window.devicePixelRatio || 1;

let currentSource = null;
let currentGain = null;
let isPlaying = false;
let autoAdvanceActive = false;
let stopRequested = false;
let generationEnabled = false;

/* Multi-PDF identity */
let currentPdfKey = null;
let currentPdfDescriptor = null;

/* Caches */
const audioCache = new Map();

/* TTS engine */
let piperInstance = null;
let currentPiperVoice = null;
let piperLoading = false;

/* Concurrency / timers */
const MAX_CONCURRENT_SYNTH = 2;
const WORD_BOUNDARY_CHUNK_SIZE = 40;
const YIELD_AFTER_MS = 32;

/* View mode */
let viewMode = "single";

/* Highlights state */
let savedHighlights = new Map(); // sentenceIndex -> {color, timestamp}
let autoHighlightEnabled = false;

/* ------------ DOM ------------ */
const voiceSelect = document.getElementById("voice-select");
const speedSelect = document.getElementById("rate-select");
const btnNextSentence = document.getElementById("next-sentence");
const btnPrevSentence = document.getElementById("prev-sentence");
const btnPlayToggle = document.getElementById("play-toggle");
const btnPrevPage = document.getElementById("prev-page");
const btnNextPage = document.getElementById("next-page");
const toggleViewBtn = document.getElementById("toggle-view-mode");
const infoBox = document.getElementById("info-box");
const ttsStatus = document.getElementById("tts-status");
// const prefetchBar = document.getElementById("prefetch-bar");
// const subtitlePreview = document.getElementById("subtitle-preview");
const pdfCanvas = document.getElementById("pdf-canvas");
const pdfDocContainer = document.getElementById("pdf-doc-container");
const viewerWrapper = document.getElementById("viewer-wrapper");

/* Highlight controls */
const highlightColorPicker = document.getElementById("highlight-color");
const saveHighlightBtn = document.getElementById("save-highlight");
const exportHighlightsBtn = document.getElementById("export-highlights");

/* ------------ ARIA Regions ------------ */
(function ensureAriaRegions() {
    if (ENABLE_LIVE_WORD_REGION && !document.getElementById(LIVE_WORD_REGION_ID)) {
        const div = document.createElement("div");
        div.id = LIVE_WORD_REGION_ID;
        div.setAttribute("aria-live", "polite");
        div.setAttribute("aria-atomic", "true");
        div.style.position = "absolute";
        div.style.left = "-9999px";
        document.body.appendChild(div);
    }
    if (!document.getElementById(LIVE_STATUS_REGION_ID)) {
        const div = document.createElement("div");
        div.id = LIVE_STATUS_REGION_ID;
        div.setAttribute("aria-live", "polite");
        div.setAttribute("aria-atomic", "true");
        div.style.position = "absolute";
        div.style.left = "-9999px";
        document.body.appendChild(div);
    }
})();

/* ------------ Helpers ------------ */
const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const isMobile = () => window.innerWidth <= MOBILE_BREAKPOINT;

function cooperativeYield() {
    if (typeof requestIdleCallback === "function") return new Promise((res) => requestIdleCallback(() => res()));
    return new Promise((res) => setTimeout(res, 0));
}

async function ensureAudioContext() {
    if (!audioCtx) {
        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)(AUDIO_CONTEXT_OPTIONS);
        } catch {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
    }
    if (audioCtx.state === "suspended") {
        try {
            await audioCtx.resume();
        } catch (e) {
            console.warn("Resume fail:", e);
        }
    }
    return audioCtx;
}

/* Responsive scaling:
   Returns a scale factor (<=1) so pages fit on mobile without distortion */
function getPageDisplayScale(viewportDisplay) {
    if (!isMobile()) return 1;
    const available = window.innerWidth - HORIZONTAL_MOBILE_MARGIN;
    return Math.min(1, available / viewportDisplay.width);
}

/* ------------ Multi-PDF Progress ------------ */
function getProgressMap() {
    try {
        return JSON.parse(localStorage.getItem(PROGRESS_STORAGE_KEY) || "{}");
    } catch {
        return {};
    }
}
function setProgressMap(map) {
    try {
        localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(map));
    } catch (e) {
        console.warn("Failed to write progress map:", e);
    }
}

/* ------------ Highlights Storage ------------ */
function getHighlightsMap() {
    try {
        return JSON.parse(localStorage.getItem(HIGHLIGHTS_STORAGE_KEY) || "{}");
    } catch {
        return {};
    }
}
function setHighlightsMap(map) {
    try {
        localStorage.setItem(HIGHLIGHTS_STORAGE_KEY, JSON.stringify(map));
    } catch (e) {
        console.warn("Failed to write highlights map:", e);
    }
}
function loadSavedHighlights(pdfKey) {
    if (!pdfKey) return new Map();
    const allHighlights = getHighlightsMap();
    const pdfHighlights = allHighlights[pdfKey] || {};
    const highlightsMap = new Map();
    for (const [sentenceIndex, data] of Object.entries(pdfHighlights)) {
        highlightsMap.set(parseInt(sentenceIndex), data);
    }
    return highlightsMap;
}
function saveHighlightsForPdf() {
    if (!currentPdfKey) return;
    const allHighlights = getHighlightsMap();
    const pdfHighlights = {};
    for (const [sentenceIndex, data] of savedHighlights.entries()) {
        pdfHighlights[sentenceIndex] = data;
    }
    allHighlights[currentPdfKey] = pdfHighlights;
    setHighlightsMap(allHighlights);
}
function saveCurrentSentenceHighlight(color = null) {
    if (currentSentenceIndex < 0 || currentSentenceIndex >= sentences.length) return;
    const highlightColor = color || (highlightColorPicker?.value || "#ffeb3b");
    savedHighlights.set(currentSentenceIndex, {
        color: highlightColor,
        timestamp: Date.now(),
        sentenceText: sentences[currentSentenceIndex].text
    });
    saveHighlightsForPdf();
    updateHighlightDisplay();
}
function clearHighlight(sentenceIndex) {
    savedHighlights.delete(sentenceIndex);
    saveHighlightsForPdf();
    updateHighlightDisplay();
}

/* ------------ PDF Export with Highlights ------------ */
async function exportPdfWithHighlights() {
    if (!currentPdfDescriptor || savedHighlights.size === 0) {
        alert("No highlights to export or no PDF loaded.");
        return;
    }
    
    try {
        updateStatus("Preparing PDF export...");
        
        // Get original PDF data
        let pdfBytes;
        if (currentPdfDescriptor.type === "file") {
            if (currentPdfDescriptor.fileObject) {
                pdfBytes = await currentPdfDescriptor.fileObject.arrayBuffer();
            } else {
                throw new Error("Original file object not available for export");
            }
        } else if (currentPdfDescriptor.type === "url") {
            const response = await fetch(currentPdfDescriptor.url);
            pdfBytes = await response.arrayBuffer();
        } else {
            throw new Error("Cannot export: unsupported PDF source");
        }
        
        // Load PDF with pdf-lib
        const pdfDoc = await PDFLib.PDFDocument.load(pdfBytes);
        const pages = pdfDoc.getPages();
        
        // Group highlights by page
        const highlightsByPage = new Map();
        for (const [sentenceIndex, highlightData] of savedHighlights.entries()) {
            const sentence = sentences[sentenceIndex];
            if (!sentence || !sentence.words || sentence.words.length === 0) continue;
            
            const pageNum = sentence.pageNumber;
            if (!highlightsByPage.has(pageNum)) {
                highlightsByPage.set(pageNum, []);
            }
            highlightsByPage.get(pageNum).push({
                sentence: sentence,
                color: highlightData.color,
                text: sentence.text
            });
        }
        
        // Add highlights to each page
        for (const [pageNum, pageHighlights] of highlightsByPage.entries()) {
            if (pageNum > pages.length) continue;
            
            const page = pages[pageNum - 1]; // pdf-lib uses 0-based indexing
            const { width, height } = page.getSize();
            
            // Get the viewport scale used in our rendering
            const viewportDisplay = viewportDisplayByPage.get(pageNum);
            if (!viewportDisplay) continue;
            
            const scaleX = width / viewportDisplay.width;
            const scaleY = height / viewportDisplay.height;
            
            for (const highlight of pageHighlights) {
                const { sentence, color } = highlight;
                
                // Convert hex color to RGB
                const rgb = hexToRgb(color);
                const pdfColor = rgb ? 
                    PDFLib.rgb(rgb.r / 255, rgb.g / 255, rgb.b / 255) : 
                    PDFLib.rgb(1, 1, 0); // fallback yellow
                
                // Add individual word highlights instead of sentence bounding box
                for (const word of sentence.words) {
                    // Convert our coordinates to PDF coordinates
                    // Our Y coordinates are from top, PDF coordinates are from bottom
                    // word.y is the baseline, word.y - word.height is the top
                    const pdfX = word.x * scaleX;
                    const pdfY = height - (word.y - word.height) * scaleY; // Use top of word
                    const pdfWidth = word.width * scaleX;
                    const pdfHeight = word.height * scaleY;
                    
                    // Add rectangle annotation for each word
                    page.drawRectangle({
                        x: pdfX,
                        y: pdfY - pdfHeight, // Position from bottom
                        width: pdfWidth,
                        height: pdfHeight,
                        color: pdfColor,
                        opacity: 0.3,
                    });
                }
            }
        }
        
        // Generate filename
        const originalName = currentPdfDescriptor.name || "document";
        const baseName = originalName.replace(/\.pdf$/i, "");
        const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
        const filename = `${baseName}_highlighted_${timestamp}.pdf`;
        
        // Save the PDF
        const highlightedPdfBytes = await pdfDoc.save();
        const blob = new Blob([highlightedPdfBytes], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        
        URL.revokeObjectURL(url);
        updateStatus(`Exported: ${filename}`);
        
    } catch (error) {
        console.error("Export failed:", error);
        updateStatus("Export failed: " + error.message);
        alert("Failed to export PDF: " + error.message);
    }
}
function computePdfKeyFromSource(source) {
    if (source.type === "url") return `url::${source.name}`;
    if (source.type === "file") {
        const { name, size = 0, lastModified = 0 } = source;
        return `file::${name}::${size}::${lastModified}`;
    }
    return null;
}
function loadSavedPosition(pdfKey) {
    return getProgressMap()[pdfKey] || null;
}
function saveProgress() {
    if (!sentences.length || currentSentenceIndex < 0 || !currentPdfKey) return;
    const map = getProgressMap();
    map[currentPdfKey] = {
        sentenceIndex: currentSentenceIndex,
        totalSentences: sentences.length,
        updated: Date.now(),
    };
    setProgressMap(map);
}

/* ------------ PDF Processing ------------ */
async function preprocessPage(pageNumber) {
    if (viewportDisplayByPage.has(pageNumber)) return;
    const page = await pdf.getPage(pageNumber);
    pagesCache.set(pageNumber, page);
    const unscaled = page.getViewport({ scale: 1 });
    const displayScale = BASE_WIDTH_CSS / unscaled.width;
    const viewportDisplay = page.getViewport({ scale: displayScale });
    viewportDisplayByPage.set(pageNumber, viewportDisplay);

    const textContent = await page.getTextContent();
    const pageWords = [];
    for (const item of textContent.items) {
        if (!item?.transform || !item.str) continue;
        if (!item.str.trim()) continue;
        const [a, , , d, e, f] = item.transform;
        const x = e * displayScale;
        const y = viewportDisplay.height - f * displayScale;
        const width = (item.width || Math.abs(a)) * displayScale;
        const height = (item.height || Math.abs(d)) * displayScale;
        const tokens = item.str.split(/(\s+)/).filter((t) => t.trim().length > 0);
        const markLineBreak = !!item.hasEOL;
        if (tokens.length <= 1) {
            pageWords.push({ pageNumber, str: item.str.trim(), x, y, width, height, lineBreak: markLineBreak });
        } else {
            const totalChars = tokens.reduce((acc, t) => acc + t.length, 0) || 1;
            let cursorX = x;
            for (const tk of tokens) {
                const w = width * (tk.length / totalChars);
                pageWords.push({ pageNumber, str: tk.trim(), x: cursorX, y, width: w, height, lineBreak: false });
                cursorX += w;
            }
            if (markLineBreak && pageWords.length) pageWords[pageWords.length - 1].lineBreak = true;
        }
    }
    page.pageWords = pageWords;
    console.log(page);
}

function buildSentences() {
    const abbreviations = ["Mr", "Mrs", "Ms", "Dr", "Prof", "Sr", "Jr", "e.g", "i.e", "etc", "Fig", "p"];
    function isSentenceEnd(wordStr, nextWordStr) {
        const w = wordStr.replace(/[.?!]+$/, "");
        if (abbreviations.includes(w)) return false;
        if (nextWordStr && /^[0-9)]/.test(nextWordStr)) return false;
        return /[.?!]$/.test(wordStr);
    }

    sentences = [];
    let sentenceIndex = 0;
    for (let p = 1; p <= pdf.numPages; p++) {
        const page = pagesCache.get(p);
        if (!page?.pageWords) continue;
        let buffer = [];
        let lastY = null,
            lastHeight = null;

        const flush = () => {
            if (!buffer.length) return;
            const bbox = combinedBBox(buffer);
            const text = buffer.map((w) => w.str).join(" ");
            sentences.push({
                index: sentenceIndex++,
                pageNumber: p,
                words: [...buffer],
                text,
                bbox,
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
            });
            buffer = [];
        };

        for (let i = 0; i < page.pageWords.length; i++) {
            const w = page.pageWords[i];

            let gapBreak = false;
            if (SPLIT_ON_LINE_GAP && lastY !== null) {
                const verticalDelta = Math.abs(lastY - w.y);
                if (lastHeight && verticalDelta > lastHeight * LINE_GAP_THRESHOLD) gapBreak = true;
            }
            if (gapBreak && buffer.length) flush();

            // buffer.push(w);
            // if (/[.?!]$/.test(w.str) || (BREAK_ON_LINE && w.lineBreak)) flush();

            buffer.push(w);
            const nextWord = page.pageWords[i + 1]?.str || "";
            if (isSentenceEnd(w.str, nextWord) || (BREAK_ON_LINE && w.lineBreak)) flush();

            lastY = w.y;
            lastHeight = w.height;
        }
        flush();
    }
}

function combinedBBox(words) {
    if (!words.length) return null;
    const xs = words.map((w) => w.x);
    const ysTop = words.map((w) => w.y - w.height);
    const ysBottom = words.map((w) => w.y);
    const ws = words.map((w) => w.x + w.width);
    return {
        x: Math.min(...xs),
        y: Math.min(...ysTop),
        width: Math.max(...ws) - Math.min(...xs),
        height: Math.max(...ysBottom) - Math.min(...ysTop),
    };
}

async function ensureFullPageRendered(pageNumber) {
    if (fullPageRenderCache.has(pageNumber)) return fullPageRenderCache.get(pageNumber);
    const page = pagesCache.get(pageNumber) || (await pdf.getPage(pageNumber));
    const viewportDisplay = viewportDisplayByPage.get(pageNumber);
    const fullW = Math.round(viewportDisplay.width * deviceScale);
    const fullH = Math.round(viewportDisplay.height * deviceScale);
    const scale = (viewportDisplay.width / page.getViewport({ scale: 1 }).width) * deviceScale;
    const viewportRender = page.getViewport({ scale });
    const off = document.createElement("canvas");
    off.width = fullW;
    off.height = fullH;
    const offCtx = off.getContext("2d");
    await page.render({ canvasContext: offCtx, viewport: viewportRender }).promise;
    fullPageRenderCache.set(pageNumber, off);
    return off;
}

/* ------------ Full Document Mode ------------ */
function clearFullDocHighlights() {
    if (!pdfDocContainer) return;
    pdfDocContainer.querySelectorAll(".pdf-word-highlight").forEach((n) => n.remove());
    pdfDocContainer.querySelectorAll(".persistent-highlight").forEach((n) => n.remove());
}

function updateHighlightFullDoc(sentence) {
    if (viewMode !== "full" || !pdfDocContainer || !sentence) return;
    clearFullDocHighlights();
    
    // Show current sentence highlight (temporary)
    const wrapper = pdfDocContainer.querySelector(`.pdf-page-wrapper[data-page-number="${sentence.pageNumber}"]`);
    if (!wrapper) return;
    const scale = parseFloat(wrapper.dataset.scale) || 1;
    for (const w of sentence.words) {
        const div = document.createElement("div");
        div.className = "pdf-word-highlight";
        div.style.left = w.x * scale + "px";
        div.style.top = (w.y - w.height) * scale + "px";
        div.style.width = w.width * scale + "px";
        div.style.height = w.height * scale + "px";
        wrapper.appendChild(div);
    }
    
    // Show all saved highlights
    renderSavedHighlightsFullDoc();
}

function renderSavedHighlightsFullDoc() {
    if (viewMode !== "full" || !pdfDocContainer) return;
    
    for (const [sentenceIndex, highlightData] of savedHighlights.entries()) {
        const sentence = sentences[sentenceIndex];
        if (!sentence) continue;
        
        const wrapper = pdfDocContainer.querySelector(`.pdf-page-wrapper[data-page-number="${sentence.pageNumber}"]`);
        if (!wrapper) continue;
        
        const scale = parseFloat(wrapper.dataset.scale) || 1;
        
        // Create individual word highlights instead of sentence bounding box
        for (const word of sentence.words) {
            const div = document.createElement("div");
            div.className = "persistent-highlight";
            if (sentenceIndex === currentSentenceIndex) {
                div.classList.add("current-playing");
            }
            div.style.left = word.x * scale + "px";
            div.style.top = (word.y - word.height) * scale + "px";
            div.style.width = word.width * scale + "px";
            div.style.height = word.height * scale + "px";
            div.style.backgroundColor = highlightData.color;
            div.style.borderRadius = "2px"; // Slightly rounded for natural look
            div.title = `Highlighted: ${sentence.text.substring(0, 50)}...`;
            wrapper.appendChild(div);
        }
    }
}

function scrollSentenceIntoView(sentence) {
    if (viewMode !== "full" || !pdfDocContainer || !sentence) return;
    const wrapper = pdfDocContainer.querySelector(`.pdf-page-wrapper[data-page-number="${sentence.pageNumber}"]`);
    if (!wrapper) return;
    const bbox = sentence.bbox;
    if (!bbox) {
        wrapper.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
    }
    const scale = parseFloat(wrapper.dataset.scale) || 1;
    const wrapperTop = wrapper.offsetTop;
    const targetY = wrapperTop + bbox.y * scale - SCROLL_MARGIN;
    const maxScroll = pdfDocContainer.scrollHeight - pdfDocContainer.clientHeight;
    pdfDocContainer.scrollTo({ top: clamp(targetY, 0, maxScroll), behavior: "smooth" });
}

function applyPageScale(wrapper, viewportDisplay) {
    const scale = getPageDisplayScale(viewportDisplay);
    wrapper.dataset.scale = String(scale);
    wrapper.style.width = viewportDisplay.width * scale + "px";
    wrapper.style.height = viewportDisplay.height * scale + "px";
    const c = wrapper.querySelector("canvas");
    if (c) {
        c.style.width = "100%";
        c.style.height = "100%";
    }
}

async function renderFullDocumentIfNeeded() {
    if (viewMode !== "full" || !pdfDocContainer) return;
    pdfDocContainer.innerHTML = "";
    for (let p = 1; p <= pdf.numPages; p++) {
        const viewportDisplay = viewportDisplayByPage.get(p);
        await ensureFullPageRendered(p);
        const offscreen = fullPageRenderCache.get(p);

        const pageWrapper = document.createElement("div");
        pageWrapper.className = "pdf-page-wrapper";
        pageWrapper.dataset.pageNumber = p;

        const c = document.createElement("canvas");
        c.width = offscreen.width;
        c.height = offscreen.height;
        c.getContext("2d").drawImage(offscreen, 0, 0);

        pageWrapper.appendChild(c);
        pdfDocContainer.appendChild(pageWrapper);
        applyPageScale(pageWrapper, viewportDisplay);
    }
}

function rescaleAllPages() {
    if (viewMode !== "full" || !pdfDocContainer) return;
    pdfDocContainer.querySelectorAll(".pdf-page-wrapper").forEach((wrapper) => {
        const p = parseInt(wrapper.dataset.pageNumber, 10);
        const viewportDisplay = viewportDisplayByPage.get(p);
        if (viewportDisplay) applyPageScale(wrapper, viewportDisplay);
    });
    // Repaint highlight for current sentence
    updateHighlightFullDoc(sentences[currentSentenceIndex]);
}

function updateHighlightDisplay() {
    if (viewMode === "full") {
        renderSavedHighlightsFullDoc();
    } else {
        // Re-render current sentence to show any new highlights
        renderSentence(currentSentenceIndex);
    }
}

/* ------------ Rendering Sentence ------------ */
async function renderSentence(idx) {
    if (idx < 0 || idx >= sentences.length) return;
    currentSentenceIndex = idx;
    const sentence = sentences[idx];
    const pageNumber = sentence.pageNumber;

    if (viewMode === "full") {
        if (pdfCanvas) pdfCanvas.style.display = "none";
        if (pdfDocContainer) pdfDocContainer.style.display = "block";
        updateHighlightFullDoc(sentence);
        scrollSentenceIntoView(sentence);
    } else {
        if (pdfDocContainer) pdfDocContainer.style.display = "none";
        if (pdfCanvas) pdfCanvas.style.display = "block";

        const ctx = pdfCanvas.getContext("2d");
        const viewportDisplay = viewportDisplayByPage.get(pageNumber);
        const fullPageCanvas = await ensureFullPageRendered(pageNumber);

        if (isMobile()) {
            // Full page render (no cropping) scaled proportionally via CSS width
            const scaleCSS = getPageDisplayScale(viewportDisplay);
            pdfCanvas.width = Math.round(viewportDisplay.width * deviceScale);
            pdfCanvas.height = Math.round(viewportDisplay.height * deviceScale);
            pdfCanvas.style.width = viewportDisplay.width * scaleCSS + "px";
            pdfCanvas.style.height = viewportDisplay.height * scaleCSS + "px";
            ctx.clearRect(0, 0, pdfCanvas.width, pdfCanvas.height);
            ctx.drawImage(
                fullPageCanvas,
                0,
                0,
                fullPageCanvas.width,
                fullPageCanvas.height,
                0,
                0,
                pdfCanvas.width,
                pdfCanvas.height,
            );
            // Render saved highlights first, then current sentence highlight
            renderSavedHighlightsSingleCanvas(ctx, pageNumber, 0);
            highlightSentenceSingleCanvas(ctx, sentence, 0);
        } else {
            // Original cropped view for desktop
            const pageHeightDisplay = viewportDisplay.height;
            const pageWidthDisplay = viewportDisplay.width;

            pdfCanvas.style.width = pageWidthDisplay + "px";
            pdfCanvas.style.height = VIEWPORT_HEIGHT_CSS + "px";
            pdfCanvas.width = Math.round(pageWidthDisplay * deviceScale);
            pdfCanvas.height = Math.round(VIEWPORT_HEIGHT_CSS * deviceScale);

            let offsetYDisplay = 0;
            if (sentence.bbox) {
                const targetTop = sentence.bbox.y - MARGIN_TOP;
                const maxOffset = Math.max(0, pageHeightDisplay - VIEWPORT_HEIGHT_CSS);
                offsetYDisplay = clamp(targetTop, 0, maxOffset);
            }

            const offsetYRender = offsetYDisplay * deviceScale;
            const sliceHeightRender = pdfCanvas.height;
            const maxAvail = fullPageCanvas.height - offsetYRender;
            const effectiveSliceHeight = Math.min(sliceHeightRender, maxAvail);

            ctx.clearRect(0, 0, pdfCanvas.width, pdfCanvas.height);
            ctx.drawImage(
                fullPageCanvas,
                0,
                offsetYRender,
                fullPageCanvas.width,
                effectiveSliceHeight,
                0,
                0,
                pdfCanvas.width,
                effectiveSliceHeight,
            );
            // Render saved highlights first, then current sentence highlight
            renderSavedHighlightsSingleCanvas(ctx, pageNumber, offsetYDisplay);
            highlightSentenceSingleCanvas(ctx, sentence, offsetYDisplay);
        }
    }

    showInfo(`Sentence ${sentence.index + 1}/${sentences.length} (Page ${pageNumber})`);
    updateSubtitlePreview(sentence);
    updatePlayButton();
    schedulePrefetch();
    saveProgress();
}

function highlightSentenceSingleCanvas(ctx, sentence, offsetYDisplay) {
    if (!ctx || !sentence) return;
    ctx.save();
    ctx.fillStyle = "rgba(255,255,0,0.28)";
    for (const w of sentence.words) {
        const xR = w.x * deviceScale;
        const yTopDisplay = w.y - w.height - offsetYDisplay;
        const yR = yTopDisplay * deviceScale;
        const widthR = w.width * deviceScale;
        const heightR = w.height * deviceScale;
        if (yR + heightR < 0 || yR > pdfCanvas.height) continue;
        ctx.fillRect(xR, yR, widthR, heightR);
    }
    ctx.restore();
}

function renderSavedHighlightsSingleCanvas(ctx, pageNumber, offsetYDisplay) {
    if (!ctx) return;
    ctx.save();
    
    // Render all saved highlights for this page
    for (const [sentenceIndex, highlightData] of savedHighlights.entries()) {
        const sentence = sentences[sentenceIndex];
        if (!sentence || sentence.pageNumber !== pageNumber) continue;
        
        // Use saved color with some transparency
        const color = highlightData.color;
        const rgb = hexToRgb(color);
        if (rgb) {
            ctx.fillStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.3)`;
        } else {
            ctx.fillStyle = "rgba(255, 235, 59, 0.3)"; // fallback yellow
        }
        
        // Highlight each word individually instead of using bounding box
        for (const word of sentence.words) {
            const xR = word.x * deviceScale;
            const yTopDisplay = word.y - word.height - offsetYDisplay;
            const yR = yTopDisplay * deviceScale;
            const widthR = word.width * deviceScale;
            const heightR = word.height * deviceScale;
            
            if (yR + heightR < 0 || yR > pdfCanvas.height) continue;
            
            // Add rounded corners for a more natural highlight look
            ctx.fillRect(xR, yR, widthR, heightR);
        }
        
        // Add border for current sentence using word outlines
        if (sentenceIndex === currentSentenceIndex) {
            ctx.strokeStyle = "#ff9800";
            ctx.lineWidth = 2;
            for (const word of sentence.words) {
                const xR = word.x * deviceScale;
                const yTopDisplay = word.y - word.height - offsetYDisplay;
                const yR = yTopDisplay * deviceScale;
                const widthR = word.width * deviceScale;
                const heightR = word.height * deviceScale;
                if (yR + heightR < 0 || yR > pdfCanvas.height) continue;
                ctx.strokeRect(xR, yR, widthR, heightR);
            }
        }
    }
    ctx.restore();
}

function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
    } : null;
}

/* ------------ Navigation ------------ */
function nextSentence(manual = true) {
    if (currentSentenceIndex < sentences.length - 1) {
        stopPlayback(true);
        if (manual) autoAdvanceActive = false;
        renderSentence(currentSentenceIndex + 1);
    }
}
function prevSentence(manual = true) {
    if (currentSentenceIndex > 0) {
        stopPlayback(true);
        if (manual) autoAdvanceActive = false;
        renderSentence(currentSentenceIndex - 1);
    }
}
function nextPageNav() {
    const currentPage = sentences[currentSentenceIndex]?.pageNumber || 1;
    const target = Math.min(pdf.numPages, currentPage + 1);
    const firstIdx = sentences.findIndex((s) => s.pageNumber === target);
    if (firstIdx >= 0) renderSentence(firstIdx);
}
function prevPageNav() {
    const currentPage = sentences[currentSentenceIndex]?.pageNumber || 1;
    const target = Math.max(1, currentPage - 1);
    const firstIdx = sentences.findIndex((s) => s.pageNumber === target);
    if (firstIdx >= 0) renderSentence(firstIdx);
}

/* ------------ Text Normalizing ------------ */
function normalizeText(raw) {
    if (!raw) return "";
    let t = raw.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, " ");
    t = t.replace(/\s+/g, " ").trim();
    if (t && !/[.?!…]$/.test(t)) t += ".";
    return t;
}
function formatTextToSpeech(text) {
    if (!text) return "";
    text = text
        .replace(/\([^)]*\)/g, "")
        .replace(/\[[^\]]]*\]/g, "")
        .replace(/\b(?:https?:\/\/|www\.)\S+\b/g, "")
        .replace(/\b([a-z]+)-\s*([a-z]+)/g, "$1$2")
        .replace(/\n/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim();
    return text;
}

/* ------------ TTS Build ------------ */
async function ensurePiper(voice) {
    if (!window.ort) throw new Error("ONNX Runtime not loaded.");
    if (!window.ProperPiperTTS) throw new Error("Piper library not loaded.");
    if (!piperInstance || currentPiperVoice !== voice) {
        if (piperLoading) {
            while (piperLoading) await cooperativeYield();
        } else {
            piperLoading = true;
            try {
                if (piperInstance && currentPiperVoice !== voice) {
                    await piperInstance.changeVoice(voice);
                } else {
                    piperInstance = new window.ProperPiperTTS(voice);
                    await piperInstance.init();
                }
                currentPiperVoice = voice;
            } finally {
                piperLoading = false;
            }
        }
    }
}

async function buildPiperAudio(sentence, voice, text) {
    async function retryAsync(fn, tries = 3, gap = 300) {
        let last;
        for (let i = 0; i < tries; i++) {
            try {
                return await fn();
            } catch (e) {
                last = e;
                if (i < tries - 1) await delay(gap);
            }
        }
        throw last;
    }

    await ensureAudioContext();
    await ensurePiper(voice);
    await cooperativeYield();

    const wavBlob = await retryAsync(async () => {
        try {
            const cleaned = formatTextToSpeech(text);
            return await piperInstance.synthesize(cleaned, CURRENT_SPEED);
        } catch (e) {
            await ensurePiper(voice);
            throw e;
        }
    });

    const arrBuf = await wavBlob.arrayBuffer();
    const decoded = await safeDecodeAudioData(arrBuf.slice(0));

    let wordBoundaries = [];
    if (ENABLE_WORD_HIGHLIGHT) {
        const words = text.split(/\s+/).filter(Boolean);
        const total = words.length || 1;
        const totalMs = decoded.duration * 1000;
        for (let i = 0; i < words.length; i++) {
            wordBoundaries.push({
                text: words[i],
                offsetMs: Math.floor((i / total) * totalMs),
                durationMs: Math.floor(totalMs / total),
            });
            if (i > 0 && i % WORD_BOUNDARY_CHUNK_SIZE === 0) await cooperativeYield();
        }
    }

    const cacheKey = `${voice}|${CURRENT_SPEED}|${sentence.normalizedText}`;
    audioCache.set(cacheKey, {
        audioBlob: STORE_DECODED_ONLY ? null : wavBlob,
        wavBlob: MAKE_WAV_COPY ? wavBlob : null,
        audioBuffer: decoded,
        wordBoundaries,
    });

    Object.assign(sentence, {
        audioBlob: STORE_DECODED_ONLY ? null : wavBlob,
        wavBlob: MAKE_WAV_COPY ? wavBlob : null,
        audioBuffer: decoded,
        audioReady: true,
        lastVoice: voice,
        lastSpeed: CURRENT_SPEED,
        prefetchQueued: false,
        audioError: null,
        wordBoundaries,
    });
}

async function safeDecodeAudioData(arrayBuffer) {
    await ensureAudioContext();
    if (!arrayBuffer || arrayBuffer.byteLength < 100) throw new Error("Audio buffer too small/invalid.");
    try {
        return await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    } catch (err) {
        try {
            if (audioCtx) await audioCtx.close();
        } catch {}
        audioCtx = null;
        await ensureAudioContext();
        return audioCtx.decodeAudioData(arrayBuffer.slice(0));
    }
}

/* ------------ TTS Queue ------------ */
class TTSQueueManager {
    constructor() {
        this.queue = [];
        this.active = 0;
        this.inFlight = new Set();
    }
    add(idx, priority = false) {
        if (!generationEnabled) return;
        const s = sentences[idx];
        if (!s || s.audioReady || s.audioInProgress) return;
        if (this.queue.includes(idx) || this.inFlight.has(idx)) return;
        s.prefetchQueued = true;
        priority ? this.queue.unshift(idx) : this.queue.push(idx);
        this.run();
    }
    run() {
        while (this.active < MAX_CONCURRENT_SYNTH && this.queue.length) {
            const idx = this.queue.shift();
            this.startTask(idx);
        }
        updatePrefetchVisual();
    }
    async startTask(idx) {
        const s = sentences[idx];
        if (!s) return;
        if (s.audioReady || s.audioInProgress) {
            this.run();
            return;
        }
        this.active++;
        this.inFlight.add(idx);
        try {
            await synthesizeSequential(idx);
        } catch (e) {
            console.warn("Synthesis failure:", e);
        } finally {
            this.active--;
            this.inFlight.delete(idx);
            this.run();
        }
    }
    reset() {
        this.queue = [];
    }
}
const ttsQueue = new TTSQueueManager();

async function synthesizeSequential(idx) {
    if (!generationEnabled) return;
    const s = sentences[idx];
    if (!s) return;
    const voice = voiceSelect?.value || DEFAULT_PIPER_VOICE;
    if (s.audioReady && s.lastVoice === voice && s.lastSpeed === CURRENT_SPEED) return;
    if (s.audioInProgress) return;
    const norm = normalizeText(s.text);
    s.normalizedText = norm;
    const cacheKey = `${voice}|${CURRENT_SPEED}|${norm}`;
    if (audioCache.has(cacheKey)) {
        const cached = audioCache.get(cacheKey);
        Object.assign(s, {
            audioBlob: cached.audioBlob || null,
            wavBlob: cached.wavBlob || null,
            audioBuffer: cached.audioBuffer,
            audioReady: true,
            lastVoice: voice,
            lastSpeed: CURRENT_SPEED,
            audioError: null,
            audioInProgress: false,
            prefetchQueued: false,
            wordBoundaries: cached.wordBoundaries || [],
        });
        return;
    }
    s.audioInProgress = true;
    s.audioError = null;

    const icon = btnPlayToggle?.querySelector("i");
    const label = document.getElementById("play-toggle-label");
    if (icon) icon.className = "fa-solid fa-spinner fa-spin";
    if (label) label.textContent = "Generating";

    updateStatus(`Generating audio (sentence ${s.index + 1})...`);
    try {
        await buildPiperAudio(s, voice, norm);
        updateStatus("");
    } catch (err) {
        s.audioError = err;
        updateStatus(`TTS error (sentence ${s.index + 1})`);
    } finally {
        s.audioInProgress = false;
        updatePrefetchVisual();
        if (icon) icon.className = isPlaying ? "fa-solid fa-pause" : "fa-solid fa-play";
        if (label) label.textContent = isPlaying ? "Pause" : "Play";
    }
}

/* ------------ Prefetch Visual ------------ */
function schedulePrefetch() {
    if (!generationEnabled) return;
    if (currentSentenceIndex >= 0) ttsQueue.add(currentSentenceIndex, true);
    const base = currentSentenceIndex;
    for (let i = base + 1; i <= base + PREFETCH_AHEAD && i < sentences.length; i++) {
        ttsQueue.add(i);
    }
    updatePrefetchVisual();
}

function updatePrefetchVisual() {
    return;
    if (!prefetchBar) return;
    if (!generationEnabled) {
        prefetchBar.style.width = "0%";
        return;
    }
    let needed = 0,
        ready = 0;
    const base = currentSentenceIndex;
    for (let i = base; i <= base + PREFETCH_AHEAD && i < sentences.length; i++) {
        needed++;
        if (sentences[i].audioReady) ready++;
    }
    prefetchBar.style.width = (needed === 0 ? 0 : (ready / needed) * 100) + "%";
}

/* ------------ Playback ------------ */
function updateStatus(msg) {
    if (ttsStatus) ttsStatus.textContent = msg || "";
    const live = document.getElementById(LIVE_STATUS_REGION_ID);
    if (live) live.textContent = msg || "";
}

function updatePlayButton() {
    const s = sentences[currentSentenceIndex];
    if (!btnPlayToggle) return;
    btnPlayToggle.disabled = !s;
    const icon = btnPlayToggle.querySelector("i");
    const label = document.getElementById("play-toggle-label");
    if (!s) {
        if (icon) icon.className = "fa-solid fa-play";
        if (label) label.textContent = "Play";
        return;
    }
    if (icon) icon.className = isPlaying ? "fa-solid fa-pause" : "fa-solid fa-play";
    if (label) label.textContent = isPlaying ? "Pause" : "Play";
}

async function playCurrentSentence() {
    const s = sentences[currentSentenceIndex];
    if (!s || isPlaying) return;
    await ensureAudioContext();

    if (!generationEnabled) {
        generationEnabled = true;
        ttsQueue.add(currentSentenceIndex, true);
        ttsQueue.run();
        schedulePrefetch();
    }
    if (!s.audioReady) {
        ttsQueue.add(currentSentenceIndex, true);
        ttsQueue.run();
        try {
            await waitFor(() => s.audioReady || s.audioError, 45000);
        } catch {}
    }
    if (!s.audioReady || s.audioError || !s.audioBuffer) {
        updateStatus("❌ Audio not ready.");
        return;
    }

    stopPlayback(false);
    stopRequested = false;

    try {
        if (currentSource)
            try {
                currentSource.disconnect();
            } catch {}
        if (currentGain)
            try {
                currentGain.disconnect();
            } catch {}

        currentSource = audioCtx.createBufferSource();
        currentSource.buffer = s.audioBuffer;

        currentGain = audioCtx.createGain();
        currentGain.gain.setValueAtTime(MIN_GAIN, audioCtx.currentTime);
        currentSource.connect(currentGain).connect(audioCtx.destination);
        currentGain.gain.exponentialRampToValueAtTime(1.0, audioCtx.currentTime + FADE_IN_SEC);

        setupWordBoundaryTimers(s);

        currentSource.onended = async () => {
            clearWordBoundaryTimers(s);
            if (stopRequested) return;
            
            // Auto-highlight if enabled
            if (autoHighlightEnabled) {
                saveCurrentSentenceHighlight();
            }
            
            isPlaying = false;
            updatePlayButton();
            if (!autoAdvanceActive) return;
            if (currentSentenceIndex < sentences.length - 1) {
                await delay(120);
                if (stopRequested) return;
                renderSentence(currentSentenceIndex + 1);
                playCurrentSentence();
            }
        };

        await delay(10);
        currentSource.start();
        isPlaying = true;
        autoAdvanceActive = true;
        updatePlayButton();
    } catch (err) {
        console.error("Playback error:", err);
        updateStatus("Playback error; resetting context.");
        try {
            if (audioCtx) await audioCtx.close();
        } catch {}
        audioCtx = null;
    }
}

async function stopPlayback(fade = true) {
    stopRequested = true;
    if (currentSource && audioCtx) {
        try {
            if (fade && currentGain && audioCtx.state === "running") {
                const now = audioCtx.currentTime;
                const val = currentGain.gain.value;
                if (val > MIN_GAIN) {
                    currentGain.gain.cancelScheduledValues(now);
                    currentGain.gain.setValueAtTime(val, now);
                    currentGain.gain.linearRampToValueAtTime(MIN_GAIN, now + FADE_OUT_SEC);
                }
                setTimeout(
                    () => {
                        try {
                            currentSource.stop();
                        } catch {}
                        try {
                            currentSource.disconnect();
                        } catch {}
                        try {
                            if (currentGain) currentGain.disconnect();
                        } catch {}
                    },
                    FADE_OUT_SEC * 1000 + 10,
                );
            } else {
                try {
                    currentSource.stop();
                } catch {}
                try {
                    currentSource.disconnect();
                } catch {}
                try {
                    if (currentGain) currentGain.disconnect();
                } catch {}
            }
        } catch (e) {
            console.warn("Stop error:", e);
        }
    }
    currentSource = null;
    currentGain = null;
    isPlaying = false;
    updatePlayButton();
    const s = sentences[currentSentenceIndex];
    if (s) clearWordBoundaryTimers(s);
}

function togglePlay() {
    if (isPlaying) {
        stopPlayback(true);
        autoAdvanceActive = false;
    } else {
        playCurrentSentence();
    }
}

/* ------------ Word Boundaries ------------ */
function setupWordBoundaryTimers(s) {
    clearWordBoundaryTimers(s);
    if (!ENABLE_WORD_HIGHLIGHT || !s.wordBoundaries?.length) return;
    const liveWord = document.getElementById(LIVE_WORD_REGION_ID);
    for (const wb of s.wordBoundaries) {
        const id = setTimeout(() => {
            if (liveWord) liveWord.textContent = wb.text;
        }, wb.offsetMs);
        s.playbackWordTimers.push(id);
    }
}
function clearWordBoundaryTimers(s) {
    if (!s.playbackWordTimers) return;
    for (const t of s.playbackWordTimers) clearTimeout(t);
    s.playbackWordTimers = [];
}

/* ------------ Wait For ------------ */
function waitFor(condFn, timeoutMs = 10000, interval = 120) {
    return new Promise((resolve, reject) => {
        const start = performance.now();
        const id = setInterval(() => {
            if (condFn()) {
                clearInterval(id);
                resolve(true);
            } else if (performance.now() - start > timeoutMs) {
                clearInterval(id);
                reject(new Error("Timeout"));
            }
        }, interval);
    });
}

/* ------------ Subtitle Preview ------------ */
function updateSubtitlePreview(sentence) {
    return;
    // if (!subtitlePreview) return;
    // if (!sentence?.text) {
    //     subtitlePreview.textContent = "";
    //     return;
    // }
    // const txt = sentence.text.trim().replace(/\s+/g, " ");
    // subtitlePreview.textContent = txt.length > 160 ? txt.slice(0, 160) + "..." : txt;
}

/* ------------ Info ------------ */
function showInfo(msg) {
    if (infoBox) infoBox.textContent = msg;
    else console.log(msg);
}

/* ------------ Invalidate ------------ */
function invalidateFrom(idx) {
    for (let i = idx; i < sentences.length; i++) {
        const s = sentences[i];
        s.audioBlob = null;
        s.wavBlob = null;
        s.audioBuffer = null;
        s.audioReady = false;
        s.audioError = null;
        s.audioInProgress = false;
        s.prefetchQueued = false;
        s.lastVoice = null;
        s.lastSpeed = null;
        s.normalizedText = null;
        s.wordBoundaries = [];
        clearWordBoundaryTimers(s);
    }
    ttsQueue.reset();
}

/* ------------ View Mode Toggle ------------ */
function applyViewModeUI() {
    if (!toggleViewBtn) return;
    const label = toggleViewBtn.querySelector(".label");
    if (viewMode === "full") {
        if (label) label.textContent = "View: Full Doc";
        if (pdfDocContainer) pdfDocContainer.style.display = "block";
        if (viewerWrapper) viewerWrapper.style.display = "none";
    } else {
        if (label) label.textContent = "View: Single Page";
        if (pdfDocContainer) pdfDocContainer.style.display = "none";
        if (viewerWrapper) viewerWrapper.style.display = "flex";
    }
}

window.toggleViewMode = async function () {
    viewMode = viewMode === "full" ? "single" : "full";
    localStorage.setItem(VIEW_MODE_STORAGE_KEY, viewMode);
    applyViewModeUI();
    if (viewMode === "full") {
        await renderFullDocumentIfNeeded();
        renderSentence(currentSentenceIndex);
    } else {
        clearFullDocHighlights();
        renderSentence(currentSentenceIndex);
    }
};

/* ------------ Load PDF ------------ */
export async function loadPDF(file = null, { resume = true } = {}) {
    try {
        if (file instanceof File) {
            currentPdfDescriptor = {
                type: "file",
                name: file.name,
                size: file.size,
                lastModified: file.lastModified,
                fileObject: file, // Store reference to the actual file
            };
            document.getElementById("pdf-open").classList.remove("fa-beat");
        } else {
            if (!piperInstance) {
                piperInstance = new window.ProperPiperTTS(DEFAULT_PIPER_VOICE);
                await piperInstance.init();
                await piperInstance.getAvailableVoices();
            }
            initVoices();

            document.getElementById("pdf-open").classList.add("fa-beat");
            document.getElementById("play-toggle-icon").classList.toggle("disabled");

            return;
        }
        currentPdfKey = computePdfKeyFromSource(currentPdfDescriptor);

        pagesCache.clear();
        viewportDisplayByPage.clear();
        fullPageRenderCache.clear();
        audioCache.clear();
        sentences = [];
        currentSentenceIndex = -1;

        let arrayBuffer;
        if (file instanceof File) {
            arrayBuffer = await file.arrayBuffer();
        } else {
            return;
        }

        const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) });
        pdf = await loadingTask.promise;
        if (!pdf.numPages) throw new Error("PDF has no pages.");

        for (let p = 1; p <= pdf.numPages; p++) await preprocessPage(p);
        buildSentences();

        if (viewMode === "full") {
            await renderFullDocumentIfNeeded();
        }

        let startIndex = 0;
        if (resume && currentPdfKey) {
            const saved = loadSavedPosition(currentPdfKey);
            if (saved && typeof saved.sentenceIndex === "number")
                startIndex = clamp(saved.sentenceIndex, 0, sentences.length - 1);
        }

        // Load saved highlights for this PDF
        savedHighlights = loadSavedHighlights(currentPdfKey);

        await renderSentence(startIndex);
        showInfo(`Total sentences: ${sentences.length}`);
        updatePlayButton();
    } catch (e) {
        console.error(e);
        showInfo("Error: " + e.message);
    }

    try {
        if (!piperInstance) {
            piperInstance = new window.ProperPiperTTS(DEFAULT_PIPER_VOICE);
            await piperInstance.init();
            await piperInstance.getAvailableVoices();
        }
        initVoices();
    } catch (e) {
        console.warn("Piper init error:", e);
    }
}

/* ------------ Voices Init ------------ */
function initVoices() {
    if (!voiceSelect) return;
    voiceSelect.innerHTML = "";
    const allVoices = piperInstance.availableVoices;
    PIPER_VOICES.forEach((v) => {
        const opt = document.createElement("option");
        opt.value = v;
        opt.textContent = allVoices[v] || v;
        voiceSelect.appendChild(opt);
    });
    voiceSelect.value = DEFAULT_PIPER_VOICE;
    const micIcon = document.getElementById("mic-icon");
    if (micIcon) {
        micIcon.classList.remove("fa-spinner", "fa-spin");
        micIcon.classList.add("fa-microphone");
    }
}

/* ------------ Events ------------ */
if (btnNextSentence) btnNextSentence.addEventListener("click", () => nextSentence(true));
if (btnPrevSentence) btnPrevSentence.addEventListener("click", () => prevSentence(true));
if (btnPlayToggle) btnPlayToggle.addEventListener("click", togglePlay);
if (btnNextPage)
    btnNextPage.addEventListener("click", () => {
        stopPlayback(true);
        autoAdvanceActive = false;
        ttsQueue.reset();
        nextPageNav();
    });
if (btnPrevPage)
    btnPrevPage.addEventListener("click", () => {
        stopPlayback(true);
        autoAdvanceActive = false;
        ttsQueue.reset();
        prevPageNav();
    });

/* Highlight controls */
if (saveHighlightBtn) {
    saveHighlightBtn.addEventListener("click", () => {
        saveCurrentSentenceHighlight();
        updateStatus("Highlight saved!");
        setTimeout(() => updateStatus(""), 2000);
    });
}

if (exportHighlightsBtn) {
    exportHighlightsBtn.addEventListener("click", exportPdfWithHighlights);
}

if (voiceSelect) {
    voiceSelect.addEventListener("change", () => {
        stopPlayback(true);
        autoAdvanceActive = false;
        invalidateFrom(currentSentenceIndex);
        schedulePrefetch();
    });
}

if (speedSelect) {
    speedSelect.addEventListener("change", () => {
        const val = parseFloat(speedSelect.value);
        CURRENT_SPEED = isNaN(val) ? 1.0 : val;
        stopPlayback(true);
        autoAdvanceActive = false;
        invalidateFrom(currentSentenceIndex);
        schedulePrefetch();
    });
}

window.addEventListener("keydown", (e) => {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
    } else if (e.code === "ArrowRight") {
        nextSentence(true);
    } else if (e.code === "ArrowLeft") {
        prevSentence(true);
    } else if (e.key.toLowerCase() === "p") {
        togglePlay();
    }
});

window.addEventListener("beforeunload", () => saveProgress());

/* Responsive re-scaling on resize/orientation */
window.addEventListener("resize", () => {
    if (viewMode === "full") {
        rescaleAllPages();
        updateHighlightFullDoc(sentences[currentSentenceIndex]);
    } else {
        // Re-render current sentence so single page view recalculates canvas CSS sizes
        renderSentence(currentSentenceIndex);
    }
});
window.addEventListener("orientationchange", () => {
    setTimeout(() => {
        if (viewMode === "full") {
            rescaleAllPages();
            updateHighlightFullDoc(sentences[currentSentenceIndex]);
        } else {
            renderSentence(currentSentenceIndex);
        }
    }, 150);
});

/* ------------ Public Extras ------------ */
window.listSavedProgress = () => getProgressMap();
window.clearPdfProgress = (key) => {
    const map = getProgressMap();
    if (map[key]) {
        delete map[key];
        setProgressMap(map);
    }
};

/* Highlight management functions */
window.listSavedHighlights = () => getHighlightsMap();
window.clearPdfHighlights = (key) => {
    const map = getHighlightsMap();
    if (map[key]) {
        delete map[key];
        setHighlightsMap(map);
        if (key === currentPdfKey) {
            savedHighlights.clear();
            updateHighlightDisplay();
        }
    }
};
window.exportHighlights = exportPdfWithHighlights;
window.saveHighlight = () => saveCurrentSentenceHighlight();

/* ------------ Initialization Helper ------------ */
window.initializePdfApp = async function () {
    applyViewModeUI();
    await loadPDF();
};

/* Expose some functions */
window.loadPDF = loadPDF;
window.nextSentence = () => nextSentence(true);
window.prevSentence = () => prevSentence(true);
window.playSentence = playCurrentSentence;
window.togglePlay = togglePlay;
