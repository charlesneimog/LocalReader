export class ControlsManager {
    constructor(app) {
        this.app = app;
        this._cacheDOMElements();
        this._setupEventListeners();
    }

    _cacheDOMElements() {
        this.voiceSelect = document.getElementById("voice-select");
        this.speedSelect = document.getElementById("rate-select");
        this.btnNextSentence = document.getElementById("next-sentence");
        this.btnPrevSentence = document.getElementById("prev-sentence");
        this.btnPlayToggle = document.getElementById("play-toggle");
        this.btnNextPage = document.getElementById("next-page");
        this.btnPrevPage = document.getElementById("prev-page");
        this.toggleViewBtn = document.getElementById("toggle-view-mode");
        this.saveHighlightBtn = document.getElementById("save-highlight");
        this.exportHighlightsBtn = document.getElementById("export-highlights");
        this.highlightColorPicker = document.getElementById("highlight-color");
        this.infoBox = document.getElementById("info-box");
        this.ttsStatus = document.getElementById("tts-status");
    }

    _setupEventListeners() {
        if (this.btnNextSentence) this.btnNextSentence.addEventListener("click", () => this.app.nextSentence(true));
        if (this.btnPrevSentence) this.btnPrevSentence.addEventListener("click", () => this.app.prevSentence(true));
        if (this.btnPlayToggle) this.btnPlayToggle.addEventListener("click", () => this.app.togglePlay());
        if (this.btnNextPage) this.btnNextPage.addEventListener("click", () => {
            this.app.audioManager.stopPlayback(true);
            this.app.state.autoAdvanceActive = false;
            this.app.ttsQueue.reset();
            this.app.nextPageNav();
        });
        if (this.btnPrevPage) this.btnPrevPage.addEventListener("click", () => {
            this.app.audioManager.stopPlayback(true);
            this.app.state.autoAdvanceActive = false;
            this.app.ttsQueue.reset();
            this.app.prevPageNav();
        });
        if (this.saveHighlightBtn) {
            this.saveHighlightBtn.addEventListener("click", () => {
                this.app.highlightManager.saveCurrentSentenceHighlight();
                this.app.ui.updateStatus("Highlight saved!");
                setTimeout(() => this.app.ui.updateStatus(""), 2000);
            });
        }
        if (this.exportHighlightsBtn) {
            this.exportHighlightsBtn.addEventListener("click", () => this.app.exportManager.exportPdfWithHighlights());
        }
        if (this.voiceSelect) {
            this.voiceSelect.addEventListener("change", () => {
                this.app.audioManager.stopPlayback(true);
                this.app.state.autoAdvanceActive = false;
                this.app.cache.clearAudioFrom(this.app.state.currentSentenceIndex);
                this.app.ttsEngine.schedulePrefetch();
            });
        }
        if (this.speedSelect) {
            this.speedSelect.addEventListener("change", () => {
                const val = parseFloat(this.speedSelect.value);
                this.app.state.CURRENT_SPEED = isNaN(val) ? 1.0 : val;
                this.app.audioManager.stopPlayback(true);
                this.app.state.autoAdvanceActive = false;
                this.app.cache.clearAudioFrom(this.app.state.currentSentenceIndex);
                this.app.ttsEngine.schedulePrefetch();
            });
        }
        window.addEventListener("keydown", (e) => {
            if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
            if (e.code === "Space") {
                e.preventDefault();
                this.app.togglePlay();
            } else if (e.code === "ArrowRight") {
                this.app.nextSentence(true);
            } else if (e.code === "ArrowLeft") {
                this.app.prevSentence(true);
            } else if (e.key.toLowerCase() === "p") {
                this.app.togglePlay();
            }
        });

        window.addEventListener("beforeunload", () => this.app.progressManager.saveProgress());

        window.addEventListener("resize", () => {
            const s = this.app.state;
            if (s.viewMode === "full") {
                this.app.pdfRenderer.rescaleAllPages();
                this.app.pdfRenderer.updateHighlightFullDoc(s.currentSentence);
                this.app.pdfRenderer.renderHoverHighlightFullDoc();
            } else {
                this.app.pdfRenderer.renderSentence(s.currentSentenceIndex);
            }
        });
        window.addEventListener("orientationchange", () => {
            setTimeout(() => {
                const s = this.app.state;
                if (s.viewMode === "full") {
                    this.app.pdfRenderer.rescaleAllPages();
                    this.app.pdfRenderer.updateHighlightFullDoc(s.currentSentence);
                    this.app.pdfRenderer.renderHoverHighlightFullDoc();
                } else {
                    this.app.pdfRenderer.renderSentence(s.currentSentenceIndex);
                }
            }, 150);
        });
    }
}