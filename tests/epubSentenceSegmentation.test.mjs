import test from "node:test";
import assert from "node:assert/strict";

import { splitSegmentsOnSemicolons } from "../src/modules/epub/sentenceSegmentation.js";

test("splits EPUB sentence segments at semicolons and preserves offsets", () => {
    const text = "First phrase;  second phrase. Third phrase; fourth.";
    const segments = [
        { text: "First phrase; second phrase.", start: 0, end: 29 },
        { text: "Third phrase; fourth.", start: 30, end: text.length },
    ];

    assert.deepEqual(splitSegmentsOnSemicolons(text, segments), [
        { text: "First phrase;", start: 0, end: 13 },
        { text: "second phrase.", start: 15, end: 29 },
        { text: "Third phrase;", start: 30, end: 43 },
        { text: "fourth.", start: 44, end: 51 },
    ]);
});
