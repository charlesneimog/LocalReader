import { delay, waitFor } from "../utils/helpers.js";
import { EVENTS } from "../../constants/events.js";

export class AudioManager {
    constructor(app) {
        this.app = app;
        this._playPromise = null;
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
        const { state, config } = this.app;
        if (state.isPlaying) {
            return;
        }

        if (this._playPromise) {
            return this._playPromise;
        }

        this._playPromise = this._playCurrentSentence(config).finally(() => {
            this._playPromise = null;
        });
        return this._playPromise;
    }

    async _playCurrentSentence(config) {
        const { state } = this.app;
        if (state.isPlaying) return;

        if (!state.pdf) {
            this.app.ui.showInfo("Load a document before playing.");
            return;
        }

        try {
            await this.app.pdfLoader.ensureLayoutFilteringReady();
        } catch (err) {
            console.error("Layout preparation failed:", err);
            this.app.ui.showInfo("❌ Layout analysis failed. Cannot start playback.");
            return;
        }

        const s = state.currentSentence;
        if (!s) {
            this.app.ui.showInfo("No readable sentences available.");
            return;
        }

        if (!s.isTextToRead) {
            this.app.ui.showInfo("Selected sentence is outside readable layout regions.");
            return;
        }

        await this.app.ttsEngine.ensureAudioContext();

        if (!state.generationEnabled) {
            state.generationEnabled = true;
        }

        const icon = document.querySelector("#play-toggle span.material-symbols-outlined");
        let attempts = 0;
        while ((!s.audioReady || !s.audioBuffer) && !s.audioError) {
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
                await waitFor(() => s.audioReady || s.audioError, 5000);
            } catch {}
            if (s.audioReady && s.audioBuffer) break;
            if (s.audioError || state.stopRequested || attempts >= 3) {
                break;
            }
        }

        if (!s.audioReady || s.audioError || !s.audioBuffer) {
            if (icon) {
                icon.textContent = this.app.state.isPlaying ? "pause" : "play_arrow";
                icon.classList.remove("animate-spin");
            }
            if (!s.audioError) {
                setTimeout(() => {
                    this._playCurrentSentence(config);
                }, 300);

                return;
            }
            return;
        }

        if (icon) {
            icon.textContent = this.app.state.isPlaying ? "pause" : "play_arrow";
            icon.classList.remove("animate-spin");
        }

        this.app.ttsEngine.schedulePrefetch();

        this.stopPlayback(false);
        state.stopRequested = false;

        let shouldRetry = false;
        try {
            if (state.currentSource)
                try {
                    state.currentSource.disconnect();
                } catch {}
            if (state.currentGain)
                try {
                    state.currentGain.disconnect();
                } catch {}

            state.currentSource = state.audioCtx.createBufferSource();
            state.currentSource.buffer = s.audioBuffer;
            state.currentGain = state.audioCtx.createGain();
            state.currentGain.gain.setValueAtTime(config.MIN_GAIN, state.audioCtx.currentTime);
            state.currentSource.connect(state.currentGain).connect(state.audioCtx.destination);
            state.currentGain.gain.exponentialRampToValueAtTime(1.0, state.audioCtx.currentTime + config.FADE_IN_SEC);

            this.setupWordBoundaryTimers(s);

            state.currentSource.onended = async () => {
                this.clearWordBoundaryTimers(s);
                if (state.stopRequested) return;
                if (state.autoHighlightEnabled) {
                    this.app.highlightManager.saveCurrentSentenceHighlight();
                }
                state.isPlaying = false;
                state.playingSentenceIndex = -1;
                this.updatePlayButton();
                this.app.pdfRenderer.updateHighlightFullDoc();
                if (!state.autoAdvanceActive) return;
                if (state.currentSentenceIndex < state.sentences.length - 1) {
                    await delay(120);
                    if (state.stopRequested) return;
                    await this.app.pdfRenderer.renderSentence(state.currentSentenceIndex + 1, { autoAdvance: true });
                    const nextSentence = state.sentences[state.currentSentenceIndex];
                    if (!state.generationEnabled || nextSentence?.isTextToRead) {
                        await this.playCurrentSentence();
                    }
                }
                this.app.eventBus.emit(EVENTS.AUDIO_PLAYBACK_END, { index: state.currentSentenceIndex });
            };

            await delay(10);
            state.currentSource.start();
            state.isPlaying = true;
            state.autoAdvanceActive = true;
            state.playingSentenceIndex = state.currentSentenceIndex;
            this.updatePlayButton();
            this.app.pdfRenderer.updateHighlightFullDoc();
            this.app.eventBus.emit(EVENTS.AUDIO_PLAYBACK_START, { index: state.currentSentenceIndex });
        } catch (err) {
            console.error("Playback error:", err);
            this.app.ui.showInfo("Playback error; resetting context.");
            try {
                if (state.audioCtx) await state.audioCtx.close();
            } catch {}
            state.audioCtx = null;
            shouldRetry = !state.stopRequested;
        } finally {
            if (shouldRetry) {
                await delay(200);
                if (!state.stopRequested) {
                    setTimeout(() => this.playCurrentSentence(), 0);
                }
            }
        }
    }

    async stopPlayback(fade = true) {
        const { state, config } = this.app;
        state.stopRequested = true;
        if (state.currentSource && state.audioCtx) {
            try {
                if (fade && state.currentGain && state.audioCtx.state === "running") {
                    const now = state.audioCtx.currentTime;
                    const val = state.currentGain.gain.value;
                    if (val > config.MIN_GAIN) {
                        state.currentGain.gain.cancelScheduledValues(now);
                        state.currentGain.gain.setValueAtTime(val, now);
                        state.currentGain.gain.linearRampToValueAtTime(config.MIN_GAIN, now + config.FADE_OUT_SEC);
                    }
                    setTimeout(
                        () => {
                            try {
                                state.currentSource.stop();
                            } catch {}
                            try {
                                state.currentSource.disconnect();
                            } catch {}
                            try {
                                if (state.currentGain) state.currentGain.disconnect();
                            } catch {}
                        },
                        config.FADE_OUT_SEC * 1000 + 10,
                    );
                } else {
                    try {
                        state.currentSource.stop();
                    } catch {}
                    try {
                        state.currentSource.disconnect();
                    } catch {}
                    try {
                        if (state.currentGain) state.currentGain.disconnect();
                    } catch {}
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
        const s = state.currentSentence;
        if (s) this.clearWordBoundaryTimers(s);
        this.app.pdfRenderer.updateHighlightFullDoc();
        this.app.eventBus.emit(EVENTS.AUDIO_PLAYBACK_PAUSE, { index: state.currentSentenceIndex });
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

    setupWordBoundaryTimers(s) {
        const { state, config } = this.app;
        this.clearWordBoundaryTimers(s);
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
        if (!s.playbackWordTimers) return;
        for (const t of s.playbackWordTimers) clearTimeout(t);
        s.playbackWordTimers = [];
    }
}
