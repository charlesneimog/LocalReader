export const TTS_WEBGPU_STORAGE_KEY = "config.ttsWebGpu";

export function isSmartphoneEnvironment({
    userAgent = "",
    viewportWidth = Number.POSITIVE_INFINITY,
    coarsePointer = false,
    maxTouchPoints = 0,
    mobileBreakpoint = 680,
} = {}) {
    const mobileUserAgent = /Android.+Mobile|iPhone|iPod|Windows Phone|Mobile Safari/i.test(userAgent);
    const smallTouchScreen =
        (coarsePointer || Number(maxTouchPoints) > 0) && Number(viewportWidth) <= Number(mobileBreakpoint);
    return mobileUserAgent || smallTouchScreen;
}

export function resolveTtsWebGpuPreference({ storedValue = null, ...environment } = {}) {
    if (isSmartphoneEnvironment(environment)) return false;
    if (storedValue === "1" || storedValue === "true") return true;
    if (storedValue === "0" || storedValue === "false") return false;
    return true;
}
