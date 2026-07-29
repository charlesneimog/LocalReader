import test from "node:test";
import assert from "node:assert/strict";

import { HighlightsStorage } from "../src/modules/storage/highlightsStorage.js";

const word = (str) => ({ str });

function createStorage() {
    const pageWords = ["Alpha", "beta", "gamma", "delta"].map(word);
    const sentences = [
        { index: 0, pageNumber: 1, words: [pageWords[0]] },
        { index: 1, pageNumber: 1, words: pageWords.slice(1) },
    ];
    const app = {
        state: {
            currentDocumentType: "pdf",
            currentPdfKey: "book",
            pagesCache: new Map([[1, { pageWords }]]),
            pageSentencesIndex: new Map([[1, [0, 1]]]),
            sentences,
        },
    };
    return { storage: new HighlightsStorage(app), pageWords };
}

test("serializes PDF highlights under a zero-based page index with their words", () => {
    const { storage } = createStorage();
    const serialized = storage._serializePdfHighlights(
        new Map([[1, { color: "#ffff00", text: "beta gamma delta" }]]),
    );

    assert.equal(serialized.version, 2);
    assert.deepEqual(serialized.pages["0"][0].words, ["beta", "gamma", "delta"]);
    assert.equal(serialized.pages["0"][0].wordStart, 1);
    assert.equal("sentenceIndex" in serialized.pages["0"][0], false);
    assert.equal("pageIndex" in serialized.pages["0"][0], false);
});

test("matches saved words on their page after parsed sentence indices change", () => {
    const { storage, pageWords } = createStorage();
    const saved = new Map([
        [
            42,
            {
                pageIndex: 0,
                wordStart: 1,
                words: ["beta", "gamma"],
                color: "#ffff00",
            },
        ],
    ]);

    const remapped = storage.remapPdfHighlights(saved);

    assert.equal(remapped.has(42), false);
    assert.equal(remapped.has(1), true);
    assert.deepEqual(storage.getHighlightWords(remapped.get(1)), pageWords.slice(1, 3));
});

test("loads page-grouped highlights without a persisted parsed-sentence index", () => {
    const { storage } = createStorage();
    storage.app.config = { HIGHLIGHTS_STORAGE_KEY: "highlights" };
    globalThis.localStorage = {
        getItem: () =>
            JSON.stringify({
                book: {
                    version: 2,
                    pages: {
                        0: [{ wordStart: 1, words: ["beta", "gamma"], color: "#ffff00" }],
                    },
                },
            }),
    };

    const loaded = storage.loadSavedHighlights("book");
    const remapped = storage.remapPdfHighlights(loaded);

    assert.equal(loaded.has(-1), true);
    assert.equal(remapped.has(1), true);
});
