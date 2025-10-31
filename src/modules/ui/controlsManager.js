export class ControlsManager {
    constructor(app) {
        this.app = app;
        this._cacheDOMElements();
        this._setupEventListeners();

        // internal
        this.isLocked = false;

        // stopwatch
        this.autoStopDuration = 30 * 60; // default 30 min in seconds
        this.timeLeft = this.autoStopDuration;
        this.timerInterval = null;

        this._updateTimerDisplay();
    }

    // Cache all used DOM nodes once
    _cacheDOMElements() {
        this.voiceSelect = document.getElementById("voice-select");
        this.speedSelect = document.getElementById("reading-speed");
        this.speedSelectValue = document.getElementById("reading-speed-value");

        this.btnNextSentence = document.getElementById("next-sentence");
        this.btnPrevSentence = document.getElementById("prev-sentence");
        this.btnPlayToggle = document.getElementById("play-toggle");
        this.btnNextPage = document.getElementById("next-page");
        this.btnPrevPage = document.getElementById("prev-page");
        this.bntHelp = document.getElementById("help-button");
        this.bntHelpClose = document.getElementById("help-close");
        this.bntFullScreen = document.getElementById("toggle-fullscreen");

        this.saveHighlightBtn = document.getElementById("save-highlight");
        this.exportHighlightsBtn = document.getElementById("export-highlights");
        this.highlightColorButtons = Array.from(document.querySelectorAll(".highlight-color-option"));
        this.infoBox = document.getElementById("info-box");
        this.ttsStatus = document.getElementById("tts-status");
        this.overlayHelp = document.getElementById("help-overlay");
        this.controlsToolbar = document.getElementById("controls");
        this.lockBtn = document.getElementById("lock-screen");

        // Default highlight color
        this.app.highlightManager?.setSelectedHighlightColor("#ffda76");
        const icon = this.saveHighlightBtn?.querySelector(".material-symbols-outlined");
        if (icon) {
            icon.style.color = "#ffda76";
        }

        // cache
        this.btnClearCache = document.getElementById("clear-cache-btn");

        // stopwatch
        this.autoStopInput = document.getElementById("stopwatch-input");
        this.btnPlayTimer = document.getElementById("btn-timer-play");
        this.btnStopTimer = document.getElementById("btn-timer-stop");
    }

    _setupEventListeners() {
        const { app } = this;
        const on = (el, type, fn) => el && el.addEventListener(type, fn, { passive: true });
        const stopAndResetAudio = () => {
            app.audioManager.stopPlayback(true);
            app.state.autoAdvanceActive = false;
            app.ttsQueue.reset();
        };

        // Basic controls
        on(this.btnNextSentence, "click", () => app.nextSentence(true));
        on(this.btnPrevSentence, "click", () => app.prevSentence(true));
        on(this.btnPlayToggle, "click", () => app.togglePlay());
        on(this.bntFullScreen, "click", () => this.toggleFullscreen());

        // Help overlay
        on(this.bntHelp, "click", () => (this.overlayHelp.style.display = "block"));
        on(this.bntHelpClose, "click", () => (this.overlayHelp.style.display = "none"));

        // Page navigation
        on(this.btnNextPage, "click", () => {
            stopAndResetAudio();
            app.nextPageNav();
        });
        on(this.btnPrevPage, "click", () => {
            stopAndResetAudio();
            app.prevPageNav();
        });

        // Highlights
        on(this.saveHighlightBtn, "click", () => app.highlightManager.saveCurrentSentenceHighlight());
        on(this.exportHighlightsBtn, "click", () => app.exportManager.exportPdfWithHighlights());

        if (this.highlightColorButtons?.length) {
            this.highlightColorButtons.forEach((btn) => {
                btn.setAttribute("aria-pressed", "false");
                btn.setAttribute("role", "button");
                on(btn, "click", () => {
                    const color = btn.dataset.highlightColor;
                    if (!color) return;
                    app.highlightManager?.setSelectedHighlightColor(color);
                    const icon = this.saveHighlightBtn?.querySelector(".material-symbols-outlined");
                    if (icon) icon.style.color = color;
                    this.reflectSelectedHighlightColor();
                });
            });
        }

        // Voice and speed
        on(this.voiceSelect, "change", () => {
            app.audioManager.stopPlayback(true);
            app.state.autoAdvanceActive = false;
            app.cache.clearAudioFrom(app.state.currentSentenceIndex);
            app.ttsEngine.schedulePrefetch();
        });

        if (this.speedSelect) {
            const updateSpeedDisplay = () => {
                const val = parseFloat(this.speedSelect.value);
                this.speedSelectValue.textContent = (isNaN(val) ? 1 : val) + "x";
            };

            on(this.speedSelect, "input", updateSpeedDisplay);

            on(this.speedSelect, "change", () => {
                const val = parseFloat(this.speedSelect.value);
                app.state.CURRENT_SPEED = Math.abs(isNaN(val) ? 1.0 : val - 2); // original logic preserved
                app.audioManager.stopPlayback(true);
                app.state.autoAdvanceActive = false;
                app.cache.clearAudioFrom(app.state.currentSentenceIndex);
                app.ttsEngine.schedulePrefetch();
                updateSpeedDisplay();
            });

            // Initialize display
            const initVal = parseFloat(this.speedSelect.value);
            this.speedSelectValue.textContent = (isNaN(initVal) ? 1 : initVal) + "x";
        }

        // Keyboard shortcuts
        window.addEventListener(
            "keydown",
            (e) => {
                const tag = e.target?.tagName || "";
                if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;

                const actions = {
                    Space: () => {
                        e.preventDefault();
                        app.togglePlay();
                    },
                    ArrowRight: () => app.nextSentence(true),
                    ArrowLeft: () => app.prevSentence(true),
                    KeyH: () => app.saveCurrentSentenceHighlight(),
                    KeyF: () => this.toggleFullscreen(),
                    Digit1: () => this._selectHighlightIndex(0),
                    Digit2: () => this._selectHighlightIndex(1),
                    Digit3: () => this._selectHighlightIndex(2),
                    Digit4: () => this._selectHighlightIndex(3),
                };

                const fn = actions[e.code];
                if (fn) fn();
            },
            { passive: false },
        );

        // Persist progress on unload
        window.addEventListener("beforeunload", () => app.progressManager.saveProgress());
        this.reflectSelectedHighlightColor();

        // Orientation
        this.lockBtn.addEventListener("click", async () => {
            if (!screen.orientation || !screen.orientation.lock) {
                alert("API de orientação não suportada neste navegador.");
                return;
            }

            if (!document.fullscreenElement) {
                await this.toggleFullscreen();
            }

            this.lockBtn.classList.toggle("bg-primary/10");
            this.lockBtn.classList.toggle("text-primary");

            if (screen.orientation.lock) {
                if (!this.isLocked) {
                    try {
                        await screen.orientation.lock(screen.orientation.type);
                    } catch (e) {}
                    this.isLocked = true;
                } else {
                    try {
                        screen.orientation.unlock();
                    } catch (e) {}
                    this.isLocked = false;
                }
            }
        });

        // Handle orientation change: fit PDF to new container width
        this._orientationTimer = null;
        this._lastContainerWidth = null;
        this.orientationChange = this.orientationChange.bind(this);
        window.addEventListener("orientationchange", this.orientationChange, { passive: true });

        //
        on(this.btnClearCache, "click", () => {
            {
                const confirmed = confirm("Are you sure you want to clear all pdfs saved?");
                if (confirmed) {
                    this.app.progressManager.clearPDFCache();
                }
            }
        });

        // Stop Watch
        this.btnPlayTimer.addEventListener("click", () => this._toggleTimer());
        this.btnStopTimer.addEventListener("click", () => this._stopTimer());
        this.autoStopInput.addEventListener("change", (e) => {
            const val = parseInt(e.target.value, 10);
            if (!isNaN(val) && val >= 0) {
                this.autoStopDuration = val * 60;
                this.timeLeft = this.autoStopDuration;
                this._updateTimerDisplay();
            }
        });
    }

    orientationChange() {
        if (this.isLocked) return; // don't alter layout when orientation is locked

        if (this._orientationTimer) clearTimeout(this._orientationTimer);
        this._orientationTimer = setTimeout(async () => {
            const { state, config, pdfRenderer } = this.app;
            if (!state?.pdf) return;

            const container = document.getElementById("pdf-doc-container");
            const containerWidth = Math.max(1, container?.clientWidth || window.innerWidth);
            if (this._lastContainerWidth && Math.abs(containerWidth - this._lastContainerWidth) < 2) {
                // width didn't change meaningfully; skip work
                return;
            }
            this._lastContainerWidth = containerWidth;

            // Recompute viewportDisplay per page lazily: mark pages for rescale instead of mutating all words now
            let i = 0;
            for (const [pageNumber, page] of state.pagesCache.entries()) {
                try {
                    const unscaledWidth = page.unscaledWidth || page.getViewport({ scale: 1 }).width;
                    const unscaledHeight = page.unscaledHeight || page.getViewport({ scale: 1 }).height;
                    const displayScale = containerWidth / unscaledWidth;
                    const viewportDisplay = {
                        width: unscaledWidth * displayScale,
                        height: unscaledHeight * displayScale,
                    };
                    state.viewportDisplayByPage.set(pageNumber, viewportDisplay);
                    page.currentDisplayScale = displayScale;
                    page.needsWordRescale = true;
                } catch (err) {
                    console.warn("[orientationChange] Viewport recompute failed for page", pageNumber, err);
                }
                if (++i % 200 === 0) {
                    // Yield to keep UI responsive on very large PDFs
                    // eslint-disable-next-line no-await-in-loop
                    await new Promise(requestAnimationFrame);
                }
            }

            // Force re-render at new size
            state.fullPageRenderCache.clear();
            state.deviceScale = window.devicePixelRatio || 1;

            if (state.viewMode === "full") {
                try {
                    await this.app.pdfRenderer.refreshLayoutAfterViewportChange();
                    pdfRenderer.updateHighlightFullDoc(state.currentSentence);
                    pdfRenderer.renderHoverHighlightFullDoc();
                    if (state.currentSentence) pdfRenderer.scrollSentenceIntoView(state.currentSentence);
                } catch (e) {
                    console.warn("[orientationChange] Full doc re-render failed", e);
                }
            } else {
                this.app.pdfRenderer.renderSentence(state.currentSentenceIndex);
            }
        }, 160);
    }

    _selectHighlightIndex = (index) => {
        const btn = this.highlightColorButtons?.[index];
        if (!btn) return;
        const color = btn.dataset.highlightColor;
        if (!color) return;
        this.app.highlightManager?.setSelectedHighlightColor(color);
        const icon = this.saveHighlightBtn?.querySelector(".material-symbols-outlined");
        if (icon) icon.style.color = color;
        this.reflectSelectedHighlightColor();
    };

    toggleCollapsedState() {
        if (!this.controlsToolbar) return;
        this.controlsToolbar.classList.toggle("toolbar--collapsed");
    }

    async toggleFullscreen() {
        this.toggleCollapsedState();

        const doc = document;
        const docEl = doc.documentElement;
        const requestFull =
            docEl.requestFullscreen ||
            docEl.mozRequestFullScreen ||
            docEl.webkitRequestFullscreen ||
            docEl.msRequestFullscreen;
        const exitFull =
            doc.exitFullscreen || doc.mozCancelFullScreen || doc.webkitExitFullscreen || doc.msExitFullscreen;

        const isFull =
            doc.fullscreenElement || doc.mozFullScreenElement || doc.webkitFullscreenElement || doc.msFullscreenElement;

        if (!isFull) {
            await requestFull.call(docEl);
            this.enableWakeLock();
            this.bntFullScreen.classList.add("bg-primary/10", "text-primary");
        } else {
            await exitFull.call(doc);
            this.disableWakeLock();
            this.bntFullScreen.classList.remove("bg-primary/10", "text-primary");
        }
    }

    async enableWakeLock() {
        if ("wakeLock" in navigator) {
            this.wakeLock = await navigator.wakeLock.request("screen");
            this.wakeLock.addEventListener("release", () => {});
        }
    }

    disableWakeLock() {
        if (this.wakeLock) {
            this.wakeLock.release();
            this.wakeLock = null;
        }
    }

    reflectSelectedHighlightColor() {
        if (!this.highlightColorButtons?.length) return;
        const selectedColor = this.app.state?.selectedHighlightColor;
        let activeButton =
            (selectedColor && this.highlightColorButtons.find((btn) => btn.dataset.highlightColor === selectedColor)) ||
            this.highlightColorButtons[0];

        this.highlightColorButtons.forEach((btn) => {
            const isActive = btn === activeButton;
            btn.classList.toggle("is-active", isActive);
            btn.setAttribute("aria-pressed", isActive ? "true" : "false");
        });
    }

    _toggleTimer() {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
            this.btnPlayTimer.querySelector("span").textContent = "play_arrow";
        } else {
            this.btnPlayTimer.querySelector("span").textContent = "pause";
            this.timerInterval = setInterval(() => {
                if (this.timeLeft > 0) {
                    this.timeLeft--;
                    this._updateTimerDisplay();
                } else {
                    this._stopTimer();
                    this.app.audioManager.stopPlayback(true);
                }
            }, 1000);
        }
    }

    _stopTimer() {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
            this.disableWakeLock();
        }
        this.timeLeft = this.autoStopDuration;
        this._updateTimerDisplay();
        if (this.btnPlayTimer) this.btnPlayTimer.querySelector("span").textContent = "play_arrow";
    }

    _updateTimerDisplay() {
        if (!this.autoStopInput) return;
        const minutes = Math.floor(this.timeLeft / 60);
        const seconds = this.timeLeft % 60;
        this.autoStopInput.value = `${minutes}:${seconds.toString().padStart(2, "0")}`;
    }
}
