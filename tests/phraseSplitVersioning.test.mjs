import test from "node:test";
import assert from "node:assert/strict";

import {
    CURRENT_PHRASE_SPLIT_VERSION,
    PHRASE_SPLIT_HISTORY,
} from "../src/modules/phrases/phraseSplitVersions.js";
import { HighlightsStorage } from "../src/modules/storage/highlightsStorage.js";
import { AudioManager } from "../src/modules/tts/audioManager.js";

test("keeps an append-only phrase split history with the current version", () => {
    assert.deepEqual(
        PHRASE_SPLIT_HISTORY.map(({ version }) => version),
        [1, 2],
    );
    assert.equal(CURRENT_PHRASE_SPLIT_VERSION, 2);
    assert.equal(Object.isFrozen(PHRASE_SPLIT_HISTORY), true);
});

test("treats unversioned highlights as version 1 and stamps new highlights", () => {
    const values = new Map([[3, { color: "yellow", text: "Old phrase" }]]);
    const app = {
        config: { HIGHLIGHTS_STORAGE_KEY: "test-highlights" },
        state: {
            phraseSplitVersion: 2,
            savedHighlights: values,
            currentDocumentType: "pdf",
            currentPdfKey: "book",
        },
    };
    const storage = new HighlightsStorage(app);

    assert.equal(storage.getPhraseSplitVersion("book", values), 1);
    values.set(4, { color: "blue", text: "New phrase", phraseSplitVersion: 2 });
    assert.equal(storage.getPhraseSplitVersion("book", values), 1);
    storage._stampPhraseSplitVersion(values);
    assert.equal(values.get(3).phraseSplitVersion, 2);
});

test("announces reading only when a reading run starts", () => {
    const finishedMessages = [];
    const preparationMessages = [];
    const manager = Object.create(AudioManager.prototype);
    manager.app = {
        ui: {
            finishPlaybackPreparation: (message) => finishedMessages.push(message),
            updatePlaybackPreparation: (message) => preparationMessages.push(message),
        },
    };

    manager._updatePlaybackPreparationForStart({ continuesReading: false });
    manager._updatePlaybackPreparationForStart({ continuesReading: true });
    manager._finishPlaybackPreparationForStart({ continuesReading: false });
    manager._finishPlaybackPreparationForStart({ continuesReading: true });

    assert.deepEqual(preparationMessages, ["Starting reading…"]);
    assert.deepEqual(finishedMessages, ["Reading started.", ""]);
});
