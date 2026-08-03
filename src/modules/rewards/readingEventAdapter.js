import { EVENTS } from "../../constants/events.js";

/** Normalizes existing reader state and trusted activity signals. */
export class ReadingEventAdapter {
    constructor({ app, tracker }) {
        this.app = app;
        this.tracker = tracker;
        this.unsubscribers = [];
        this.domListeners = [];
    }

    getDocumentDescriptor() {
        const { state } = this.app;
        const type = state.currentDocumentType;
        if (type !== "pdf" && type !== "epub") return null;
        const id = type === "epub" ? state.currentEpubKey : state.currentPdfKey;
        if (!id || (type === "pdf" ? !state.pdf : !state.epub)) return null;
        const sentenceIndex = Math.max(0, Number(state.currentSentenceIndex) || 0);
        return {
            id,
            type,
            title: state.bookTitle || state.currentPdfDescriptor?.name || state.currentEpubDescriptor?.name || "Untitled",
            currentLocation: sentenceIndex,
            progress: state.sentences.length ? sentenceIndex / state.sentences.length : 0,
        };
    }

    start() {
        const opened = () => this.documentOpened();
        this.unsubscribers.push(this.app.eventBus.on(EVENTS.PDF_LOADED, opened));
        this.unsubscribers.push(this.app.eventBus.on(EVENTS.EPUB_LOADED, opened));
        for (const eventName of [EVENTS.SENTENCE_CHANGED, EVENTS.EPUB_LOCATION_CHANGED, EVENTS.HIGHLIGHT_ADDED]) {
            this.unsubscribers.push(this.app.eventBus.on(eventName, () => this.activity(eventName)));
        }
        this.unsubscribers.push(this.app.eventBus.on(EVENTS.AUDIO_PLAYBACK_START, () => {
            // PDF loading publishes its event before the gallery overlay is
            // finally hidden. Re-evaluate the live DOM here so a stale
            // readingScreen=false value cannot keep a real playback red and
            // uncounted for the entire session.
            if (this.getDocumentDescriptor()) {
                this.tracker.setDocumentOpen(true);
                this._updateReadingScreen();
            }
            this.tracker.setTtsPlaying(true);
            this.activity("tts-start");
        }));
        this.unsubscribers.push(this.app.eventBus.on(
            EVENTS.AUDIO_PLAYBACK_PAUSE,
            () => this.tracker.setTtsPlaying(false),
        ));
        this.unsubscribers.push(this.app.eventBus.on(EVENTS.AUDIO_PLAYBACK_END, () => {
            // Auto-advance can start the replacement source before the prior
            // phrase publishes its END event. Do not let that stale END turn
            // off the clock (and status dot) for audio that is already playing.
            this.tracker.setTtsPlaying(!!(
                this.app.state.isPlaying || this.app.state.autoAdvanceActive
            ));
        }));
        const activityEvents = ["pointerdown", "touchstart", "keydown", "scroll", "wheel"];
        for (const eventName of activityEvents) {
            const handler = (event) => {
                if (eventName === "keydown" && event.metaKey) return;
                this.activity(eventName);
            };
            globalThis.window?.addEventListener?.(eventName, handler, { capture: true, passive: true });
            this.domListeners.push({ eventName, handler });
        }
        if (typeof MutationObserver === "function" && document.body) {
            this.screenObserver = new MutationObserver(() => this._updateReadingScreen());
            this.screenObserver.observe(document.body, {
                subtree: true,
                attributes: true,
                attributeFilter: ["class", "style", "open", "hidden"],
            });
        }
    }

    documentOpened() {
        const descriptor = this.getDocumentDescriptor();
        if (!descriptor) return;
        this.tracker.setDocumentOpen(true);
        this._updateReadingScreen();
        this.app.state.rewards.document = descriptor;
        this.app.eventBus.emit(EVENTS.READING_DOCUMENT_OPENED, descriptor);
    }

    documentClosed() {
        const descriptor = this.app.state.rewards.document;
        this.tracker.setDocumentOpen(false);
        this.tracker.setReadingScreen(false);
        this.tracker.setTtsPlaying(false);
        this.app.state.rewards.document = null;
        this.app.eventBus.emit(EVENTS.READING_DOCUMENT_CLOSED, descriptor);
    }

    activity(source) {
        if (!this.getDocumentDescriptor()) return;
        this.tracker.recordActivity(source);
        this.app.eventBus.emit(EVENTS.READING_ACTIVITY, { source, timestamp: Date.now() });
    }

    _updateReadingScreen() {
        const descriptor = this.getDocumentDescriptor();
        const blockers = [
            ...document.querySelectorAll("dialog[open]"),
            document.getElementById("config-menu"),
            document.getElementById("auth-overlay"),
            document.getElementById("previous-pdf-header"),
        ].filter(Boolean);
        const blocked = blockers.some((element) => {
            if (element.matches?.("dialog[open]")) return true;
            if (element.hidden || element.classList.contains("hidden")) return false;
            return globalThis.getComputedStyle?.(element)?.display !== "none";
        });
        this.tracker.setReadingScreen(!!descriptor && !blocked);
    }

    destroy() {
        this.unsubscribers.forEach((unsubscribe) => unsubscribe());
        for (const { eventName, handler } of this.domListeners) {
            globalThis.window?.removeEventListener?.(eventName, handler, { capture: true });
        }
        this.screenObserver?.disconnect();
    }
}
