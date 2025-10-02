// ==============================================
// PDF Sentenças + Visor Recortado + TTS (Communicate) Buffer-First (Anti-Artifact)
// ==============================================
//
// Principais melhorias contra artefatos:
// - NÃO decodifica cada chunk individualmente.
// - Junta os bytes originais (MP3 / codec sugerido) e decodifica UMA vez ao final.
//   Assim, evita o padding/priming repetido que causava clicks ou gaps.
// - Converte corretamente offsets de WordBoundary (100-ns -> ms).
// - Usa construção correta do Communicate: new Communicate(text, { voice, ... } )
//
// Mantido:
// - Prefetch de frases futuras
// - Cache de áudio (agora guarda: mp3Blob + decoded AudioBuffer + opcional wavBlob)
// - Fallback EdgeTTS
// - Estrutura para word boundaries
//
// Config adicional:
// - MAKE_WAV_COPY: se true gera também WAV (custo CPU extra).
// - STORE_DECODED_ONLY: se true não guarda mp3Blob (apenas o AudioBuffer).
//
// Uso somente em browser (sem Node).
//
// ==============================================

import {
    Communicate,
    EdgeTTS, // fallback opcional
    listVoices,
} from "https://cdn.jsdelivr.net/npm/edge-tts-universal/dist/browser.js";

// ============ CONFIG ACESSIBILIDADE ============
const ENABLE_WORD_HIGHLIGHT = false;
const ENABLE_LIVE_WORD_REGION = true;
const LIVE_WORD_REGION_ID = "live-word";
const LIVE_STATUS_REGION_ID = "live-status";

// ============ CONFIG ÁUDIO E BUFFER ============
const MAKE_WAV_COPY = false; // true -> gera wavBlob adicional
const STORE_DECODED_ONLY = false; // true -> não guarda mp3Blob
const MAX_ACCUMULATED_BYTES = 8_000_000; // segurança (8MB) por sentença (ajuste conforme necessidade)

// ============ CONFIG PDF ============
const PDF_URL = "pdf.pdf";
const BASE_WIDTH_CSS = 1400;
const VIEWPORT_HEIGHT_CSS = 650;
const MARGIN_TOP = 100;

// ============ CONFIG FRASES ============
const BREAK_ON_LINE = false;
const SPLIT_ON_LINE_GAP = false;
const LINE_GAP_THRESHOLD = 1.6;

// ============ CONFIG TTS ============
const PREFETCH_AHEAD = 2;
const DEFAULT_VOICE = "en-US-EmmaMultilingualNeural";
let CURRENT_RATE = "+30%";
const DEFAULT_PITCH = "+0Hz";
const DEFAULT_VOLUME = "+0%";
const MANUAL_NAV_STOPS_CONTINUOUS = true;

const USE_COMMUNICATE = true;
const COMMUNICATE_TIMEOUT_MS = 45000;
const COMMUNICATE_MAX_RETRIES = 2;
const EDGE_FALLBACK_ON_FAILURE = true;

// Fades / timing de reprodução
const FADE_IN_SEC = 0.03;
const FADE_OUT_SEC = 0.05;
const GAP_AFTER_SENTENCE_SEC = 0.1;

// ============ ELEMENTOS DOM ============
const languageSelect = document.getElementById("language-select");
const voiceSelect = document.getElementById("voice-select");
const canvas = document.getElementById("pdf-canvas");
const ctx = canvas.getContext("2d");
const btnNextSentence = document.getElementById("next-sentence");
const btnPrevSentence = document.getElementById("prev-sentence");
const btnPlayToggle = document.getElementById("play-toggle");
const infoBox = document.getElementById("info-box");
const ttsStatus = document.getElementById("tts-status");
const rateSelect = document.getElementById("rate-select");
const prefetchBar = document.getElementById("prefetch-bar");
const subtitlePreview = document.getElementById("subtitle-preview");

// ============ ESTADO ============
let pdf = null;
let pagesCache = new Map();
let viewportDisplayByPage = new Map();
let fullPageRenderCache = new Map();
let sentences = [];
let currentSentenceIndex = -1;
let deviceScale = window.devicePixelRatio || 1;

// Áudio
let audioCtx = null;
let currentSource = null;
let currentGain = null;
let isPlaying = false;
let autoAdvanceActive = false;
let stopRequested = false;

// Cache de áudio final (key = voz|rate|texto normalizado)
const audioCache = new Map();

// Aria live regions
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

// ============ VOICES ============
async function initVoices() {
    const voices = await listVoices();
    const languages = [...new Set(voices.map((v) => v.ShortName.split("-").slice(0, 2).join("-")))];
    languages.forEach((lang) => {
        const option = document.createElement("option");
        option.value = lang;
        option.textContent = lang;
        languageSelect.appendChild(option);
    });
    populateVoices(languages[0]);
    languageSelect.addEventListener("change", () => populateVoices(languageSelect.value));

    function populateVoices(lang) {
        voiceSelect.innerHTML = "";
        const filtered = voices.filter((v) => v.ShortName.startsWith(lang));
        filtered.forEach((v) => {
            const option = document.createElement("option");
            option.value = v.ShortName;
            option.textContent = v.ShortName;
            voiceSelect.appendChild(option);
        });
    }
}
initVoices();

// ============ TTS QUEUE ============
class TTSQueueManager {
    constructor() {
        this.queue = [];
        this.processing = false;
        this.currentTask = null;
    }
    add(sentenceIndex, priority = false) {
        const s = sentences[sentenceIndex];
        if (!s) return;
        if (s.audioReady || s.audioInProgress) return;
        if (this.queue.includes(sentenceIndex)) return;
        s.prefetchQueued = true;
        if (priority) this.queue.unshift(sentenceIndex);
        else this.queue.push(sentenceIndex);
        this.run();
    }
    async run() {
        if (this.processing) return;
        this.processing = true;
        while (this.queue.length) {
            const idx = this.queue.shift();
            const s = sentences[idx];
            if (!s || s.audioReady || s.audioInProgress) continue;
            this.currentTask = idx;
            await synthesizeSequential(idx);
            this.currentTask = null;
            updatePrefetchVisual();
        }
        this.processing = false;
    }
}
const ttsQueue = new TTSQueueManager();

// Utils
const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ================== LOAD PDF ==================
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
        if (!pdf.numPages) throw new Error("PDF sem páginas.");
        await preprocessAllPages();
        buildSentences();
        await renderSentence(0);
        showInfo(`Total de frases: ${sentences.length}`);
        updatePlayButton();
        schedulePrefetch();
        ensureFullPageRendered(1);
    } catch (e) {
        console.error(e);
        showInfo("Erro: " + e.message);
    }
}

// ================== PREPROCESS ==================
async function preprocessAllPages() {
    for (let p = 1; p <= pdf.numPages; p++) await preprocessPage(p);
}
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

// ================== SENTENCES ==================
function buildSentences() {
    sentences = [];
    let sentenceIndex = 0;
    for (let p = 1; p <= pdf.numPages; p++) {
        const page = pagesCache.get(p);
        if (!page?.pageWords) continue;
        let buffer = [];
        let lastY = null;
        let lastHeight = null;

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
                audioBlob: null, // MP3 / original
                wavBlob: null, // opcional WAV
                audioBuffer: null, // AudioBuffer decodificado
                audioReady: false,
                audioInProgress: false,
                audioError: null,
                lastVoice: null,
                lastRate: null,
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

// ================== PAGE RENDER ==================
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

    showInfo(`Frase ${sentence.index + 1}/${sentences.length} (Pág. ${pageNumber})`);
    updateSubtitlePreview(sentence);
    updatePlayButton();
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

// ================== NAVIGAÇÃO ==================
function nextSentence(manual = true) {
    if (currentSentenceIndex < sentences.length - 1) {
        stopPlayback(true);
        if (manual && MANUAL_NAV_STOPS_CONTINUOUS) autoAdvanceActive = false;
        renderSentence(currentSentenceIndex + 1);
    }
}
function prevSentence(manual = true) {
    if (currentSentenceIndex > 0) {
        stopPlayback(true);
        if (manual && MANUAL_NAV_STOPS_CONTINUOUS) autoAdvanceActive = false;
        renderSentence(currentSentenceIndex - 1);
    }
}

// ================== NORMALIZAÇÃO ==================
function normalizeText(raw) {
    if (!raw) return "";
    let t = raw.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, " ");
    t = t.replace(/\s+/g, " ").trim();
    if (t && !/[.?!…]$/.test(t)) t += ".";
    return t;
}

// ================== STREAM (Communicate) ==================
async function* streamCommunicate(text, voice, opts = {}) {
    // Construção correta: new Communicate(text, { voice, ... })
    const inst = new Communicate(text, {
        voice,
        ...opts,
    });

    if (inst && typeof inst.stream === "function") {
        const s = inst.stream();
        if (s && typeof s[Symbol.asyncIterator] === "function") {
            for await (const evt of s) yield evt;
            return;
        }
    }

    // Fallback genérico caso API mude no futuro
    if (typeof inst[Symbol.asyncIterator] === "function") {
        for await (const evt of inst) yield evt;
        return;
    }

    throw new Error("Communicate não suportou iteração esperada.");
}

// ================== SÍNTESE (SINGLE-DECODE) ==================
async function synthesizeSequential(idx) {
    const s = sentences[idx];
    if (!s) return;
    const voice = voiceSelect?.value || DEFAULT_VOICE;

    if (s.audioReady && s.lastVoice === voice && s.lastRate === CURRENT_RATE) return;

    const normalized = normalizeText(s.text);
    s.normalizedText = normalized;
    const cacheKey = `${voice}|${CURRENT_RATE}|${normalized}`;

    if (audioCache.has(cacheKey)) {
        const cached = audioCache.get(cacheKey);
        Object.assign(s, {
            audioBlob: cached.audioBlob || null,
            wavBlob: cached.wavBlob || null,
            audioBuffer: cached.audioBuffer,
            audioReady: true,
            lastVoice: voice,
            lastRate: CURRENT_RATE,
            audioError: null,
            audioInProgress: false,
            prefetchQueued: false,
            wordBoundaries: cached.wordBoundaries || [],
        });
        return;
    }

    s.audioInProgress = true;
    s.audioError = null;
    updateStatus(`Gerando áudio (frase ${s.index + 1})...`);

    let success = false;
    let lastErr = null;

    if (USE_COMMUNICATE) {
        for (let attempt = 0; attempt <= COMMUNICATE_MAX_RETRIES && !success; attempt++) {
            try {
                await buildSingleDecodeCommunicate(s, voice, normalized);
                success = true;
            } catch (err) {
                lastErr = err;
                if (attempt < COMMUNICATE_MAX_RETRIES) await delay(600 * (attempt + 1));
            }
        }
    }

    if (!success && EDGE_FALLBACK_ON_FAILURE) {
        try {
            await buildWithEdgeFallback(s, voice, normalized);
            success = true;
        } catch (fallbackErr) {
            lastErr = fallbackErr;
        }
    }

    s.audioInProgress = false;
    if (!success) {
        s.audioError = lastErr || new Error("Falha TTS desconhecida");
        updateStatus(`Erro TTS (frase ${s.index + 1})`);
    } else {
        updateStatus("");
    }
    updatePrefetchVisual();
}

async function buildSingleDecodeCommunicate(s, voice, text) {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    const start = performance.now();
    const timeout = COMMUNICATE_TIMEOUT_MS;

    const byteChunks = [];
    let totalBytes = 0;

    const wordBoundaries = [];

    for await (const evt of streamCommunicate(text, voice, {
        rate: CURRENT_RATE,
        volume: DEFAULT_VOLUME,
        pitch: DEFAULT_PITCH,
        enableWordBoundary: ENABLE_WORD_HIGHLIGHT,
    })) {
        if (performance.now() - start > timeout) throw new Error("Timeout Communicate");

        if (evt.type === "audio") {
            // Normalmente evt.data = ArrayBuffer ou Blob
            let arrBuf;
            if (evt.data instanceof Blob) arrBuf = await evt.data.arrayBuffer();
            else if (evt.data instanceof ArrayBuffer) arrBuf = evt.data;
            else if (evt.data?.buffer instanceof ArrayBuffer) arrBuf = evt.data.buffer;
            else continue;

            const u8 = new Uint8Array(arrBuf);
            totalBytes += u8.length;
            if (totalBytes > MAX_ACCUMULATED_BYTES) {
                throw new Error("Limite de bytes excedido para a sentença (possível texto muito longo).");
            }
            byteChunks.push(u8);
        } else if (evt.type === "WordBoundary" || evt.type === "word-boundary") {
            if (ENABLE_WORD_HIGHLIGHT) {
                // offset/duration em 100-ns => ms = val / 10_000
                const rawOffset = evt.offset ?? evt.Offset ?? 0;
                const rawDur = evt.duration ?? evt.Duration ?? 0;
                wordBoundaries.push({
                    text: evt.text || evt.Text || "",
                    offsetMs: rawOffset / 10000,
                    durationMs: rawDur / 10000,
                });
            }
        }
    }

    if (!byteChunks.length) throw new Error("Nenhum áudio recebido.");

    const joined = concatUint8(byteChunks);
    const mimeType = "audio/mpeg"; // Edge TTS usual: mp3 (24khz 48kbit)
    const mp3Blob = new Blob([joined], { type: mimeType });

    // Decodifica uma única vez -> elimina artifacts
    const arr = await mp3Blob.arrayBuffer();
    let decoded;
    try {
        decoded = await audioCtx.decodeAudioData(arr.slice(0));
    } catch (e) {
        throw new Error("Falha ao decodificar áudio final: " + e.message);
    }

    let wavBlob = null;
    if (MAKE_WAV_COPY) {
        wavBlob = audioBufferToWavBlob(decoded);
    }

    const cacheKey = `${voice}|${CURRENT_RATE}|${s.normalizedText}`;

    audioCache.set(cacheKey, {
        audioBlob: STORE_DECODED_ONLY ? null : mp3Blob,
        wavBlob,
        audioBuffer: decoded,
        wordBoundaries,
    });

    Object.assign(s, {
        audioBlob: STORE_DECODED_ONLY ? null : mp3Blob,
        wavBlob,
        audioBuffer: decoded,
        audioReady: true,
        lastVoice: voice,
        lastRate: CURRENT_RATE,
        prefetchQueued: false,
        audioError: null,
        wordBoundaries,
    });
}

async function buildWithEdgeFallback(s, voice, text) {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const tts = new EdgeTTS(text, voice, {
        rate: CURRENT_RATE,
        volume: DEFAULT_VOLUME,
        pitch: DEFAULT_PITCH,
    });
    const result = await tts.synthesize();
    const arr = await result.audio.arrayBuffer();
    const decoded = await audioCtx.decodeAudioData(arr.slice(0));
    let wavBlob = null;
    if (MAKE_WAV_COPY) wavBlob = audioBufferToWavBlob(decoded);

    const cacheKey = `${voice}|${CURRENT_RATE}|${s.normalizedText}`;
    audioCache.set(cacheKey, {
        audioBlob: STORE_DECODED_ONLY ? null : result.audio,
        wavBlob,
        audioBuffer: decoded,
        wordBoundaries: [], // Simple API word boundaries would be separate if needed
    });

    Object.assign(s, {
        audioBlob: STORE_DECODED_ONLY ? null : result.audio,
        wavBlob,
        audioBuffer: decoded,
        audioReady: true,
        lastVoice: voice,
        lastRate: CURRENT_RATE,
        prefetchQueued: false,
        audioError: null,
        wordBoundaries: [],
    });
}

// ================== HELPERS ÁUDIO ==================
function concatUint8(chunks) {
    const total = chunks.reduce((a, c) => a + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
    }
    return out;
}

function audioBufferToWavBlob(audioBuffer) {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const samples = audioBuffer.length;

    // Interleave (se > 1 canal)
    let interleaved;
    if (numChannels === 1) {
        interleaved = audioBuffer.getChannelData(0);
    } else {
        const chans = [];
        for (let c = 0; c < numChannels; c++) chans.push(audioBuffer.getChannelData(c));
        interleaved = new Float32Array(samples * numChannels);
        let idx = 0;
        for (let i = 0; i < samples; i++) {
            for (let c = 0; c < numChannels; c++) {
                interleaved[idx++] = chans[c][i];
            }
        }
    }

    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const buffer = new ArrayBuffer(44 + interleaved.length * 2);
    const view = new DataView(buffer);

    function writeString(off, str) {
        for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
    }

    writeString(0, "RIFF");
    view.setUint32(4, 36 + interleaved.length * 2, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeString(36, "data");
    view.setUint32(40, interleaved.length * 2, true);

    let offset = 44;
    for (let i = 0; i < interleaved.length; i++, offset += 2) {
        let s = Math.max(-1, Math.min(1, interleaved[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buffer], { type: "audio/wav" });
}

// ================== PREFETCH ==================
function schedulePrefetch() {
    if (currentSentenceIndex >= 0) ttsQueue.add(currentSentenceIndex, true);
    const base = currentSentenceIndex;
    for (let i = base + 1; i <= base + PREFETCH_AHEAD && i < sentences.length; i++) ttsQueue.add(i);
    updatePrefetchVisual();
}

function updatePrefetchVisual() {
    if (!prefetchBar) return;
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

// ================== PLAYBACK ==================
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

    if (!s.audioReady) {
        ttsQueue.add(currentSentenceIndex, true);
        try {
            await waitFor(() => s.audioReady || s.audioError, 45000);
        } catch {}
    }
    if (s.audioError || !s.audioReady || !s.audioBuffer) {
        updateStatus("Falha ao obter áudio desta frase.");
        return;
    }
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    stopPlayback(false);

    stopRequested = false;
    currentSource = audioCtx.createBufferSource();
    currentSource.buffer = s.audioBuffer;

    currentGain = audioCtx.createGain();
    currentGain.gain.setValueAtTime(0, audioCtx.currentTime);
    currentGain.gain.linearRampToValueAtTime(1, audioCtx.currentTime + FADE_IN_SEC);

    currentSource.connect(currentGain).connect(audioCtx.destination);

    setupWordBoundaryTimers(s);

    currentSource.onended = async () => {
        clearWordBoundaryTimers(s);
        if (stopRequested) return;
        isPlaying = false;
        updatePlayButton();
        if (!autoAdvanceActive) return;
        if (currentSentenceIndex < sentences.length - 1) {
            await delay(GAP_AFTER_SENTENCE_SEC * 1000);
            if (stopRequested) return;
            renderSentence(currentSentenceIndex + 1);
            playCurrentSentence();
        }
    };

    try {
        currentSource.start();
        isPlaying = true;
        autoAdvanceActive = true;
        updatePlayButton();
    } catch (err) {
        console.error("Erro ao iniciar reprodução:", err);
        updateStatus("Falha ao iniciar áudio.");
    }
}

function stopPlayback(fade = true) {
    stopRequested = true;
    if (currentSource && audioCtx) {
        try {
            if (fade && currentGain) {
                const now = audioCtx.currentTime;
                currentGain.gain.cancelScheduledValues(now);
                currentGain.gain.setValueAtTime(currentGain.gain.value, now);
                currentGain.gain.linearRampToValueAtTime(0, now + FADE_OUT_SEC);
                currentSource.stop(now + FADE_OUT_SEC + 0.005);
            } else {
                currentSource.stop();
            }
        } catch {}
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

// ================== WORD BOUNDARIES ==================
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

// ================== ESPERA ==================
function waitFor(condFn, timeoutMs = 10000, interval = 120) {
    return new Promise((resolve, reject) => {
        const start = performance.now();
        const id = setInterval(() => {
            if (condFn()) {
                clearInterval(id);
                resolve(true);
            } else if (performance.now() - start > timeoutMs) {
                clearInterval(id);
                reject(new Error("Timeout aguardando condição"));
            }
        }, interval);
    });
}

// ================== SUBTITLE PREVIEW ==================
function updateSubtitlePreview(sentence) {
    if (!subtitlePreview) return;
    if (!sentence?.text) {
        subtitlePreview.textContent = "";
        return;
    }
    const txt = sentence.text.trim().replace(/\s+/g, " ");
    subtitlePreview.textContent = txt.length > 160 ? txt.slice(0, 160) + "..." : txt;
}

// ================== INFO ==================
function showInfo(msg) {
    if (infoBox) infoBox.textContent = msg;
    else console.log(msg);
}

// ================== EVENTOS ==================
if (btnNextSentence) btnNextSentence.addEventListener("click", () => nextSentence(true));
if (btnPrevSentence) btnPrevSentence.addEventListener("click", () => prevSentence(true));
if (btnPlayToggle) btnPlayToggle.addEventListener("click", togglePlay);

if (voiceSelect)
    voiceSelect.addEventListener("change", () => {
        stopPlayback(true);
        autoAdvanceActive = false;
        invalidateFrom(currentSentenceIndex);
        schedulePrefetch();
    });

if (rateSelect)
    rateSelect.addEventListener("change", () => {
        CURRENT_RATE = rateSelect.value;
        stopPlayback(true);
        autoAdvanceActive = false;
        invalidateFrom(currentSentenceIndex);
        schedulePrefetch();
    });

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

// Invalida áudios a partir de um ponto
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
        s.lastRate = null;
        s.normalizedText = null;
        s.wordBoundaries = [];
        clearWordBoundaryTimers(s);
    }
    ttsQueue.queue = [];
}

// ================== EXPORTS ==================
window.loadPDF = loadPDF;
window.nextSentence = () => nextSentence(true);
window.prevSentence = () => prevSentence(true);
window.playSentence = playCurrentSentence;
window.togglePlay = togglePlay;

