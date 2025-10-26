import { EVENTS } from "../../constants/events.js";

export class TTSQueueManager {
    constructor(app) {
        this.app = app;
        this.queue = [];
        this.active = 0;
        this.inFlight = new Set();
    }

    add(idx, priority = false) {
        const { state } = this.app;
        if (!state.generationEnabled) return;
        const sentence = state.sentences[idx];
        if (!sentence || sentence.audioReady || sentence.audioInProgress) return;

        if (!sentence.layoutProcessed) {
            if (!sentence.layoutProcessingPromise) {
                const icon = document.querySelector("#play-toggle span.material-symbols-outlined");
                if (icon) {
                    console.log(icon);
                    icon.textContent = "autorenew";
                    icon.classList.add("animate-spin");
                }
                sentence.layoutProcessingPromise = this.app.pdfHeaderFooterDetector
                    .ensureReadabilityForPage(sentence.pageNumber)
                    .catch((err) => {
                        console.warn("Layout filtering failed for sentence", sentence.index, err);
                    })
                    .finally(() => {
                        sentence.layoutProcessingPromise = null;
                        const iconFinal = document.querySelector("#play-toggle span.material-symbols-outlined");
                        if (iconFinal) {
                            iconFinal.textContent = state.isPlaying ? "pause" : "play_arrow";
                            iconFinal.classList.remove("animate-spin");
                        }
                        this.add(idx, priority);
                    });
            }
            return;
        }

        if (!sentence.isTextToRead) {
            return;
        }

        if (this.queue.includes(idx) || this.inFlight.has(idx)) return;
        sentence.prefetchQueued = true;
        priority ? this.queue.unshift(idx) : this.queue.push(idx);
        this.run();
    }

    run() {
        const { config } = this.app;
        while (this.active < config.MAX_CONCURRENT_SYNTH && this.queue.length) {
            const idx = this.queue.shift();
            this.startTask(idx);
        }
    }

    async startTask(idx) {
        const { state } = this.app;
        const sentence = state.sentences[idx];
        if (!sentence) return;

        if (!sentence.layoutProcessed) {
            this.add(idx, true);
            this.run();
            return;
        }

        if (sentence.audioReady || sentence.audioInProgress || !sentence.isTextToRead) {
            this.run();
            return;
        }

        this.active++;
        this.inFlight.add(idx);
        try {
            await this.app.ttsEngine.synthesizeSequential(idx);
        } catch (e) {
            console.warn("Synthesis failure:", e);
            this.app.eventBus.emit(EVENTS.TTS_SYNTHESIS_ERROR, { index: idx, error: e });
        } finally {
            this.active--;
            this.inFlight.delete(idx);
            this.run();
        }
    }

    reset() {
        this.queue = [];
        this.active = 0;
        this.inFlight.clear();
    }
}
