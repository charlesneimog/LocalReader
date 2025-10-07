export class PDFHeaderFooterDetector {
    constructor(app) {
        this.app = app;
        this._overlayStylesInjected = false;
        this._pageContainers = new Map();
        this._pendingOverlayData = new Map();
        this._detectionsByPage = new Map();

        this.debug = false;

        // TODO: Move this to threashold
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
        ctx.fillStyle = "rgba(255, 0, 0, 0.05)";

        // **CORREÇÃO: Usar a mesma escala do _markUnreadableText**
        const canvasWidth = baseCanvas?.width || viewportDisplay.width;
        const canvasHeight = baseCanvas?.height || viewportDisplay.height;
        const scaleX = viewportDisplay.width / canvasWidth;
        const scaleY = viewportDisplay.height / canvasHeight;

        console.log(`Scaling factors: scaleX=${scaleX}, scaleY=${scaleY}`);

        let drawnCount = 0;
        for (const det of detections) {
            if (!this.ITEMS_TO_READ.includes(det.label)) {
                let x1, y1, width, height;

                if (det.normalized) {
                    // Converte para coordenadas do viewport
                    x1 = det.normalized.left * viewportDisplay.width;
                    y1 = det.normalized.top * viewportDisplay.height;
                    width = (det.normalized.right - det.normalized.left) * viewportDisplay.width;
                    height = (det.normalized.bottom - det.normalized.top) * viewportDisplay.height;
                } else {
                    // Usa escala se não tiver coordenadas normalizadas
                    x1 = det.x1 * scaleX;
                    y1 = det.y1 * scaleY;
                    width = (det.width || det.x2 - det.x1) * scaleX;
                    height = (det.height || det.y2 - det.y1) * scaleY;
                }

                console.log(
                    `Drawing ${det.label}: (${x1.toFixed(1)}, ${y1.toFixed(1)}) ${width.toFixed(1)}x${height.toFixed(1)}`,
                );

                if (width > 0 && height > 0 && x1 < overlay.width && y1 < overlay.height) {
                    ctx.fillRect(x1, y1, width, height);
                    drawnCount++;
                }
            }
        }

        console.log(`Drawn ${drawnCount} ignored regions`);

        if (drawnCount > 0) {
            container.appendChild(overlay);
            console.log("Overlay appended successfully");
        }
    }

    _markUnreadableText(pageNumber, detections, sourceCanvas = null) {
        const { state } = this.app;
        const viewportDisplay = state.viewportDisplayByPage.get(pageNumber);
        if (!viewportDisplay) return;

        const sentenceIndices = state.pageSentencesIndex.get(pageNumber) || [];
        if (!sentenceIndices.length) return;
        const sentences = sentenceIndices.map((i) => state.sentences[i]).filter(Boolean);
        if (!sentences.length) return;

        const canvas = sourceCanvas || state.fullPageRenderCache.get(pageNumber);
        const canvasWidth = canvas?.width || viewportDisplay.width;
        const canvasHeight = canvas?.height || viewportDisplay.height;
        const scaleX = canvasWidth ? viewportDisplay.width / canvasWidth : 1;
        const scaleY = canvasHeight ? viewportDisplay.height / canvasHeight : 1;

        const toDetectionBox = (det) => {
            if (!det) return null;
            if (det.normalized) {
                return {
                    x1: det.normalized.left * viewportDisplay.width,
                    y1: det.normalized.top * viewportDisplay.height,
                    x2: det.normalized.right * viewportDisplay.width,
                    y2: det.normalized.bottom * viewportDisplay.height,
                };
            }
            if ([det.x1, det.y1, det.x2, det.y2].every((v) => typeof v === "number")) {
                return {
                    x1: det.x1 * scaleX,
                    y1: det.y1 * scaleY,
                    x2: det.x2 * scaleX,
                    y2: det.y2 * scaleY,
                };
            }
            return null;
        };

        const toSentenceBox = (sentence) => {
            const bbox = sentence?.bbox;
            if (!bbox) return null;
            const x1 = bbox.x1 ?? bbox.x ?? 0;
            const y1 = bbox.y1 ?? bbox.y ?? 0;
            const x2 = bbox.x2 ?? (bbox.x ?? 0) + (bbox.width ?? 0);
            const y2 = bbox.y2 ?? (bbox.y ?? 0) + (bbox.height ?? 0);
            if ([x1, y1, x2, y2].some((v) => Number.isNaN(v))) return null;
            return { x1, y1, x2, y2 };
        };

        const TOLERANCE = 20; // pixels around detection boxes to tolerate small misalignments
        const clampBox = (box) => ({
            x1: Math.max(0, box.x1 - TOLERANCE),
            y1: Math.max(0, box.y1 - TOLERANCE),
            x2: Math.min(viewportDisplay.width, box.x2 + TOLERANCE),
            y2: Math.min(viewportDisplay.height, box.y2 + TOLERANCE),
        });

        const detectionBoxes = detections.map((det) => ({ det, box: toDetectionBox(det) })).filter(({ box }) => !!box);

        const readableBoxes = detectionBoxes
            .filter(({ det }) => this.ITEMS_TO_READ.includes(det.label))
            .map(({ box }) => clampBox(box));

        const ignoreBoxes = detectionBoxes
            .filter(({ det }) => !this.ITEMS_TO_READ.includes(det.label))
            .map(({ box }) => clampBox(box));

        const overlaps = (a, b) => {
            const overlapX = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
            const overlapY = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
            return overlapX > 0 && overlapY > 0;
        };

        const annotatedSentences = sentences
            .map((sentence) => ({ sentence, box: toSentenceBox(sentence) }))
            .filter(({ box }) => !!box);

        for (const { sentence, box } of annotatedSentences) {
            const insideReadable = readableBoxes.some((r) => overlaps(box, r));
            const overlapsIgnored = ignoreBoxes.some((r) => overlaps(box, r));
            const shouldRead = insideReadable && !overlapsIgnored;

            sentence.isTextToRead = shouldRead;
            sentence.layoutProcessed = true;
            sentence.layoutFlags = {
                insideReadable,
                overlapsIgnored,
                readableBoxes: readableBoxes.length,
                ignoreBoxes: ignoreBoxes.length,
            };

            for (const w of sentence.words) {
                w.isTextToRead = shouldRead;
                w.layoutProcessed = true;
            }
        }

        const unreadable = annotatedSentences
            .filter(({ sentence }) => !sentence.isTextToRead)
            .map(({ sentence }) => sentence);
    }

    // ---------- Main Detection ----------
    async detectHeadersAndFooters(pageNumber, scaleFactor = 0.3) {
        await this._ensureModelReady();

        if (this._detectionsByPage.has(pageNumber)) {
            return this._detectionsByPage.get(pageNumber).detections;
        }

        const { state } = this.app;
        const canvas = state.fullPageRenderCache.get(pageNumber);
        const pagesCache = state.pagesCache.get(pageNumber);

        if (!canvas) return null;

        const ctx = canvas.getContext("2d");
        if (!ctx) {
            if (icon) icon.className = this.app.state.isPlaying ? "fa-solid fa-pause" : "fa-solid fa-play";
            return null;
        }

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
        ctx.save();
        ctx.lineWidth = 2;
        ctx.font = "16px sans-serif";
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
            const labelText = `${label} ${(score * 100).toFixed(1)}%`;
            const textWidth = ctx.measureText(labelText).width;

            const labelBoxHeight = 20;
            const labelY = Math.max(0, y1 - labelBoxHeight - 2);

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

        ctx.restore();

        const overlayPayload = { detections, canvasWidth: canvas.width, canvasHeight: canvas.height };
        this._detectionsByPage.set(pageNumber, overlayPayload);
        this._markUnreadableText(pageNumber, detections, canvas);
        this.app.ui.showInfo("");
        this._drawIgnoredDetectionsOverlay(pageNumber, detections, canvas);

        return detections;
    }

    registerPageDomElement(pageObj, pageContainer) {
        return;
    }
}
