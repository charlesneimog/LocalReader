import { delay, waitFor, hasUsableSpeechText } from "../utils/helpers.js";
import { EVENTS } from "../../constants/events.js";

export class AudioManager {
    constructor(app) {
        this.app = app;
        this._playPromise = null;
        this._playbackContext = null;
        this._playbackContextId = 0;
    }

    updatePlayButton() {
        const icon = document.querySelector("#play-toggle span.material-symbols-outlined");
        if (!icon) return;

        if (this.app.state.autoAdvanceActive) {
            icon.textContent = "pause";
        } else {
            icon.textContent = this.app.state.isPlaying ? "pause" : "play_arrow";
        }
    }

    async playCurrentSentence() {
        const { state } = this.app;
        if (state.isPlaying) {
            return;
        }

        const context = {
            id: ++this._playbackContextId,
            sentenceIndex: state.currentSentenceIndex,
        };
        this._playbackContext = context;

        const playPromise = this._playCurrentSentence(context);
        this._playPromise = playPromise.finally(() => {
            if (this._playPromise === playPromise) {
                this._playPromise = null;
            }
        });
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

        const icon = document.querySelector("#play-toggle span.material-symbols-outlined");
        let attempts = 0;
        while ((!sentence.audioReady || !sentence.audioBuffer) && !sentence.audioError) {
            if (!this._isContextActive(context)) return;
            if (icon) {
                icon.textContent = "hourglass_empty";
                icon.classList.add("animate-spin");
            }
            if (attempts === 0) {
                this.app.ttsQueue.add(state.currentSentenceIndex, true);
                this.app.ttsQueue.run();
            }
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
            if (icon) {
                icon.textContent = this.app.state.isPlaying ? "pause" : "play_arrow";
                icon.classList.remove("animate-spin");
            }
            if (!sentence.audioError && !state.stopRequested && this._isContextActive(context)) {
                await delay(300);
                if (this._isContextActive(context) && !state.stopRequested) {
                    return this._playCurrentSentence(context);
                }
            }
            return;
        }

        if (!this._isContextActive(context)) return;

        if (icon) {
            icon.textContent = this.app.state.isPlaying ? "pause" : "play_arrow";
            icon.classList.remove("animate-spin");
        }

        this.app.ttsEngine.schedulePrefetch();
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
                return;
            }

            source.start();
            state.isPlaying = true;
            state.autoAdvanceActive = true;
            state.playingSentenceIndex = state.currentSentenceIndex;
            this.updatePlayButton();
            // this.app.pdfRenderer.updateHighlightFullDoc();
            this.app.eventBus.emit(EVENTS.AUDIO_PLAYBACK_START, { index: state.currentSentenceIndex });
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

        const icon = document.querySelector("#play-toggle span.material-symbols-outlined");
        let attempts = 0;
        while ((!sentence.audioReady || !sentence.audioBuffer) && !sentence.audioError) {
            if (!this._isContextActive(context)) return;
            if (icon) {
                icon.textContent = "hourglass_empty";
                icon.classList.add("animate-spin");
            }
            if (attempts === 0) {
                this.app.ttsQueue.add(state.currentSentenceIndex, true);
                this.app.ttsQueue.run();
            }
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
            if (icon) {
                icon.textContent = this.app.state.isPlaying ? "pause" : "play_arrow";
                icon.classList.remove("animate-spin");
            }
            if (!sentence.audioError && !state.stopRequested && this._isContextActive(context)) {
                await delay(300);
                if (this._isContextActive(context) && !state.stopRequested) {
                    return this._playCurrentSentence(context);
                }
            }
            return;
        }

        if (!this._isContextActive(context)) return;

        if (icon) {
            icon.textContent = this.app.state.isPlaying ? "pause" : "play_arrow";
            icon.classList.remove("animate-spin");
        }

        this.app.ttsEngine.schedulePrefetch();
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
                return;
            }

            source.start();
            state.isPlaying = true;
            state.autoAdvanceActive = true;
            state.playingSentenceIndex = state.currentSentenceIndex;
            this.updatePlayButton();
            this.app.pdfRenderer.updateHighlightFullDoc();
            this.app.eventBus.emit(EVENTS.AUDIO_PLAYBACK_START, { index: state.currentSentenceIndex });
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
        const { config, state } = this.app;

        if (!this._isContextActive(context)) return;
        if (state.isPlaying) return;

        if (!state.pdf && !state.epub) {
            this.app.ui.showInfo("Load a document before playing.");
            return;
        }

        if (state.currentDocumentType === "pdf") {
            this._playPDFSentence(context);
        } else if (state.currentDocumentType === "epub") {
            this._playEPUBSentence(context);
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
        this.updatePlayButton();

        const currentSentence = state.currentSentence;
        if (currentSentence) this.clearWordBoundaryTimers(currentSentence);
        this.app.pdfRenderer.updateHighlightFullDoc();
        if (emitEvent) {
            this.app.eventBus.emit(EVENTS.AUDIO_PLAYBACK_PAUSE, { index: state.currentSentenceIndex });
        }

        if (clearContext) {
            this._playbackContext = null;
        }
    }

    togglePlay() {
        const { state } = this.app;
        if (state.isPlaying) {
            this.stopPlayback(true);
            state.autoAdvanceActive = false;
        } else {
            this.playCurrentSentence();
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
        this.updatePlayButton();
        this.app.pdfRenderer.updateHighlightFullDoc();

        const hasNextSentence =
            typeof finishedIndex === "number" && finishedIndex >= 0 && finishedIndex < state.sentences.length - 1;

        if (!state.autoAdvanceActive || !hasNextSentence) {
            state.autoAdvanceActive = false;
            this._invalidateContext(context);
            this.app.eventBus.emit(EVENTS.AUDIO_PLAYBACK_END, { index: state.currentSentenceIndex });
            return;
        }

        await delay(120);
        if (!this._isContextActive(context) || state.stopRequested) {
            state.autoAdvanceActive = false;
            this._invalidateContext(context);
            this.app.eventBus.emit(EVENTS.AUDIO_PLAYBACK_END, { index: state.currentSentenceIndex });
            return;
        }

        try {
            await this.app.pdfRenderer.renderSentence(finishedIndex + 1, { autoAdvance: true });
        } catch (err) {
            console.warn("Auto-advance render failed", err);
            state.autoAdvanceActive = false;
            this._invalidateContext(context);
            this.app.eventBus.emit(EVENTS.AUDIO_PLAYBACK_END, { index: state.currentSentenceIndex });
            return;
        }

        const nextSentence = state.sentences[state.currentSentenceIndex];
        this._invalidateContext(context);
        if (!state.generationEnabled || nextSentence?.isTextToRead) {
            await this.playCurrentSentence();
        }
        this.app.eventBus.emit(EVENTS.AUDIO_PLAYBACK_END, { index: state.currentSentenceIndex });
    }

    setupWordBoundaryTimers(s) {
        const { state, config } = this.app;
        this.clearWordBoundaryTimers(s);
        if (!config.ENABLE_WORD_HIGHLIGHT || !s.wordBoundaries?.length) return;
        const liveWord = document.getElementById(config.LIVE_WORD_REGION_ID);
        if (!Array.isArray(s.playbackWordTimers)) {
            s.playbackWordTimers = [];
        }
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
    }
}
