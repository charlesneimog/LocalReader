import test from "node:test";
import assert from "node:assert/strict";
import { RewardsController } from "../src/modules/rewards/index.js";

test("earned-tree prompt pauses reading and playback until the required paragraph is saved", async () => {
    const announcements = [];
    const notePrompts = [];
    const lifecycle = [];
    const controller = Object.create(RewardsController.prototype);
    controller.reflectionPromptPromise = null;
    controller.reflectionResumeState = null;
    controller.pendingTreeNotifications = [
        { id: "tree-1", speciesId: "reading-sapling", sessionId: "session-1" },
    ];
    controller.storage = {
        getSnapshot: () => ({
            sessions: [{ id: "session-1" }],
            reflections: [],
        }),
    };
    controller.reflectionDialog = {
        isOpen: () => false,
        open: (session, summary) => notePrompts.push({ session, summary }),
    };
    controller.panel = {
        announce: (key, message) => announcements.push({ key, message }),
    };
    const nextSession = { id: "session-2", state: "active", pauseReason: null };
    controller.sessions = {
        getCurrentSession: () => nextSession,
        pause: async ({ reason }) => {
            nextSession.state = "paused";
            nextSession.pauseReason = reason;
            lifecycle.push("reading-paused");
        },
        resume: async () => {
            nextSession.state = "active";
            nextSession.pauseReason = null;
            lifecycle.push("reading-resumed");
        },
    };
    controller.app = {
        state: { isPlaying: true, autoAdvanceActive: true },
        audioManager: {
            stopPlayback: async () => {
                controller.app.state.isPlaying = false;
                controller.app.state.autoAdvanceActive = false;
                lifecycle.push("playback-paused");
            },
            playCurrentSentence: async () => lifecycle.push("playback-resumed"),
        },
    };
    controller.adapter = {
        _updateReadingScreen: () => lifecycle.push("screen-updated"),
        getDocumentDescriptor: () => ({ id: "doc" }),
    };

    assert.deepEqual(notePrompts, []);
    await controller._flushTreeNotification();

    assert.deepEqual(announcements, [{
        key: "tree-earned:tree-1",
        message: "You earned one Reading Tree — Reading Sapling.",
    }]);
    assert.deepEqual(notePrompts, [{
        session: { id: "session-1" },
        summary: "Reading Sapling was added to your garden. Reading is paused until you save its paragraph.",
    }]);
    assert.deepEqual(lifecycle, ["playback-paused", "reading-paused"]);
    assert.equal(nextSession.pauseReason, "reflection");

    await controller._resumeAfterRequiredReflection();
    assert.deepEqual(lifecycle, [
        "playback-paused",
        "reading-paused",
        "screen-updated",
        "reading-resumed",
        "playback-resumed",
    ]);
    assert.equal(controller.pendingTreeNotifications.length, 0);
});
