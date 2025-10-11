import { cooperativeYield, delay, normalizeText, formatTextToSpeech } from "../utils/helpers.js";
import { EVENTS } from "../../constants/events.js";
import { PiperWorkerClient } from "./piper-client.js";

export class TTSEngine {
    constructor(app) {
        this.app = app;
        this.client = null;
        this.voice = app.config.DEFAULT_PIPER_VOICE;
        this.piperInstance = null;

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
            try {
                state.audioCtx = new (window.AudioContext || window.webkitAudioContext)(config.AUDIO_CONTEXT_OPTIONS);
            } catch {
                state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            }
        }
        if (state.audioCtx.state === "suspended") {
            try {
                await state.audioCtx.resume();
            } catch (e) {
                console.warn("Resume fail:", e);
            }
        }
        return state.audioCtx;
    }

    async ensurePiper(voiceId) {
        document.body.style.cursor = "wait";
        try {
            this.client = new PiperWorkerClient({ workerUrl: "./src/modules/tts/piper.worker.js" });
            this.voices = await this.getVoicesLists();
            if (!this.voices[voiceId]) {
                throw new Error(`Unknown voice: ${voiceId}. Available voices: ${Object.keys(this.voices).join(", ")}`);
            }
            if (this.voiceId === voiceId && this.initialized) {
                console.log(`Voice already set to ${voiceId}`);
                document.body.style.cursor = "default";
                return;
            }

            // Voice paths
            const voice = this.voices[voiceId];
            const filePaths = Object.keys(voice.files);
            const MODEL_URL = this.huggingFaceRoot + filePaths.find((f) => f.endsWith(".onnx"));
            const CONFIG_URL = this.huggingFaceRoot + filePaths.find((f) => f.endsWith(".onnx.json"));

            const modelBuffer = await getCachedModel("en_US-hfc_male-medium.onnx", MODEL_URL);
            const voiceConfig = await getCachedJSON("en_US-hfc_male-medium.onnx.json", CONFIG_URL);

            const ortJsUrl = "https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.23.0/ort.min.js";
            const ortWasmRoot = "https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.23.0/";
            const phonemizerJsUrl = "./thirdparty/piper/piper-o91UDS6e.js";
            const phonemizerWasmUrl = "./thirdparty/piper/piper_phonemize.wasm";
            const phonemizerDataUrl = "./thirdparty/piper/piper_phonemize.data";

            // Initialize Piper in the worker
            this.client
                .init({
                    modelBuffer,
                    voiceConfig,
                    ortJsUrl,
                    ortWasmRoot,
                    phonemizerJsUrl,
                    phonemizerWasmUrl,
                    phonemizerDataUrl,
                    logLevel: "error",
                    transferModel: true,
                })
                .then((instance) => {
                    this.piperInstance = instance;
                    document.body.style.cursor = "default";
                    this.initialized = true;
                });

            this.voiceId = voiceId;
        } catch (err) {
            console.error("Failed to initialize Piper:", err);
            alert("Piper init error: " + err.message);
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
        await this.ensurePiper(voice);
        await cooperativeYield();

        const wavBlob = await retryAsync(async () => {
            try {
                console.log("Synthesizing:", text);
                const cleaned = formatTextToSpeech(text);
                document.body.style.cursor = "wait";
                let result = await state.piperInstance.synthesize(cleaned, state.CURRENT_SPEED);
                document.body.style.cursor = "default";
                return result;
            } catch (e) {
                await this.ensurePiper(voice);
                throw e;
            }
        });

        const arrBuf = await wavBlob.arrayBuffer();
        const decoded = await this.safeDecodeAudioData(arrBuf.slice(0));
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
            audioBlob: config.STORE_DECODED_ONLY ? null : wavBlob,
            wavBlob: config.MAKE_WAV_COPY ? wavBlob : null,
            audioBuffer: decoded,
            wordBoundaries,
        });

        Object.assign(sentence, {
            audioBlob: config.STORE_DECODED_ONLY ? null : wavBlob,
            wavBlob: config.MAKE_WAV_COPY ? wavBlob : null,
            audioBuffer: decoded,
            audioReady: true,
            lastVoice: voice,
            lastSpeed: state.CURRENT_SPEED,
            prefetchQueued: false,
            audioError: null,
            wordBoundaries,
        });
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
            return;
        }

        s.audioInProgress = true;
        s.audioError = null;

        const icon = document.querySelector("#play-toggle span.material-symbols-outlined");
        if (icon) {
            icon.textContent = "hourglass_empty";
            icon.classList.add("animate-spin");
        }

        this.app.ui.showInfo(`Generating audio (sentence ${s.index + 1})...`);
        this.app.eventBus.emit(EVENTS.TTS_SYNTHESIS_START, { index: idx });

        try {
            await this.buildPiperAudio(s, voice, norm);
            this.app.eventBus.emit(EVENTS.TTS_SYNTHESIS_COMPLETE, { index: idx });
        } catch (err) {
            s.audioError = err;
            this.app.ui.showInfo(`TTS error (sentence ${s.index + 1})`);
            this.app.eventBus.emit(EVENTS.TTS_SYNTHESIS_ERROR, { index: idx, error: err });
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
        if (state.currentSentenceIndex >= 0) this.app.ttsQueue.add(state.currentSentenceIndex, true);
        const base = state.currentSentenceIndex;
        for (let i = base + 1; i <= base + config.PREFETCH_AHEAD && i < state.sentences.length; i++) {
            this.app.ttsQueue.add(i);
        }
    }

    async initVoices() {
        const { state, config } = this.app;
        const voiceSelect = document.getElementById("voice-select");
        if (!voiceSelect || !state.piperInstance) return;
        voiceSelect.innerHTML = "";
        const allVoices = state.piperInstance.availableVoices;
        config.PIPER_VOICES.forEach((v) => {
            const opt = document.createElement("option");
            opt.value = v;
            const lang = allVoices[v]["language"];
            const flag = this.app.helpers.regionToFlag(lang["region"]);
            const qual = this.app.helpers.capitalizeFirst(allVoices[v]["quality"]);
            const voiceName = this.app.helpers.capitalizeFirst(allVoices[v]["name"]);
            if (qual === "High") {
                opt.textContent = `${flag} ${voiceName} ${qual} - Need Fast CPU`;
            } else {
                opt.textContent = `${flag} ${voiceName} ${qual}`;
            }
            voiceSelect.appendChild(opt);
        });
        voiceSelect.value = config.DEFAULT_PIPER_VOICE;
        const micIcon = document.getElementById("mic-icon");
        if (micIcon) {
            micIcon.classList.remove("fa-spinner", "fa-spin");
            micIcon.classList.add("fa-microphone");
        }
    }
}
