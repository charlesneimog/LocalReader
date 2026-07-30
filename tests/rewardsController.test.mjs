import test from "node:test";
import assert from "node:assert/strict";
import { RewardsController } from "../src/modules/rewards/index.js";

test("earned-tree notification waits in the queue until a reading boundary flushes it", () => {
    const announcements = [];
    const notePrompts = [];
    const controller = Object.create(RewardsController.prototype);
    controller.pendingTreeNotifications = [
        { id: "tree-1", speciesId: "reading-sapling" },
    ];
    controller.storage = {
        getSnapshot: () => ({
            sessions: [{ id: "session-1" }],
            reflections: [],
        }),
    };
    controller.pendingTreeNotifications[0].sessionId = "session-1";
    controller.reflectionDialog = {
        isOpen: () => false,
        open: (session, summary) => notePrompts.push({ session, summary }),
    };
    controller.panel = {
        announce: (key, message) => announcements.push({ key, message }),
    };

    assert.deepEqual(notePrompts, []);
    controller._flushTreeNotification();

    assert.deepEqual(announcements, [{
        key: "tree-earned:tree-1",
        message: "You earned one Reading Tree — Reading Sapling.",
    }]);
    assert.deepEqual(notePrompts, [{
        session: { id: "session-1" },
        summary: "Reading Sapling was added to your garden.",
    }]);
    assert.equal(controller.pendingTreeNotifications.length, 0);
});
