// ==============================================
// PDF Sentence Highlighter + Piper TTS (Local WASM)
// ==============================================
//
// Rewritten from EdgeTTS-only version to use Piper (ProperPiperTTS).
// Removed all EdgeTTS streaming logic. Prefetch/caching/fades retained.
// Word highlighting is approximate (heuristic) because Piper JS wrapper
// does not expose real word boundary timings.
//
// Refactor:
//  - Concurrency-limited background synthesis
//  - Cooperative yielding to keep UI responsive
//  - Only start generating audio AFTER user presses Play
//
// ==============================================

/* -------------------- CONFIG: ACCESSIBILITY -------------------- */
const ENABLE_WORD_HIGHLIGHT = true;
const ENABLE_LIVE_WORD_REGION = true;
const LIVE_WORD_REGION_ID = "live-word";
const LIVE_STATUS_REGION_ID = "live-status";

/* -------------------- CONFIG: AUDIO / FADES / BUFFER -------------------- */
const MAKE_WAV_COPY = false;
const STORE_DECODED_ONLY = true;
const FADE_IN_SEC = 0.03;
const FADE_OUT_SEC = 0.08;
const MIN_GAIN = 0.001;

/* -------------------- AUDIO CONTEXT -------------------- */
const AUDIO_CONTEXT_OPTIONS = { latencyHint: "playback" };
let audioCtx = null;

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

async function safeDecodeAudioData(arrayBuffer) {
    await ensureAudioContext();
    if (!arrayBuffer || arrayBuffer.byteLength < 100) throw new Error("Audio ArrayBuffer too small or invalid.");
    try {
        return await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    } catch (err) {
        console.warn("Primary decode failed; recreating AudioContext:", err);
        try {
            if (audioCtx) await audioCtx.close();
        } catch {}
        audioCtx = null;
        await ensureAudioContext();
        return await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    }
}

function analyzeAudioBuffer(buffer) {
    if (!buffer) return;
    console.log("=== AUDIO DIAGNOSTIC ===");
    console.log("Duration (s):", buffer.duration);
    console.log("Sample Rate:", buffer.sampleRate);
    console.log("Channels:", buffer.numberOfChannels);
    console.log("Length (samples):", buffer.length);
}

/* -------------------- CONFIG: PDF -------------------- */
const PDF_URL = "pdf.pdf";
const BASE_WIDTH_CSS = 1400;
const VIEWPORT_HEIGHT_CSS = 650;
const MARGIN_TOP = 100;

/* -------------------- CONFIG: SENTENCE BUILDING -------------------- */
const BREAK_ON_LINE = false;
const SPLIT_ON_LINE_GAP = false;
const LINE_GAP_THRESHOLD = 1.6;

/* -------------------- CONFIG: TTS PREFETCH -------------------- */
const PREFETCH_AHEAD = 1;

/* -------------------- PIPER SETTINGS -------------------- */
const DEFAULT_PIPER_VOICE = "en_US-hfc_female-medium";
let CURRENT_SPEED = 1.0;

/* -------------------- DOM ELEMENTS -------------------- */
const languageSelect = document.getElementById("language-select");
const voiceSelect = document.getElementById("voice-select");
const canvas = document.getElementById("pdf-canvas");
const ctx = canvas.getContext("2d");
const btnNextSentence = document.getElementById("next-sentence");
const btnPrevSentence = document.getElementById("prev-sentence");
const btnPlayToggle = document.getElementById("play-toggle");
const infoBox = document.getElementById("info-box");
const ttsStatus = document.getElementById("tts-status");
const speedSelect = document.getElementById("rate-select");
const prefetchBar = document.getElementById("prefetch-bar");
const subtitlePreview = document.getElementById("subtitle-preview");

/* -------------------- STATE -------------------- */
let pdf = null;
let pagesCache = new Map();
let viewportDisplayByPage = new Map();
let fullPageRenderCache = new Map();
let sentences = [];
let currentSentenceIndex = -1;
let deviceScale = window.devicePixelRatio || 1;

// Playback
let currentSource = null;
let currentGain = null;
let isPlaying = false;
let autoAdvanceActive = false;
let stopRequested = false;

// TTS generation enable flag (só gera depois do Play)
let generationEnabled = false;

// Audio cache
const audioCache = new Map();

/* -------------------- COOPERATIVE MULTITASKING HELPERS -------------------- */
const MAX_CONCURRENT_SYNTH = 2;
const WORD_BOUNDARY_CHUNK_SIZE = 40;
const YIELD_AFTER_MS = 32;

function cooperativeYield() {
    if (typeof requestIdleCallback === "function") return new Promise((res) => requestIdleCallback(() => res()));
    return new Promise((res) => setTimeout(res, 0));
}

async function timedCooperativeLoop(loopFn) {
    let lastYield = performance.now();
    while (true) {
        const result = loopFn();
        if (result === false) break;
        if (performance.now() - lastYield > YIELD_AFTER_MS) {
            await cooperativeYield();
            lastYield = performance.now();
        }
    }
}

/* -------------------- ARIA LIVE REGIONS -------------------- */
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

/* -------------------- PIPER INITIALIZATION -------------------- */
let piperInstance = null;
let currentPiperVoice = null;
let piperLoading = false;

async function ensurePiper(voice) {
    if (!window.ort) throw new Error("ONNX Runtime (ort.min.js) not loaded.");
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

/* -------------------- VOICE LIST -------------------- */
const PIPER_VOICES = ["en_US-hfc_female-medium"];

function initVoices() {
    console.log(piperInstance.availableVoices);
    if (languageSelect) {
        languageSelect.innerHTML = "";
        const opt = document.createElement("option");
        opt.value = "en";
        opt.textContent = "en";
        languageSelect.appendChild(opt);
    }
    if (voiceSelect) {
        voiceSelect.innerHTML = "";
        PIPER_VOICES.forEach((v) => {
            const option = document.createElement("option");
            option.value = v;
            option.textContent = v;
            voiceSelect.appendChild(option);
        });
        voiceSelect.value = DEFAULT_PIPER_VOICE;
    }
}

/* -------------------- QUEUE MANAGER -------------------- */
class TTSQueueManager {
    constructor() {
        this.queue = [];
        this.active = 0;
        this.MAX_CONCURRENT = MAX_CONCURRENT_SYNTH;
        this.inFlight = new Set();
    }
    add(sentenceIndex, priority = false) {
        if (!generationEnabled) return; // não enfileira antes do play
        const s = sentences[sentenceIndex];
        if (!s) return;
        if (s.audioReady || s.audioInProgress) return;
        if (this.queue.includes(sentenceIndex) || this.inFlight.has(sentenceIndex)) return;
        s.prefetchQueued = true;
        priority ? this.queue.unshift(sentenceIndex) : this.queue.push(sentenceIndex);
        this.run();
    }
    run() {
        if (!generationEnabled) return;
        while (this.active < this.MAX_CONCURRENT && this.queue.length) {
            const idx = this.queue.shift();
            if (idx == null) break;
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

/* -------------------- UTILS -------------------- */
const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================== LOAD PDF ================== */
export async function loadPDF(file = null) {
    try {
        let loadingTask;
        if (!file) {
            loadingTask = pdfjsLib.getDocument(PDF_URL);
        } else {
            const arrayBuffer = await file.arrayBuffer();
            loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) });
            pagesCache.clear();
            viewportDisplayByPage.clear();
            fullPageRenderCache.clear();
            audioCache.clear();
        }
        pdf = await loadingTask.promise;
        if (!pdf.numPages) throw new Error("PDF has no pages.");
        for (let p = 1; p <= pdf.numPages; p++) await preprocessPage(p);
        buildSentences();
        await renderSentence(0);
        showInfo(`Total sentences: ${sentences.length}`);
        updatePlayButton();
        // NÃO faz prefetch aqui (somente após Play)
        ensureFullPageRendered(1);
    } catch (e) {
        console.error(e);
        showInfo("Error: " + e.message);
    }
    piperInstance = new window.ProperPiperTTS(DEFAULT_PIPER_VOICE);
    await piperInstance.init();

    initVoices();
}

/* ================== PREPROCESS PAGE ================== */
async function preprocessPage(pageNumber) {
    if (viewportDisplayByPage.has(pageNumber)) return;
    const page = await pdf.getPage(pageNumber);
    pagesCache.set(pageNumber, page);
    const unscaled = page.getViewport({ scale: 1 });
    const displayScale = BASE_WIDTH_CSS / unscaled.width;
    const viewportDisplay = page.getViewport({ scale: displayScale });
    viewportDisplayByPage.set(pageNumber, viewportDisplay);
    const textContent = await page.getTextContent();
    const rawItems = textContent.items;
    let pageWords = [];

    for (const item of rawItems) {
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
}

/* ================== BUILD SENTENCES ================== */
function buildSentences() {
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

        for (const w of page.pageWords) {
            let gapBreak = false;
            if (SPLIT_ON_LINE_GAP && lastY !== null) {
                const verticalDelta = Math.abs(lastY - w.y);
                if (lastHeight && verticalDelta > lastHeight * LINE_GAP_THRESHOLD) gapBreak = true;
            }
            if (gapBreak && buffer.length) flush();

            buffer.push(w);
            const punctuationEnd = /[.?!]$/.test(w.str);
            const lineBreakTriggered = BREAK_ON_LINE && w.lineBreak;
            if (punctuationEnd || lineBreakTriggered) flush();

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

/* ================== RENDER SENTENCE ================== */
async function ensureFullPageRendered(pageNumber) {
    if (fullPageRenderCache.has(pageNumber)) return fullPageRenderCache.get(pageNumber);
    const page = pagesCache.get(pageNumber) || (await pdf.getPage(pageNumber));
    const viewportDisplay = viewportDisplayByPage.get(pageNumber);
    const fullW = Math.round(viewportDisplay.width * deviceScale);
    const fullH = Math.round(viewportDisplay.height * deviceScale);
    const renderScale = (viewportDisplay.width / page.getViewport({ scale: 1 }).width) * deviceScale;
    const viewportRender = page.getViewport({ scale: renderScale });
    const off = document.createElement("canvas");
    off.width = fullW;
    off.height = fullH;
    const offCtx = off.getContext("2d");
    await page.render({ canvasContext: offCtx, viewport: viewportRender }).promise;
    fullPageRenderCache.set(pageNumber, off);
    return off;
}

async function renderSentence(idx) {
    if (idx < 0 || idx >= sentences.length) return;
    currentSentenceIndex = idx;
    const sentence = sentences[idx];
    const pageNumber = sentence.pageNumber;

    const viewportDisplay = viewportDisplayByPage.get(pageNumber);
    const pageHeightDisplay = viewportDisplay.height;
    const pageWidthDisplay = viewportDisplay.width;

    const fullPageCanvas = await ensureFullPageRendered(pageNumber);

    canvas.style.width = pageWidthDisplay + "px";
    canvas.style.height = VIEWPORT_HEIGHT_CSS + "px";
    canvas.width = Math.round(pageWidthDisplay * deviceScale);
    canvas.height = Math.round(VIEWPORT_HEIGHT_CSS * deviceScale);

    let offsetYDisplay = 0;
    if (sentence.bbox) {
        const targetTop = sentence.bbox.y - MARGIN_TOP;
        const maxOffset = Math.max(0, pageHeightDisplay - VIEWPORT_HEIGHT_CSS);
        offsetYDisplay = clamp(targetTop, 0, maxOffset);
    }

    const offsetYRender = offsetYDisplay * deviceScale;
    const sliceHeightRender = canvas.height;
    const maxAvail = fullPageCanvas.height - offsetYRender;
    const effectiveSliceHeight = Math.min(sliceHeightRender, maxAvail);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(
        fullPageCanvas,
        0,
        offsetYRender,
        fullPageCanvas.width,
        effectiveSliceHeight,
        0,
        0,
        canvas.width,
        effectiveSliceHeight,
    );
    highlightSentence(sentence, offsetYDisplay);

    showInfo(`Sentence ${sentence.index + 1}/${sentences.length} (Page ${pageNumber})`);
    updateSubtitlePreview(sentence);
    updatePlayButton();

    // Prefetch só se já começou a geração (após Play)
    schedulePrefetch();
}

function highlightSentence(sentence, offsetYDisplay) {
    ctx.save();
    ctx.fillStyle = "rgba(255,255,0,0.28)";
    for (const w of sentence.words) {
        const xR = w.x * deviceScale;
        const yTopDisplay = w.y - w.height - offsetYDisplay;
        const yR = yTopDisplay * deviceScale;
        const widthR = w.width * deviceScale;
        const heightR = w.height * deviceScale;
        if (yR + heightR < 0 || yR > canvas.height) continue;
        ctx.fillRect(xR, yR, widthR, heightR);
    }
    ctx.restore();
}

/* ================== NAVIGATION ================== */
function nextSentence(manual = true) {
    if (currentSentenceIndex < sentences.length - 1) {
        stopPlayback(true); // garante pausar ao clicar Next
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

/* ================== NORMALIZE ================== */
function normalizeText(raw) {
    if (!raw) return "";
    let t = raw.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, " ");
    t = t.replace(/\s+/g, " ").trim();
    if (t && !/[.?!…]$/.test(t)) t += ".";
    return t;
}

/* ================== BUILD PIPER AUDIO ================== */
async function buildPiperAudio(sentence, voice, text) {
    await ensureAudioContext();
    await ensurePiper(voice);
    await cooperativeYield();

    const wavBlob = await piperInstance.synthesize(text, CURRENT_SPEED);
    await cooperativeYield();

    const arrBuf = await wavBlob.arrayBuffer();
    await cooperativeYield();
    const decoded = await safeDecodeAudioData(arrBuf.slice(0));
    await cooperativeYield();

    analyzeAudioBuffer(decoded);
    await cooperativeYield();

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

    let finalWav = null;
    if (MAKE_WAV_COPY) finalWav = wavBlob;

    const cacheKey = `${voice}|${CURRENT_SPEED}|${sentence.normalizedText}`;
    audioCache.set(cacheKey, {
        audioBlob: STORE_DECODED_ONLY ? null : wavBlob,
        wavBlob: finalWav,
        audioBuffer: decoded,
        wordBoundaries,
    });

    Object.assign(sentence, {
        audioBlob: STORE_DECODED_ONLY ? null : wavBlob,
        wavBlob: finalWav,
        audioBuffer: decoded,
        audioReady: true,
        lastVoice: voice,
        lastSpeed: CURRENT_SPEED,
        prefetchQueued: false,
        audioError: null,
        wordBoundaries,
    });
}

/* ================== SYNTHESIZE (SEM GERAR ANTES DO PLAY) ================== */
async function synthesizeSequential(idx) {
    if (!generationEnabled) return; // não gera antes do Play
    const s = sentences[idx];
    if (!s) return;
    const voice = voiceSelect?.value || DEFAULT_PIPER_VOICE;

    if (s.audioReady && s.lastVoice === voice && s.lastSpeed === CURRENT_SPEED) return;
    if (s.audioInProgress) return;

    const normalized = normalizeText(s.text);
    s.normalizedText = normalized;
    const cacheKey = `${voice}|${CURRENT_SPEED}|${normalized}`;

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
    updateStatus(`Generating audio (sentence ${s.index + 1})...`);
    try {
        await buildPiperAudio(s, voice, normalized);
        updateStatus("");
    } catch (err) {
        console.error("Piper TTS failure:", err);
        s.audioError = err;
        updateStatus(`TTS error (sentence ${s.index + 1})`);
    } finally {
        s.audioInProgress = false;
        updatePrefetchVisual();
    }
}

/* ================== PREFETCH ================== */
function schedulePrefetch() {
    if (!generationEnabled) return; // só depois do Play
    if (currentSentenceIndex >= 0) ttsQueue.add(currentSentenceIndex, true);
    const base = currentSentenceIndex;
    for (let i = base + 1; i <= base + PREFETCH_AHEAD && i < sentences.length; i++) {
        ttsQueue.add(i);
    }
    updatePrefetchVisual();
}

function updatePrefetchVisual() {
    if (!prefetchBar) return;
    if (!generationEnabled) {
        prefetchBar.style.display = "none";
        return;
    }
    const base = currentSentenceIndex;
    let needed = 0,
        ready = 0;
    for (let i = base; i <= base + PREFETCH_AHEAD && i < sentences.length; i++) {
        needed++;
        if (sentences[i].audioReady) ready++;
    }
    const pct = needed === 0 ? 0 : (ready / needed) * 100;
    prefetchBar.style.width = pct + "%";
    prefetchBar.style.display = pct < 99 ? "block" : "none";
}

/* ================== PLAYBACK ================== */
function updateStatus(msg) {
    if (ttsStatus) ttsStatus.textContent = msg || "";
    const live = document.getElementById(LIVE_STATUS_REGION_ID);
    if (live) live.textContent = msg || "";
}

function updatePlayButton() {
    const s = sentences[currentSentenceIndex];
    if (!btnPlayToggle) return;
    if (!s) {
        btnPlayToggle.textContent = "▶️";
        btnPlayToggle.disabled = true;
        return;
    }
    btnPlayToggle.disabled = false;
    btnPlayToggle.textContent = isPlaying ? "⏸️" : "▶️";
}

async function playCurrentSentence() {
    const s = sentences[currentSentenceIndex];
    if (!s) return;
    if (isPlaying) return;

    await ensureAudioContext();

    // Ativa geração ao apertar Play pela primeira vez
    if (!generationEnabled) {
        generationEnabled = true;
        // coloca a sentença atual imediatamente na fila
        ttsQueue.add(currentSentenceIndex, true);
        ttsQueue.run();
        // prefetch futuro só depois da primeira play
        schedulePrefetch();
    }

    if (!s.audioReady) {
        // prioriza novamente (caso usuário pulou rápido)
        ttsQueue.add(currentSentenceIndex, true);
        ttsQueue.run();
        try {
            await waitFor(() => s.audioReady || s.audioError, 45000);
        } catch {}
    }

    if (s.audioError || !s.audioReady || !s.audioBuffer) {
        updateStatus("Failed to get audio for this sentence.");
        return;
    }

    stopPlayback(false);
    stopRequested = false;

    try {
        if (currentSource) {
            try {
                currentSource.disconnect();
            } catch {}
        }
        if (currentGain) {
            try {
                currentGain.disconnect();
            } catch {}
        }

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
        console.error("Critical playback error:", err);
        updateStatus("Critical audio failure - resetting context...");
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
                const currentValue = currentGain.gain.value;
                if (currentValue > MIN_GAIN) {
                    currentGain.gain.cancelScheduledValues(now);
                    currentGain.gain.setValueAtTime(currentValue, now);
                    currentGain.gain.linearRampToValueAtTime(MIN_GAIN, now + FADE_OUT_SEC);
                }
                setTimeout(
                    () => {
                        try {
                            if (currentSource) {
                                currentSource.stop();
                                currentSource.disconnect();
                            }
                            if (currentGain) currentGain.disconnect();
                        } catch {}
                    },
                    FADE_OUT_SEC * 1000 + 10,
                );
            } else {
                try {
                    currentSource.stop();
                    currentSource.disconnect();
                } catch {}
                try {
                    if (currentGain) currentGain.disconnect();
                } catch {}
            }
        } catch (e) {
            console.warn("Error during stop:", e);
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

/* ================== WORD BOUNDARIES ================== */
function setupWordBoundaryTimers(s) {
    clearWordBoundaryTimers(s);
    if (!ENABLE_WORD_HIGHLIGHT) return;
    if (!s.wordBoundaries?.length) return;
    const liveWord = document.getElementById(LIVE_WORD_REGION_ID);
    for (const wb of s.wordBoundaries) {
        const timerId = setTimeout(() => {
            if (liveWord) liveWord.textContent = wb.text;
        }, wb.offsetMs);
        s.playbackWordTimers.push(timerId);
    }
}
function clearWordBoundaryTimers(s) {
    if (!s.playbackWordTimers) return;
    for (const t of s.playbackWordTimers) clearTimeout(t);
    s.playbackWordTimers = [];
}

/* ================== WAIT FOR ================== */
function waitFor(condFn, timeoutMs = 10000, interval = 120) {
    return new Promise((resolve, reject) => {
        const start = performance.now();
        const id = setInterval(() => {
            if (condFn()) {
                clearInterval(id);
                resolve(true);
            } else if (performance.now() - start > timeoutMs) {
                clearInterval(id);
                reject(new Error("Timeout waiting for condition"));
            }
        }, interval);
    });
}

/* ================== SUBTITLE PREVIEW ================== */
function updateSubtitlePreview(sentence) {
    if (!subtitlePreview) return;
    if (!sentence?.text) {
        subtitlePreview.textContent = "";
        return;
    }
    const txt = sentence.text.trim().replace(/\s+/g, " ");
    subtitlePreview.textContent = txt.length > 160 ? txt.slice(0, 160) + "..." : txt;
}

/* ================== INFO ================== */
function showInfo(msg) {
    if (infoBox) infoBox.textContent = msg;
    else console.log(msg);
}

/* ================== EVENTS ================== */
if (btnNextSentence) btnNextSentence.addEventListener("click", () => nextSentence(true));
if (btnPrevSentence) btnPrevSentence.addEventListener("click", () => prevSentence(true));
if (btnPlayToggle) btnPlayToggle.addEventListener("click", togglePlay);

if (voiceSelect) {
    voiceSelect.addEventListener("change", () => {
        stopPlayback(true);
        autoAdvanceActive = false;
        invalidateFrom(currentSentenceIndex);
        schedulePrefetch(); // só vai rodar se generationEnabled for true
    });
}

if (speedSelect) {
    speedSelect.addEventListener("change", () => {
        const val = speedSelect.value.trim();
        const match = val.match(/([-+]?)(\d+)%/);
        if (match) {
            const sign = match[1] === "-" ? -1 : 1;
            const pct = parseInt(match[2], 10) || 0;
            CURRENT_SPEED = 1 + sign * (pct / 100);
        } else {
            CURRENT_SPEED = 1.0;
        }
        stopPlayback(true);
        autoAdvanceActive = false;
        invalidateFrom(currentSentenceIndex);
        schedulePrefetch();
    });
}

window.addEventListener("keydown", (e) => {
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable))
        return;
    if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
    } else if (e.code === "ArrowRight") nextSentence(true);
    else if (e.code === "ArrowLeft") prevSentence(true);
    else if (e.key === "p") togglePlay();
});

/* ================== INVALIDATE ================== */
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

/* ================== EXPORTS ================== */
window.loadPDF = loadPDF;
window.nextSentence = () => nextSentence(true);
window.prevSentence = () => prevSentence(true);
window.playSentence = playCurrentSentence;
window.togglePlay = togglePlay;

