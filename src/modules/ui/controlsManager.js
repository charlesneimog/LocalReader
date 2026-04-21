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

    getPlaybarIcon() {
        return this.playIcon;
    }

    // Cache all used DOM nodes once
    _cacheDOMElements() {
        this.serverLinkInput = document.getElementById("server-link");
        this.voiceSelect = document.getElementById("voice-select");
        this.speedSelect = document.getElementById("reading-speed");
        this.speedSelectValue = document.getElementById("reading-speed-value");

        this.btnNextSentence = document.getElementById("next-sentence");
        this.btnPrevSentence = document.getElementById("prev-sentence");
        this.btnPlayToggle = document.getElementById("play-toggle");
        this.btnNextPage = document.getElementById("next-page");
        this.btnPrevPage = document.getElementById("prev-page");
        this.bntHelp = document.getElementById("toggle-help") || document.getElementById("help-button");
        this.bntHelpClose = document.getElementById("help-close");
        this.bntFullScreen = document.getElementById("toggle-fullscreen");

        this.saveHighlightBtn = document.getElementById("save-highlight");
        this.saveCommentBtn = document.getElementById("save-comment");
        this.exportHighlightsBtn = document.getElementById("export-highlights");
        this.highlightColorButtons = Array.from(document.querySelectorAll(".highlight-color-option"));
        this.infoBox = document.getElementById("info-box");
        this.ttsStatus = document.getElementById("tts-status");
        this.overlayHelp = document.getElementById("help-overlay");
        this.controlsToolbar = document.getElementById("controls");
        this.lockBtn = document.getElementById("lock-screen");

        // Translate
        this.toggleTranslateBtn = document.getElementById("toggle-translate");

        // Read translation (use translated sentence for TTS)
        this.toggleReadTranslationBtn = document.getElementById("toggle-read-translation");

        // Default highlight color
        this.app.highlightManager?.setSelectedHighlightColor("#ffda76");
        const icon = this.saveHighlightBtn?.querySelector(".material-symbols-outlined");
        if (icon) {
            icon.style.color = "#ffda76";
        }

        // stopwatch
        this.autoStopInput = document.getElementById("stopwatch-input");
        this.btnPlayTimer = document.getElementById("btn-timer-play");
        this.btnStopTimer = document.getElementById("btn-timer-stop");
        this.btnTimerIncrease = document.getElementById("btn-timer-increase");
        this.btnTimerDecrease = document.getElementById("btn-timer-decrease");
    }

    _setupEventListeners() {
        const { app } = this;
        const on = (el, type, fn) => el && el.addEventListener(type, fn, { passive: true });
        const isAuthButton = (el) => {
            if (!el) return false;
            const label = (el.getAttribute("aria-label") || el.title || "").toLowerCase();
            return label.includes("login") || label.includes("account") || label.includes("auth");
        };
        const isTouchLikeDevice = () => {
            try {
                return (
                    (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) ||
                    (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0)
                );
            } catch {
                return false;
            }
        };
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
        on(this.bntHelp, "click", () => this.overlayHelp?.classList.remove("hidden"));
        on(this.bntHelpClose, "click", () => this.overlayHelp?.classList.add("hidden"));
        on(this.overlayHelp, "click", (e) => {
            if (e.target === this.overlayHelp) {
                this.overlayHelp.classList.add("hidden");
            }
        });

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
        if (this.saveHighlightBtn) {
            const LONG_PRESS_MS = 350;
            let longPressTimer = null;
            let longPressTriggered = false;

            // Avoid text selection / callout on long-press (mobile).
            try {
                this.saveHighlightBtn.style.userSelect = "none";
                this.saveHighlightBtn.style.webkitUserSelect = "none";
                this.saveHighlightBtn.style.webkitTouchCallout = "none";
                this.saveHighlightBtn.style.touchAction = "manipulation";
            } catch {}

            const clearLongPress = () => {
                if (longPressTimer) {
                    clearTimeout(longPressTimer);
                    longPressTimer = null;
                }
            };

            const startLongPress = () => {
                longPressTriggered = false;
                clearLongPress();
                longPressTimer = setTimeout(() => {
                    longPressTriggered = true;
                    // Use current highlight configuration (selected color etc.)
                    app.saveCurrentSentenceHighlight?.();
                }, LONG_PRESS_MS);
            };

            // Touch-only long press.
            if ("PointerEvent" in window) {
                this.saveHighlightBtn.addEventListener(
                    "pointerdown",
                    (e) => {
                        if (!isTouchLikeDevice()) return;
                        if (e.pointerType && e.pointerType !== "touch" && e.pointerType !== "pen") return;
                        // Prevent long-press text selection / callout.
                        e.preventDefault();
                        startLongPress();
                    },
                    { passive: false },
                );
                this.saveHighlightBtn.addEventListener(
                    "pointerup",
                    () => {
                        if (!isTouchLikeDevice()) return;
                        clearLongPress();
                    },
                    { passive: true },
                );
                this.saveHighlightBtn.addEventListener(
                    "pointercancel",
                    () => {
                        if (!isTouchLikeDevice()) return;
                        clearLongPress();
                    },
                    { passive: true },
                );
            } else {
                // Fallback for older mobile browsers
                this.saveHighlightBtn.addEventListener(
                    "touchstart",
                    (e) => {
                        if (!isTouchLikeDevice()) return;
                        // Prevent long-press text selection / callout.
                        e.preventDefault();
                        startLongPress();
                    },
                    { passive: false },
                );
                this.saveHighlightBtn.addEventListener(
                    "touchend",
                    () => {
                        if (!isTouchLikeDevice()) return;
                        clearLongPress();
                    },
                    { passive: true },
                );
                this.saveHighlightBtn.addEventListener(
                    "touchcancel",
                    () => {
                        if (!isTouchLikeDevice()) return;
                        clearLongPress();
                    },
                    { passive: true },
                );
            }

            // Short tap opens the menu; long press applies highlight and suppresses the click.
            this.saveHighlightBtn.addEventListener(
                "click",
                (e) => {
                    if (isTouchLikeDevice() && longPressTriggered) {
                        e.preventDefault();
                        e.stopPropagation();
                        longPressTriggered = false;
                        return;
                    }
                    app.ui?.showHighlightPopup?.();
                },
                { passive: false },
            );
        }
        // Note: the toolbar "person" button is used for Login/Account in index.html
        // (it currently reuses id="save-comment"). Avoid also opening comment UI on click.
        if (this.saveCommentBtn && !isAuthButton(this.saveCommentBtn)) {
            on(this.saveCommentBtn, "click", () => app.highlightManager.editCurrentSentenceComment());
        }
        on(this.exportHighlightsBtn, "click", () => app.exportManager.exportPdfWithHighlights());

        // Translate toggle (auto translate every spoken sentence)
        if (this.toggleTranslateBtn) {
            // Initialize UI from persisted value (app will also load into state).
            const raw = localStorage.getItem("config.autoTranslate");
            const enabled = raw === "1" || raw === "true";
            this.reflectAutoTranslateToggle(enabled);

            on(this.toggleTranslateBtn, "click", () => {
                const next = !app.isAutoTranslateEnabled?.();
                app.setAutoTranslateEnabled?.(next);
                this.showInfo(next ? "Auto-translate: ON" : "Auto-translate: OFF", 1500);
            });
        }

        // Read translation toggle (replace spoken text with translated text)
        if (this.toggleReadTranslationBtn) {
            const raw = localStorage.getItem("config.readTranslation");
            const enabled = raw === "1" || raw === "true";
            this.reflectReadTranslationToggle(enabled);

            on(this.toggleReadTranslationBtn, "click", () => {
                const next = !app.isReadTranslationEnabled?.();
                app.setReadTranslationEnabled?.(next);
                this.showInfo(next ? "Read translation: ON" : "Read translation: OFF", 1500);
            });
        }

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
                    KeyC: async () => {
                        // Don't hijack common browser/system shortcuts like Ctrl+C / Cmd+C.
                        if (e.ctrlKey || e.metaKey || e.altKey) return;
                        e.preventDefault();
                        const didSelection = await app.interactionHandler?.promptCommentForSelection?.();
                        if (!didSelection) await app.highlightManager?.editCurrentSentenceComment?.();
                    },
                    KeyT: () => app.translateCurrentSentence?.(),
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

        // Stop Watch
        this.btnPlayTimer.addEventListener("click", () => this._toggleTimer());
        this.btnStopTimer.addEventListener("click", () => this._stopTimer());
        this.btnTimerIncrease?.addEventListener("click", () => this._stepAutoStopMinutes(1));
        this.btnTimerDecrease?.addEventListener("click", () => this._stepAutoStopMinutes(-1));
        const commitAutoStopMinutes = () => this._applyAutoStopMinutes(this.autoStopInput?.value);
        this.autoStopInput.addEventListener("change", commitAutoStopMinutes);
        this.autoStopInput.addEventListener("blur", commitAutoStopMinutes);
        this.autoStopInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                commitAutoStopMinutes();
                this.autoStopInput.blur();
            }
        });

        // Server Link Configuration
        if (this.serverLinkInput) {
            // Load saved server link from localStorage
            const savedServerLink = localStorage.getItem("config.serverLink");
            if (savedServerLink) {
                this.serverLinkInput.value = savedServerLink;
                this.showInfo("Loaded saved server link");
            }

            // Save server link on change
            on(this.serverLinkInput, "change", () => {
                const serverLink = this.serverLinkInput.value.trim();
                if (serverLink) {
                    localStorage.setItem("config.serverLink", serverLink);
                    this.showInfo("Server link saved");
                } else {
                    localStorage.removeItem("config.serverLink");
                }
            });
        }
    }

    reflectAutoTranslateToggle(enabled) {
        if (!this.toggleTranslateBtn) return;

        const active = !!enabled;
        this.toggleTranslateBtn.setAttribute("aria-pressed", active ? "true" : "false");

        // Match the styling used by other toggles (e.g. fullscreen).
        this.toggleTranslateBtn.classList.toggle("bg-primary/10", active);
        this.toggleTranslateBtn.classList.toggle("text-primary", active);
    }

    reflectReadTranslationToggle(enabled) {
        if (!this.toggleReadTranslationBtn) return;
        const active = !!enabled;
        this.toggleReadTranslationBtn.setAttribute("aria-pressed", active ? "true" : "false");
        this.toggleReadTranslationBtn.classList.toggle("bg-primary/10", active);
        this.toggleReadTranslationBtn.classList.toggle("text-primary", active);
    }

    orientationChange() {
        if (this.isLocked) return; // don't alter layout when orientation is locked

        if (this._orientationTimer) clearTimeout(this._orientationTimer);
        this._orientationTimer = setTimeout(async () => {
            const { state, pdfRenderer } = this.app;
            if (!state?.pdf || !pdfRenderer) return;

            const container = document.getElementById("pdf-doc-container");
            const containerWidth = Math.max(1, container?.clientWidth || window.innerWidth);
            if (this._lastContainerWidth && Math.abs(containerWidth - this._lastContainerWidth) < 2) {
                // width didn't change meaningfully; skip work
                return;
            }
            this._lastContainerWidth = containerWidth;

            try {
                await pdfRenderer.refreshPdfRendering({ containerWidth, forceFullRescale: true });
            } catch (err) {
                console.warn("[orientationChange] Refresh failed", err);
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

        try {
            if (!isFull) {
                await requestFull.call(docEl);
                await this.enableWakeLock();
                this.bntFullScreen.classList.add("bg-primary/10", "text-primary");
            } else {
                await exitFull.call(doc);
                this.disableWakeLock();
                this.bntFullScreen.classList.remove("bg-primary/10", "text-primary");
            }
        } catch (err) {
            console.warn("[toggleFullscreen] Fullscreen toggle failed", err);
        }

        this._lastContainerWidth = null;
        if (this.app?.pdfRenderer?.refreshPdfRendering) {
            try {
                await this.app.pdfRenderer.refreshPdfRendering({ forceFullRescale: true });
            } catch (err) {
                console.warn("[toggleFullscreen] Refresh failed", err);
            }
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

    _applyAutoStopMinutes(rawValue) {
        const parsed = Number.parseInt(String(rawValue ?? "").trim(), 10);
        if (!Number.isFinite(parsed)) {
            this._updateTimerDisplay();
            return false;
        }

        const minutes = Math.min(720, Math.max(1, parsed));
        this.autoStopDuration = minutes * 60;
        this.timeLeft = this.autoStopDuration;
        this._updateTimerDisplay();
        return true;
    }

    _stepAutoStopMinutes(delta = 1) {
        if (!this.autoStopInput) return;
        const currentRaw = Number.parseInt(String(this.autoStopInput.value || "").trim(), 10);
        const fallbackMinutes = Math.max(1, Math.ceil(this.timeLeft / 60));
        const current = Number.isFinite(currentRaw) ? currentRaw : fallbackMinutes;
        const next = Math.min(720, Math.max(1, current + delta));
        this.autoStopInput.value = String(next);
        this._applyAutoStopMinutes(next);
    }

    _updateTimerDisplay() {
        if (!this.autoStopInput) return;
        // Minutes-only UI: avoid second-level churn on small/mobile screens.
        const minutes = Math.max(1, Math.ceil(this.timeLeft / 60));
        this.autoStopInput.value = String(minutes);
    }

    showInfo(message, duration = 2000) {
        if (!this.infoBox) return;
        this.infoBox.textContent = message;
        this.infoBox.classList.remove("hidden");
        setTimeout(() => this.infoBox.classList.add("hidden"), duration);
    }

    getServerLink() {
        return localStorage.getItem("config.serverLink") || "";
    }
}
