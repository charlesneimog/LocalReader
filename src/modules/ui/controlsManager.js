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
        this.bntHelp = document.getElementById("help-button");
        this.bntHelpClose = document.getElementById("help-close");
        this.bntFullScreen = document.getElementById("toggle-fullscreen");
        this.toggleViewBtn = document.getElementById("toggle-view-mode");
        this.saveHighlightBtn = document.getElementById("save-highlight");
        this.exportHighlightsBtn = document.getElementById("export-highlights");
        this.highlightColorPicker = document.getElementById("highlight-color");
        this.infoBox = document.getElementById("info-box");
        this.ttsStatus = document.getElementById("tts-status");
        this.overlayHelp = document.getElementById("help-overlay");
        this.controlsToolbar = document.getElementById("controls");
        this.wakeLock = null;
    }

    _setupEventListeners() {
        if (this.btnNextSentence) this.btnNextSentence.addEventListener("click", () => this.app.nextSentence(true));
        if (this.btnPrevSentence) this.btnPrevSentence.addEventListener("click", () => this.app.prevSentence(true));
        if (this.btnPlayToggle) this.btnPlayToggle.addEventListener("click", () => this.app.togglePlay());
        if (this.bntHelp) this.bntHelp.addEventListener("click", () => (this.overlayHelp.style.display = "block"));
        if (this.bntFullScreen) this.bntFullScreen.addEventListener("click", () => this.toggleFullscreen());
        if (this.bntHelpClose)
            this.bntHelpClose.addEventListener("click", () => (this.overlayHelp.style.display = "none"));

        if (this.btnNextPage)
            this.btnNextPage.addEventListener("click", () => {
                this.app.audioManager.stopPlayback(true);
                this.app.state.autoAdvanceActive = false;
                this.app.ttsQueue.reset();
                this.app.nextPageNav();
            });
        if (this.btnPrevPage)
            this.btnPrevPage.addEventListener("click", () => {
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
            } else if (e.code === "KeyH") {
                this.app.saveCurrentSentenceHighlight();
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

    collapseToolbar() {
        if (!this.controlsToolbar) return;
        this.controlsToolbar.classList.add("toolbar--collapsed");
    }

    expandToolbar() {
        if (!this.controlsToolbar) return;
        this.controlsToolbar.classList.remove("toolbar--collapsed");
        this.controlsToolbar.classList.remove("toolbar--hidden"); // caso estivesse totalmente ocultada
    }

    hideToolbarTemporarily() {
        if (!this.controlsToolbar) return;
        this.controlsToolbar.classList.add("toolbar--hidden");
    }

    showToolbar() {
        if (!this.collapseToolbar) return;
        this.controlsToolbar.classList.remove("toolbar--hidden");
    }

    toggleCollapsedState() {
        if (!this.controlsToolbar) return;
        if (this.controlsToolbar.classList.contains("toolbar--collapsed")) this.expandToolbar();
        else this.collapseToolbar();
    }

    async toggleFullscreen() {
        this.toggleCollapsedState();
        const doc = window.document;
        const docEl = doc.documentElement;
        const requestFull =
            docEl.requestFullscreen ||
            docEl.mozRequestFullScreen ||
            docEl.webkitRequestFullscreen ||
            docEl.msRequestFullscreen;
        const exitFull =
            doc.exitFullscreen || doc.mozCancelFullScreen || doc.webkitExitFullscreen || doc.msExitFullscreen;

        if (
            !doc.fullscreenElement &&
            !doc.mozFullScreenElement &&
            !doc.webkitFullscreenElement &&
            !doc.msFullscreenElement
        ) {
            await requestFull.call(docEl);
            this.enableWakeLock();
        } else {
            await exitFull.call(doc);
            this.disableWakeLock();
        }
    }

    async enableWakeLock() {
        try {
            if ("wakeLock" in navigator) {
                this.wakeLock = await navigator.wakeLock.request("screen");
                this.wakeLock.addEventListener("release", () => {});
            }
        } catch (err) {
            console.error(`${err.name}, ${err.message}`);
        }
    }
    disableWakeLock() {
        if (this.wakeLock) {
            this.wakeLock.release();
            this.wakeLock = null;
        }
    }
}
