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

test("HTML audio receives the synthesized speech as PCM WAV", async () => {
    const manager = Object.create(AudioManager.prototype);
    const samples = new Float32Array([0.75, -0.5]);
    const blob = manager._audioBufferToWavBlob({
        duration: 0.00025,
        length: samples.length,
        sampleRate: 8000,
        numberOfChannels: 1,
        getChannelData: () => samples,
    });

    assert.equal(blob.type, "audio/wav");
    const bytes = await blob.arrayBuffer();
    const view = new DataView(bytes);
    assert.equal(bytes.byteLength, 48);
    assert.equal(view.getInt16(44, true), Math.trunc(0.75 * 0x7fff));
    assert.equal(view.getInt16(46, true), Math.trunc(-0.5 * 0x8000));
});

test("HTML audio is the audible player and owns sentence completion", async () => {
    let playCalls = 0;
    let endedCalls = 0;
    const audio = {
        currentTime: 10,
        defaultMuted: true,
        muted: true,
        volume: 0,
        removeAttribute: () => {},
        play: async () => {
            playCalls += 1;
            assert.equal(audio.muted, false);
            assert.equal(audio.volume, 1);
        },
    };
    const manager = Object.create(AudioManager.prototype);
    manager.app = { state: { currentSentenceIndex: 2 } };
    manager._mediaBridgeAudio = audio;
    manager._mediaBridgeObjectUrl = null;
    manager._mediaBridgeSyncing = false;
    manager._setMediaSessionMetadata = () => {};
    manager._setMediaSessionPlaybackState = () => {};
    manager._handleSourceEnded = async () => {
        endedCalls += 1;
    };

    const originalCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = () => "blob:test-audio";
    try {
        await manager._activateMediaBridge(
            { audioBuffer: {}, audioBlob: new Blob(["speech"], { type: "audio/wav" }) },
            { id: 1 },
        );
        assert.equal(playCalls, 1);
        assert.equal(audio.src, "blob:test-audio");
        await audio.onended();
        assert.equal(endedCalls, 1);
    } finally {
        URL.createObjectURL = originalCreateObjectURL;
    }
});

test("playback rejection never enters an infinite retry loop", () => {
    const manager = Object.create(AudioManager.prototype);
    const context = { id: 7 };
    manager._playbackContext = context;
    manager.app = {
        state: { stopRequested: false },
        ui: { showInfo: () => {} },
    };

    assert.equal(manager._shouldRetryPlayback(context, { name: "NotAllowedError" }), false);

    const recoverableContext = { id: 8 };
    manager._playbackContext = recoverableContext;
    assert.equal(manager._shouldRetryPlayback(recoverableContext, new Error("temporary")), true);
    assert.equal(manager._shouldRetryPlayback(recoverableContext, new Error("still failing")), false);
});

test("the HTML audio element is primed synchronously by the Play gesture", async () => {
    let playCalls = 0;
    const audio = {
        currentTime: 0,
        loop: false,
        play: () => {
            playCalls += 1;
            return Promise.resolve();
        },
        pause: () => {},
    };
    const manager = Object.create(AudioManager.prototype);
    manager._mediaBridgeAudio = audio;
    manager._mediaBridgeObjectUrl = null;
    manager._mediaBridgeSyncing = false;
    manager._mediaElementUnlocked = false;
    manager._mediaUnlockPromise = null;

    const originalCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = () => "blob:silent-unlock";
    try {
        const unlockPromise = manager._primeMediaElementForUserGesture({ keepAlive: true });
        assert.equal(playCalls, 1);
        assert.equal(audio.loop, true);
        await unlockPromise;
        assert.equal(manager._mediaElementUnlocked, true);
    } finally {
        URL.createObjectURL = originalCreateObjectURL;
    }
});
