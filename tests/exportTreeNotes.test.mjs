import test from "node:test";
import assert from "node:assert/strict";

import { ExportManager } from "../src/modules/storage/exportManager.js";

function createManager() {
    const sentence = {
        pageNumber: 2,
        text: "A sentence beside the note.",
        words: [{ str: "sentence" }],
    };
    const app = {
        state: {
            currentPdfKey: "book-1",
            sentences: [sentence],
            viewportDisplayByPage: new Map([[2, {
                width: 600,
                height: 800,
                convertToPdfPoint: (_x, y) => [0, 800 - y],
            }]]),
        },
        pdfRenderer: {
            getMergedLineRects: () => [{ x: 72, y: 300, width: 350, height: 14 }],
        },
        rewards: {
            storage: {
                getSnapshot: () => ({
                    reflections: [
                        {
                            id: "reflection-1",
                            documentId: "book-1",
                            text: "This is my reading note.",
                            anchor: { sentenceIndex: 0, pageNumber: 2, text: sentence.text },
                        },
                        { id: "other", documentId: "book-2", text: "Not in this PDF." },
                    ],
                    plants: [{
                        id: "tree-1",
                        reflectionId: "reflection-1",
                        speciesId: "reading-sapling",
                    }],
                }),
            },
        },
    };
    return { manager: new ExportManager(app), sentence };
}

test("PDF export selects tree notes belonging to the current book", () => {
    const { manager } = createManager();
    const notes = manager._getTreeNotesForCurrentPdf();

    assert.equal(notes.length, 1);
    assert.equal(notes[0].id, "reflection-1");
    assert.equal(notes[0].speciesId, "reading-sapling");
});

test("PDF tree notes resolve their sentence and sit in the right margin", () => {
    const { manager, sentence } = createManager();
    const note = manager._getTreeNotesForCurrentPdf()[0];
    assert.equal(manager._resolveTreeNoteSentence(note), sentence);

    const rect = manager._getTreeNoteRect(
        { getSize: () => ({ width: 600, height: 800 }) },
        2,
        sentence,
        new Map(),
    );
    assert.deepEqual(rect, [574, 482, 592, 500]);
});
