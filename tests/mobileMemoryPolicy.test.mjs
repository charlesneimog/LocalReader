import assert from "node:assert/strict";
import test from "node:test";

import { isIOSLike, isMobile } from "../src/modules/utils/helpers.js";

function withNavigator(value, callback) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value });
    try {
        callback();
    } finally {
        if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
        else delete globalThis.navigator;
    }
}

test("recognizes an iPad using the desktop-class Safari user agent", () => {
    withNavigator(
        {
            userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15",
            maxTouchPoints: 5,
        },
        () => {
            assert.equal(isIOSLike(), true);
            assert.equal(isMobile(), true);
        },
    );
});

test("does not classify a regular Mac as an iOS device", () => {
    withNavigator(
        {
            userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15",
            maxTouchPoints: 0,
        },
        () => {
            assert.equal(isIOSLike(), false);
            assert.equal(isMobile(), false);
        },
    );
});
