import test from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../src/core/eventBus.js";
import { EVENTS } from "../src/constants/events.js";
import { ReadingEventAdapter } from "../src/modules/rewards/readingEventAdapter.js";

test("a late phrase-end event does not stop an already-playing replacement", () => {
    const playingStates = [];
    const app = {
        eventBus: new EventBus(),
        state: {
            currentDocumentType: null,
            isPlaying: false,
        },
    };
    const tracker = {
        setTtsPlaying: (playing) => playingStates.push(playing),
    };
    const adapter = new ReadingEventAdapter({ app, tracker });
    adapter.start();

    app.state.isPlaying = true;
    app.eventBus.emit(EVENTS.AUDIO_PLAYBACK_START);
    app.eventBus.emit(EVENTS.AUDIO_PLAYBACK_END);
    assert.deepEqual(playingStates, [true, true]);

    app.state.isPlaying = false;
    app.eventBus.emit(EVENTS.AUDIO_PLAYBACK_END);
    assert.deepEqual(playingStates, [true, true, false]);

    adapter.destroy();
});

test("phrase end keeps continuous TTS active while auto-advance is running", () => {
    const playingStates = [];
    const app = {
        eventBus: new EventBus(),
        state: {
            currentDocumentType: null,
            isPlaying: false,
            autoAdvanceActive: true,
        },
    };
    const adapter = new ReadingEventAdapter({
        app,
        tracker: {
            setTtsPlaying: (playing) => playingStates.push(playing),
        },
    });
    adapter.start();

    app.eventBus.emit(EVENTS.AUDIO_PLAYBACK_END);
    assert.deepEqual(playingStates, [true]);

    app.state.autoAdvanceActive = false;
    app.eventBus.emit(EVENTS.AUDIO_PLAYBACK_END);
    assert.deepEqual(playingStates, [true, false]);
    adapter.destroy();
});

test("playback start refreshes stale document and reading-screen eligibility", () => {
    const calls = [];
    const originalDocument = globalThis.document;
    globalThis.document = {
        querySelectorAll: () => [],
        getElementById: () => null,
        body: null,
    };
    try {
        const app = {
            eventBus: new EventBus(),
            state: {
                currentDocumentType: "pdf",
                currentPdfKey: "doc",
                currentPdfDescriptor: { name: "Book" },
                currentSentenceIndex: 0,
                sentences: [{ text: "A sentence" }],
                pdf: {},
                rewards: {},
                isPlaying: true,
            },
        };
        const tracker = {
            setDocumentOpen: (open) => calls.push(["document", open]),
            setReadingScreen: (reading) => calls.push(["screen", reading]),
            setTtsPlaying: (playing) => calls.push(["tts", playing]),
            recordActivity: () => {},
        };
        const adapter = new ReadingEventAdapter({ app, tracker });
        adapter.start();

        app.eventBus.emit(EVENTS.AUDIO_PLAYBACK_START);

        assert.deepEqual(calls, [
            ["document", true],
            ["screen", true],
            ["tts", true],
        ]);
        adapter.destroy();
    } finally {
        globalThis.document = originalDocument;
    }
});
