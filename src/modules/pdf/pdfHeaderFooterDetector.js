import { hitTestSentence } from "../utils/coordinates.js";

export class PDFHeaderFooterDetector {
    constructor(app) {
        this.app = app;
        this._overlayStylesInjected = false;
        this._pageContainers = new Map();
        this._pendingOverlayData = new Map();
        this.debug = false;

        this.app.ui.showInfo("Loading Layout AI model...");
        this.worker = new Worker("./src/modules/pdf/ts.js", { type: "module" });
        this.app.ui.showInfo("AI Layout model loaded...");

        this._pendingWorkerRequests = new Map();
        this._pendingDetectionsByPage = new Map();
        this._requestIdCounter = 0;

        const threads = Math.floor(navigator.hardwareConcurrency / 2);
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
        this.TEXT_CONFIDENCE_THRESHOLD = 0.89;
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

    _normalizeDetectionLabels(detections) {
        if (!Array.isArray(detections)) return [];
        return detections.map((det) => {
            if (!det) return det;
            const label = String(det.label || "").toLowerCase();
            const score = Number(det.score);
            if (
                label === "text" &&
                !det.manualLabel &&
                Number.isFinite(score) &&
                score < this.TEXT_CONFIDENCE_THRESHOLD
            ) {
                return {
                    ...det,
                    originalLabel: det.originalLabel || det.label,
                    label: "not-sure-text",
                };
            }
            return det;
        });
    }

    dispose() {
        try {
            this.worker?.terminate?.();
        } catch (error) {
            console.debug("[Layout] Failed to terminate worker", error);
        }
        this._pendingWorkerRequests.forEach((pending) => {
            pending.reject(new Error("Layout detector disposed"));
        });
        this._pendingWorkerRequests.clear();
        this._pendingDetectionsByPage.clear();
        this.worker = null;
        this._modelReady = null;
        this.workerReadyPromise = null;
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

    _drawDetectedLayoutOverlay(pageNumber, detections, baseCanvas) {
        const { state } = this.app;
        const viewportDisplay = state.viewportDisplayByPage.get(pageNumber);
        const container = document.querySelector(`[data-page-number="${pageNumber}"]`);
        if (!container || !viewportDisplay) return;

        container.querySelector(".layout-debug-overlay")?.remove();

        const overlay = document.createElement("canvas");
        overlay.width = viewportDisplay.width;
        overlay.height = viewportDisplay.height;
        overlay.style.position = "absolute";
        overlay.style.top = "0";
        overlay.style.left = "0";
        overlay.style.pointerEvents = "none";
        overlay.style.zIndex = "5";
        overlay.className = "layout-debug-overlay";

        const ctx = overlay.getContext("2d");
        ctx.lineWidth = 1.5;
        ctx.font = "11px sans-serif";
        ctx.textBaseline = "top";

        const canvasWidth = baseCanvas?.width || viewportDisplay.width;
        const canvasHeight = baseCanvas?.height || viewportDisplay.height;
        const scaleX = viewportDisplay.width / canvasWidth;
        const scaleY = viewportDisplay.height / canvasHeight;
        for (const det of detections || []) {
            let x, y, w, h;
            if (det.normalized) {
                x = det.normalized.left * viewportDisplay.width;
                y = det.normalized.top * viewportDisplay.height;
                w = (det.normalized.right - det.normalized.left) * viewportDisplay.width;
                h = (det.normalized.bottom - det.normalized.top) * viewportDisplay.height;
            } else {
                x = det.x1 * scaleX;
                y = det.y1 * scaleY;
                w = (det.width || det.x2 - det.x1) * scaleX;
                h = (det.height || det.y2 - det.y1) * scaleY;
            }
            if (w <= 0 || h <= 0) continue;
            ctx.strokeStyle = "rgba(255, 0, 0, 0.9)";
            ctx.fillStyle = "rgba(255, 0, 0, 0.9)";
            ctx.strokeRect(x, y, w, h);
            const label = det.score ? `${det.label} ${(det.score * 100).toFixed(0)}%` : det.label;
            const textWidth = ctx.measureText(label).width + 6;
            const labelHeight = 14;
            ctx.fillRect(x, Math.max(0, y - labelHeight), textWidth, labelHeight);
            ctx.fillStyle = "white";
            ctx.fillText(label, x + 3, Math.max(0, y - labelHeight + 2));
        }
        container.appendChild(overlay);
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
        overlay.style.zIndex = "4";
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
            const hasNewLowConfidenceText = cached.detections.some((det) => {
                const label = String(det?.label || "").toLowerCase();
                const score = Number(det?.score);
                return label === "text" && Number.isFinite(score) && score < this.TEXT_CONFIDENCE_THRESHOLD;
            });
            cached.detections = this._normalizeDetectionLabels(cached.detections);
            if (hasNewLowConfidenceText) {
                cached.readabilityVersion = null;
                cached.readableWordCount = null;
            }
            const canvas = state.fullPageRenderCache.get(pageNumber) || null;
            this._drawNotSureTextControls(pageNumber, cached.detections, canvas);
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
                const detections = this._normalizeDetectionLabels(
                    Array.isArray(payload?.detections) ? payload.detections.map((det) => ({ ...det, pageNumber })) : [],
                );

                const cacheEntry = {
                    pageNumber,
                    detections,
                    timestamp: Date.now(),
                    cacheVersion: state.layoutCacheVersion,
                    modelVersion: payload?.modelVersion || "Oblix/yolov10m-doclaynet_ONNX_document-layout-analysis",
                    readabilityVersion: null,
                    readableWordCount: null,
                };

                state.layoutDetectionCache.set(pageNumber, cacheEntry);
                this._drawIgnoredDetectionsOverlay(pageNumber, detections, canvas);
                this._drawNotSureTextControls(pageNumber, detections, canvas);

                if (this.debug) {
                    this._drawDetectedLayoutOverlay(pageNumber, detections, canvas);
                }

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

            const expanded = {
                ...this._expandBox(box, viewportDisplay),
                label: det.label,
            };
            if (this.ITEMS_TO_READ.includes(det.label)) {
                readableBoxes.push(expanded);
            } else {
                ignoreBoxes.push(expanded);
            }
        }

        return { readableBoxes, ignoreBoxes };
    }

    // Public helper: returns readable/ignored layout boxes in viewport coordinates.
    // This lets other modules (e.g. SentenceParser) use layout regions for ordering/splitting.
    async getLayoutRegions(pageNumber, { force = false } = {}) {
        const { state } = this.app;
        const viewportDisplay = state.viewportDisplayByPage.get(pageNumber);
        if (!viewportDisplay) return { readableBoxes: [], ignoreBoxes: [] };

        const detections = await this.detectHeadersAndFooters(pageNumber, 1);
        // If we have no detections, return empty regions (caller can fall back to heuristics).
        if (!Array.isArray(detections) || detections.length === 0) {
            return { readableBoxes: [], ignoreBoxes: [] };
        }

        // Optionally force readability cache refresh to keep regions consistent.
        if (force) {
            try {
                await this.ensureReadabilityForPage(pageNumber, { force: true });
            } catch {}
        }

        return this._buildRegionsFromDetections(detections, viewportDisplay);
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
                    modelVersion: "Oblix/yolov10m-doclaynet_ONNX_document-layout-analysis",
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

    _getDetectionDisplayBox(det, viewportDisplay, baseCanvas = null) {
        if (!det || !viewportDisplay) return null;

        if (det.normalized) {
            const x1 = det.normalized.left * viewportDisplay.width;
            const y1 = det.normalized.top * viewportDisplay.height;
            const x2 = det.normalized.right * viewportDisplay.width;
            const y2 = det.normalized.bottom * viewportDisplay.height;
            if (x2 <= x1 || y2 <= y1) return null;
            return { x1, y1, x2, y2, width: x2 - x1, height: y2 - y1 };
        }

        const canvasWidth = baseCanvas?.width || viewportDisplay.width;
        const canvasHeight = baseCanvas?.height || viewportDisplay.height;
        const scaleX = viewportDisplay.width / canvasWidth;
        const scaleY = viewportDisplay.height / canvasHeight;
        const x1 = det.x1 * scaleX;
        const y1 = det.y1 * scaleY;
        const width = (det.width || det.x2 - det.x1) * scaleX;
        const height = (det.height || det.y2 - det.y1) * scaleY;
        if (width <= 0 || height <= 0) return null;
        return { x1, y1, x2: x1 + width, y2: y1 + height, width, height };
    }

    _drawNotSureTextControls(pageNumber, detections, baseCanvas = null) {
        const { state } = this.app;
        const viewportDisplay = state.viewportDisplayByPage.get(pageNumber);
        const container = document.querySelector(`[data-page-number="${pageNumber}"]`);
        if (!container || !viewportDisplay) return;

        container.querySelector(".not-sure-layout-controls")?.remove();
        const uncertain = (detections || [])
            .map((det, index) => ({ det, index }))
            .filter(({ det }) => String(det?.label || "").toLowerCase() === "not-sure-text");
        if (!uncertain.length) return;

        const overlay = document.createElement("div");
        overlay.className = "not-sure-layout-controls";

        for (const { det, index } of uncertain) {
            const box = this._getDetectionDisplayBox(det, viewportDisplay, baseCanvas);
            if (!box) continue;

            const region = document.createElement("button");
            region.type = "button";
            region.className = "not-sure-layout-region";
            region.style.left = `${box.x1}px`;
            region.style.top = `${box.y1}px`;
            region.style.width = `${box.width}px`;
            region.style.height = `${box.height}px`;
            region.title = "Read this uncertain text";
            region.setAttribute("aria-label", "Read this uncertain text");
            region.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                this._readNotSureTextRegion(pageNumber, index, event).catch((error) => {
                    console.warn("[Layout] Failed to read uncertain text region", error);
                });
            });

            for (const side of ["left", "right"]) {
                const addBtn = document.createElement("button");
                addBtn.type = "button";
                addBtn.className = `not-sure-layout-add not-sure-layout-add-${side}`;
                addBtn.title = "Add as text";
                addBtn.setAttribute("aria-label", "Add as text");
                addBtn.innerHTML = `<span class="material-symbols-outlined">add</span>`;
                addBtn.addEventListener("click", (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    this.setDetectionLabel(pageNumber, index, "text").catch((error) => {
                        console.warn("[Layout] Failed to add uncertain region as text", error);
                    });
                });
                region.appendChild(addBtn);
            }

            overlay.appendChild(region);
        }

        container.appendChild(overlay);
    }

    async setDetectionLabel(pageNumber, detectionIndex, label) {
        const { state } = this.app;
        const cacheEntry = state.layoutDetectionCache.get(pageNumber);
        const detections = cacheEntry?.detections;
        const det = detections?.[detectionIndex];
        if (!det) return false;

        det.originalLabel = det.originalLabel || det.label;
        det.label = label;
        det.manualLabel = true;
        cacheEntry.readabilityVersion = null;
        cacheEntry.readableWordCount = null;

        await this.ensureReadabilityForPage(pageNumber, { force: true });
        this._refreshPageLayoutUi(pageNumber);
        this.app.ui?.showInfo?.(`Layout label: ${label}`);
        return true;
    }

    async _readNotSureTextRegion(pageNumber, detectionIndex, event) {
        const { state } = this.app;
        const wrapper = event.target?.closest?.(".pdf-page-wrapper");
        const canvas = wrapper?.querySelector?.("canvas.page-canvas");
        const viewportDisplay = state.viewportDisplayByPage.get(pageNumber);
        if (!wrapper || !canvas || !viewportDisplay) return;

        const canvasRect = canvas.getBoundingClientRect();
        const scale = parseFloat(wrapper.dataset.scale) || 1;
        const xDisplay = (event.clientX - canvasRect.left) / scale;
        const yDisplay = (event.clientY - canvasRect.top) / scale;

        await this.setDetectionLabel(pageNumber, detectionIndex, "text");

        const idx = hitTestSentence(state, pageNumber, xDisplay, yDisplay);
        if (idx < 0) return;

        await this.app.audioManager?.stopPlayback?.(true);
        state.autoAdvanceActive = false;
        await this.app.pdfRenderer?.renderSentence?.(idx, { skipTTS: true });
        this.app.cache?.clearAudioFrom?.(idx);
        this.app.ttsQueue?.add?.(idx, true);
        this.app.ttsQueue?.run?.();
        await this.app.audioManager?.playCurrentSentence?.();
    }

    _refreshPageLayoutUi(pageNumber) {
        const { state } = this.app;
        const cacheEntry = state.layoutDetectionCache.get(pageNumber);
        const detections = cacheEntry?.detections || [];
        const canvas = state.fullPageRenderCache.get(pageNumber) || null;

        this._drawIgnoredDetectionsOverlay(pageNumber, detections, canvas);
        this._drawNotSureTextControls(pageNumber, detections, canvas);
        if (this.debug) this._drawDetectedLayoutOverlay(pageNumber, detections, canvas);
        this.app.pdfRenderer?.updatePhraseHighlightsAndListeners?.({ forceFullRescale: true });
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
