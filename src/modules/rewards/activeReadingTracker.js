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
        performanceNow = () => performance.now(),
        documentObject = globalThis.document,
        windowObject = globalThis.window,
        setIntervalFn = globalThis.setInterval,
        clearIntervalFn = globalThis.clearInterval,
    } = {}) {
        this.config = config;
        this.onDelta = onDelta;
        this.onIdle = onIdle;
        this.onActivityResumed = onActivityResumed;
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
    }

    start() {
        if (this.timer) return;
        const now = this.performanceNow();
        this.lastTickAt = now;
        this.lastActivityAt = now;
        this.timer = this.setIntervalFn(() => this.tick(), this.config.tickIntervalMs);
    }

    stop() {
        if (this.timer) this.clearIntervalFn(this.timer);
        this.timer = null;
        this.lastTickAt = null;
    }

    setDocumentOpen(open) {
        this.documentOpen = !!open;
        if (open) this.recordActivity("document-opened");
    }

    setReadingScreen(reading) {
        this.readingScreen = !!reading;
    }

    setPaused(paused) {
        this.explicitlyPaused = !!paused;
        this.lastTickAt = this.performanceNow();
        if (!paused) this.recordActivity("session-resumed");
    }

    setTtsPlaying(playing) {
        this.ttsPlaying = !!playing;
        if (playing) this.recordActivity("tts-playback");
    }

    recordActivity(source = "interaction") {
        const wasIdle = this.idle;
        this.lastActivityAt = this.performanceNow();
        this.idle = false;
        if (wasIdle && !this.explicitlyPaused) this.onActivityResumed?.({ source });
    }

    isEligible(now = this.performanceNow()) {
        const visible = !this.documentObject || this.documentObject.visibilityState !== "hidden";
        const focused = !this.documentObject?.hasFocus || this.documentObject.hasFocus();
        const withinIdleWindow = this.ttsPlaying || now - this.lastActivityAt <= this.config.idleTimeoutMs;
        return (
            this.documentOpen &&
            this.readingScreen &&
            !this.explicitlyPaused &&
            visible &&
            focused &&
            withinIdleWindow
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
            this.onIdle?.();
        }
        if (!this.isEligible(now)) return 0;
        const acceptedDelta = Math.min(rawDelta, this.config.maxAcceptedDeltaMs);
        if (acceptedDelta > 0) this.onDelta?.(acceptedDelta);
        return acceptedDelta;
    }

    checkpoint() {
        this.tick(this.performanceNow());
    }
}
