export function ensureAriaRegions(config) {
    if (config.ENABLE_LIVE_WORD_REGION && !document.getElementById(config.LIVE_WORD_REGION_ID)) {
        const div = document.createElement("div");
        div.id = config.LIVE_WORD_REGION_ID;
        div.setAttribute("aria-live", "polite");
        div.setAttribute("aria-atomic", "true");
        div.style.position = "absolute";
        div.style.left = "-9999px";
        document.body.appendChild(div);
    }
    if (!document.getElementById(config.LIVE_STATUS_REGION_ID)) {
        const div = document.createElement("div");
        div.id = config.LIVE_STATUS_REGION_ID;
        div.setAttribute("aria-live", "polite");
        div.setAttribute("aria-atomic", "true");
        div.style.position = "absolute";
        div.style.left = "-9999px";
        document.body.appendChild(div);
    }
}