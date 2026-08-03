import test from "node:test";
import assert from "node:assert/strict";
import { RewardsController } from "../src/modules/rewards/index.js";

test("continuous TTS resumes a stale automatic reward pause", async () => {
    let resumed = false;
    const controller = Object.create(RewardsController.prototype);
    controller.automaticStartPromise = null;
    controller.app = {
        state: { isPlaying: true, autoAdvanceActive: true },
        ui: { showInfo() {} },
    };
    controller.sessions = {
        ensureAutomatic: async () => ({
            id: "session-1",
            state: "paused",
            pauseReason: "explicit",
        }),
        resume: async () => {
            resumed = true;
            return { id: "session-1", state: "active", pauseReason: null };
        },
    };
    controller._refresh = () => {};

    const session = await controller._ensureAutomaticTree();

    assert.equal(resumed, true);
    assert.equal(session.state, "active");
});

test("historical trees do not become mandatory reflection popups on startup", () => {
    const controller = Object.create(RewardsController.prototype);
    controller.pendingTreeNotifications = [];
    controller.notifiedTreeIds = new Set();
    controller.storage = {
        getSnapshot: () => ({
            plants: [
                { id: "old-tree-without-note", stage: "mature", completedAt: 1, reflectionRequired: true },
                { id: "growing-tree", stage: "young", completedAt: null },
            ],
        }),
    };

    controller._rememberHistoricalTrees();

    assert.deepEqual(controller.pendingTreeNotifications, []);
    assert.deepEqual([...controller.notifiedTreeIds], ["old-tree-without-note"]);
});

test("removing a mature tree creates a sync-safe tombstone and clears pending prompts", async () => {
    const state = {
        plants: [{
            id: "tree-1",
            speciesId: "minute-sprout",
            stage: "mature",
            plotId: "garden-1",
            cell: { x: 0, y: 0 },
            reflectionRequired: true,
            updatedAt: 1,
        }],
        sessions: [{ id: "session-1", plantId: "tree-1" }],
        reflections: [],
    };
    const emitted = [];
    const notices = [];
    const controller = Object.create(RewardsController.prototype);
    controller.pendingTreeNotifications = [{ id: "tree-1" }];
    controller.notifiedTreeIds = new Set();
    controller.storage = {
        transaction: async (mutator) => mutator(state),
    };
    controller._refresh = () => {};
    controller._queueSync = (immediate) => assert.equal(immediate, true);
    controller.app = {
        eventBus: { emit: (...args) => emitted.push(args) },
        ui: { showInfo: (message) => notices.push(message) },
    };

    const removed = await controller.removeTree("tree-1");

    assert.equal(removed.id, "tree-1");
    assert.ok(Number.isFinite(state.plants[0].deletedAt));
    assert.equal(state.plants[0].plotId, null);
    assert.equal(state.plants[0].cell, null);
    assert.equal(state.plants[0].reflectionRequired, false);
    assert.equal(state.sessions.length, 1);
    assert.deepEqual(controller.pendingTreeNotifications, []);
    assert.equal(controller.notifiedTreeIds.has("tree-1"), true);
    assert.equal(emitted[0][0], "rewards:garden:updated");
    assert.deepEqual(notices, ["Tree removed from your garden."]);
});

test("automatic completion queues the reflection until the next sentence boundary", async () => {
    const lifecycle = [];
    const controller = Object.create(RewardsController.prototype);
    controller.automaticCompletionPromise = null;
    controller.pendingTreeNotifications = [];
    controller.notifiedTreeIds = new Set();
    controller.sessions = {
        getCurrentSession: () => ({ automatic: true, activeReadingMs: 60000, goalMs: 60000 }),
        complete: async () => {
            lifecycle.push("tree-completed");
            return { plant: { id: "tree-1", speciesId: "minute-sprout" } };
        },
        ensureAutomatic: async () => lifecycle.push("next-tree-created"),
    };
    controller._refresh = () => lifecycle.push("refreshed");
    controller.app = { ui: { showInfo: () => {} } };

    await controller._completeAutomaticTree();

    assert.deepEqual(lifecycle, [
        "tree-completed",
        "next-tree-created",
        "refreshed",
    ]);
    assert.deepEqual(controller.pendingTreeNotifications, [
        { id: "tree-1", speciesId: "minute-sprout" },
    ]);
});

test("a reading boundary waits for tree completion before opening its reflection", async () => {
    const lifecycle = [];
    let finishCompletion;
    const controller = Object.create(RewardsController.prototype);
    controller.readingBoundaryPromise = null;
    controller.automaticCompletionPromise = new Promise((resolve) => {
        finishCompletion = () => {
            lifecycle.push("tree-finalized");
            resolve();
        };
    });
    controller._flushTreeNotification = async () => lifecycle.push("prompt-opened");

    const boundary = controller.handleReadingBoundary();
    await Promise.resolve();
    assert.deepEqual(lifecycle, []);

    finishCompletion();
    await boundary;
    assert.deepEqual(lifecycle, ["tree-finalized", "prompt-opened"]);
});

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
            addPlaybackBlock: async (reason) => {
                controller.app.state.isPlaying = false;
                controller.app.state.autoAdvanceActive = false;
                lifecycle.push(`playback-blocked:${reason}`);
            },
            removePlaybackBlock: (reason) => lifecycle.push(`playback-unblocked:${reason}`),
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
    assert.deepEqual(lifecycle, ["playback-blocked:required-reflection", "reading-paused"]);
    assert.equal(nextSession.pauseReason, "reflection");

    await controller._resumeAfterRequiredReflection();
    assert.deepEqual(lifecycle, [
        "playback-blocked:required-reflection",
        "reading-paused",
        "playback-unblocked:required-reflection",
        "screen-updated",
        "reading-resumed",
        "playback-resumed",
    ]);
    assert.equal(controller.pendingTreeNotifications.length, 0);
});
