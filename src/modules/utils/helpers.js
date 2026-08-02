export const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
export const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export function cooperativeYield() {
    if (typeof requestIdleCallback === "function") {
        return new Promise((res) => requestIdleCallback(() => res()));
    }
    return new Promise((res) => setTimeout(res, 0));
}

export function waitFor(condFn, timeoutMs = 10000, interval = 120) {
    return new Promise((resolve, reject) => {
        const start = performance.now();
        const id = setInterval(() => {
            if (condFn()) {
                clearInterval(id);
                resolve(true);
            } else if (performance.now() - start > timeoutMs) {
                clearInterval(id);
                reject(new Error("Timeout"));
            }
        }, interval);
    });
}

export function hexToRgb(hex) {
    hex = hex.replace(/^#/, "");
    if (hex.length === 3) {
        hex = hex
            .split("")
            .map((c) => c + c)
            .join("");
    }
    const bigint = parseInt(hex, 16);
    if (Number.isNaN(bigint)) return null;
    return {
        r: (bigint >> 16) & 255,
        g: (bigint >> 8) & 255,
        b: bigint & 255,
    };
}

export function regionToFlag(region) {
    if (!region) return "";
    return region
        .toUpperCase()
        .replace(/[^A-Z]/g, "")
        .split("")
        .map((c) => String.fromCodePoint(c.charCodeAt(0) + 0x1f1a5))
        .join("");
}

export function capitalizeFirst(str) {
    if (!str) return "";
    return str.charAt(0).toUpperCase() + str.slice(1);
}

export function normalizeText(raw) {
    if (!raw) return "";
    let t = raw.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, " ");
    t = t.replace(/\s+/g, " ").trim();
    if (t && !/[.?!…]$/.test(t)) t += ".";
    return t;
}

export function formatTextToSpeech(text) {
    if (!text) return "";
    text = text
        .replace(/\([^)]*\)/g, "")
        .replace(/\[[^\]]]*\]/g, "")
        .replace(/\b(?:https?:\/\/|www\.)\S+\b/g, "")
        .replace(/\b([a-z]+)-\s*([a-z]+)/gi, "$1$2")
        .replace(/\n/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim();
    return text;
}

export function hasUsableSpeechText(text) {
    if (!text) return false;
    const cleaned = formatTextToSpeech(text).trim();
    if (!cleaned) return false;
    return /[^\s.,;:!?()[\]{}'"“”‘’…—–\-•]/.test(cleaned);
}

export function isIOSLike() {
    if (typeof navigator === "undefined") return false;
    const userAgent = navigator.userAgent || "";
    // iPadOS may request the desktop site and identify itself as a Macintosh.
    return /iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && navigator.maxTouchPoints > 1);
}

export function isMobile() {
    if (typeof navigator === "undefined") return false;
    return (
        /Mobi|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent || "") ||
        isIOSLike()
    );
}


export function getWebsiteRoot() {
    const { protocol, hostname, port, pathname } = window.location;
    const origin = `${protocol}//${hostname}${port ? `:${port}` : ""}`;

    // If we are at the domain root ("/") or a file-like first segment ("index.html"),
    // the website root is the origin root.
    const pathSegments = pathname.split("/").filter(Boolean);
    const firstSegment = pathSegments[0] || "";
    if (!firstSegment || firstSegment.includes(".")) {
        return `${origin}/`;
    }

    // GitHub Pages style: https://user.github.io/<repo>/...
    // Keep the first segment as the app root.
    return `${origin}/${firstSegment}/`;
}
