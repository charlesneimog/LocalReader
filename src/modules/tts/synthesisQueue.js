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
        const s = state.sentences[idx];
        if (!s || s.audioReady || s.audioInProgress) return;

        if (!s.layoutProcessed) {
            this.app.ui.showInfo("Detecting layout of page" + s.pageNumber);
            const icon = document.querySelector("#play-toggle i");
            if (icon) icon.className = "fa-solid fa-spinner fa-spin";
            this.app.pdfHeaderFooterDetector.detectHeadersAndFooters(s.pageNumber);
            if (icon) icon.className = "fa-solid fa-spinner fa-spin";
            if (icon) icon.className = state.isPlaying ? "fa-solid fa-pause" : "fa-solid fa-play";
            this.app.ui.showInfo("");
        }

        if (!s.isTextToRead) {
            return;
        }

        if (this.queue.includes(idx) || this.inFlight.has(idx)) return;
        s.prefetchQueued = true;
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
        const s = state.sentences[idx];
        if (!s) return;
        if (s.audioReady || s.audioInProgress) {
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
    }
}
