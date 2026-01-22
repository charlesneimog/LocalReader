// Helper UI functions (info/status) separated for reuse
export class UIService {
    constructor(app) {
        this.app = app;
        this.infoBox = document.getElementById("info-box");
        this.fatalErrorBox = document.getElementById("fatal-error");
        this.hideMessageTimeout = null;
        this.hideErrorTimeout = null;
        this.playBarIcon = document.querySelector("#play-toggle span.material-symbols-outlined");

        this._translatePopupEl = null;
        this._translatePopupCleanup = null;

        this._commentPopupEl = null;
        this._commentPopupCleanup = null;

        this._highlightPopupEl = null;
        this._highlightPopupCleanup = null;
    }

    _hideTranslatePopup() {
        if (this._translatePopupEl) {
            this._translatePopupEl.remove();
            this._translatePopupEl = null;
        }
        if (typeof this._translatePopupCleanup === "function") {
            this._translatePopupCleanup();
            this._translatePopupCleanup = null;
        }
    }

    _hideCommentPopup() {
        if (this._commentPopupEl) {
            this._commentPopupEl.remove();
            this._commentPopupEl = null;
        }
        if (typeof this._commentPopupCleanup === "function") {
            this._commentPopupCleanup();
            this._commentPopupCleanup = null;
        }
    }

    _hideHighlightPopup() {
        if (this._highlightPopupEl) {
            this._highlightPopupEl.remove();
            this._highlightPopupEl = null;
        }
        if (typeof this._highlightPopupCleanup === "function") {
            this._highlightPopupCleanup();
            this._highlightPopupCleanup = null;
        }
    }

    showHighlightPopup() {
        this._hideHighlightPopup();

        const { app } = this;
        const { state } = app;
        if (!state?.sentences?.length) {
            this.showInfo?.("Load a document first");
            return;
        }

        const getActiveIndex = () =>
            typeof state.playingSentenceIndex === "number" && state.playingSentenceIndex >= 0
                ? state.playingSentenceIndex
                : state.currentSentenceIndex;

        const idx = getActiveIndex();
        if (!Number.isFinite(idx) || idx < 0 || idx >= state.sentences.length) return;

        const getCurrent = () => (state.savedHighlights?.get?.(idx) ? state.savedHighlights.get(idx) : null);
        const hasHighlight = () => !!getCurrent()?.color;
        const currentComment = () => {
            const c = getCurrent()?.comment;
            return typeof c === "string" ? c : "";
        };

        const persistAndRefresh = ({ allowEmpty = true } = {}) => {
            try {
                app.highlightsStorage?.saveHighlightsForPdf?.({ allowEmpty });
            } catch {}
            try {
                if (state.currentDocumentType === "epub") {
                    app.epubRenderer?.updateHighlightDisplay?.();
                } else {
                    app.pdfRenderer?.updateHighlightFullDoc?.();
                }
            } catch {}
        };

        const wrap = document.createElement("div");
        wrap.className =
            "fixed z-50 bottom-20 left-1/2 -translate-x-1/2 w-[92vw] max-w-md rounded-lg " +
            "bg-background-light dark:bg-background-dark bg-opacity-100 " +
            "px-3 py-2 shadow-lg border border-slate-200 dark:border-slate-700";
        wrap.style.zIndex = "10000";

        const header = document.createElement("div");
        header.className = "flex items-center justify-between gap-2 mb-2";

        const left = document.createElement("div");
        left.className = "flex items-center gap-2 min-w-0";

        const hiIcon = document.createElement("span");
        hiIcon.className = "material-symbols-outlined";
        hiIcon.textContent = "format_ink_highlighter";
        hiIcon.style.color = state.selectedHighlightColor || getCurrent()?.color || "#ffda76";

        const title = document.createElement("div");
        title.className = "text-sm font-semibold text-slate-800 dark:text-slate-100 truncate";
        title.textContent = `Highlight · Sentence ${idx + 1}`;

        left.appendChild(hiIcon);
        left.appendChild(title);

        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.className =
            "p-1 rounded-full text-slate-500 dark:text-slate-400 hover:text-primary dark:hover:text-primary";
        const closeIcon = document.createElement("span");
        closeIcon.className = "material-symbols-outlined";
        closeIcon.textContent = "close";
        closeBtn.appendChild(closeIcon);

        header.appendChild(left);
        header.appendChild(closeBtn);

        const body = document.createElement("div");
        body.className = "space-y-2";

        const colorRow = document.createElement("div");
        colorRow.className = "flex items-center justify-between gap-2";

        const presets = ["#ffda76", "#F44336", "#81C784", "#4FC3F7"];
        const presetWrap = document.createElement("div");
        presetWrap.className = "flex items-center gap-2";

        const setColor = (color) => {
            const c = String(color || "").trim();
            if (!c) return;

            // Update selected color (and icon tint)
            try {
                app.highlightManager?.setSelectedHighlightColor?.(c);
            } catch {
                state.selectedHighlightColor = c;
            }
            hiIcon.style.color = c;

            // If already highlighted, also recolor the existing highlight
            const cur = getCurrent();
            if (cur?.color) {
                state.savedHighlights.set(idx, { ...cur, color: c });
                persistAndRefresh();
            }
        };

        for (const p of presets) {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "h-6 w-6 rounded-full border border-slate-300 dark:border-slate-600";
            b.style.backgroundColor = p;
            b.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                setColor(p);
                colorPicker.value = p;
            });
            presetWrap.appendChild(b);
        }

        const colorPicker = document.createElement("input");
        colorPicker.type = "color";
        colorPicker.className = "h-8 w-10 bg-transparent";
        colorPicker.value = state.selectedHighlightColor || getCurrent()?.color || "#ffda76";
        colorPicker.addEventListener("input", () => setColor(colorPicker.value));

        colorRow.appendChild(presetWrap);
        colorRow.appendChild(colorPicker);

        const actions = document.createElement("div");
        actions.className = "flex items-center justify-between gap-2";

        const toggleBtn = document.createElement("button");
        toggleBtn.type = "button";
        toggleBtn.className =
            "rounded-md px-3 py-2 text-sm border border-slate-200 dark:border-slate-700 " +
            "text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-white/5";

        const status = document.createElement("div");
        status.className = "text-xs text-slate-500 dark:text-slate-400";

        const syncUI = () => {
            const on = hasHighlight();
            toggleBtn.textContent = on ? "Remove highlight" : "Add highlight";
            status.textContent = on ? "Highlighted" : "Not highlighted";

            const c = currentComment().trim();
            commentArea.value = c;
            removeCommentBtn.disabled = !c;
        };

        toggleBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();

            const sentenceText = state.sentences[idx]?.text || "";
            const cur = getCurrent() || {};
            if (hasHighlight()) {
                state.savedHighlights.delete(idx);
                persistAndRefresh({ allowEmpty: true });
            } else {
                const color = state.selectedHighlightColor || colorPicker.value || "#ffda76";
                state.savedHighlights.set(idx, {
                    ...cur,
                    color,
                    timestamp: cur.timestamp || Date.now(),
                    text: cur.text || sentenceText,
                    sentenceText: cur.sentenceText || sentenceText,
                    comment: typeof cur.comment === "string" ? cur.comment : undefined,
                });
                persistAndRefresh();
            }
            syncUI();
        });

        actions.appendChild(toggleBtn);
        actions.appendChild(status);

        const commentArea = document.createElement("textarea");
        commentArea.className =
            "w-full min-h-[64px] rounded-md border border-slate-200 dark:border-slate-700 " +
            "bg-white/80 dark:bg-black/20 text-slate-900 dark:text-slate-100 " +
            "px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary";
        commentArea.placeholder = "Comment (optional)…";

        const commentActions = document.createElement("div");
        commentActions.className = "flex items-center justify-between gap-2";

        const removeCommentBtn = document.createElement("button");
        removeCommentBtn.type = "button";
        removeCommentBtn.className =
            "rounded-md px-3 py-2 text-sm border border-slate-200 dark:border-slate-700 " +
            "text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-white/5";
        removeCommentBtn.textContent = "Remove comment";

        const saveCommentBtn = document.createElement("button");
        saveCommentBtn.type = "button";
        saveCommentBtn.className = "rounded-md px-3 py-2 text-sm bg-primary text-white hover:opacity-95";
        saveCommentBtn.textContent = "Save comment";

        const upsertComment = (nextComment) => {
            const sentenceText = state.sentences[idx]?.text || "";
            const cur = getCurrent() || {};
            const color = cur.color || state.selectedHighlightColor || colorPicker.value || "#ffda76";

            const next = {
                ...cur,
                color,
                timestamp: cur.timestamp || Date.now(),
                text: cur.text || sentenceText,
                sentenceText: cur.sentenceText || sentenceText,
            };

            if (nextComment) {
                next.comment = nextComment;
            } else {
                delete next.comment;
            }

            state.savedHighlights.set(idx, next);
            persistAndRefresh();
        };

        saveCommentBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const next = String(commentArea.value || "").trim();
            if (!next) return;
            upsertComment(next);
            syncUI();
        });

        removeCommentBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const cur = getCurrent();
            if (!cur) return;
            const next = { ...cur };
            delete next.comment;
            if (next.color) {
                state.savedHighlights.set(idx, next);
            }
            persistAndRefresh({ allowEmpty: true });
            syncUI();
        });

        commentActions.appendChild(removeCommentBtn);
        commentActions.appendChild(saveCommentBtn);

        body.appendChild(colorRow);
        body.appendChild(actions);
        body.appendChild(commentArea);
        body.appendChild(commentActions);

        wrap.appendChild(header);
        wrap.appendChild(body);
        document.body.appendChild(wrap);
        this._highlightPopupEl = wrap;

        const close = () => this._hideHighlightPopup();
        closeBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            close();
        });

        const onKey = (e) => {
            if (e.key === "Escape") close();
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                const next = String(commentArea.value || "").trim();
                if (next) {
                    upsertComment(next);
                    syncUI();
                }
            }
        };
        const onDown = (e) => {
            if (!this._highlightPopupEl) return;
            if (e.target === this._highlightPopupEl || this._highlightPopupEl.contains(e.target)) return;
            close();
        };

        window.addEventListener("keydown", onKey, { passive: true });
        window.addEventListener("mousedown", onDown, { capture: true });
        this._highlightPopupCleanup = () => {
            window.removeEventListener("keydown", onKey);
            window.removeEventListener("mousedown", onDown, { capture: true });
        };

        syncUI();

        setTimeout(() => {
            try {
                commentArea.focus();
            } catch {}
        }, 0);
    }

    async showCommentPopup({
        title = "Comment",
        initialText = "",
        placeholder = "Write a comment...",
        allowRemove = false,
    } = {}) {
        this._hideCommentPopup();

        return await new Promise((resolve) => {
            const wrap = document.createElement("div");
            wrap.className =
                "fixed z-50 bottom-24 left-1/2 -translate-x-1/2 w-[92vw] max-w-2xl rounded-lg " +
                "bg-background-light dark:bg-background-dark bg-opacity-100 " +
                "px-4 py-3 shadow-lg border border-slate-200 dark:border-slate-700";
            wrap.style.zIndex = "10000";

            const header = document.createElement("div");
            header.className = "flex items-center justify-between gap-3 mb-2";

            const titleEl = document.createElement("div");
            titleEl.className = "text-sm font-semibold text-slate-800 dark:text-slate-100";
            titleEl.textContent = title;

            const actions = document.createElement("div");
            actions.className = "flex items-center gap-2";

            const closeBtn = document.createElement("button");
            closeBtn.type = "button";
            closeBtn.className =
                "p-1 rounded-full text-slate-500 dark:text-slate-400 hover:text-primary dark:hover:text-primary";
            const closeIcon = document.createElement("span");
            closeIcon.className = "material-symbols-outlined";
            closeIcon.textContent = "close";
            closeBtn.appendChild(closeIcon);

            const resolveAndClose = (result) => {
                this._hideCommentPopup();
                resolve(result);
            };

            closeBtn.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                resolveAndClose(null);
            });

            actions.appendChild(closeBtn);
            header.appendChild(titleEl);
            header.appendChild(actions);

            const body = document.createElement("div");
            body.className = "space-y-3";

            const textarea = document.createElement("textarea");
            textarea.className =
                "w-full min-h-[96px] rounded-md border border-slate-200 dark:border-slate-700 " +
                "bg-white/80 dark:bg-black/20 text-slate-900 dark:text-slate-100 " +
                "px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary";
            textarea.placeholder = placeholder;
            textarea.value = typeof initialText === "string" ? initialText : "";

            const footer = document.createElement("div");
            footer.className = "flex items-center justify-between gap-2 pt-1";

            const left = document.createElement("div");
            left.className = "flex items-center gap-2";

            const right = document.createElement("div");
            right.className = "flex items-center gap-2";

            const cancelBtn = document.createElement("button");
            cancelBtn.type = "button";
            cancelBtn.className =
                "rounded-md px-3 py-2 text-sm border border-slate-200 dark:border-slate-700 " +
                "text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-white/5";
            cancelBtn.textContent = "Cancel";
            cancelBtn.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                resolveAndClose(null);
            });

            const saveBtn = document.createElement("button");
            saveBtn.type = "button";
            saveBtn.className =
                "rounded-md px-3 py-2 text-sm bg-primary text-white hover:opacity-95";
            saveBtn.textContent = "Save";
            saveBtn.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                resolveAndClose({ action: "save", text: String(textarea.value || "").trim() });
            });

            if (allowRemove) {
                const removeBtn = document.createElement("button");
                removeBtn.type = "button";
                removeBtn.className =
                    "rounded-md px-3 py-2 text-sm border border-red-200 dark:border-red-800 " +
                    "text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20";
                removeBtn.textContent = "Remove";
                removeBtn.addEventListener("click", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    resolveAndClose({ action: "remove" });
                });
                left.appendChild(removeBtn);
            }

            right.appendChild(cancelBtn);
            right.appendChild(saveBtn);
            footer.appendChild(left);
            footer.appendChild(right);

            body.appendChild(textarea);
            body.appendChild(footer);

            wrap.appendChild(header);
            wrap.appendChild(body);
            document.body.appendChild(wrap);
            this._commentPopupEl = wrap;

            // Focus textarea shortly after mount
            setTimeout(() => {
                try {
                    textarea.focus();
                    const len = textarea.value.length;
                    textarea.setSelectionRange(len, len);
                } catch {}
            }, 0);

            const onKey = (e) => {
                if (e.key === "Escape") resolveAndClose(null);
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                    resolveAndClose({ action: "save", text: String(textarea.value || "").trim() });
                }
            };
            const onDown = (e) => {
                if (!this._commentPopupEl) return;
                if (e.target === this._commentPopupEl || this._commentPopupEl.contains(e.target)) return;
                resolveAndClose(null);
            };

            window.addEventListener("keydown", onKey, { passive: true });
            window.addEventListener("mousedown", onDown, { capture: true });
            this._commentPopupCleanup = () => {
                window.removeEventListener("keydown", onKey);
                window.removeEventListener("mousedown", onDown, { capture: true });
            };
        });
    }

    async showTranslatePopup({ originalText = "", translatedText = "", target = "", detectedSource = "" } = {}) {
        this._hideTranslatePopup();

        const wrap = document.createElement("div");
        wrap.className =
            "fixed z-40 bottom-24 left-1/2 -translate-x-1/2 w-[92vw] max-w-2xl rounded-lg " +
            "bg-background-light dark:bg-background-dark bg-opacity-100 " +
            "px-4 py-3 shadow-lg border border-slate-200 dark:border-slate-700";

        // zindex must be on front of all other elements
        wrap.style.zIndex = "10000";

        const header = document.createElement("div");
        header.className = "flex items-center justify-between gap-3 mb-2";

        const title = document.createElement("div");
        title.className = "text-sm font-semibold text-slate-800 dark:text-slate-100";
        const langPart = target ? ` → ${target}` : "";
        title.textContent = `Translation${langPart}`;

        const actions = document.createElement("div");
        actions.className = "flex items-center gap-2";

        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        if (!document.getElementById("config-menu-close")) {
            closeBtn.id = "config-menu-close";
        }
        closeBtn.className =
            "p-1 rounded-full text-slate-500 dark:text-slate-400 hover:text-primary dark:hover:text-primary";
        const closeIcon = document.createElement("span");
        closeIcon.className = "material-symbols-outlined";
        closeIcon.textContent = "close";
        closeBtn.appendChild(closeIcon);
        closeBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._hideTranslatePopup();
        });

        actions.appendChild(closeBtn);

        header.appendChild(title);
        header.appendChild(actions);

        const body = document.createElement("div");
        body.className = "space-y-2";

        const tText = document.createElement("div");
        //tText.className = "text-sm font-medium text-slate-900 dark:text-white";
        tText.className = "text-lg font-medium text-slate-900 dark:text-white";

        tText.textContent = translatedText || "(empty)";
        body.appendChild(tText);

        wrap.appendChild(header);
        wrap.appendChild(body);
        document.body.appendChild(wrap);
        this._translatePopupEl = wrap;

        const onKey = (e) => {
            if (e.key === "Escape") this._hideTranslatePopup();
        };
        const onDown = (e) => {
            if (!this._translatePopupEl) return;
            if (e.target === this._translatePopupEl || this._translatePopupEl.contains(e.target)) return;
            this._hideTranslatePopup();
        };

        window.addEventListener("keydown", onKey, { passive: true });
        window.addEventListener("mousedown", onDown, { capture: true });
        this._translatePopupCleanup = () => {
            window.removeEventListener("keydown", onKey);
            window.removeEventListener("mousedown", onDown, { capture: true });
        };
    }

    showInfo(msg) {
        if (!this.infoBox) {
            console.log(msg);
            return;
        }

        // Mostra a mensagem
        this.infoBox.textContent = msg;
        this.infoBox.style.display = "block";
        this.isLoading = false;

        // Cancela qualquer timeout anterior
        clearTimeout(this.hideMessageTimeout);

        // Inicia novo timeout para esconder depois de 2s
        this.hideMessageTimeout = setTimeout(() => {
            this.infoBox.style.display = "none";
        }, 5000);
    }

    showMessage(msg, duration = 5000) {
        if (!this.infoBox) {
            console.log(msg);
            return;
        }

        this.infoBox.textContent = msg;
        this.infoBox.style.display = "block";
        this.isLoading = false;

        clearTimeout(this.hideMessageTimeout);

        const ms = Number.isFinite(duration) ? Math.max(0, duration) : 5000;
        if (ms > 0) {
            this.hideMessageTimeout = setTimeout(() => {
                this.infoBox.style.display = "none";
            }, ms);
        }
    }

    updatePlayButton(value) {
        const { state } = this.app;
        if (!this.playBarIcon) return;

        if (value === state.playerState.LOADING) {
            this.isLoading = true;
            this.playBarIcon.textContent = "hourglass_empty";
            this.playBarIcon.classList.add("animate-spin");
            return;
        }

        this.isLoading = false;
        this.playBarIcon.classList.remove("animate-spin");

        switch (value) {
            case state.playerState.PLAY:
                this.playBarIcon.textContent = "pause";
                return;
            case state.playerState.PAUSE:
            case state.playerState.STOP:
                this.playBarIcon.textContent = "play_arrow";
                return;
            default:
                this.playBarIcon.textContent = state.isPlaying ? "pause" : "play_arrow";
        }
    }

    showFatalError(msg) {
        if (!this.fatalErrorBox) {
            alert(msg);
        }

        // Mostra a mensagem
        this.fatalErrorBox.textContent = msg;
        this.fatalErrorBox.style.display = "block";

        // Cancela qualquer timeout anterior
        clearTimeout(this.hideErrorTimeout);

        // Inicia novo timeout para esconder depois de 2s
        this.hideErrorTimeout = setTimeout(() => {
            this.fatalErrorBox.style.display = "none";
        }, 30000);
    }
}
