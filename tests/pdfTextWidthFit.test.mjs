import test from "node:test";
import assert from "node:assert/strict";

import { calculateHorizontalTextFit, getFocusedReadableWords } from "../src/modules/pdf/pdfTextWidthFit.js";

const word = (x, width, { readable = true, y = 20, height = 10 } = {}) => ({
    x,
    y,
    width,
    height,
    isReadable: readable,
});

test("fits readable word extrema to exactly five pixels on each side", () => {
    const fit = calculateHorizontalTextFit([word(100, 50), word(300, 100)], 600, 800);

    assert.ok(fit);
    assert.equal(fit.left, 100);
    assert.equal(fit.right, 400);
    assert.equal(fit.padding, 5);
    assert.equal(fit.offsetLeft + fit.left * fit.scale, 5);
    assert.equal(fit.offsetLeft + fit.right * fit.scale, 795);
});

test("focus block excludes readable words in other columns and all unreadable words", () => {
    const words = [
        word(40, 120),
        word(350, 100),
        word(0, 600, { readable: false }),
    ];
    const readableBoxes = [
        { x1: 20, y1: 0, x2: 180, y2: 100 },
        { x1: 320, y1: 0, x2: 480, y2: 100 },
    ];

    assert.deepEqual(getFocusedReadableWords(words, readableBoxes, "readable:1"), [words[1]]);
});
