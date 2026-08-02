/**
 * Owns the monotonic active-reading clock. EventBus activity signals only
 * refresh idle eligibility; they never carry rewardable durations.
 */
export class ActiveReadingTracker {
    constructor({
        config,
        onDelta,
        onIdle,
        onActivityResumed,
        onInterrupted,
        performanceNow = () => performance.now(),
        documentObject = globalThis.document,
        windowObject = globalThis.window,
        // Window timers require Window as their receiver in Firefox. Wrapping
        // them also keeps dependency injection available for fake timers.
        setIntervalFn = (...args) => globalThis.setInterval(...args),
        clearIntervalFn = (...args) => globalThis.clearInterval(...args),
    } = {}) {
        this.config = config;
        this.onDelta = onDelta;
        this.onIdle = onIdle;
        this.onActivityResumed = onActivityResumed;
        this.onInterrupted = onInterrupted;
        this.performanceNow = performanceNow;
        this.documentObject = documentObject;
        this.windowObject = windowObject;
        this.setIntervalFn = setIntervalFn;
        this.clearIntervalFn = clearIntervalFn;
        this.documentOpen = false;
        this.readingScreen = false;
        this.explicitlyPaused = true;
        this.ttsPlaying = false;
        this.lastActivityAt = 0;
        this.lastTickAt = null;
        this.idle = false;
        this.timer = null;
        this.continuityBroken = true;
        this.focusListenersBound = false;
    }

    start() {
        if (this.timer) return;
        const now = this.performanceNow();
        this.lastTickAt = now;
        this.lastActivityAt = now;
        this.continuityBroken = !this.isEligible(now);
        this._bindFocusListeners();
        this.timer = this.setIntervalFn(() => this.tick(), this.config.tickIntervalMs);
    }

    stop() {
        if (this.timer) this.clearIntervalFn(this.timer);
        this.timer = null;
        this.lastTickAt = null;
        this._unbindFocusListeners();
    }

    setDocumentOpen(open) {
        const wasOpen = this.documentOpen;
        this.documentOpen = !!open;
        if (open) this.recordActivity("document-opened");
        else if (wasOpen) this._interrupt("document-closed");
    }

    setReadingScreen(reading) {
        const next = !!reading;
        if (next === this.readingScreen) return;
        const now = this.performanceNow();
        if (!next && this.readingScreen && this.ttsPlaying) this.tick(now);
        this.readingScreen = next;
        this.lastTickAt = now;
        if (!next) this.continuityBroken = true;
        else if (this.isEligible()) this.continuityBroken = false;
    }

    setPaused(paused) {
        this.explicitlyPaused = !!paused;
        this.lastTickAt = this.performanceNow();
        if (paused) this.continuityBroken = true;
        else {
            this.recordActivity("session-resumed");
            if (this.isEligible()) this.continuityBroken = false;
        }
    }

    setTtsPlaying(playing) {
        const next = !!playing;
        const now = this.performanceNow();
        if (!next && this.ttsPlaying) this.tick(now);
        this.ttsPlaying = next;
        this.lastTickAt = now;
        if (next) {
            this.recordActivity("tts-playback");
            if (this.isEligible()) this.continuityBroken = false;
        } else {
            // A stopped player is an allowed pause. It freezes the current tree
            // and prevents a subsequent window blur from resetting its progress.
            this.continuityBroken = true;
        }
    }

    recordActivity(source = "interaction") {
        const wasIdle = this.idle;
        this.lastActivityAt = this.performanceNow();
        this.idle = false;
        if (this.isEligible()) this.continuityBroken = false;
        if (wasIdle && !this.explicitlyPaused) this.onActivityResumed?.({ source });
    }

    isEligible(now = this.performanceNow()) {
        const visible = !this.documentObject || this.documentObject.visibilityState !== "hidden";
        const focused = !this.documentObject?.hasFocus || this.documentObject.hasFocus();
        return (
            this.documentOpen &&
            this.readingScreen &&
            !this.explicitlyPaused &&
            this.ttsPlaying &&
            visible &&
            focused
        );
    }

    tick(now = this.performanceNow()) {
        if (this.lastTickAt === null) {
            this.lastTickAt = now;
            return 0;
        }
        const rawDelta = Math.max(0, now - this.lastTickAt);
        this.lastTickAt = now;
        const inactiveFromIdle = !this.ttsPlaying && now - this.lastActivityAt > this.config.idleTimeoutMs;
        if (inactiveFromIdle && !this.idle && !this.explicitlyPaused) {
            this.idle = true;
            this.continuityBroken = true;
            this.onIdle?.();
        }
        if (!this.isEligible(now)) {
            if (!inactiveFromIdle && !this.explicitlyPaused && this.ttsPlaying) {
                this._interrupt(this._ineligibilityReason(now));
            }
            return 0;
        }
        this.continuityBroken = false;
        const acceptedDelta = Math.min(rawDelta, this.config.maxAcceptedDeltaMs);
        if (acceptedDelta > 0) this.onDelta?.(acceptedDelta);
        return acceptedDelta;
    }

    checkpoint() {
        this.tick(this.performanceNow());
    }

    _ineligibilityReason(now = this.performanceNow()) {
        if (!this.documentOpen) return "document-closed";
        if (!this.readingScreen) return "left-reader";
        if (this.documentObject?.visibilityState === "hidden") return "tab-hidden";
        if (this.documentObject?.hasFocus && !this.documentObject.hasFocus()) return "focus-lost";
        if (!this.ttsPlaying && now - this.lastActivityAt > this.config.idleTimeoutMs) return "idle";
        return "interrupted";
    }

    _interrupt(reason) {
        if (this.continuityBroken) return;
        this.continuityBroken = true;
        this.lastTickAt = this.performanceNow();
        this.onInterrupted?.({ reason });
    }

    _bindFocusListeners() {
        if (this.focusListenersBound) return;
        this.visibilityHandler = () => {
            if (this.documentObject?.visibilityState === "hidden") this._interrupt("tab-hidden");
            else this._restartContinuityClock();
        };
        this.blurHandler = () => this._interrupt("focus-lost");
        this.focusHandler = () => this._restartContinuityClock();
        this.pageHideHandler = () => this._interrupt("page-left");
        this.documentObject?.addEventListener?.("visibilitychange", this.visibilityHandler);
        this.windowObject?.addEventListener?.("blur", this.blurHandler);
        this.windowObject?.addEventListener?.("focus", this.focusHandler);
        this.windowObject?.addEventListener?.("pagehide", this.pageHideHandler);
        this.focusListenersBound = true;
    }

    _unbindFocusListeners() {
        if (!this.focusListenersBound) return;
        this.documentObject?.removeEventListener?.("visibilitychange", this.visibilityHandler);
        this.windowObject?.removeEventListener?.("blur", this.blurHandler);
        this.windowObject?.removeEventListener?.("focus", this.focusHandler);
        this.windowObject?.removeEventListener?.("pagehide", this.pageHideHandler);
        this.focusListenersBound = false;
    }

    _restartContinuityClock() {
        this.lastTickAt = this.performanceNow();
        if (this.isEligible()) this.continuityBroken = false;
    }
}
