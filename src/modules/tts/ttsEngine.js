import {
    getWebsiteRoot,
    cooperativeYield,
    delay,
    normalizeText,
    formatTextToSpeech,
    hasUsableSpeechText,
} from "../utils/helpers.js";
import { EVENTS } from "../../constants/events.js";
import { PiperWorkerClient } from "./piper-client.js";

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

        const scriptSrc = (document.currentScript && document.currentScript.src) || window.location.href;
        const scriptDir = scriptSrc.substring(0, scriptSrc.lastIndexOf("/"));
        const baseUrl = scriptDir.replace(/\/thirdparty\/piper$/, "");
        this.baseUrl = baseUrl;

        this.huggingFaceRoot = "https://huggingface.co/rhasspy/piper-voices/resolve/main/";
        this.initialized = false;
    }

    async getVoicesLists() {
        this.voicesUrl = "https://huggingface.co/rhasspy/piper-voices/resolve/main/voices.json";
        this.huggingFaceRoot = "https://huggingface.co/rhasspy/piper-voices/resolve/main/";
        const response = await fetch(this.voicesUrl);
        if (!response.ok) throw new Error("Failed to fetch voices.json");
        return await response.json();
    }

    async ensureAudioContext() {
        const { state, config } = this.app;
        if (!state.audioCtx) {
            state.audioCtx = new window.AudioContext(config.AUDIO_CONTEXT_OPTIONS);
        }
        // if (state.audioCtx.state === "suspended") {
        //     try {
        //         await state.audioCtx.resume();
        //     } catch (e) {
        //         console.warn("Resume fail:", e);
        //     }
        // }
        return state.audioCtx;
    }

    async ensurePiper(voiceId) {
        const { state, config } = this.app;
        const targetVoiceId = voiceId || config.DEFAULT_PIPER_VOICE;

        if (this.initialized && this.voiceId === targetVoiceId && state.piperInstance) {
            return state.piperInstance;
        }

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
            this.initializingPromise = null;
        }
    }

    async _initializeVoice(voiceId) {
        const { state } = this.app;
        const icon = document.querySelector("#play-toggle span.material-symbols-outlined");

        if (icon) {
            icon.textContent = "hourglass_empty";
            icon.classList.add("animate-spin");
        }

        document.body.style.cursor = "wait";

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

            const modelBuffer = await getCachedModel(modelFile, MODEL_URL);
            const voiceConfig = await getCachedJSON(configFile, CONFIG_URL);

            const baseUrl = getWebsiteRoot();
            const ortJsUrl = `${baseUrl}thirdparty/ort/ort.js`;
            const ortWasmRoot = `${baseUrl}thirdparty/ort/`;
            const phonemizerJsUrl = `${baseUrl}thirdparty/piper/piper-o91UDS6e.js`;
            const phonemizerWasmUrl = `${baseUrl}thirdparty/piper/piper_phonemize.wasm`;
            const phonemizerDataUrl = `${baseUrl}thirdparty/piper/piper_phonemize.data`;

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
            console.error("Failed to initialize Piper:", err);
            alert("Piper init error: " + err.message);
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
            if (icon) {
                icon.textContent = this.app.state.isPlaying ? "pause" : "play_arrow";
                icon.classList.remove("animate-spin");
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
            } catch {}
            state.audioCtx = null;
            await this.ensureAudioContext();
            return state.audioCtx.decodeAudioData(arrayBuffer.slice(0));
        }
    }

    async buildPiperAudio(sentence, voice, text) {
        const { state, config } = this.app;

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
        const voiceSelect = document.getElementById("voice-select");
        const voice = voiceSelect?.value || config.DEFAULT_PIPER_VOICE;
        if (s.audioReady && s.lastVoice === voice && s.lastSpeed === state.CURRENT_SPEED) return;
        if (s.audioInProgress) return;

        const sourceText = s.readableText && s.readableText.trim().length ? s.readableText : s.text;
        if (!sourceText || !sourceText.trim().length) {
            s.audioError = new Error("No readable text available for synthesis");
            return;
        }

        if (!hasUsableSpeechText(sourceText)) {
            this._markSentenceAsSilent(s);
            return;
        }

        const norm = normalizeText(sourceText);
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
            delete s._restartAttempted;
            return;
        }

        s.audioInProgress = true;
        s.audioError = null;

        const icon = document.querySelector("#play-toggle span.material-symbols-outlined");
        if (icon) {
            icon.textContent = "hourglass_empty";
            icon.classList.add("animate-spin");
        }

        this.app.eventBus.emit(EVENTS.TTS_SYNTHESIS_START, { index: idx });

        try {
            await this.buildPiperAudio(s, voice, norm);
            this.app.eventBus.emit(EVENTS.TTS_SYNTHESIS_COMPLETE, { index: idx });
        } catch (err) {
            s.audioError = err;
            this.app.ui.showInfo(`TTS error, resetting engine for ${err.message}`);
            this.app.eventBus.emit(EVENTS.TTS_SYNTHESIS_ERROR, { index: idx, error: err });
            try {
                if (!s._restartAttempted) {
                    s._restartAttempted = true;
                    await this.resetEngine({ clearCache: true, reason: err.message });
                    const retrySentence = this.app.state.sentences[idx];
                    if (retrySentence) {
                        retrySentence.audioError = null;
                        retrySentence.audioInProgress = false;
                    }
                    if (this.app.state.generationEnabled && this.app.ttsQueue) {
                        this.app.ttsQueue.add(idx, true);
                        this.app.ttsQueue.run();
                    }
                }
            } catch (resetErr) {
                console.error("Failed to reset TTS engine:", resetErr);
            }
        } finally {
            s.audioInProgress = false;
            if (icon) {
                icon.textContent = this.app.state.isPlaying ? "pause" : "play_arrow";
                icon.classList.remove("animate-spin");
            }
        }
    }

    schedulePrefetch() {
        const { state, config } = this.app;
        if (!state.generationEnabled) return;
        const indices = [];
        if (state.currentSentenceIndex >= 0) {
            this.app.ttsQueue.add(state.currentSentenceIndex, true);
            indices.push(state.currentSentenceIndex);
        }
        const base = state.currentSentenceIndex;
        for (let i = base + 1; i <= base + config.PREFETCH_AHEAD && i < state.sentences.length; i++) {
            this.app.ttsQueue.add(i);
            indices.push(i);
        }

        if (indices.length) {
            Promise.resolve()
                .then(() => this._renderSentencesAhead(indices))
                .catch((err) => console.warn("[TTSEngine] Prefetch render failed", err));
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

    async resetEngine({ clearCache = true, reason } = {}) {
        const { state } = this.app;
        console.warn("Restarting TTS engine", reason || "");

        if (this.app.audioManager?.stopPlayback) {
            try {
                await this.app.audioManager.stopPlayback(false);
            } catch (err) {
                console.warn("stopPlayback during reset failed:", err);
            }
        }

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

        if (state.audioCtx) {
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
        state.stopRequested = false;

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
                delete sentence._restartAttempted;
            }
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
