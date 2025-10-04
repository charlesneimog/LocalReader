import { delay, waitFor } from "../utils/helpers.js";
import { EVENTS } from "../../constants/events.js";

export class AudioManager {
    constructor(app) {
        this.app = app;
    }

    updatePlayButton() {
        const { state } = this.app;
        const s = state.currentSentence;
        const btn = document.getElementById("play-toggle");
        if (!btn) return;
        btn.disabled = !s;
        const icon = btn.querySelector("i");
        if (!s) {
            if (icon) icon.className = "fa-solid fa-play";
            return;
        }
        if (icon) icon.className = state.isPlaying ? "fa-solid fa-pause" : "fa-solid fa-play";
    }

    async playCurrentSentence() {
        const { state, config } = this.app;
        const s = state.currentSentence;
        if (!s || state.isPlaying) return;
        await this.app.ttsEngine.ensureAudioContext();

        if (!state.generationEnabled) {
            state.generationEnabled = true;
            this.app.ttsQueue.add(state.currentSentenceIndex, true);
            this.app.ttsQueue.run();
            this.app.ttsEngine.schedulePrefetch();
        }
        if (!s.audioReady) {
            this.app.ttsQueue.add(state.currentSentenceIndex, true);
            this.app.ttsQueue.run();
            try {
                await waitFor(() => s.audioReady || s.audioError, 45000);
            } catch {}
        }
        if (!s.audioReady || s.audioError || !s.audioBuffer) {
            this.app.ui.updateStatus("❌ Audio not ready.");
            return;
        }

        this.stopPlayback(false);
        state.stopRequested = false;

        try {
            if (state.currentSource) try { state.currentSource.disconnect(); } catch {}
            if (state.currentGain) try { state.currentGain.disconnect(); } catch {}

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
                this.updatePlayButton();
                if (!state.autoAdvanceActive) return;
                if (state.currentSentenceIndex < state.sentences.length - 1) {
                    await delay(120);
                    if (state.stopRequested) return;
                    this.app.pdfRenderer.renderSentence(state.currentSentenceIndex + 1);
                    this.playCurrentSentence();
                }
                this.app.eventBus.emit(EVENTS.AUDIO_PLAYBACK_END, { index: state.currentSentenceIndex });
            };

            await delay(10);
            state.currentSource.start();
            state.isPlaying = true;
            state.autoAdvanceActive = true;
            this.updatePlayButton();
            this.app.eventBus.emit(EVENTS.AUDIO_PLAYBACK_START, { index: state.currentSentenceIndex });

        } catch (err) {
            console.error("Playback error:", err);
            this.app.ui.updateStatus("Playback error; resetting context.");
            try { if (state.audioCtx) await state.audioCtx.close(); } catch {}
            state.audioCtx = null;
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
                    setTimeout(() => {
                        try { state.currentSource.stop(); } catch {}
                        try { state.currentSource.disconnect(); } catch {}
                        try { if (state.currentGain) state.currentGain.disconnect(); } catch {}
                    }, config.FADE_OUT_SEC * 1000 + 10);
                } else {
                    try { state.currentSource.stop(); } catch {}
                    try { state.currentSource.disconnect(); } catch {}
                    try { if (state.currentGain) state.currentGain.disconnect(); } catch {}
                }
            } catch (e) {
                console.warn("Stop error:", e);
            }
        }
        state.currentSource = null;
        state.currentGain = null;
        state.isPlaying = false;
        this.updatePlayButton();
        const s = state.currentSentence;
        if (s) this.clearWordBoundaryTimers(s);
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