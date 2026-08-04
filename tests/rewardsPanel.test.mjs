import test from "node:test";
import assert from "node:assert/strict";
import {
    formatReadingProgressTime,
    getReadingProgressPercent,
} from "../src/modules/ui/rewardsPanel.js";

test("tree border is half complete after two and a half of five minutes", () => {
    assert.equal(getReadingProgressPercent({ activeReadingMs: 150000, goalMs: 300000 }), 50);
});

test("tree border is almost complete at four minutes fifty-eight seconds", () => {
    const percent = getReadingProgressPercent({ activeReadingMs: 298000, goalMs: 300000 });
    assert.ok(percent > 99 && percent < 100);
});

test("tree border progress is safe for missing, negative, and over-goal times", () => {
    assert.equal(getReadingProgressPercent(null), 0);
    assert.equal(getReadingProgressPercent({ activeReadingMs: -1, goalMs: 300000 }), 0);
    assert.equal(getReadingProgressPercent({ activeReadingMs: 301000, goalMs: 300000 }), 100);
});

test("tree time uses a compact minute and second label", () => {
    assert.equal(formatReadingProgressTime(150000), "2:30");
    assert.equal(formatReadingProgressTime(298000), "4:58");
});
