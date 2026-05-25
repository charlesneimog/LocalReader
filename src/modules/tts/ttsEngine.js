import {
    getWebsiteRoot,
    cooperativeYield,
    delay,
    normalizeText,
    formatTextToSpeech,
    hasUsableSpeechText,
} from "../utils/helpers.js";
import { EVENTS } from "../../constants/events.js";
import { PiperWorkerClient, getCachedModel, getCachedJSON } from "./piper-client.js";

const OFFLINE_VOICE_MESSAGE =
    "This voice is not available offline. Please connect to the internet to download it first.";

export class TTSEngine {
    constructor(app) {
        this.app = app;
        this.client = null;
        this.voice = app.config.DEFAULT_PIPER_VOICE;
        this.piperInstance = null;
        this.voices = null;
        this.pendingVoiceId = null;
        this.initializingPromise = null;
        this._renderAheadPages = new Set();
        this._restartAttemptedCount = 0;
        this._resetPromise = null;
        this.PREFETCH_TARGET = Number.isFinite(app.config?.PREFETCH_TARGET) ? app.config.PREFETCH_TARGET : 5;

        const scriptSrc = (document.currentScript && document.currentScript.src) || window.location.href;
        const scriptDir = scriptSrc.substring(0, scriptSrc.lastIndexOf("/"));
        const baseUrl = scriptDir.replace(/\/thirdparty\/piper$/, "");
        this.baseUrl = baseUrl;

        this.huggingFaceRoot = "https://huggingface.co/rhasspy/piper-voices/resolve/main/";
        this.initialized = false;
    }

    _isOffline() {
        return this.app?.network?.isOffline?.() === true;
    }

    _isOfflineVoiceError(error) {
        if (!error) return false;
        const message = String(error?.message || error);
        if (message === OFFLINE_VOICE_MESSAGE) return true;
        if (!this._isOffline()) return false;
        return /no available backend found|WebAssembly\.instantiate|CompileError|\bwasm\b/i.test(message);
    }

    isOfflineVoiceError(error) {
        return this._isOfflineVoiceError(error);
    }

    async _assertOfflineAsset(url, { expectWasm = false } = {}) {
        try {
            const response = await this.app.network.fetch(url, {}, { allowOfflineCache: true, cacheOnly: true });
            if (!response || !response.ok) {
                throw new Error(OFFLINE_VOICE_MESSAGE);
            }
            if (expectWasm) {
                const contentType = response.headers?.get("Content-Type") || "";
                if (/text\/html/i.test(contentType)) {
                    throw new Error(OFFLINE_VOICE_MESSAGE);
                }
            }
        } catch (err) {
            throw new Error(OFFLINE_VOICE_MESSAGE);
        }
    }

    async _assertOfflineCoreAssets({
        ortJsUrl,
        ortWasmRoot,
        phonemizerJsUrl,
        phonemizerWasmUrl,
        phonemizerDataUrl,
    }) {
        if (!this._isOffline()) return;

        await this._assertOfflineAsset(ortJsUrl);
        const ortFiles = [
            "ort-wasm-simd.wasm",
            "ort-wasm-simd-threaded.jsep.mjs",
            "ort-wasm-simd-threaded.jsep.wasm",
        ];
        for (const file of ortFiles) {
            await this._assertOfflineAsset(`${ortWasmRoot}${file}`, { expectWasm: file.endsWith(".wasm") });
        }
        await this._assertOfflineAsset(phonemizerJsUrl);
        await this._assertOfflineAsset(phonemizerWasmUrl, { expectWasm: true });
        await this._assertOfflineAsset(phonemizerDataUrl);
    }

    async getVoicesLists() {
        const url = "https://huggingface.co/rhasspy/piper-voices/resolve/main/voices.json";
        const cache = await caches.open("piper-voices-v1");

        if (!this._isOffline()) {
            try {
                const response = await this.app.network.fetch(url);
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
                throw new Error("Failed to fetch voices.json and no cache available");
            }
        }

        const cached = await cache.match(url);
        if (cached) {
            return await cached.json();
        }
        throw new Error(OFFLINE_VOICE_MESSAGE);
    }

    async prepareVoicesList({ silent = true } = {}) {
        if (this.voices) {
            await this.initVoices();
            return;
        }

        try {
            this.voices = await this.getVoicesLists();
            await this.initVoices();
        } catch (err) {
            if (!silent) {
                if (this._isOfflineVoiceError(err)) {
                    this.app.ui?.showInfo?.(OFFLINE_VOICE_MESSAGE);
                    return;
                }
                this.app.ui?.showInfo?.("Failed to load voice list.");
            }

            if (!this._isOfflineVoiceError(err)) {
                console.warn("[TTS] Failed to load voices list", err);
            }
        }
    }

    async ensureAudioContext(options = {}) {
        const { state, config } = this.app;
        const resume = options?.resume === true;

        if (!state.audioCtx || state.audioCtx.state === "closed") {
            state.audioCtx = new window.AudioContext(config.AUDIO_CONTEXT_OPTIONS);
        }

        if (resume && state.audioCtx?.state === "suspended") {
            try {
                await state.audioCtx.resume();
            } catch (error) {
                console.debug("[TTS] AudioContext resume blocked", error);
            }
        }

        return state.audioCtx;
    }

    async ensurePiper(voiceId, options = {}) {
        const { state, config } = this.app;
        const targetVoiceId = voiceId || config.DEFAULT_PIPER_VOICE;
        const silent =
            typeof options.silent === "boolean" ? options.silent : !(state && state.playbackPending === true);
        const showUi = !silent;

        if (this.initialized && this.voiceId === targetVoiceId && state.piperInstance) {
            return state.piperInstance;
        }

        if (showUi) {
            this.app.ui.showInfo("Loading AI Natural Voices...");
        }
        if (this.initializingPromise) {
            if (this.pendingVoiceId && this.pendingVoiceId !== targetVoiceId) {
                await this.initializingPromise.catch(() => { });
            } else {
                await this.initializingPromise;
                return state.piperInstance;
            }
        }

        this.pendingVoiceId = targetVoiceId;
        this.initializingPromise = this._initializeVoice(targetVoiceId, { silent })
            .then(async () => {
                await this.initVoices();
                return state.piperInstance;
            })
            .finally(() => {
                this.pendingVoiceId = null;
            });

        try {
            const instance = await this.initializingPromise;
            if (showUi) {
                this.app.ui.showInfo("AI Natural Voices Loaded!");
            }
            return instance;
        } catch (err) {
            throw err;
        } finally {
            this.initializingPromise = null;
        }
    }

    async _initializeVoice(voiceId, options = {}) {
        const { ui, state } = this.app;
        const silent = options?.silent === true;
        const showUi = !silent;
        if (showUi) {
            document.body.style.cursor = "wait";
        }

        try {
            if (!this.client) {
                this.client = new PiperWorkerClient({ workerUrl: "./src/modules/tts/piper.worker.js" });
            }

            if (!this.voices) {
                this.voices = await this.getVoicesLists();
                this.client.availableVoices = this.voices;
            }

            const voice = this.voices[voiceId];
            if (!voice) {
                throw new Error(`Unknown voice: ${voiceId}. Available voices: ${Object.keys(this.voices).join(", ")}`);
            }

            const filePaths = Object.keys(voice.files || {});
            const modelFile = filePaths.find((f) => f.endsWith(".onnx"));
            const configFile = filePaths.find((f) => f.endsWith(".onnx.json"));

            if (!modelFile || !configFile) {
                throw new Error(`Voice ${voiceId} is missing required model or config files.`);
            }

            const MODEL_URL = this.huggingFaceRoot + modelFile;
            const CONFIG_URL = this.huggingFaceRoot + configFile;

            const allowNetwork = !this._isOffline();
            const fetcher = this.app.network.fetch.bind(this.app.network);

            const modelBuffer = await getCachedModel(modelFile, MODEL_URL, {
                onProgress: showUi ? (pct) => ui.showMessage(`Downloading model: ${pct.toFixed(2)}%`, 1200) : undefined,
                allowNetwork,
                offlineErrorMessage: OFFLINE_VOICE_MESSAGE,
                fetcher,
            });
            const voiceConfig = await getCachedJSON(configFile, CONFIG_URL, {
                allowNetwork,
                offlineErrorMessage: OFFLINE_VOICE_MESSAGE,
                fetcher,
            });

            const baseUrl = getWebsiteRoot();
            const ortJsUrl = `${baseUrl}thirdparty/ort/ort.js`;
            const ortWasmRoot = `${baseUrl}thirdparty/ort/`;
            const phonemizerJsUrl = `${baseUrl}thirdparty/piper/piper-o91UDS6e.js`;
            const phonemizerWasmUrl = `${baseUrl}thirdparty/piper/piper_phonemize.wasm`;
            const phonemizerDataUrl = `${baseUrl}thirdparty/piper/piper_phonemize.data`;

            await this._assertOfflineCoreAssets({
                ortJsUrl,
                ortWasmRoot,
                phonemizerJsUrl,
                phonemizerWasmUrl,
                phonemizerDataUrl,
            });

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
                });
            } else if (this.voiceId !== voiceId) {
                await this.client.changeVoice({
                    modelBuffer,
                    voiceConfig,
                    transferModel: true,
                });
            }

            this.voiceId = voiceId;
            this.initialized = true;
            state.piperInstance = this.client;
            state.currentPiperVoice = voiceId;
            state.piperInstance.availableVoices = this.voices;

            return state.piperInstance;
        } catch (err) {
            const offlineVoiceError = this._isOfflineVoiceError(err);
            if (!offlineVoiceError) {
                console.error("Failed to initialize Piper:", err);
            }
            this.initialized = false;
            this.voiceId = null;
            state.piperInstance = null;
            state.currentPiperVoice = null;
            if (this.client) {
                try {
                    this.client.terminate();
                } catch (_) { }
            }
            this.client = null;
            if (offlineVoiceError) {
                throw new Error(OFFLINE_VOICE_MESSAGE);
            }
            throw err;
        } finally {
            if (showUi) {
                document.body.style.cursor = "default";
            }
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
            } catch { }
            state.audioCtx = null;
            await this.ensureAudioContext();
            return state.audioCtx.decodeAudioData(arrayBuffer.slice(0));
        }
    }

    async buildPiperAudio(sentence, voice, text) {
        const { state, config } = this.app;

        const isOfflineVoiceError = (error) => this._isOfflineVoiceError(error);

        async function retryAsync(fn, tries = 3, gap = 300) {
            let last;
            for (let i = 0; i < tries; i++) {
                try {
                    return await fn();
                } catch (e) {
                    if (isOfflineVoiceError(e)) {
                        throw e;
                    }
                    last = e;
                    if (i < tries - 1) await delay(gap);
                }
            }
            throw last;
        }

        await this.ensureAudioContext();
        const client = await this.ensurePiper(voice);
        if (!client) {
            sentence.audioError = new Error("Piper voice unavailable");
            return;
        }
        await cooperativeYield();

        const { blob: wavBlob, wavBuffer } = await retryAsync(async () => {
            try {
                const cleaned = formatTextToSpeech(text);
                const activeClient = this.app.state.piperInstance || client;
                if (!activeClient) throw new Error("Piper worker unavailable");
                const result = await activeClient.synthesize(cleaned, state.CURRENT_SPEED);
                return result;
            } catch (e) {
                await this.ensurePiper(voice);
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
        const effectiveBlob = wavBlob || new Blob([bufferForDecode], { type: "audio/wav" });
        let wordBoundaries = [];
        if (config.ENABLE_WORD_HIGHLIGHT) {
            const words = text.split(/\s+/).filter(Boolean);
            const total = words.length || 1;
            const totalMs = decoded.duration * 1000;
            for (let i = 0; i < words.length; i++) {
                wordBoundaries.push({
                    text: words[i],
                    offsetMs: Math.floor((i / total) * totalMs),
                    durationMs: Math.floor(totalMs / total),
                });
                if (i > 0 && i % config.WORD_BOUNDARY_CHUNK_SIZE === 0) await cooperativeYield();
            }
        }

        const cacheKey = `${voice}|${state.CURRENT_SPEED}|${sentence.normalizedText}`;
        state.audioCache.set(cacheKey, {
            audioBlob: config.STORE_DECODED_ONLY ? null : effectiveBlob,
            wavBlob: config.MAKE_WAV_COPY ? effectiveBlob : null,
            audioBuffer: decoded,
            wordBoundaries,
        });

        Object.assign(sentence, {
            audioBlob: config.STORE_DECODED_ONLY ? null : effectiveBlob,
            wavBlob: config.MAKE_WAV_COPY ? effectiveBlob : null,
            audioBuffer: decoded,
            audioReady: true,
            lastVoice: voice,
            lastSpeed: state.CURRENT_SPEED,
            prefetchQueued: false,
            audioError: null,
            wordBoundaries,
        });
        sentence._restartRetryCount = 0;
        delete sentence._restartAttempted;

        // Persist a small snapshot of the synthesized audio for this sentence so it
        // can be restored on subsequent loads (improves smartphone perceived latency).
        try {
            const storageKey = state.currentPdfKey || state.currentEpubKey || null;
            if (storageKey) {
                const docType = state.currentDocumentType === "epub" ? "epub" : "pdf";
                const compound = this.app.progressManager._progressKey(docType, storageKey);
                const voiceSpeed = `${voice}|${state.CURRENT_SPEED}`;
                // prefer a blob if available, otherwise fall back to wavBuffer
                let blobToStore = null;
                if (effectiveBlob instanceof Blob) blobToStore = effectiveBlob;
                else if (wavBuffer instanceof ArrayBuffer) blobToStore = new Blob([wavBuffer], { type: "audio/wav" });
                if (blobToStore) {
                    // Don't await too long; fire-and-forget
                    this.app.progressManager.saveSentenceAudio(compound, sentence.index, voiceSpeed, blobToStore, {
                        wordBoundaries,
                    }).catch((err) => console.debug("[ProgressManager] saveSentenceAudio failed", err));
                }
            }
        } catch (e) {
            console.debug("[TTSEngine] persist audio failed", e);
        }
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

        s.rendering = true;
        try {
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
            const voice = voiceSelect?.value || config.DEFAULT_PIPER_VOICE;

            if (!hasUsableSpeechText(sourceText)) {
                this._markSentenceAsSilent(s);
                return;
            }

            const norm = normalizeText(sourceText);

            if (
                s.audioReady &&
                s.lastVoice === voice &&
                s.lastSpeed === state.CURRENT_SPEED &&
                typeof s.normalizedText === "string" &&
                s.normalizedText === norm
            ) {
                return;
            }

            s.normalizedText = norm;
            const cacheKey = `${voice}|${state.CURRENT_SPEED}|${norm}`;
            if (state.audioCache.has(cacheKey)) {
                const cached = state.audioCache.get(cacheKey);
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
                });
                s._restartRetryCount = 0;
                delete s._restartAttempted;
                return;
            }

            s.audioInProgress = true;
            s.audioError = null;

            this.app.eventBus.emit(EVENTS.TTS_SYNTHESIS_START, { index: idx });

            try {
                await this.buildPiperAudio(s, voice, norm);
                this.app.eventBus.emit(EVENTS.TTS_SYNTHESIS_COMPLETE, { index: idx });
            } catch (err) {
                if (this._isOfflineVoiceError(err)) {
                    s.audioError = err;
                    this.app.ui?.showInfo?.(OFFLINE_VOICE_MESSAGE);
                    this.app.eventBus.emit(EVENTS.TTS_SYNTHESIS_ERROR, { index: idx, error: err });
                    return;
                }
                s.audioError = err;
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
                        retrySentence.rendering = false;
                    }
                    if (this.app.state.generationEnabled && this.app.ttsQueue) {
                        const baseIndex =
                            Number.isFinite(state.playingSentenceIndex) && state.playingSentenceIndex >= 0
                                ? state.playingSentenceIndex
                                : state.currentSentenceIndex;
                        let priority = "normal";
                        if (idx === baseIndex) {
                            priority = "critical";
                        } else if (Number.isFinite(baseIndex) && (idx === baseIndex + 1 || idx === baseIndex + 2)) {
                            priority = "high";
                        }
                        this.app.ttsQueue.add(idx, { priority, force: true });
                        this.app.ttsQueue.run();
                    }
                } catch (resetErr) {
                    console.error("Failed to reset TTS engine:", resetErr);
                }
            }
        } finally {
            s.audioInProgress = false;
            s.rendering = false;
        }
    }

    schedulePrefetch() {
        const { state, config } = this.app;
        if (!state.generationEnabled) return;
        if (!Array.isArray(state.sentences) || !state.sentences.length) return;

        const baseIndex =
            Number.isFinite(state.playingSentenceIndex) && state.playingSentenceIndex >= 0
                ? state.playingSentenceIndex
                : state.currentSentenceIndex;
        if (!Number.isFinite(baseIndex) || baseIndex < 0) return;

        const target =
            Number.isFinite(this.PREFETCH_TARGET) && this.PREFETCH_TARGET > 0
                ? this.PREFETCH_TARGET
                : Number.isFinite(config.PREFETCH_TARGET) && config.PREFETCH_TARGET > 0
                    ? config.PREFETCH_TARGET
                    : 5;

        // Keep a rolling buffer ahead of playback; assign higher priority to the nearest sentences.
        let readyCount = 0;
        let pendingCount = 0;
        let highAssigned = 0;
        const renderCandidates = [];

        for (let i = baseIndex + 1; i < state.sentences.length && readyCount + pendingCount < target; i++) {
            const sentence = state.sentences[i];
            if (!sentence) continue;

            if (sentence.layoutProcessed && !sentence.isTextToRead) continue;

            const speechText =
                sentence.readableText && sentence.readableText.trim().length ? sentence.readableText : sentence.text;
            if (!hasUsableSpeechText(speechText)) continue;
            if (sentence.audioError) continue;

            if (sentence.audioReady && sentence.audioBuffer) {
                readyCount++;
                continue;
            }

            if (sentence.rendering || sentence.audioInProgress || sentence.prefetchQueued) {
                pendingCount++;
                renderCandidates.push(i);
                continue;
            }

            const useHigh = i <= baseIndex + 2 || highAssigned < 2;
            const priority = useHigh ? "high" : "normal";
            if (useHigh) highAssigned++;

            this.app.ttsQueue.add(i, { priority });
            this.app.prefetchSentenceTranslationForTTS?.(i);
            pendingCount++;
            renderCandidates.push(i);
        }

        if (Number.isFinite(baseIndex) && baseIndex >= 0) {
            this.app.prefetchSentenceTranslationForTTS?.(baseIndex);
        }

        if (renderCandidates.length) {
            Promise.resolve()
                .then(() => this._renderSentencesAhead(renderCandidates))
                .catch((err) => console.warn("[TTSEngine] Prefetch render failed", err));
        }

        if (pendingCount > 0) {
            this.app.ttsQueue.run();
        }
    }

    _markSentenceAsSilent(sentence) {
        if (!sentence) return;
        sentence.isTextToRead = false;
        sentence.audioReady = false;
        sentence.audioBuffer = null;
        sentence.audioError = null;
        sentence.audioInProgress = false;
        sentence.rendering = false;
        sentence.prefetchQueued = false;
        sentence.wordBoundaries = [];
    }

    async initVoices() {
        const { state, config } = this.app;
        const voiceSelect = document.getElementById("voice-select");
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

        const requestedVoiceId = this.voiceId || config.DEFAULT_PIPER_VOICE;
        const hasRequestedOption = Array.from(voiceSelect.options).some((opt) => opt.value === requestedVoiceId);
        const selectedVoiceId = hasRequestedOption
            ? requestedVoiceId
            : firstAvailableVoice || voiceSelect.options[0]?.value || config.DEFAULT_PIPER_VOICE;
        voiceSelect.value = selectedVoiceId;
        const micIcon = document.getElementById("mic-icon");
        if (micIcon) {
            micIcon.classList.remove("fa-spinner", "fa-spin");
            micIcon.classList.add("fa-microphone");
        }
    }

    async resetEngine({ clearCache = true, reason, preservePlayback = true, attempt } = {}) {
        const { state } = this.app;

        if (this._resetPromise) {
            await this._resetPromise.catch(() => { });
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
                    await this.initializingPromise.catch(() => { });
                } catch { }
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
                        sentence.rendering = false;
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
                    sentence.rendering = false;
                    sentence.lastVoice = null;
                    sentence.lastSpeed = null;
                    sentence.audioError = null;
                    sentence.prefetchQueued = false;
                    sentence.wordBoundaries = [];
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
        if (!app.pdfRenderer || !app.pdfHeaderFooterDetector) return;
        if (state.currentDocumentType && state.currentDocumentType !== "pdf") return;

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
                await app.pdfHeaderFooterDetector.ensureReadabilityForPage(pageNumber);
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
