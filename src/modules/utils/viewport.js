const CSS_VH_VARIABLE = "--vh";
const DEFAULT_DEBOUNCE_MS = 100;

function debounce(fn, delay = DEFAULT_DEBOUNCE_MS) {
    let frame = null;
    return (...args) => {
        if (frame) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
            frame = null;
            fn(...args);
        });
    };
}

export class ViewportHeightManager {
    constructor(options = {}) {
        this.onChange = new Set();
        if (typeof options.onChange === "function") this.onChange.add(options.onChange);
        this._handleResize = debounce(this._handleResize.bind(this));
        this._handleVisualViewport = debounce(this._handleVisualViewport.bind(this));
        this._lastHeight = null;
        this._started = false;
    }

    start() {
        if (this._started) return;
        this._started = true;
        this._updateCssVariable(this.getDynamicHeight());
        window.addEventListener("resize", this._handleResize, { passive: true });
        window.addEventListener("orientationchange", this._handleResize, { passive: true });
        if (window.visualViewport) {
            window.visualViewport.addEventListener("resize", this._handleVisualViewport, { passive: true });
            window.visualViewport.addEventListener("scroll", this._handleVisualViewport, { passive: true });
        }
    }

    stop() {
        if (!this._started) return;
        this._started = false;
        window.removeEventListener("resize", this._handleResize);
        window.removeEventListener("orientationchange", this._handleResize);
        if (window.visualViewport) {
            window.visualViewport.removeEventListener("resize", this._handleVisualViewport);
            window.visualViewport.removeEventListener("scroll", this._handleVisualViewport);
        }
    }

    getDynamicHeight() {
        const height = window.visualViewport ? window.visualViewport.height : window.innerHeight;
        return Math.round(height);
    }

    getCurrentHeight() {
        return this._lastHeight ?? this.getDynamicHeight();
    }

    addListener(listener) {
        if (typeof listener === "function") this.onChange.add(listener);
    }

    removeListener(listener) {
        this.onChange.delete(listener);
    }

    _handleResize() {
        this._updateCssVariable(this.getDynamicHeight());
    }

    _handleVisualViewport() {
        this._updateCssVariable(this.getDynamicHeight());
    }

    _updateCssVariable(height) {
        if (!Number.isFinite(height)) return;
        if (height === this._lastHeight) return;
        this._lastHeight = height;
        const vh = height * 0.01;
        document.documentElement.style.setProperty(CSS_VH_VARIABLE, `${vh}px`);
        this._notify(height);
    }

    _notify(height) {
        for (const listener of this.onChange) {
            try {
                listener(height);
            } catch (err) {
                console.warn("[ViewportHeightManager] Listener error", err);
            }
        }
    }
}

export const viewportHeightManager = new ViewportHeightManager();
