import test from "node:test";
import assert from "node:assert/strict";

import { calculatePdfReadingPercentage } from "../src/modules/storage/pdfThumbnailCache.js";
import { ProgressManager } from "../src/modules/storage/progressManager.js";

test("calculates PDF reading progress from the current page and total pages", () => {
    assert.equal(calculatePdfReadingPercentage(25, 100), 25);
    assert.equal(calculatePdfReadingPercentage(1, 3), 33);
    assert.equal(calculatePdfReadingPercentage(3, 3), 100);
});

test("clamps invalid and out-of-range PDF reading progress", () => {
    assert.equal(calculatePdfReadingPercentage(0, 100), 0);
    assert.equal(calculatePdfReadingPercentage(undefined, 100), 0);
    assert.equal(calculatePdfReadingPercentage(10, 0), 0);
    assert.equal(calculatePdfReadingPercentage(110, 100), 100);
});

test("persists the current and total PDF pages with the reading position", () => {
    const values = new Map();
    globalThis.localStorage = {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
    };

    const app = {
        config: { PROGRESS_STORAGE_KEY: "test-progress" },
        state: {
            sentences: [{ pageNumber: 7 }],
            currentSentenceIndex: 0,
            currentSentence: { pageNumber: 7 },
            currentDocumentType: "pdf",
            currentPdfKey: "book.pdf",
            currentPiperVoice: "voice",
            pdf: { numPages: 20 },
        },
        serverSync: { isEnabled: () => false },
    };

    new ProgressManager(app).saveProgress();

    const saved = JSON.parse(values.get("test-progress"))["pdf::book.pdf"];
    assert.equal(saved.currentPage, 7);
    assert.equal(saved.totalPages, 20);
});
