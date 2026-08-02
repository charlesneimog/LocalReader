import test from "node:test";
import assert from "node:assert/strict";
import { AudioManager } from "../src/modules/tts/audioManager.js";

test("a playback block prevents delayed auto-advance from restarting speech", async () => {
    let starts = 0;
    const manager = Object.create(AudioManager.prototype);
    manager._playbackBlocks = new Set(["required-reflection"]);
    manager._playbackContextId = 0;
    manager._playbackContext = null;
    manager._playPromise = null;
    manager.app = {
        state: {
            isPlaying: false,
            autoAdvanceActive: true,
            currentSentenceIndex: 3,
            currentDocumentType: "pdf",
        },
        ui: {
            beginPlaybackPreparation: () => {},
            finishPlaybackPreparation: () => {},
        },
    };
    manager._playCurrentSentence = async () => {
        starts += 1;
    };
    manager._clearWaitingForAudio = () => {};

    await manager.playCurrentSentence();
    assert.equal(starts, 0);

    manager.removePlaybackBlock("required-reflection");
    await manager.playCurrentSentence();
    assert.equal(starts, 1);
});

test("startup buffering requires the current and next readable phrase", () => {
    const manager = Object.create(AudioManager.prototype);
    manager.app = {
        state: {
            currentSentenceIndex: 0,
            sentences: [
                { layoutProcessed: true, isTextToRead: true, text: "First.", audioReady: true, audioBuffer: {} },
                { layoutProcessed: true, isTextToRead: false, text: "Header." },
                { layoutProcessed: true, isTextToRead: true, text: "Second.", audioReady: false, audioBuffer: null },
            ],
        },
    };

    assert.deepEqual(manager._startupBufferStatus(2), {
        ready: 1,
        required: 2,
        unresolved: false,
    });

    manager.app.state.sentences[2].audioReady = true;
    manager.app.state.sentences[2].audioBuffer = {};
    assert.deepEqual(manager._startupBufferStatus(2), {
        ready: 2,
        required: 2,
        unresolved: false,
    });
});

test("startup buffering permits a single remaining phrase at document end", () => {
    const manager = Object.create(AudioManager.prototype);
    manager.app = {
        state: {
            currentSentenceIndex: 0,
            sentences: [
                { layoutProcessed: true, isTextToRead: true, text: "Only phrase.", audioReady: true, audioBuffer: {} },
            ],
        },
    };

    assert.deepEqual(manager._startupBufferStatus(2), {
        ready: 1,
        required: 1,
        unresolved: false,
    });
});
