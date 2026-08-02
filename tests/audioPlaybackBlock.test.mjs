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
