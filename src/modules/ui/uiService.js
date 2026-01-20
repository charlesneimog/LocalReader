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
