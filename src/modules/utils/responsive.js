import { isMobile } from "./helpers.js";

export function getPageDisplayScale(viewportDisplay, config) {
    if (!isMobile(config)) return 1;
    const available = window.innerWidth - config.HORIZONTAL_MOBILE_MARGIN;
    return Math.min(1, available / viewportDisplay.width);
}