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

export function resolveTtsWebGpuPreference(environment = {}) {
    return !isSmartphoneEnvironment(environment);
}
