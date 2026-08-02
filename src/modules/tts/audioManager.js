import { delay, waitFor, hasUsableSpeechText } from "../utils/helpers.js";
import { EVENTS } from "../../constants/events.js";

export class AudioManager {
    constructor(app) {
        this.app = app;
        this._playPromise = null;
        this._playbackContext = null;
        this._playbackContextId = 0;
        this._playbackBlocks = new Set();
        this._mediaBridgeAudio = null;
        this._mediaBridgeObjectUrl = null;
        this._mediaBridgeSyncing = false;
        this._waitingForAudioNoticeKey = null;
        this._setupMediaBridge();
        this._setupMediaSession();
    }

    async playCurrentSentence() {
        const { state } = this.app;
        if (this._playbackBlocks.size) {
            return;
        }
        if (state.isPlaying) {
            return;
        }

        const context = {
            id: this._playbackContextId++,
            sentenceIndex: state.currentSentenceIndex,
            continuesReading: !!state.autoAdvanceActive,
        };
        this._beginPlaybackPreparationForStart(context);
        state.stopRequested = false;

        this._playbackContext = context;
        this._clearWaitingForAudio();

        const playPromise = this._playCurrentSentence(context);
        const trackedPromise = playPromise.finally(() => {
            if (this._playPromise === trackedPromise) {
                this._playPromise = null;
            }
            if (!state.isPlaying && this._isContextActive(context)) {
                this.app.ui.finishPlaybackPreparation();
            }
        });
        this._playPromise = trackedPromise;
        return this._playPromise;
    }

    async _playEPUBSentence(context) {
        const { config, state } = this.app;

        await this.app.epubLoader.ensureLayoutFilteringReady();
        if (!this._isContextActive(context)) return;

        if (!state.sentences.length) {
            this.app.ui.showInfo("No readable sentences available in EPUB.");
            return;
        }

        if (state.currentSentenceIndex < 0) {
            await this.app.pdfRenderer.renderSentence(0, { suppressScroll: true });
            if (!this._isContextActive(context)) return;
        }

        let sentence = state.currentSentence || state.sentences[state.currentSentenceIndex];
        if (!sentence) {
            this.app.ui.showInfo("No readable sentences available.");
            return;
        }

        const ensuredSentence = await this._ensureSentenceHasSpeech(sentence);
        if (!this._isContextActive(context)) return;
        if (!ensuredSentence) {
            this.app.ui.showInfo("No readable sentences available.");
            return;
        }

        sentence = ensuredSentence;
        context.sentenceIndex = state.currentSentenceIndex;

        await this.app.ttsEngine.ensureAudioContext();
        if (!this._isContextActive(context)) return;

        if (!state.generationEnabled) {
            state.generationEnabled = true;
        }

        let attempts = 0;
        while ((!sentence.audioReady || !sentence.audioBuffer) && !sentence.audioError) {
            if (!this._isContextActive(context)) return;
            if (attempts === 0) {
                this.app.ttsQueue.add(state.currentSentenceIndex, true);
                this.app.ttsQueue.run();
            }
            this._showWaitingForAudio(sentence);
            attempts += 1;
            try {
                await waitFor(() => sentence.audioReady || sentence.audioError, 5000);
            } catch {}
            if (!this._isContextActive(context)) return;
            if (sentence.audioReady && sentence.audioBuffer) break;
            if (sentence.audioError || state.stopRequested || attempts >= 3) {
                break;
            }
        }

        if (!sentence.audioReady || sentence.audioError || !sentence.audioBuffer) {
            this._clearWaitingForAudio();
            if (!sentence.audioError && !state.stopRequested && this._isContextActive(context)) {
                await delay(300);
                if (this._isContextActive(context) && !state.stopRequested) {
                    return this._playCurrentSentence(context);
                }
            }
            return;
        }

        if (!this._isContextActive(context)) return;

        await this.stopPlayback(false, { clearContext: false, emitEvent: false });
        if (!this._isContextActive(context)) return;

        state.stopRequested = false;

        let shouldRetry = false;
        try {
            const audioCtx = state.audioCtx;
            if (!audioCtx) {
                throw new Error("Audio context not ready");
            }

            const source = audioCtx.createBufferSource();
            const gain = audioCtx.createGain();

            source.buffer = sentence.audioBuffer;
            gain.gain.setValueAtTime(config.MIN_GAIN, audioCtx.currentTime);
            source.connect(gain).connect(audioCtx.destination);
            gain.gain.exponentialRampToValueAtTime(1.0, audioCtx.currentTime + config.FADE_IN_SEC);

            state.currentSource = source;
            state.currentGain = gain;
            state.playingSentenceIndex = state.currentSentenceIndex;

            this.setupWordBoundaryTimers(sentence);

            source.onended = () => {
                this._handleSourceEnded(context, sentence);
            };

            await delay(10);
            if (!this._isContextActive(context) || state.stopRequested) {
                source.onended = null;
                try {
                    source.stop();
                } catch {}
                state.playingSentenceIndex = -1;
                state.playingPhraseBlockKey = null;
                return;
            }

            source.start();
            this.app.finishBookOpenPlaybackTimer?.({ sentenceIndex: state.currentSentenceIndex });
            this._clearWaitingForAudio();
            state.isPlaying = true;
            state.autoAdvanceActive = true;
            state.playingSentenceIndex = state.currentSentenceIndex;
            await this._activateMediaBridge(sentence);
            this._finishPlaybackPreparationForStart(context);
            this.app.ui.updatePlayButton(state.playerState.PLAY);
            this.app.eventBus.emit(EVENTS.AUDIO_PLAYBACK_START, { index: state.currentSentenceIndex });
            if (!state.stopRequested && this._isContextActive(context)) {
                this.app.ttsEngine.schedulePrefetch();
            }
        } catch (err) {
            console.error("Playback error:", err);
            if (this._isContextActive(context)) {
                this.app.ui.showInfo("Playback error; resetting context.");
            }
            try {
                if (state.audioCtx) await state.audioCtx.close();
            } catch {}
            state.audioCtx = null;
            shouldRetry = !state.stopRequested && this._isContextActive(context);
        } finally {
            if (shouldRetry) {
                await delay(200);
                if (this._isContextActive(context) && !state.stopRequested) {
                    return this._playCurrentSentence(context);
                }
            }
        }
    }

    async _playPDFSentence(context) {
        const { config, state } = this.app;
        try {
            await this.app.pdfLoader.ensureLayoutFilteringReady();
        } catch (err) {
            console.error("Layout preparation failed:", err);
            if (this._isContextActive(context)) {
                this.app.ui.showInfo("❌ Layout analysis failed. Cannot start playback.");
            }
            return;
        }
        if (!this._isContextActive(context)) return;

        state.stopRequested = false;
        this.app.ui.updatePlaybackPreparation("Phrases are ready. Preparing speech…");

        let sentence = state.currentSentence;
        if (!sentence) {
            this.app.ui.showInfo("No readable sentences available.");
            return;
        }

        if (!sentence.isTextToRead) {
            this.app.ui.showInfo("Selected sentence is outside readable layout regions.");
            return;
        }

        const ensuredSentence = await this._ensureSentenceHasSpeech(sentence);
        if (!this._isContextActive(context)) return;
        if (!ensuredSentence) {
            this.app.ui.showInfo("No readable sentences available.");
            return;
        }

        sentence = ensuredSentence;
        context.sentenceIndex = state.currentSentenceIndex;

        await this.app.ttsEngine.ensureAudioContext();
        if (!this._isContextActive(context)) return;

        if (!state.generationEnabled) {
            state.generationEnabled = true;
        }

        let attempts = 0;
        while ((!sentence.audioReady || !sentence.audioBuffer) && !sentence.audioError) {
            if (!this._isContextActive(context)) return;
            if (attempts === 0) {
                this.app.ttsQueue.add(state.currentSentenceIndex, true);
                this.app.ttsQueue.run();
            }
            this._showWaitingForAudio(sentence);
            attempts += 1;
            try {
                await waitFor(() => sentence.audioReady || sentence.audioError, 5000);
            } catch {}
            if (!this._isContextActive(context)) return;
            if (sentence.audioReady && sentence.audioBuffer) break;
            if (sentence.audioError || state.stopRequested || attempts >= 3) {
                break;
            }
        }

        if (!sentence.audioReady || sentence.audioError || !sentence.audioBuffer) {
            this._clearWaitingForAudio();
            if (!sentence.audioError && !state.stopRequested && this._isContextActive(context)) {
                await delay(300);
                if (this._isContextActive(context) && !state.stopRequested) {
                    return this._playCurrentSentence(context);
                }
            }
            return;
        }

        if (!this._isContextActive(context)) return;

        this._updatePlaybackPreparationForStart(context);
        await this.stopPlayback(false, { clearContext: false, emitEvent: false });
        if (!this._isContextActive(context)) return;

        state.stopRequested = false;

        let shouldRetry = false;
        try {
            const audioCtx = state.audioCtx;
            if (!audioCtx) {
                throw new Error("Audio context not ready");
            }

            const source = audioCtx.createBufferSource();
            const gain = audioCtx.createGain();

            source.buffer = sentence.audioBuffer;
            gain.gain.setValueAtTime(config.MIN_GAIN, audioCtx.currentTime);
            source.connect(gain).connect(audioCtx.destination);
            gain.gain.exponentialRampToValueAtTime(1.0, audioCtx.currentTime + config.FADE_IN_SEC);

            state.currentSource = source;
            state.currentGain = gain;
            state.playingSentenceIndex = state.currentSentenceIndex;

            this.setupWordBoundaryTimers(sentence);

            source.onended = () => {
                this._handleSourceEnded(context, sentence);
            };

            await delay(10);
            if (!this._isContextActive(context) || state.stopRequested) {
                source.onended = null;
                try {
                    source.stop();
                } catch {}
                state.playingSentenceIndex = -1;
                state.playingPhraseBlockKey = null;
                return;
            }

            source.start();
            this.app.finishBookOpenPlaybackTimer?.({ sentenceIndex: state.currentSentenceIndex });
            this._clearWaitingForAudio();
            state.isPlaying = true;
            state.autoAdvanceActive = true;
            state.playingSentenceIndex = state.currentSentenceIndex;
            await this._activateMediaBridge(sentence);
            this.app.pdfRenderer.updateHighlightFullDoc();
            this._finishPlaybackPreparationForStart(context);
            this.app.ui.updatePlayButton(state.playerState.PLAY);
            this.app.eventBus.emit(EVENTS.AUDIO_PLAYBACK_START, { index: state.currentSentenceIndex });
            if (!state.stopRequested && this._isContextActive(context)) {
                this.app.ttsEngine.schedulePrefetch();
            }
        } catch (err) {
            console.error("Playback error:", err);
            if (this._isContextActive(context)) {
                this.app.ui.showInfo("Playback error; resetting context.");
            }
            try {
                if (state.audioCtx) await state.audioCtx.close();
            } catch {}
            state.audioCtx = null;
            shouldRetry = !state.stopRequested && this._isContextActive(context);
        } finally {
            if (shouldRetry) {
                await delay(200);
                if (this._isContextActive(context) && !state.stopRequested) {
                    return this._playCurrentSentence(context);
                }
            }
        }
    }

    async _playCurrentSentence(context) {
        const { ui, state } = this.app;

        if (!this._isContextActive(context)) return;

        if (!state.pdf && !state.epub) {
            ui.showInfo("Load a document before playing.");
            return;
        }

        try {
            if (state.currentDocumentType === "pdf") {
                await this._playPDFSentence(context);
            } else if (state.currentDocumentType === "epub") {
                await this._playEPUBSentence(context);
            }
        } catch (err) {
            console.error("Playback error:", err);
            if (this._isContextActive(context)) {
                ui.showInfo("Playback error; resetting context.");
            }
            try {
                if (state.audioCtx) await state.audioCtx.close();
            } catch {}
            state.audioCtx = null;
        }
    }

    _finishPlaybackPreparationForStart(context) {
        this.app.ui.finishPlaybackPreparation(context?.continuesReading ? "" : "Reading started.");
    }

    _beginPlaybackPreparationForStart(context) {
        if (context?.continuesReading) return;
        const documentType = this.app.state.currentDocumentType;
        this.app.ui.beginPlaybackPreparation(
            documentType === "pdf" ? "Checking page layout…" : "Preparing the text for reading…",
        );
    }

    _updatePlaybackPreparationForStart(context) {
        if (!context?.continuesReading) {
            this.app.ui.updatePlaybackPreparation("Starting reading…");
        }
    }

    async stopPlayback(fade = true, options = {}) {
        const { state, config } = this.app;
        const { clearContext = true, emitEvent = true } = options;

        state.stopRequested = true;

        const source = state.currentSource;
        const gain = state.currentGain;
        const audioCtx = state.audioCtx;

        if (source) {
            try {
                source.onended = null;
            } catch {}
        }

        if (source && audioCtx) {
            try {
                if (fade && gain && audioCtx.state === "running" && config.FADE_OUT_SEC > 0) {
                    const fadeDuration = Math.max(config.FADE_OUT_SEC, 0.01);
                    const now = audioCtx.currentTime;
                    const currentValue = Math.max(config.MIN_GAIN, gain.gain.value || config.MIN_GAIN);
                    gain.gain.cancelScheduledValues(now);
                    gain.gain.setValueAtTime(currentValue, now);
                    gain.gain.linearRampToValueAtTime(config.MIN_GAIN, now + fadeDuration);

                    const stopDelay = fadeDuration * 1000 + 10;
                    setTimeout(() => {
                        try {
                            source.stop();
                        } catch {}
                        try {
                            source.disconnect();
                        } catch {}
                        if (gain) {
                            try {
                                gain.disconnect();
                            } catch {}
                        }
                    }, stopDelay);
                } else {
                    try {
                        source.stop();
                    } catch {}
                    try {
                        source.disconnect();
                    } catch {}
                    if (gain) {
                        try {
                            gain.disconnect();
                        } catch {}
                    }
                }
            } catch (e) {
                console.warn("Stop error:", e);
            }
        }

        state.currentSource = null;
        state.currentGain = null;
        state.isPlaying = false;
        state.autoAdvanceActive = false;
        state.playingSentenceIndex = -1;
        state.playingPhraseBlockKey = null;
        this._clearWaitingForAudio();
        this._pauseMediaBridge();

        const currentSentence = state.currentSentence;
        if (currentSentence) this.clearWordBoundaryTimers(currentSentence);
        this.app.pdfRenderer.updateHighlightFullDoc();
        this._setMediaSessionPlaybackState("paused");
        if (emitEvent) {
            this.app.eventBus.emit(EVENTS.AUDIO_PLAYBACK_PAUSE, { index: state.currentSentenceIndex });
        }

        if (clearContext) {
            this._playbackContext = null;
        }
    }

    async addPlaybackBlock(reason, fade = false) {
        this._playbackBlocks.add(String(reason || "unspecified"));
        await this.stopPlayback(fade);
    }

    removePlaybackBlock(reason) {
        this._playbackBlocks.delete(String(reason || "unspecified"));
    }

    togglePlay() {
        const { state } = this.app;
        if (state.isPlaying) {
            this.stopPlayback(true);
            state.autoAdvanceActive = false;
            this.app.ui.updatePlayButton(state.playerState.PAUSE);
        } else {
            this.playCurrentSentence().catch((error) => {
                console.error("Unable to start playback:", error);
                this.app.ui.finishPlaybackPreparation();
            });
        }
    }

    async _ensureSentenceHasSpeech(sentence) {
        const { state } = this.app;
        if (!sentence) return null;

        let current = sentence;
        let attempts = 0;
        const limit = state.sentences.length || 0;

        while (current && attempts < limit) {
            if (current.isTextToRead && hasUsableSpeechText(this._extractSpeechText(current))) {
                return current;
            }

            if (current.isTextToRead) {
                this._markSentenceAsSilent(current);
            }

            const nextIndex = state.currentSentenceIndex + 1;
            if (nextIndex >= state.sentences.length) {
                return null;
            }

            await this.app.pdfRenderer.renderSentence(nextIndex, { autoAdvance: true });
            current = state.currentSentence;
            attempts += 1;
        }

        return null;
    }

    _extractSpeechText(sentence) {
        if (!sentence) return "";
        if (sentence.readableText && sentence.readableText.trim()) return sentence.readableText;
        if (sentence.text && sentence.text.trim()) return sentence.text;
        return "";
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

    _showWaitingForAudio(sentence) {
        const { state } = this.app;
        const sentenceIndex = Number.isFinite(sentence?.index) ? sentence.index : state.currentSentenceIndex;
        const key = `${state.currentDocumentType || "doc"}:${sentenceIndex}`;

        this.app.ui.updatePlayButton(state.playerState.LOADING);
        if (this._waitingForAudioNoticeKey === key) return;

        this._waitingForAudioNoticeKey = key;
        const friendlyPosition = Number.isFinite(sentenceIndex) && sentenceIndex >= 0 ? sentenceIndex + 1 : null;
        const prefix = state.autoAdvanceActive ? "Generating speech for the next phrase" : "Generating speech";
        const suffix = friendlyPosition ? ` (${friendlyPosition}/${state.sentences.length})` : "";
        const message = `${prefix}${suffix}… Long passages can take a moment.`;
        if (this.app.ui.playbackPreparationActive) {
            this.app.ui.updatePlaybackPreparation(message);
        } else {
            this.app.ui.showMessage(message, 4500);
        }
    }

    _clearWaitingForAudio() {
        this._waitingForAudioNoticeKey = null;
    }

    _isContextActive(context) {
        return !!(context && this._playbackContext && context.id === this._playbackContext.id);
    }

    _invalidateContext(context) {
        if (context && this._playbackContext && context.id === this._playbackContext.id) {
            this._playbackContext = null;
        }
    }

    async _handleSourceEnded(context, sentence) {
        const { state } = this.app;
        const finishedIndex =
            typeof context?.sentenceIndex === "number" ? context.sentenceIndex : state.currentSentenceIndex;

        if (!this._isContextActive(context)) {
            return;
        }

        this.clearWordBoundaryTimers(sentence);

        if (state.stopRequested) {
            this._invalidateContext(context);
            return;
        }

        if (state.autoHighlightEnabled) {
            this.app.highlightManager.saveCurrentSentenceHighlight();
        }

        state.isPlaying = false;
        state.playingSentenceIndex = -1;
        state.playingPhraseBlockKey = null;
        this._pauseMediaBridge();
        this.app.pdfRenderer.updateHighlightFullDoc();

        const hasNextSentence =
            typeof finishedIndex === "number" && finishedIndex >= 0 && finishedIndex < state.sentences.length - 1;

        if (!state.autoAdvanceActive || !hasNextSentence) {
            state.autoAdvanceActive = false;
            this._invalidateContext(context);
            this._setMediaSessionPlaybackState("paused");
            this.app.eventBus.emit(EVENTS.AUDIO_PLAYBACK_END, { index: state.currentSentenceIndex });
            return;
        }

        await delay(120);
        if (!this._isContextActive(context) || state.stopRequested) {
            state.autoAdvanceActive = false;
            this._invalidateContext(context);
            this._setMediaSessionPlaybackState("paused");
            this.app.eventBus.emit(EVENTS.AUDIO_PLAYBACK_END, { index: state.currentSentenceIndex });
            return;
        }

        try {
            await this.app.pdfRenderer.renderSentence(finishedIndex + 1, { autoAdvance: true });
        } catch (err) {
            console.warn("Auto-advance render failed", err);
            state.autoAdvanceActive = false;
            this._invalidateContext(context);
            this._setMediaSessionPlaybackState("paused");
            this.app.eventBus.emit(EVENTS.AUDIO_PLAYBACK_END, { index: state.currentSentenceIndex });
            return;
        }

        // A reward interval may finish at the same time as this sentence. Wait
        // for that completion to be persisted and, when required, block TTS and
        // open the reflection dialog before starting the following sentence.
        await this.app.rewards?.handleReadingBoundary?.();

        const nextSentence = state.sentences[state.currentSentenceIndex];
        this._invalidateContext(context);
        if (!state.generationEnabled || nextSentence?.isTextToRead) {
            await this.playCurrentSentence();
        }
        this.app.eventBus.emit(EVENTS.AUDIO_PLAYBACK_END, { index: state.currentSentenceIndex });
    }

    _setupMediaBridge() {
        if (typeof document === "undefined") return;

        const audio = document.createElement("audio");
        audio.id = "localreader-media-bridge";
        audio.preload = "auto";
        audio.setAttribute("aria-hidden", "true");
        audio.tabIndex = -1;
        audio.controls = false;
        audio.volume = 0;
        audio.style.display = "none";

        audio.addEventListener("play", () => {
            if (this._mediaBridgeSyncing || this.app.state.isPlaying) return;
            this.playCurrentSentence().catch((error) => {
                console.warn("[MediaBridge] Failed to resume playback", error);
            });
        });

        audio.addEventListener("pause", () => {
            if (this._mediaBridgeSyncing || !this.app.state.isPlaying) return;
            this.stopPlayback(true).catch((error) => {
                console.warn("[MediaBridge] Failed to pause playback", error);
            });
        });

        document.body?.appendChild(audio);
        this._mediaBridgeAudio = audio;
    }

    _setupMediaSession() {
        if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
        const setHandler = (action, handler) => {
            try {
                navigator.mediaSession.setActionHandler(action, handler);
            } catch {
                // Some browsers expose a partial Media Session implementation.
            }
        };

        setHandler("play", () => {
            this.playCurrentSentence().catch((error) => console.warn("[MediaSession] play failed", error));
        });
        setHandler("pause", () => {
            this.stopPlayback(true).catch((error) => console.warn("[MediaSession] pause failed", error));
        });
        setHandler("stop", () => {
            this.stopPlayback(true).catch((error) => console.warn("[MediaSession] stop failed", error));
        });
        setHandler("previoustrack", () => {
            this._skipSentenceFromMediaControl(-1).catch((error) => {
                console.warn("[MediaSession] previous failed", error);
            });
        });
        setHandler("nexttrack", () => {
            this._skipSentenceFromMediaControl(1).catch((error) => {
                console.warn("[MediaSession] next failed", error);
            });
        });
        setHandler("seekbackward", () => {
            this._skipSentenceFromMediaControl(-1).catch((error) => {
                console.warn("[MediaSession] seek backward failed", error);
            });
        });
        setHandler("seekforward", () => {
            this._skipSentenceFromMediaControl(1).catch((error) => {
                console.warn("[MediaSession] seek forward failed", error);
            });
        });
    }

    async _skipSentenceFromMediaControl(delta) {
        const { state } = this.app;
        if (!state?.sentences?.length) return;

        const wasPlaying = !!state.isPlaying || !!state.autoAdvanceActive;
        const nextIndex = Math.min(Math.max((state.currentSentenceIndex || 0) + delta, 0), state.sentences.length - 1);
        if (nextIndex === state.currentSentenceIndex) return;

        await this.stopPlayback(true);
        state.autoAdvanceActive = false;
        const renderer = this.app.getActiveRenderer?.();
        await renderer?.renderSentence?.(nextIndex);
        if (wasPlaying) await this.playCurrentSentence();
    }

    async _activateMediaBridge(sentence) {
        const audio = this._mediaBridgeAudio;
        if (!audio || !sentence?.audioBuffer) return;

        const blob = sentence.audioBlob || sentence.wavBlob || this._audioBufferToWavBlob(sentence.audioBuffer);
        if (!blob) return;

        this._setMediaSessionMetadata(sentence);
        this._setMediaSessionPlaybackState("playing");

        this._mediaBridgeSyncing = true;
        try {
            if (this._mediaBridgeObjectUrl) {
                URL.revokeObjectURL(this._mediaBridgeObjectUrl);
                this._mediaBridgeObjectUrl = null;
            }

            this._mediaBridgeObjectUrl = URL.createObjectURL(blob);
            audio.src = this._mediaBridgeObjectUrl;
            audio.currentTime = 0;
            audio.volume = 0;
            await audio.play().catch(() => {});
        } finally {
            this._mediaBridgeSyncing = false;
        }
    }

    _pauseMediaBridge() {
        const audio = this._mediaBridgeAudio;
        if (!audio) return;

        this._mediaBridgeSyncing = true;
        try {
            audio.pause();
            audio.currentTime = 0;
        } catch {
            // ignore
        } finally {
            this._mediaBridgeSyncing = false;
        }
    }

    _setMediaSessionMetadata(sentence) {
        if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
        const { state } = this.app;
        const sentenceNumber = Number.isFinite(state?.currentSentenceIndex) ? state.currentSentenceIndex + 1 : null;
        const title = sentenceNumber ? `Sentence ${sentenceNumber}` : "Current sentence";
        const artworkSrc =
            typeof state?.bookCoverDataUrl === "string" && state.bookCoverDataUrl.startsWith("data:")
                ? state.bookCoverDataUrl
                : "./assets/icons/icon-512.png";

        try {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: "PocketReader",
                artist: "PocketReader",
                album: "Document Reader",
                artwork: [
                    {
                        src: artworkSrc,
                        sizes: "512x512",
                        type: artworkSrc.startsWith("data:") ? "image/*" : "image/png",
                    },
                ],
            });
        } catch {
            // ignore
        }
    }

    _setMediaSessionPlaybackState(value) {
        if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
        try {
            navigator.mediaSession.playbackState = value;
        } catch {
            // ignore
        }
    }

    _audioBufferToWavBlob(audioBuffer) {
        if (!audioBuffer) return null;

        const numChannels = audioBuffer.numberOfChannels || 1;
        const sampleRate = audioBuffer.sampleRate;
        const length = audioBuffer.length;
        const bytesPerSample = 2;
        const blockAlign = numChannels * bytesPerSample;
        const dataSize = length * blockAlign;
        const buffer = new ArrayBuffer(44 + dataSize);
        const view = new DataView(buffer);

        const writeString = (offset, value) => {
            for (let i = 0; i < value.length; i++) {
                view.setUint8(offset + i, value.charCodeAt(i));
            }
        };

        writeString(0, "RIFF");
        view.setUint32(4, 36 + dataSize, true);
        writeString(8, "WAVE");
        writeString(12, "fmt ");
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * blockAlign, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, bytesPerSample * 8, true);
        writeString(36, "data");
        view.setUint32(40, dataSize, true);

        let offset = 44;
        const channels = Array.from({ length: numChannels }, (_, index) => audioBuffer.getChannelData(index));
        for (let i = 0; i < length; i++) {
            for (let channel = 0; channel < numChannels; channel++) {
                const sample = Math.max(-1, Math.min(1, channels[channel][i] || 0));
                view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
                offset += bytesPerSample;
            }
        }

        return new Blob([buffer], { type: "audio/wav" });
    }

    setupWordBoundaryTimers(s) {
        const { state, config } = this.app;
        this.clearWordBoundaryTimers(s);
        if (!Array.isArray(s.playbackWordTimers)) {
            s.playbackWordTimers = [];
        }

        const phraseTimings = Array.isArray(s.ttsPhraseTimings) ? s.ttsPhraseTimings : [];
        if (state.currentDocumentType === "pdf" && phraseTimings.length > 1) {
            const setCurrentPhrase = (blockKey) => {
                state.playingPhraseBlockKey = blockKey || null;
                this.app.pdfRenderer?.updateHighlightFullDoc?.();
                this.app.eventBus?.emit?.(EVENTS.AUDIO_PHRASE_CHANGE, {
                    index: s.index ?? state.currentSentenceIndex,
                    blockKey: state.playingPhraseBlockKey,
                });
            };

            setCurrentPhrase(phraseTimings[0]?.blockKey || null);
            for (let i = 1; i < phraseTimings.length; i++) {
                const timing = phraseTimings[i];
                const id = setTimeout(
                    () => {
                        setCurrentPhrase(timing?.blockKey || null);
                    },
                    Math.max(0, timing?.offsetMs || 0),
                );
                s.playbackWordTimers.push(id);
            }
        } else {
            state.playingPhraseBlockKey = null;
        }

        if (!config.ENABLE_WORD_HIGHLIGHT || !s.wordBoundaries?.length) return;
        const liveWord = document.getElementById(config.LIVE_WORD_REGION_ID);
        for (const wb of s.wordBoundaries) {
            const id = setTimeout(() => {
                if (liveWord) liveWord.textContent = wb.text;
            }, wb.offsetMs);
            s.playbackWordTimers.push(id);
        }
    }
    clearWordBoundaryTimers(s) {
        if (!Array.isArray(s?.playbackWordTimers)) {
            if (s) s.playbackWordTimers = [];
            return;
        }
        for (const t of s.playbackWordTimers) clearTimeout(t);
        s.playbackWordTimers = [];
        if (this.app.state.playingSentenceIndex === s.index) {
            this.app.state.playingPhraseBlockKey = null;
        }
    }
}
