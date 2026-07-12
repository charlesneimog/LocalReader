import {
    getWebsiteRoot,
    cooperativeYield,
    delay,
    normalizeText,
    formatTextToSpeech,
    hasUsableSpeechText,
} from "../utils/helpers.js";
import { EVENTS } from "../../constants/events.js";
import {
    PiperWorkerClient,
    getCachedJSON,
    getCachedModel,
    getUncachedJSON,
    getUncachedModel,
} from "./piper-client.js";

const USE_PERSONALIZED_PIPER_MODEL = false;
const PERSONALIZED_PIPER_MODEL_URL = "https://huggingface.co/csukuangfj/vits-piper-pt_BR-miro-high/resolve/main/pt_BR-miro-high.onnx";
const PERSONALIZED_PIPER_CONFIG_URL = "https://huggingface.co/csukuangfj/vits-piper-pt_BR-miro-high/resolve/main/pt_BR-miro-high.onnx.json";
const PERSONALIZED_PIPER_VOICE_ID = "personalized_piper_voice2";
const PERSONALIZED_PIPER_VOICE_NAME = "Personalized Piper Model2";
const TTS_OFFLINE_UNAVAILABLE = "TTS_OFFLINE_UNAVAILABLE";

export class TTSEngine {
    constructor(app) {
        this.app = app;
        this.client = null;
        this.voice = app.config.DEFAULT_PIPER_VOICE;
        this.piperInstance = null;
        this.voices = null;
        this.pendingVoiceId = null;
        this.preferredVoiceId = null;
        this.initializingPromise = null;
        this._renderAheadPages = new Set();
        this._restartAttemptedCount = 0;
        this._resetPromise = null;

        const scriptSrc = (document.currentScript && document.currentScript.src) || window.location.href;
        const scriptDir = scriptSrc.substring(0, scriptSrc.lastIndexOf("/"));
        const baseUrl = scriptDir.replace(/\/thirdparty\/piper$/, "");
        this.baseUrl = baseUrl;

        this.huggingFaceRoot = "https://huggingface.co/rhasspy/piper-voices/resolve/main/";
        this.initialized = false;
    }

    async getVoicesLists() {
        const url = "https://huggingface.co/rhasspy/piper-voices/resolve/main/voices.json";
        const cache = await caches.open("piper-voices-v1");

        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error("Network response not ok");
            }
            await cache.put(url, response.clone());
            return await response.json();
        } catch (err) {
            const cached = await cache.match(url);
            if (cached) {
                return await cached.json();
            }
            const cachedFromAnyAppCache = await caches.match(url);
            if (cachedFromAnyAppCache) {
                const response = cachedFromAnyAppCache.clone();
                await cache.put(url, response.clone()).catch(() => {});
                return await response.json();
            }
            const error = new Error("Failed to fetch voices.json and no cache available");
            error.code = TTS_OFFLINE_UNAVAILABLE;
            throw error;
        }
    }

    _isOfflineTtsUnavailableError(error) {
        const message = String(error?.message || "");
        return (
            error?.code === TTS_OFFLINE_UNAVAILABLE ||
            message.includes("voices.json and no cache available") ||
            message === "Failed to fetch"
        );
    }

    _handleOfflineTtsUnavailable(sentence, error) {
        const { state } = this.app;
        if (sentence) {
            sentence.audioError = error;
            sentence.audioInProgress = false;
            sentence.prefetchQueued = false;
        }
        state.generationEnabled = false;
        state.isPlaying = false;
        state.stopRequested = true;
        this.app.ttsQueue?.reset?.();
        this.app.ui.updatePlayButton(state.playerState.DONE);
        if (!this._offlineTtsNoticeShown) {
            this._offlineTtsNoticeShown = true;
            this.app.ui.showInfo("Offline Mode: this voice is not cached yet. Connect once and load Natural Voices before using it offline.");
        }
    }

    async ensureAudioContext() {
        const { state, config } = this.app;
        if (!state.audioCtx) {
            state.audioCtx = new window.AudioContext(config.AUDIO_CONTEXT_OPTIONS);
        }
        return state.audioCtx;
    }

    _isPersonalizedPiperEnabled() {
        return USE_PERSONALIZED_PIPER_MODEL === true;
    }

    _getActiveVoiceId(voiceId) {
        return this._isPersonalizedPiperEnabled()
            ? PERSONALIZED_PIPER_VOICE_ID
            : voiceId || this.app.config.DEFAULT_PIPER_VOICE;
    }

    _getPersonalizedPiperConfig() {
        const modelUrl = PERSONALIZED_PIPER_MODEL_URL.trim();
        const configUrl = PERSONALIZED_PIPER_CONFIG_URL.trim();

        if (!modelUrl || !configUrl) {
            throw new Error(
                "Personalized Piper model is enabled, but PERSONALIZED_PIPER_MODEL_URL and PERSONALIZED_PIPER_CONFIG_URL are not set.",
            );
        }

        new URL(modelUrl, window.location.href);
        new URL(configUrl, window.location.href);
        return { modelUrl, configUrl };
    }

    _getPersonalizedVoicesList() {
        return {
            [PERSONALIZED_PIPER_VOICE_ID]: {
                name: PERSONALIZED_PIPER_VOICE_NAME,
                quality: "custom",
                language: {},
                files: {},
            },
        };
    }

    async ensurePiper(voiceId) {
        const { state, config } = this.app;
        const targetVoiceId = this._getActiveVoiceId(voiceId || config.DEFAULT_PIPER_VOICE);

        if (this.initialized && this.voiceId === targetVoiceId && state.piperInstance) {
            return state.piperInstance;
        }

        this.app.ui.showInfo("Loading AI Natural Voices...");
        if (this.initializingPromise) {
            if (this.pendingVoiceId && this.pendingVoiceId !== targetVoiceId) {
                await this.initializingPromise.catch(() => {});
            } else {
                await this.initializingPromise;
                return state.piperInstance;
            }
        }

        this.pendingVoiceId = targetVoiceId;
        this.initializingPromise = this._initializeVoice(targetVoiceId)
            .then(async () => {
                await this.initVoices();
                return state.piperInstance;
            })
            .finally(() => {
                this.pendingVoiceId = null;
            });

        try {
            return await this.initializingPromise;
        } finally {
            this.app.ui.showInfo("AI Natural Voices Loaded!");
            this.initializingPromise = null;
        }
    }

    async _initializeVoice(voiceId) {
        const { ui, state } = this.app;
        const targetVoiceId = this._getActiveVoiceId(voiceId);
        ui.updatePlayButton(state.playerState.LOADING);
        document.body.style.cursor = "wait";

        try {
            if (!this.client) {
                this.client = new PiperWorkerClient({ workerUrl: "./src/modules/tts/piper.worker.js" });
            }

            const usesPersonalizedModel = this._isPersonalizedPiperEnabled();
            if (usesPersonalizedModel) {
                this.voices = this._getPersonalizedVoicesList();
                this.client.availableVoices = this.voices;
            } else if (!this.voices) {
                this.voices = await this.getVoicesLists();
                this.client.availableVoices = this.voices;
            }

            let modelBuffer = null;
            let voiceConfig = null;

            if (usesPersonalizedModel) {
                const customModel = this._getPersonalizedPiperConfig();
                modelBuffer = await getUncachedModel(customModel.modelUrl, {
                    onProgress: (pct) => ui.showMessage(`Downloading personalized model: ${pct.toFixed(2)}%`, 1200),
                });
                voiceConfig = await getUncachedJSON(customModel.configUrl);
            } else {
                const voice = this.voices[targetVoiceId];
                if (!voice) {
                    ui.updatePlayButton(state.playerState.DONE);
                    throw new Error(
                        `Unknown voice: ${targetVoiceId}. Available voices: ${Object.keys(this.voices).join(", ")}`,
                    );
                }

                const filePaths = Object.keys(voice.files || {});

                const modelFile = filePaths.find((f) => f.endsWith(".onnx"));
                const configFile = filePaths.find((f) => f.endsWith(".onnx.json"));

                if (!modelFile || !configFile) {
                    ui.updatePlayButton(state.playerState.DONE);
                    throw new Error(`Voice ${targetVoiceId} is missing required model or config files.`);
                }

                const modelUrl = this.huggingFaceRoot + modelFile;
                const configUrl = this.huggingFaceRoot + configFile;

                modelBuffer = await getCachedModel(modelFile, modelUrl, {
                    onProgress: (pct) => ui.showMessage(`Downloading model: ${pct.toFixed(2)}%`, 1200),
                });
                voiceConfig = await getCachedJSON(configFile, configUrl);
            }

            const baseUrl = getWebsiteRoot();
            const ortJsUrl = `${baseUrl}thirdparty/ort/ort.js`;
            const ortWasmRoot = `${baseUrl}thirdparty/ort/`;
            const phonemizerJsUrl = `${baseUrl}thirdparty/piper/piper-o91UDS6e.js`;
            const phonemizerWasmUrl = `${baseUrl}thirdparty/piper/piper_phonemize.wasm`;
            const phonemizerDataUrl = `${baseUrl}thirdparty/piper/piper_phonemize.data`;
            const maxThreads = Math.max(1, Number(this.app.config.PIPER_MAX_THREADS) || 1);

            if (!this.initialized) {
                await this.client.init({
                    modelBuffer,
                    voiceConfig,
                    ortJsUrl,
                    ortWasmRoot,
                    phonemizerJsUrl,
                    phonemizerWasmUrl,
                    phonemizerDataUrl,
                    logLevel: "error",
                    transferModel: true,
                    maxThreads,
                });
            } else if (this.voiceId !== targetVoiceId) {
                await this.client.changeVoice({
                    modelBuffer,
                    voiceConfig,
                    transferModel: true,
                });
            }

            this.voiceId = targetVoiceId;
            this.initialized = true;
            state.piperInstance = this.client;
            state.currentPiperVoice = targetVoiceId;
            state.piperInstance.availableVoices = this.voices;

            return state.piperInstance;
        } catch (err) {
            console.error("Failed to initialize Piper:", err);
            this.initialized = false;
            this.voiceId = null;
            state.piperInstance = null;
            state.currentPiperVoice = null;
            if (this.client) {
                try {
                    this.client.terminate();
                } catch (_) {}
            }
            this.client = null;
            throw err;
        } finally {
            document.body.style.cursor = "default";
            ui.updatePlayButton(state.playerState.DONE);
        }
    }

    async safeDecodeAudioData(arrayBuffer) {
        const { state } = this.app;
        await this.ensureAudioContext();
        if (!arrayBuffer || arrayBuffer.byteLength < 100) throw new Error("Audio buffer too small/invalid.");
        try {
            return await state.audioCtx.decodeAudioData(arrayBuffer.slice(0));
        } catch (err) {
            try {
                if (state.audioCtx) await state.audioCtx.close();
            } catch {}
            state.audioCtx = null;
            await this.ensureAudioContext();
            return state.audioCtx.decodeAudioData(arrayBuffer.slice(0));
        }
    }

    _getWordBoxViewport(word) {
        if (word?.bbox && Number.isFinite(word.bbox.x1) && Number.isFinite(word.bbox.y1)) {
            return { x1: word.bbox.x1, y1: word.bbox.y1, x2: word.bbox.x2, y2: word.bbox.y2 };
        }
        const x1 = Number(word?.x) || 0;
        const y2 = Number(word?.y) || 0;
        const width = Number(word?.width) || 0;
        const height = Number(word?.height) || 0;
        return { x1, y1: y2 - height, x2: x1 + width, y2 };
    }

    _boxesOverlap(a, b) {
        const overlapX = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
        const overlapY = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
        return overlapX > 0 && overlapY > 0;
    }

    _findReadableLayoutBlockKey(word, readableBoxes) {
        const box = this._getWordBoxViewport(word);
        for (let i = 0; i < readableBoxes.length; i++) {
            if (this._boxesOverlap(box, readableBoxes[i])) return `readable:${i}`;
        }
        return "readable:unassigned";
    }

    async _getSpeechPhraseEntries(sentence, sourceText) {
        const { state, config } = this.app;
        const fallback = (sourceText || "").trim();
        if (!fallback) return [];

        if (
            state.currentDocumentType !== "pdf" ||
            !config.SPLIT_PDF_AUDIO_ON_LAYOUT_BLOCKS ||
            this.app.isReadTranslationEnabled?.()
        ) {
            return [{ text: fallback, blockKey: null }];
        }

        const words =
            Array.isArray(sentence?.readableWords) && sentence.readableWords.length
                ? sentence.readableWords
                : Array.isArray(sentence?.words)
                  ? sentence.words.filter((word) => word?.isReadable !== false)
                  : [];
        if (words.length < 2 || !this.app.getPdfHeaderFooterDetector || !sentence?.pageNumber) {
            return [{ text: fallback, blockKey: null }];
        }

        let layoutRegions = null;
        try {
            layoutRegions = await this.app.getPdfHeaderFooterDetector().getLayoutRegions(sentence.pageNumber);
        } catch (err) {
            console.warn("[TTS] Failed to get PDF layout regions for audio phrase split", err);
            return [{ text: fallback, blockKey: null }];
        }

        const readableBoxes = Array.isArray(layoutRegions?.readableBoxes) ? layoutRegions.readableBoxes : [];
        if (readableBoxes.length < 2) return [{ text: fallback, blockKey: null }];

        const groups = [];
        let currentWords = [];
        let currentBlockKey = null;

        const flush = () => {
            if (!currentWords.length) return;
            const text =
                this.app.sentenceParser?.joinWords?.(currentWords) || currentWords.map((w) => w?.str || "").join(" ");
            if (hasUsableSpeechText(text)) groups.push({ text: text.trim(), blockKey: currentBlockKey });
            currentWords = [];
        };

        for (const word of words) {
            const blockKey = this._findReadableLayoutBlockKey(word, readableBoxes);
            if (currentBlockKey !== null && blockKey !== currentBlockKey) flush();
            currentBlockKey = blockKey;
            currentWords.push(word);
        }
        flush();

        return groups.length > 1 ? groups : [{ text: fallback, blockKey: null }];
    }

    _createSilenceBuffer(durationSec, sampleRate, channels) {
        const { state } = this.app;
        const audioCtx = state.audioCtx;
        const length = Math.max(0, Math.round(durationSec * sampleRate));
        return audioCtx.createBuffer(channels, length, sampleRate);
    }

    _concatAudioBuffers(buffers) {
        const { state } = this.app;
        const audioCtx = state.audioCtx;
        const validBuffers = buffers.filter(Boolean);
        if (validBuffers.length === 1) return validBuffers[0];
        if (!validBuffers.length) throw new Error("No decoded audio buffers to concatenate");

        const sampleRate = validBuffers[0].sampleRate;
        const channels = Math.max(...validBuffers.map((buffer) => buffer.numberOfChannels || 1));
        const length = validBuffers.reduce((sum, buffer) => sum + buffer.length, 0);
        const output = audioCtx.createBuffer(channels, length, sampleRate);

        let offset = 0;
        for (const buffer of validBuffers) {
            for (let channel = 0; channel < channels; channel++) {
                const input = buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1));
                output.getChannelData(channel).set(input, offset);
            }
            offset += buffer.length;
        }

        return output;
    }

    _buildWordBoundariesForAudio(phrases, decodedBuffers, finalBuffer, pauseSec = 0) {
        const { config } = this.app;
        if (!config.ENABLE_WORD_HIGHLIGHT) return [];

        const wordBoundaries = [];
        let offsetMs = 0;
        for (let i = 0; i < phrases.length; i++) {
            const phrase = phrases[i] || "";
            const buffer = decodedBuffers[i];
            if (!buffer) continue;

            const words = phrase.split(/\s+/).filter(Boolean);
            const total = words.length || 1;
            const totalMs = buffer.duration * 1000;
            for (let wordIndex = 0; wordIndex < words.length; wordIndex++) {
                wordBoundaries.push({
                    text: words[wordIndex],
                    offsetMs: Math.floor(offsetMs + (wordIndex / total) * totalMs),
                    durationMs: Math.floor(totalMs / total),
                });
            }
            offsetMs += buffer.duration * 1000;
            if (i < phrases.length - 1) offsetMs += pauseSec * 1000;
        }

        if (!wordBoundaries.length && finalBuffer?.duration) {
            const words = phrases.join(" ").split(/\s+/).filter(Boolean);
            const total = words.length || 1;
            const totalMs = finalBuffer.duration * 1000;
            for (let i = 0; i < words.length; i++) {
                wordBoundaries.push({
                    text: words[i],
                    offsetMs: Math.floor((i / total) * totalMs),
                    durationMs: Math.floor(totalMs / total),
                });
            }
        }

        return wordBoundaries;
    }

    async buildPiperAudio(sentence, voice, text) {
        const { state, config } = this.app;
        const activeVoice = this._getActiveVoiceId(voice);

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

        await this.ensureAudioContext();
        const client = await this.ensurePiper(activeVoice);
        if (!client) {
            sentence.audioError = new Error("Piper voice unavailable");
            return;
        }
        await cooperativeYield();

        const rawPhraseEntries = await this._getSpeechPhraseEntries(sentence, text);
        const phraseEntries = rawPhraseEntries
            .map((entry) => ({
                text: normalizeText(entry?.text || ""),
                blockKey: entry?.blockKey || null,
            }))
            .filter((entry) => hasUsableSpeechText(entry.text));
        if (!phraseEntries.length) {
            sentence.audioError = new Error("No speech text available after PDF layout phrase split");
            return;
        }
        const phrases = phraseEntries.map((entry) => entry.text);

        const decodedSpeechBuffers = [];
        const buffersForPlayback = [];
        const ttsPhraseTimings = [];
        let effectiveBlob = null;
        const pauseSec =
            Number.isFinite(config.PDF_AUDIO_LAYOUT_BLOCK_PAUSE_SEC) && phraseEntries.length > 1
                ? Math.max(0, config.PDF_AUDIO_LAYOUT_BLOCK_PAUSE_SEC)
                : 0;

        let phraseOffsetMs = 0;
        for (let i = 0; i < phraseEntries.length; i++) {
            const phrase = phraseEntries[i].text;
            const { blob: wavBlob, wavBuffer } = await retryAsync(async () => {
                try {
                    const cleaned = formatTextToSpeech(phrase);
                    const activeClient = this.app.state.piperInstance || client;
                    if (!activeClient) throw new Error("Piper worker unavailable");
                    const createBlob = !config.STORE_DECODED_ONLY || config.MAKE_WAV_COPY;
                    const result = await activeClient.synthesize(cleaned, state.CURRENT_SPEED, undefined, {
                        createBlob,
                    });
                    return result;
                } catch (e) {
                    await this.ensurePiper(activeVoice);
                    throw e;
                } finally {
                    document.body.style.cursor = "default";
                }
            });

            let bufferForDecode = null;
            if (wavBuffer instanceof ArrayBuffer) {
                bufferForDecode = wavBuffer;
            } else if (wavBuffer?.buffer instanceof ArrayBuffer) {
                bufferForDecode = wavBuffer.buffer.slice(0);
            } else if (wavBlob?.arrayBuffer) {
                bufferForDecode = await wavBlob.arrayBuffer();
            } else {
                throw new Error("Invalid audio buffer returned from Piper worker");
            }

            const decoded = await this.safeDecodeAudioData(bufferForDecode.slice(0));
            decodedSpeechBuffers.push(decoded);
            buffersForPlayback.push(decoded);
            ttsPhraseTimings.push({
                blockKey: phraseEntries[i].blockKey,
                offsetMs: Math.floor(phraseOffsetMs),
                durationMs: Math.floor(decoded.duration * 1000),
            });
            phraseOffsetMs += decoded.duration * 1000;

            if (!effectiveBlob && phraseEntries.length === 1) {
                effectiveBlob = wavBlob || new Blob([bufferForDecode], { type: "audio/wav" });
            }

            if (pauseSec > 0 && i < phraseEntries.length - 1) {
                buffersForPlayback.push(
                    this._createSilenceBuffer(pauseSec, decoded.sampleRate, decoded.numberOfChannels),
                );
                phraseOffsetMs += pauseSec * 1000;
            }
        }

        const decoded = this._concatAudioBuffers(buffersForPlayback);
        const wordBoundaries = this._buildWordBoundariesForAudio(phrases, decodedSpeechBuffers, decoded, pauseSec);

        if (!this._isPersonalizedPiperEnabled()) {
            const cacheKey = `${activeVoice}|${state.CURRENT_SPEED}|${sentence.normalizedText}`;
            state.audioCache.set(cacheKey, {
                audioBlob: config.STORE_DECODED_ONLY ? null : effectiveBlob,
                wavBlob: config.MAKE_WAV_COPY ? effectiveBlob : null,
                audioBuffer: decoded,
                wordBoundaries,
                ttsPhraseTimings,
            });
        }

        Object.assign(sentence, {
            audioBlob: config.STORE_DECODED_ONLY ? null : effectiveBlob,
            wavBlob: config.MAKE_WAV_COPY ? effectiveBlob : null,
            audioBuffer: decoded,
            audioReady: true,
            lastVoice: activeVoice,
            lastSpeed: state.CURRENT_SPEED,
            prefetchQueued: false,
            audioError: null,
            wordBoundaries,
            ttsPhraseTimings,
        });
        sentence._restartRetryCount = 0;
        delete sentence._restartAttempted;
    }

    async synthesizeSequential(idx) {
        const { state, config } = this.app;
        if (!state.generationEnabled) return;
        const s = state.sentences[idx];
        if (!s) return;
        if (!s.isTextToRead) {
            return;
        }
        if (s.audioInProgress) return;

        const baseText = s.readableText && s.readableText.trim().length ? s.readableText : s.text;
        if (!baseText || !baseText.trim().length) {
            s.audioError = new Error("No readable text available for synthesis");
            return;
        }

        const sourceText = await this.app.getSentenceSpeechText?.(idx, baseText);
        if (!sourceText || !sourceText.trim().length) {
            s.audioError = new Error("No speech text available for synthesis");
            return;
        }

        if (this.app.isReadTranslationEnabled?.()) {
            try {
                await this.app.ensureReadTranslationVoiceReady?.();
            } catch (err) {
                console.warn("[TTS] Failed to align voice with translation target", err);
            }
        }

        const voiceSelect = document.getElementById("voice-select");
        const voice = this._getActiveVoiceId(
            voiceSelect?.value || this.preferredVoiceId || config.DEFAULT_PIPER_VOICE,
        );

        if (!hasUsableSpeechText(sourceText)) {
            this._markSentenceAsSilent(s);
            return;
        }

        const norm = normalizeText(sourceText);
        const requiresPdfPhraseTimings =
            state.currentDocumentType === "pdf" &&
            config.SPLIT_PDF_AUDIO_ON_LAYOUT_BLOCKS &&
            !this.app.isReadTranslationEnabled?.() &&
            Array.isArray(s.readableWords) &&
            s.readableWords.length > 1;
        const hasPhraseTimings = Array.isArray(s.ttsPhraseTimings) && s.ttsPhraseTimings.length > 0;

        if (
            s.audioReady &&
            s.lastVoice === voice &&
            s.lastSpeed === state.CURRENT_SPEED &&
            typeof s.normalizedText === "string" &&
            s.normalizedText === norm &&
            (!requiresPdfPhraseTimings || hasPhraseTimings)
        ) {
            return;
        }

        s.normalizedText = norm;
        const cacheKey = `${voice}|${state.CURRENT_SPEED}|${norm}`;
        if (!this._isPersonalizedPiperEnabled() && state.audioCache.has(cacheKey)) {
            const cached = state.audioCache.get(cacheKey);
            const cachedPhraseTimings = cached.ttsPhraseTimings || [];
            if (requiresPdfPhraseTimings && !cachedPhraseTimings.length) {
                state.audioCache.delete(cacheKey);
            } else {
                Object.assign(s, {
                    audioBlob: cached.audioBlob || null,
                    wavBlob: cached.wavBlob || null,
                    audioBuffer: cached.audioBuffer,
                    audioReady: true,
                    lastVoice: voice,
                    lastSpeed: state.CURRENT_SPEED,
                    audioError: null,
                    audioInProgress: false,
                    prefetchQueued: false,
                    wordBoundaries: cached.wordBoundaries || [],
                    ttsPhraseTimings: cachedPhraseTimings,
                });
                s._restartRetryCount = 0;
                delete s._restartAttempted;
                return;
            }
        }

        s.audioInProgress = true;
        s.audioError = null;

        this.app.eventBus.emit(EVENTS.TTS_SYNTHESIS_START, { index: idx });

        try {
            await this.buildPiperAudio(s, voice, sourceText);
            this.app.eventBus.emit(EVENTS.TTS_SYNTHESIS_COMPLETE, { index: idx });
            if (state.currentDocumentType === "pdf") {
                this.prepareNextPdfPageWhenReady(s.pageNumber).catch((error) => {
                    console.warn("[TTSEngine] Next PDF page prefetch failed", error);
                });
            }
        } catch (err) {
            s.audioError = err;
            if (this._isOfflineTtsUnavailableError(err)) {
                this._handleOfflineTtsUnavailable(s, err);
                this.app.eventBus.emit(EVENTS.TTS_SYNTHESIS_ERROR, { index: idx, error: err });
                throw err;
            }
            const retryCount = (Number.isFinite(s._restartRetryCount) ? s._restartRetryCount : 0) + 1;
            s._restartRetryCount = retryCount;
            const reason = err?.message || "unknown synthesis error";
            this.app.ui.showMessage(
                `TTS warning: restarting engine (attempt ${retryCount}). Audio generation will keep retrying. If this continues, reloading the page will help.`,
                3200,
            );
            this.app.eventBus.emit(EVENTS.TTS_SYNTHESIS_ERROR, { index: idx, error: err });
            try {
                await this.resetEngine({
                    clearCache: true,
                    reason,
                    preservePlayback: true,
                    attempt: retryCount,
                });
                const retrySentence = this.app.state.sentences[idx];
                if (retrySentence) {
                    retrySentence.audioError = null;
                    retrySentence.audioInProgress = false;
                }
                if (this.app.state.generationEnabled && this.app.ttsQueue) {
                    this.app.ttsQueue.add(idx, true);
                    this.app.ttsQueue.run();
                }
            } catch (resetErr) {
                console.error("Failed to reset TTS engine:", resetErr);
            }
            throw err;
        } finally {
            s.audioInProgress = false;
        }
    }

    schedulePrefetch() {
        const { state, config } = this.app;
        if (!state.generationEnabled) return;
        const indices = [];
        const isPdf = state.currentDocumentType === "pdf";
        const currentPage = isPdf ? state.sentences[state.currentSentenceIndex]?.pageNumber : null;
        const prefetchLimit = isPdf
            ? Math.max(0, Number(config.PDF_PREFETCH_PHRASES) || 3)
            : Math.max(0, Number(config.PREFETCH_AHEAD) || 0);
        if (state.currentSentenceIndex >= 0) {
            this.app.ttsQueue.add(state.currentSentenceIndex, true);
            indices.push(state.currentSentenceIndex);
        }
        const base = state.currentSentenceIndex;
        for (let i = base + 1; i <= base + prefetchLimit && i < state.sentences.length; i++) {
            // Crossing a PDF page boundary here starts layout analysis for both
            // pages. Leave the next page for auto-advance; a short final remainder
            // on the current page is still queued by this loop.
            if (isPdf && state.sentences[i]?.pageNumber !== currentPage) break;
            this.app.ttsQueue.add(i);
            this.app.prefetchSentenceTranslationForTTS?.(i);
        }

        if (state.currentSentenceIndex >= 0) {
            this.app.prefetchSentenceTranslationForTTS?.(state.currentSentenceIndex);
        }

        if (indices.length) {
            Promise.resolve()
                .then(() => this._renderSentencesAhead(indices))
                .catch((err) => console.warn("[TTSEngine] Prefetch render failed", err));
        }
    }

    async prepareNextPdfPageWhenReady(pageNumber) {
        const { state, config } = this.app;
        if (!state.generationEnabled || state.currentDocumentType !== "pdf") return;
        const pdf = state.pdf;
        if (!pdf) return;

        const currentPageIndices = state.pageSentencesIndex.get(pageNumber) || [];
        const readableCurrentPage = currentPageIndices
            .map((index) => state.sentences[index])
            .filter((sentence) => sentence?.layoutProcessed && sentence.isTextToRead);
        if (!readableCurrentPage.length) return;
        if (readableCurrentPage.some((sentence) => !sentence.audioReady && !sentence.audioError)) return;

        const nextPageSentence = state.sentences.find((sentence) => sentence?.pageNumber > pageNumber);
        const nextPage = nextPageSentence?.pageNumber;
        if (!Number.isFinite(nextPage)) return;
        if (this._renderAheadPages.has(nextPage)) return;

        this._renderAheadPages.add(nextPage);
        try {
            await this.app.pdfRenderer.ensureFullPageRendered(nextPage);
            if (state.pdf !== pdf) return;
            await this.app.getPdfHeaderFooterDetector().ensureReadabilityForPage(nextPage);
            if (state.pdf !== pdf) return;

            const nextPageIndices = state.pageSentencesIndex.get(nextPage) || [];
            const prefetchLimit = Math.max(1, Number(config.PDF_PREFETCH_PHRASES) || 3);
            let queued = 0;
            for (const index of nextPageIndices) {
                const sentence = state.sentences[index];
                if (!sentence?.layoutProcessed || !sentence.isTextToRead) continue;
                this.app.ttsQueue.add(index);
                this.app.prefetchSentenceTranslationForTTS?.(index);
                queued += 1;
                if (queued >= prefetchLimit) break;
            }
        } finally {
            this._renderAheadPages.delete(nextPage);
        }
    }

    _markSentenceAsSilent(sentence) {
        if (!sentence) return;
        sentence.isTextToRead = false;
        sentence.audioReady = false;
        sentence.audioBuffer = null;
        sentence.audioError = null;
        sentence.prefetchQueued = false;
        sentence.wordBoundaries = [];
        sentence.ttsPhraseTimings = [];
    }

    async initVoices() {
        const { state, config } = this.app;
        const voiceSelect = document.getElementById("voice-select");
        if (this._isPersonalizedPiperEnabled()) {
            if (!voiceSelect) return;
            voiceSelect.innerHTML = "";
            const opt = document.createElement("option");
            opt.value = PERSONALIZED_PIPER_VOICE_ID;
            opt.textContent = PERSONALIZED_PIPER_VOICE_NAME;
            voiceSelect.appendChild(opt);
            voiceSelect.value = PERSONALIZED_PIPER_VOICE_ID;
            state.currentPiperVoice = PERSONALIZED_PIPER_VOICE_ID;
            const micIcon = document.getElementById("mic-icon");
            if (micIcon) {
                micIcon.classList.remove("fa-spinner", "fa-spin");
                micIcon.classList.add("fa-microphone");
            }
            return;
        }

        const voicesSource = this.voices || state.piperInstance?.availableVoices;
        if (!voiceSelect || !voicesSource) return;
        voiceSelect.innerHTML = "";
        const allVoices = voicesSource;
        let firstAvailableVoice = null;
        config.PIPER_VOICES.forEach((v) => {
            const voiceDef = allVoices[v];
            if (!voiceDef) return;
            const opt = document.createElement("option");
            opt.value = v;
            const lang = voiceDef["language"] || {};
            const flag = this.app.helpers.regionToFlag(lang["region"] || "");
            const qual = this.app.helpers.capitalizeFirst(voiceDef["quality"] || "");
            const voiceName = this.app.helpers.capitalizeFirst(voiceDef["name"] || v);
            if (qual === "High") {
                opt.textContent = `${flag} ${voiceName} ${qual} - Need Fast CPU`;
            } else {
                opt.textContent = `${flag} ${voiceName} ${qual}`;
            }
            voiceSelect.appendChild(opt);
            if (!firstAvailableVoice) firstAvailableVoice = v;
        });

        const requestedVoiceId = this.preferredVoiceId || this.voiceId || config.DEFAULT_PIPER_VOICE;
        const hasRequestedOption = Array.from(voiceSelect.options).some((opt) => opt.value === requestedVoiceId);
        const selectedVoiceId = hasRequestedOption
            ? requestedVoiceId
            : firstAvailableVoice || voiceSelect.options[0]?.value || config.DEFAULT_PIPER_VOICE;
        voiceSelect.value = selectedVoiceId;
        this.preferredVoiceId = null;
        const micIcon = document.getElementById("mic-icon");
        if (micIcon) {
            micIcon.classList.remove("fa-spinner", "fa-spin");
            micIcon.classList.add("fa-microphone");
        }
    }

    async resetEngine({ clearCache = true, reason, preservePlayback = true, attempt } = {}) {
        const { state } = this.app;

        if (this._resetPromise) {
            await this._resetPromise.catch(() => {});
            return;
        }

        this._restartAttemptedCount += 1;
        const attemptNo = Number.isFinite(attempt) ? attempt : this._restartAttemptedCount;
        console.warn(`[TTS] Restarting engine (attempt ${attemptNo})`, reason || "");
        this.app.ui.showMessage(
            `TTS warning: restart attempt ${attemptNo}.${preservePlayback ? " Reader keeps playing." : ""}`,
            2800,
        );

        const activePlayingSentence =
            preservePlayback && state.isPlaying && state.playingSentenceIndex >= 0
                ? state.sentences[state.playingSentenceIndex]
                : null;

        this._resetPromise = (async () => {
            if (this.initializingPromise) {
                try {
                    await this.initializingPromise.catch(() => {});
                } catch {}
            }
            this.initializingPromise = null;
            this.pendingVoiceId = null;

            if (this.client) {
                try {
                    this.client.terminate();
                } catch (err) {
                    console.warn("Failed to terminate Piper worker:", err);
                }
            }
            this.client = null;
            this.initialized = false;
            this.voiceId = null;

            const shouldRecycleAudioContext = !preservePlayback || !state.isPlaying;
            if (state.audioCtx && shouldRecycleAudioContext) {
                try {
                    await state.audioCtx.close();
                } catch (err) {
                    console.warn("AudioContext close failed:", err);
                }
                state.audioCtx = null;
            }

            state.piperInstance = null;
            state.currentPiperVoice = null;
            state.piperLoading = false;

            if (!preservePlayback) {
                state.stopRequested = false;
            }

            if (clearCache && state.audioCache) {
                try {
                    state.audioCache.clear();
                } catch (err) {
                    console.warn("Audio cache clear failed:", err);
                }
            }

            if (clearCache && Array.isArray(state.sentences)) {
                for (const sentence of state.sentences) {
                    if (!sentence) continue;

                    const keepLivePlaybackSentence = !!activePlayingSentence && sentence === activePlayingSentence;
                    if (keepLivePlaybackSentence) {
                        sentence.audioInProgress = false;
                        sentence.audioError = null;
                        sentence.prefetchQueued = false;
                        continue;
                    }

                    if (Array.isArray(sentence.playbackWordTimers)) {
                        for (const timer of sentence.playbackWordTimers) clearTimeout(timer);
                    }
                    sentence.playbackWordTimers = [];
                    sentence.audioBlob = null;
                    sentence.wavBlob = null;
                    sentence.audioBuffer = null;
                    sentence.audioReady = false;
                    sentence.audioInProgress = false;
                    sentence.lastVoice = null;
                    sentence.lastSpeed = null;
                    sentence.audioError = null;
                    sentence.prefetchQueued = false;
                    sentence.wordBoundaries = [];
                    sentence.ttsPhraseTimings = [];
                    sentence._restartRetryCount = 0;
                    delete sentence._restartAttempted;
                }
            }
        })();

        try {
            await this._resetPromise;
        } finally {
            this._resetPromise = null;
        }
    }

    async _renderSentencesAhead(indices) {
        const app = this.app;
        const { state } = app;

        if (!Array.isArray(indices) || !indices.length) return;
        if (state.currentDocumentType && state.currentDocumentType !== "pdf") return;
        if (!app.pdfRenderer || !app.getPdfHeaderFooterDetector) return;

        const pagesToPrefetch = [];
        const seenPages = new Set();

        for (const idx of indices) {
            const sentence = state.sentences[idx];
            if (!sentence || sentence.layoutProcessed) continue;
            const pageNumber = sentence.pageNumber;
            if (!pageNumber || seenPages.has(pageNumber)) continue;
            if (state.prefetchedPages.has(pageNumber) || this._renderAheadPages.has(pageNumber)) continue;
            seenPages.add(pageNumber);
            this._renderAheadPages.add(pageNumber);
            pagesToPrefetch.push(pageNumber);
        }

        for (const pageNumber of pagesToPrefetch) {
            let addedToGlobalPrefetch = false;
            if (!state.prefetchedPages.has(pageNumber)) {
                state.prefetchedPages.add(pageNumber);
                addedToGlobalPrefetch = true;
            }

            try {
                await app.pdfRenderer.ensureFullPageRendered(pageNumber);
                await app.getPdfHeaderFooterDetector().ensureReadabilityForPage(pageNumber);
            } catch (err) {
                console.warn("[TTSEngine] Failed to pre-render page", pageNumber, err);
                if (addedToGlobalPrefetch) state.prefetchedPages.delete(pageNumber);
            } finally {
                this._renderAheadPages.delete(pageNumber);
                await cooperativeYield();
            }
        }
    }
}
