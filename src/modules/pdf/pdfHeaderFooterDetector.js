export class PDFHeaderFooterDetector {
    constructor(app) {
        this.app = app;
        this._overlayStylesInjected = false;
        this._pageContainers = new Map();
        this._pendingOverlayData = new Map();
        this.debug = false;

        this.app.ui.showInfo("Loading AI layout model...");
        this.worker = new Worker("./src/modules/pdf/ts.js", { type: "module" });

        this._pendingWorkerRequests = new Map();
        this._pendingDetectionsByPage = new Map();
        this._requestIdCounter = 0;

        const threads = navigator.hardwareConcurrency;
        const webgpu = "gpu" in navigator;

        this.workerReadyPromise = new Promise((resolve) => {
            this._resolveWorkerReady = resolve;
        });

        this.worker.onmessage = (event) => {
            const { status, requestId } = event.data || {};
            if (status === "ready") {
                if (typeof this._resolveWorkerReady === "function") this._resolveWorkerReady();
                return;
            }
            if (status === "detections") {
                const pending = this._pendingWorkerRequests.get(requestId);
                if (!pending) return;
                this._pendingWorkerRequests.delete(requestId);
                pending.resolve(event.data);
                return;
            }
            if (status === "error") {
                const pending = this._pendingWorkerRequests.get(requestId);
                if (pending) {
                    this._pendingWorkerRequests.delete(requestId);
                    const error = event.data.error || new Error("Worker detection error");
                    if (error.name === "AbortError") {
                        console.warn("Worker operation was aborted (likely canceled or terminated early)");
                    } else {
                        console.error("Layout worker error", error);
                        this.app.ui.showFatalError("Layout worker exit with fatal error, please report!");
                    }
                    pending.reject(error);
                }
            }
        };

        this.worker.onerror = (e) => {
            console.error("Layout worker crashed", e);
            this._pendingWorkerRequests.forEach((pending) => pending.reject(e));
            this._pendingWorkerRequests.clear();
        };

        this.worker.postMessage({ action: "init", threads, webgpu });

        // Detection configuration
        this.DETECTION_THRESHOLD = 0.35;
        this.DETECTION_CLASSES = [
            "caption",
            "footnote",
            "formula",
            "list-item",
            "page-footer",
            "page-header",
            "picture",
            "section-header",
            "table",
            "text",
        ];

        // Only these regions contain text that should be read
        this.ITEMS_TO_READ = ["list-item", "section-header", "text"];
        this._modelReady = this.workerReadyPromise;
    }

    _initModels() {
        return this.workerReadyPromise;
    }

    _ensureModelReady() {
        if (!this._modelReady) {
            this._modelReady = this._initModels();
        }
        return this._modelReady;
    }

    _drawIgnoredDetectionsOverlay(pageNumber, detections, baseCanvas) {
        const { state } = this.app;
        const viewportDisplay = state.viewportDisplayByPage.get(pageNumber);
        let container = document.querySelector(`[data-page-number="${pageNumber}"]`);
        if (!container) {
            console.error("No container found for page", pageNumber);
            return;
        }
        const existingOverlay = container.querySelector(".ignored-overlay");
        if (existingOverlay) {
            existingOverlay.remove();
        }
        const overlay = document.createElement("canvas");
        overlay.width = viewportDisplay.width;
        overlay.height = viewportDisplay.height;
        overlay.style.position = "absolute";
        overlay.style.top = "0";
        overlay.style.left = "0";
        overlay.style.pointerEvents = "none";
        overlay.style.zIndex = "1000";
        overlay.className = "ignored-overlay";

        const ctx = overlay.getContext("2d");
        ctx.fillStyle = "rgba(200, 200, 200, 0.2)";

        const canvasWidth = baseCanvas?.width || viewportDisplay.width;
        const canvasHeight = baseCanvas?.height || viewportDisplay.height;
        const scaleX = viewportDisplay.width / canvasWidth;
        const scaleY = viewportDisplay.height / canvasHeight;

        let drawnCount = 0;
        for (const det of detections) {
            if (!this.ITEMS_TO_READ.includes(det.label)) {
                let x1, y1, width, height;

                if (det.normalized) {
                    x1 = det.normalized.left * viewportDisplay.width;
                    y1 = det.normalized.top * viewportDisplay.height;
                    width = (det.normalized.right - det.normalized.left) * viewportDisplay.width;
                    height = (det.normalized.bottom - det.normalized.top) * viewportDisplay.height;
                } else {
                    x1 = det.x1 * scaleX;
                    y1 = det.y1 * scaleY;
                    width = (det.width || det.x2 - det.x1) * scaleX;
                    height = (det.height || det.y2 - det.y1) * scaleY;
                }

                if (width > 0 && height > 0 && x1 < overlay.width && y1 < overlay.height) {
                    ctx.fillRect(x1, y1, width, height);
                    drawnCount++;
                }
            }
        }

        if (drawnCount > 0) {
            container.appendChild(overlay);
        }
    }

    // ---------- Main Detection ----------
    detectHeadersAndFooters(pageNumber, scaleFactor = 1) {
        const { state } = this.app;
        const cached = state.layoutDetectionCache.get(pageNumber);
        if (cached && cached.cacheVersion === state.layoutCacheVersion && Array.isArray(cached.detections)) {
            return Promise.resolve(cached.detections);
        }

        if (this._pendingDetectionsByPage.has(pageNumber)) {
            return this._pendingDetectionsByPage.get(pageNumber);
        }

        const ttsQueue = this.app.ttsQueue;
        const queueIdle = !ttsQueue || (ttsQueue.active === 0 && ttsQueue.queue.length === 0);
        const shouldShowSpinner = !state.isPlaying && queueIdle;
        if (shouldShowSpinner) {
            this.app.ui.updatePlayButton(state.playerState.LOADING);
        }

        const detectionPromise = this._ensureModelReady()
            .then(() => this._performDetection(pageNumber, scaleFactor))
            .then((detections) => {
                this._pendingDetectionsByPage.delete(pageNumber);
                return detections;
            })
            .catch((error) => {
                this._pendingDetectionsByPage.delete(pageNumber);
                console.error(`[Layout] Detection failed for page ${pageNumber}`, error);
                return [];
            });

        const wrappedPromise = shouldShowSpinner
            ? detectionPromise.finally(() => {
                  const queueStillIdle = !ttsQueue || (ttsQueue.active === 0 && ttsQueue.queue.length === 0);
                  if (!state.isPlaying && queueStillIdle) {
                      this.app.ui.updatePlayButton(state.playerState.DONE);
                  }
              })
            : detectionPromise;

        this._pendingDetectionsByPage.set(pageNumber, wrappedPromise);
        return wrappedPromise;
    }

    _performDetection(pageNumber, scaleFactor) {
        const { state } = this.app;
        const ensureCanvas = state.fullPageRenderCache.has(pageNumber)
            ? Promise.resolve(state.fullPageRenderCache.get(pageNumber))
            : this.app.pdfRenderer
                  .ensureFullPageRendered(pageNumber)
                  .then(() => state.fullPageRenderCache.get(pageNumber));

        return ensureCanvas.then((canvas) => {
            if (!canvas) {
                console.warn(`[Layout] No canvas available for page ${pageNumber} after render attempt.`);
                return [];
            }

            const tmpCanvas = document.createElement("canvas");
            tmpCanvas.width = Math.max(1, Math.floor(canvas.width * scaleFactor));
            tmpCanvas.height = Math.max(1, Math.floor(canvas.height * scaleFactor));
            const tmpCtx = tmpCanvas.getContext("2d");
            if (!tmpCtx) {
                console.error(`[Layout] Failed to acquire temp canvas context for page ${pageNumber}`);
                return [];
            }
            tmpCtx.drawImage(canvas, 0, 0, tmpCanvas.width, tmpCanvas.height);

            let imageData;
            try {
                imageData = tmpCtx.getImageData(0, 0, tmpCanvas.width, tmpCanvas.height);
            } catch (error) {
                console.error(`[Layout] Could not extract image data for page ${pageNumber}`, error);
                return [];
            }

            return this._sendWorkerDetection({
                pageNumber,
                imageData,
                originalWidth: canvas.width,
                originalHeight: canvas.height,
                scaledWidth: tmpCanvas.width,
                scaledHeight: tmpCanvas.height,
                detectionThreshold: this.DETECTION_THRESHOLD,
                detectionClasses: this.DETECTION_CLASSES,
            }).then((payload) => {
                const detections = Array.isArray(payload?.detections)
                    ? payload.detections.map((det) => ({ ...det, pageNumber }))
                    : [];

                const cacheEntry = {
                    pageNumber,
                    detections,
                    timestamp: Date.now(),
                    cacheVersion: state.layoutCacheVersion,
                    modelVersion: payload?.modelVersion || "yolov10m-doclaynet-v1",
                    readabilityVersion: null,
                    readableWordCount: null,
                };

                state.layoutDetectionCache.set(pageNumber, cacheEntry);
                this._drawIgnoredDetectionsOverlay(pageNumber, detections, canvas);
                return detections;
            });
        });
    }

    registerPageDomElement(pageObj, pageContainer) {
        return;
    }

    _buildRegionsFromDetections(detections, viewportDisplay) {
        const readableBoxes = [];
        const ignoreBoxes = [];

        for (const det of detections || []) {
            const box = {
                x1: det.normalized.left * viewportDisplay.width,
                y1: det.normalized.top * viewportDisplay.height,
                x2: det.normalized.right * viewportDisplay.width,
                y2: det.normalized.bottom * viewportDisplay.height,
            };

            const expanded = this._expandBox(box, viewportDisplay);
            if (this.ITEMS_TO_READ.includes(det.label)) {
                readableBoxes.push(expanded);
            } else {
                ignoreBoxes.push(expanded);
            }
        }

        return { readableBoxes, ignoreBoxes };
    }

    ensureReadabilityForPage(pageNumber, { force = false } = {}) {
        const { state } = this.app;

        const page = state.pagesCache.get(pageNumber);
        if (!page?.pageWords) {
            console.warn(`[Layout] No words cached for page ${pageNumber}; skipping readability.`);
            return Promise.resolve({ readable: 0, total: 0 });
        }

        const viewportDisplay = state.viewportDisplayByPage.get(pageNumber);
        if (!viewportDisplay) {
            console.warn(`[Layout] No viewport info for page ${pageNumber}; skipping readability.`);
            return Promise.resolve({ readable: 0, total: page.pageWords.length });
        }

        return this.detectHeadersAndFooters(pageNumber).then((detections) => {
            let cacheEntry = state.layoutDetectionCache.get(pageNumber);
            if (!cacheEntry) {
                cacheEntry = {
                    pageNumber,
                    detections,
                    timestamp: Date.now(),
                    cacheVersion: state.layoutCacheVersion,
                    modelVersion: "yolov10m-doclaynet-v1",
                    readabilityVersion: null,
                    readableWordCount: null,
                };
                state.layoutDetectionCache.set(pageNumber, cacheEntry);
            }

            const alreadyProcessed =
                !force &&
                cacheEntry.readabilityVersion === state.layoutCacheVersion &&
                cacheEntry.readableWordCount !== null;

            if (alreadyProcessed) {
                this.app.sentenceParser.applyLayoutFilteringToPage(pageNumber);
                return { readable: cacheEntry.readableWordCount, total: page.pageWords.length };
            }

            const { readableBoxes, ignoreBoxes } = this._buildRegionsFromDetections(detections, viewportDisplay);

            let readableCount = 0;
            for (const word of page.pageWords) {
                const box = word?.bbox
                    ? { x1: word.bbox.x1, y1: word.bbox.y1, x2: word.bbox.x2, y2: word.bbox.y2 }
                    : {
                          x1: word.x,
                          y1: word.y - word.height,
                          x2: word.x + word.width,
                          y2: word.y,
                      };

                const insideReadable =
                    readableBoxes.length === 0 ? true : readableBoxes.some((r) => this._overlaps(box, r));
                const overlapsIgnored = ignoreBoxes.some((r) => this._overlaps(box, r));
                const isReadable = insideReadable && !overlapsIgnored;
                word.isReadable = isReadable;
                if (isReadable) readableCount++;
            }

            cacheEntry.readabilityVersion = state.layoutCacheVersion;
            cacheEntry.readableWordCount = readableCount;

            this.app.sentenceParser.applyLayoutFilteringToPage(pageNumber);
            return { readable: readableCount, total: page.pageWords.length };
        });
    }

    /**
     * NEW METHOD: Filter words based on layout detections
     * Returns only words that fall inside readable regions
     */
    filterReadableWords(pageNumber, words) {
        return this.ensureReadabilityForPage(pageNumber).then(() => (words || []).filter((word) => word?.isReadable));
    }

    _expandBox(box, viewportDisplay) {
        return {
            x1: Math.max(0, box.x1),
            y1: Math.max(0, box.y1),
            x2: Math.min(viewportDisplay.width, box.x2),
            y2: Math.min(viewportDisplay.height, box.y2),
        };
    }

    _overlaps(a, b) {
        const overlapX = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
        const overlapY = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
        return overlapX > 0 && overlapY > 0;
    }

    _nextRequestId() {
        this._requestIdCounter = (this._requestIdCounter + 1) % Number.MAX_SAFE_INTEGER;
        if (this._requestIdCounter === 0) this._requestIdCounter = 1;
        return this._requestIdCounter;
    }

    _sendWorkerDetection(payload) {
        const requestId = this._nextRequestId();
        const message = {
            action: "detect",
            requestId,
            pageNumber: payload.pageNumber,
            detectionThreshold: payload.detectionThreshold,
            detectionClasses: payload.detectionClasses,
            originalWidth: payload.originalWidth,
            originalHeight: payload.originalHeight,
            scaledWidth: payload.scaledWidth,
            scaledHeight: payload.scaledHeight,
            imageData: payload.imageData,
        };

        const transferables = [];
        if (payload.imageData?.data?.buffer) transferables.push(payload.imageData.data.buffer);

        return this.workerReadyPromise.then(
            () =>
                new Promise((resolve, reject) => {
                    this._pendingWorkerRequests.set(requestId, { resolve, reject, pageNumber: payload.pageNumber });
                    try {
                        this.worker.postMessage(message, transferables);
                    } catch (error) {
                        this._pendingWorkerRequests.delete(requestId);
                        reject(error);
                    }
                }),
        );
    }
}
