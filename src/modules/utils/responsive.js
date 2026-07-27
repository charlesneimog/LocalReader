import { isMobile } from "./helpers.js";

export function getPageDisplayScale(viewportDisplay, config) {
    if (!isMobile(config)) return 1;
    const container = document.getElementById("pdf-doc-container");
    const readerWidth = container?.clientWidth || window.innerWidth;
    const available = Math.max(1, readerWidth - config.HORIZONTAL_MOBILE_MARGIN);
    return Math.min(1, available / viewportDisplay.width);
}
