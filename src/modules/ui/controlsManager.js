export class ControlsManager {
    constructor(app) {
        this.app = app;
        this._cacheDOMElements();
        this._setupEventListeners();
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
        if (icon) icon.style.color = "#ffda76";
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

    // Orientation lock control via toolbar button
    this._initOrientationLock();

        this.reflectSelectedHighlightColor();
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

    collapseToolbar() {
        this.controlsToolbar?.classList.add("toolbar--collapsed");
    }

    expandToolbar() {
        if (!this.controlsToolbar) return;
        this.controlsToolbar.classList.remove("toolbar--collapsed", "toolbar--hidden");
    }

    hideToolbarTemporarily() {
        this.controlsToolbar?.classList.add("toolbar--hidden");
    }

    showToolbar() {
        this.controlsToolbar?.classList.remove("toolbar--hidden");
    }

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

    // ---------- Orientation lock via toolbar button ----------
    _initOrientationLock() {
        const isMobile = /Mobi|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
        const getOrientation = () => (window.innerWidth > window.innerHeight ? "landscape" : "portrait");

        this._orientationLocked = false;
        this._lockedOrientation = getOrientation();
        this._lastViewport = { w: window.innerWidth, h: window.innerHeight };

        const updateButtonState = () => {
            if (!this.lockBtn) return;
            this.lockBtn.setAttribute("aria-pressed", this._orientationLocked ? "true" : "false");
            this.lockBtn.classList.toggle("is-active", !!this._orientationLocked);
        };

        const tryLock = async (mode) => {
            if (screen.orientation?.lock) {
                try {
                    await screen.orientation.lock(mode);
                    return true;
                } catch {
                    return false;
                }
            }
            return false;
        };

        const tryUnlock = async () => {
            if (screen.orientation?.unlock) {
                try {
                    screen.orientation.unlock();
                    return true;
                } catch {
                    return false;
                }
            }
            return false;
        };

        const freezeUI = () => {
            window.__freezeViewportUpdates = true;
            const { w, h } = this._lastViewport;
            const root = document.documentElement;
            const body = document.body;
            if (root) {
                root.style.width = `${w}px`;
                root.style.height = `${h}px`;
                root.style.overflow = "hidden";
            }
            if (body) {
                body.style.width = `${w}px`;
                body.style.height = `${h}px`;
                body.style.overflow = "hidden";
            }
        };
        const unfreezeUI = () => {
            window.__freezeViewportUpdates = false;
            const root = document.documentElement;
            const body = document.body;
            if (root) {
                root.style.width = "";
                root.style.height = "";
                root.style.overflow = "";
            }
            if (body) {
                body.style.width = "";
                body.style.height = "";
                body.style.overflow = "";
            }
        };

        const onLockClick = async () => {
            if (!this._orientationLocked) {
                this._lockedOrientation = getOrientation();
                const locked = await tryLock(this._lockedOrientation);
                if (!locked && isMobile) {
                    // Fallback: freeze if lock not supported
                    freezeUI();
                }
                this._orientationLocked = true;
                updateButtonState();
            } else {
                const unlocked = await tryUnlock();
                if (!unlocked) {
                    // If fallback freeze was used, unfreeze
                    unfreezeUI();
                }
                this._orientationLocked = false;
                updateButtonState();
            }
        };

        // If device rotates while locked, try to re-lock or keep frozen
        const handleOrientationChange = async () => {
            if (!this._orientationLocked) return;
            // Attempt to keep the locked mode
            const ok = await tryLock(this._lockedOrientation);
            if (!ok && isMobile) {
                freezeUI();
            }
        };

        this.lockBtn?.addEventListener("click", onLockClick, { passive: true });
        window.addEventListener("orientationchange", handleOrientationChange, { passive: true });
        window.addEventListener("resize", () => {
            if (!this._orientationLocked) {
                this._lastViewport = { w: window.innerWidth, h: window.innerHeight };
            }
        }, { passive: true });

        updateButtonState();
    }
}
