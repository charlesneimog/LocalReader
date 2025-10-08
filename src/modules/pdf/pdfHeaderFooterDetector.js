export class PDFHeaderFooterDetector {
    constructor(app) {
        this.app = app;
        this._overlayStylesInjected = false;
        this._pageContainers = new Map();
        this._pendingOverlayData = new Map();

        this.debug = false;

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
        this._modelReady = this._initModels();
    }

    async _initModels() {
        this.app.ui.showInfo("Loading models layout models...");
        this.model = await this.app.transformers.AutoModel.from_pretrained(
            "Oblix/yolov10m-doclaynet_ONNX_document-layout-analysis",
            {
                dtype: "fp32",
            },
        );
        this.processor = await this.app.transformers.AutoProcessor.from_pretrained(
            "Oblix/yolov10m-doclaynet_ONNX_document-layout-analysis",
        );
        this.app.ui.showInfo("Layout models loaded.");
        this._modelReady = true;
        return true;
    }

    async _ensureModelReady() {
        if (!this._modelReady) {
            await this._initModels();
        }
        return this._modelReady;
    }

    _drawIgnoredDetectionsOverlay(pageNumber, detections, baseCanvas) {
        if (!this.debug) return; // Only draw in debug mode

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
    async detectHeadersAndFooters(pageNumber, scaleFactor = 0.3) {
        await this._ensureModelReady();

        // Check cache first
        const cached = this.app.state.layoutDetectionCache.get(pageNumber);
        if (cached && cached.cacheVersion === this.app.state.layoutCacheVersion) {
            console.log(`[Layout] Using cached detection for page ${pageNumber}`);
            return cached.detections;
        }

        // Check if detection is already in progress for this page
        if (this.app.state.layoutDetectionInProgress.has(pageNumber)) {
            console.log(`[Layout] Detection already in progress for page ${pageNumber}, waiting...`);
            return await this.app.state.layoutDetectionInProgress.get(pageNumber);
        }

        // Start new detection
        const detectionPromise = this._performDetection(pageNumber, scaleFactor);
        this.app.state.layoutDetectionInProgress.set(pageNumber, detectionPromise);

        try {
            const result = await detectionPromise;
            return result;
        } finally {
            this.app.state.layoutDetectionInProgress.delete(pageNumber);
        }
    }

    async _performDetection(pageNumber, scaleFactor) {
        const { state } = this.app;
        const canvas = state.fullPageRenderCache.get(pageNumber);

        if (!canvas) {
            console.warn(`[Layout] No canvas found for page ${pageNumber}, rendering first...`);
            await this.app.pdfRenderer.ensureFullPageRendered(pageNumber);
            return this.detectHeadersAndFooters(pageNumber, scaleFactor); // retry
        }

        const ctx = canvas.getContext("2d");
        if (!ctx) {
            console.error(`[Layout] Failed to get canvas context for page ${pageNumber}`);
            return null;
        }

        console.log(`[Layout] Running detection for page ${pageNumber}...`);

        // temp canvas
        const tmpCanvas = document.createElement("canvas");
        tmpCanvas.width = Math.floor(canvas.width * scaleFactor);
        tmpCanvas.height = Math.floor(canvas.height * scaleFactor);
        const tmpCtx = tmpCanvas.getContext("2d");
        tmpCtx.drawImage(canvas, 0, 0, tmpCanvas.width, tmpCanvas.height);

        // get raw image
        const rawImage = this.app.transformers.RawImage.fromCanvas(tmpCanvas);
        const { pixel_values, reshaped_input_sizes } = await this.processor(rawImage);
        const modelOutput = await this.model({ images: pixel_values });
        const predictions = modelOutput.output0.tolist()[0];

        // downscale
        const [newHeight, newWidth] = reshaped_input_sizes?.[0] || [tmpCanvas.height, tmpCanvas.width];
        const scaleX = canvas.width / newWidth;
        const scaleY = canvas.height / newHeight;

        const detections = [];
        for (const prediction of predictions) {
            const [xmin, ymin, xmax, ymax, score, id] = prediction;
            if (score < this.DETECTION_THRESHOLD) continue;

            const x1 = Math.max(0, xmin * scaleX);
            const y1 = Math.max(0, ymin * scaleY);
            const x2 = Math.min(canvas.width, xmax * scaleX);
            const y2 = Math.min(canvas.height, ymax * scaleY);
            const w = Math.max(0, x2 - x1);
            const h = Math.max(0, y2 - y1);

            const label = this.DETECTION_CLASSES[id] || `class-${id}`;

            detections.push({
                pageNumber,
                classId: id,
                label,
                score,
                x1,
                y1,
                x2,
                y2,
                width: w,
                height: h,
                normalized: {
                    left: x1 / canvas.width,
                    top: y1 / canvas.height,
                    right: x2 / canvas.width,
                    bottom: y2 / canvas.height,
                },
            });
        }

        // Cache the results with word filtering information
        const cacheEntry = {
            pageNumber,
            detections,
            timestamp: Date.now(),
            cacheVersion: state.layoutCacheVersion,
            modelVersion: "yolov10m-doclaynet-v1",
        };

        state.layoutDetectionCache.set(pageNumber, cacheEntry);
        console.log(`[Layout] Cached ${detections.length} detections for page ${pageNumber}`);

        // Draw overlay if in debug mode
        if (this.debug) {
            this._drawIgnoredDetectionsOverlay(pageNumber, detections, canvas);
        }

        return detections;
    }

    registerPageDomElement(pageObj, pageContainer) {
        return;
    }

    /**
     * NEW METHOD: Filter words based on layout detections
     * Returns only words that fall inside readable regions
     */
    filterReadableWords(pageNumber, words) {
        const cached = this.app.state.layoutDetectionCache.get(pageNumber);

        // If no layout detection yet, return all words (will be filtered later)
        if (!cached || !cached.detections) {
            console.warn(`[Layout] No cached detections for page ${pageNumber}, returning all words`);
            return words;
        }

        const detections = cached.detections;
        const viewportDisplay = this.app.state.viewportDisplayByPage.get(pageNumber);
        if (!viewportDisplay) return words;

        // Build readable and ignore regions
        const readableBoxes = [];
        const ignoreBoxes = [];

        for (const det of detections) {
            const box = {
                x1: det.normalized.left * viewportDisplay.width,
                y1: det.normalized.top * viewportDisplay.height,
                x2: det.normalized.right * viewportDisplay.width,
                y2: det.normalized.bottom * viewportDisplay.height,
            };

            if (this.ITEMS_TO_READ.includes(det.label)) {
                readableBoxes.push(this._expandBox(box, viewportDisplay));
            } else {
                ignoreBoxes.push(this._expandBox(box, viewportDisplay));
            }
        }

        // Filter words
        const filteredWords = words.filter((word) => {
            const wordBox = {
                x1: word.x,
                y1: word.y - word.height,
                x2: word.x + word.width,
                y2: word.y,
            };

            const insideReadable = readableBoxes.some((r) => this._overlaps(wordBox, r));
            const overlapsIgnored = ignoreBoxes.some((r) => this._overlaps(wordBox, r));

            return insideReadable && !overlapsIgnored;
        });

        console.log(`[Layout] Page ${pageNumber}: Filtered ${words.length} → ${filteredWords.length} words`);
        return filteredWords;
    }

    _expandBox(box, viewportDisplay) {
        const TOLERANCE = 20;
        return {
            x1: Math.max(0, box.x1 - TOLERANCE),
            y1: Math.max(0, box.y1 - TOLERANCE),
            x2: Math.min(viewportDisplay.width, box.x2 + TOLERANCE),
            y2: Math.min(viewportDisplay.height, box.y2 + TOLERANCE),
        };
    }

    _overlaps(a, b) {
        const overlapX = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
        const overlapY = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
        return overlapX > 0 && overlapY > 0;
    }
}
