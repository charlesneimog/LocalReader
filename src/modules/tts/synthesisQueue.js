import { EVENTS } from "../../constants/events.js";

const PRIORITY_ORDER = {
    critical: 0,
    high: 1,
    normal: 2,
};

const DEFAULT_PRIORITY = "normal";

export class TTSQueueManager {
    constructor(app) {
        this.app = app;
        this.queue = [];
        this.active = 0;
        this.inFlight = new Set();
        this.queued = new Map();
        this.sequence = 0;
    }

    _normalizePriority(priority) {
        if (priority === "critical" || priority === "high" || priority === "normal") {
            return priority;
        }
        return DEFAULT_PRIORITY;
    }

    _sortQueue() {
        this.queue.sort((a, b) => {
            if (a.rank !== b.rank) return a.rank - b.rank;
            return a.order - b.order;
        });
    }

    _getMaxConcurrent() {
        const { config } = this.app;
        const raw =
            Number.isFinite(config.MAX_CONCURRENT_TTS)
                ? config.MAX_CONCURRENT_TTS
                : Number.isFinite(config.MAX_CONCURRENT_SYNTH)
                    ? config.MAX_CONCURRENT_SYNTH
                    : 1;
        return Math.max(1, Number(raw) || 1);
    }

    add(idx, options = {}) {
        const { state } = this.app;
        if (!state.generationEnabled) return;
        const sentence = state.sentences[idx];
        if (!sentence) return;

        const priority = this._normalizePriority(options?.priority);
        const force = options?.force === true;

        if (sentence.prefetchQueued && !this.queued.has(idx)) {
            sentence.prefetchQueued = false;
        }

        if (sentence.audioReady && sentence.audioBuffer && !force) return;
        if (sentence.audioError && !force) return;
        if (sentence.audioInProgress || sentence.rendering || this.inFlight.has(idx)) return;

        if (!sentence.layoutProcessed) {
            if (!sentence.layoutProcessingPromise) {
                sentence.layoutProcessingPromise = this.app.pdfHeaderFooterDetector
                    .ensureReadabilityForPage(sentence.pageNumber)
                    .catch((err) => {
                        console.warn("Layout filtering failed for sentence", sentence.index, err);
                    })
                    .finally(() => {
                        sentence.layoutProcessingPromise = null;
                        this.add(idx, { priority, force });
                    });
            }
            return;
        }

        if (!sentence.isTextToRead) {
            return;
        }

        const queuedEntry = this.queued.get(idx);
        if (queuedEntry) {
            if (force && queuedEntry.priority !== priority) {
                queuedEntry.priority = priority;
                queuedEntry.rank = PRIORITY_ORDER[priority];
                this._sortQueue();
            }
            return;
        }

        if (sentence.audioError && force) {
            sentence.audioError = null;
        }

        const idle = this.active === 0 && this.queue.length === 0;
        sentence.prefetchQueued = true;

        const entry = {
            idx,
            priority,
            rank: PRIORITY_ORDER[priority],
            order: this.sequence++,
        };
        this.queue.push(entry);
        this.queued.set(idx, entry);
        this._sortQueue();

        if (idle && state.playbackPending && !state.isPlaying) {
            this.app.ui.updatePlayButton(state.playerState.LOADING);
        }
        this.run();
    }

    run() {
        const { state } = this.app;
        const maxConcurrent = this._getMaxConcurrent();
        while (this.active < maxConcurrent && this.queue.length) {
            const entry = this.queue.shift();
            if (!entry) continue;
            this.queued.delete(entry.idx);
            const sentence = state.sentences[entry.idx];
            if (sentence) {
                sentence.prefetchQueued = false;
            }
            this.startTask(entry);
        }
    }

    async startTask(entry) {
        const { state } = this.app;
        const idx = entry?.idx;
        const priority = entry?.priority || DEFAULT_PRIORITY;
        const sentence = Number.isFinite(idx) ? state.sentences[idx] : null;
        if (!sentence) return;

        if (!sentence.layoutProcessed) {
            this.add(idx, { priority, force: true });
            this.run();
            return;
        }

        if (sentence.audioReady || sentence.audioInProgress || sentence.rendering || !sentence.isTextToRead) {
            this.run();
            return;
        }

        sentence.rendering = true;
        this.active++;
        this.inFlight.add(idx);
        try {
            await this.app.ttsEngine.synthesizeSequential(idx);
            // if sentence is same as current sentence, then begin playback immediately
            if (idx === state.currentSentenceIndex && !state.isPlaying && state.playbackPending) {
                this.app.audioManager.playCurrentSentence();
            }
            this.app.eventBus.emit(EVENTS.TTS_SYNTHESIS_COMPLETE, { index: idx });

        } catch (e) {
            console.warn("Synthesis failure:", e);
            this.app.eventBus.emit(EVENTS.TTS_SYNTHESIS_ERROR, { index: idx, error: e });
        } finally {
            this.active--;
            this.inFlight.delete(idx);
            sentence.rendering = false;
            sentence.prefetchQueued = false;
            this.run();
            if (this.active === 0 && this.queue.length === 0 && !state.isPlaying && !state.playbackPending) {
                this.app.ui.updatePlayButton(state.playerState.DONE);
            }
        }
    }

    reset() {
        const { state } = this.app;
        for (const entry of this.queue) {
            const sentence = state.sentences?.[entry.idx];
            if (sentence) sentence.prefetchQueued = false;
        }
        for (const idx of this.inFlight) {
            const sentence = state.sentences?.[idx];
            if (sentence) sentence.rendering = false;
        }
        this.queue = [];
        this.active = 0;
        this.inFlight.clear();
        this.queued.clear();
    }
}
