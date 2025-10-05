export class PDFHeaderFooterDetector {
    constructor(app) {
        this.app = app;
        this._overlayStylesInjected = false;
        this._pageContainers = new Map();
        this._pendingOverlayData = new Map();
        this._detectionsByPage = new Map();
        this.DETECTION_THRESHOLD = 0.2;
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
    }

    async _ensureModelReady() {
        if (!this._modelReady) {
            this._modelReady = this._initModels();
        }
        return this._modelReady;
    }

    // ---------- Main Detection ----------
    async detectHeadersAndFooters(pageNumber, scaleFactor = 0.3) {
        await this._ensureModelReady();

        const { state } = this.app;
        const canvas = state.fullPageRenderCache.get(pageNumber);
        if (!canvas) return null;

        const ctx = canvas.getContext("2d");
        if (!ctx) return null;

        // 🔹 Criar canvas temporário reduzido
        const tmpCanvas = document.createElement("canvas");
        tmpCanvas.width = Math.floor(canvas.width * scaleFactor);
        tmpCanvas.height = Math.floor(canvas.height * scaleFactor);
        const tmpCtx = tmpCanvas.getContext("2d");
        tmpCtx.drawImage(canvas, 0, 0, tmpCanvas.width, tmpCanvas.height);

        // 🔹 Criar RawImage a partir do canvas reduzido
        const rawImage = this.app.transformers.RawImage.fromCanvas(tmpCanvas);
        const { pixel_values, reshaped_input_sizes } = await this.processor(rawImage);
        const modelOutput = await this.model({ images: pixel_values });

        const outputArray =
            typeof modelOutput.output0?.tolist === "function" ? modelOutput.output0.tolist() : modelOutput.output0;
        const predictions = Array.isArray(outputArray) ? outputArray[0] || [] : [];

        // 🔹 Escala para o canvas original
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
            const colors = this._getStyleForClass(label);
            const labelText = `${label} ${(score * 100).toFixed(1)}%`;
            const textWidth = ctx.measureText(labelText).width;

            // 🔹 Desenhar boxes no canvas original
            ctx.strokeStyle = colors.stroke;
            ctx.globalAlpha = colors.alpha;
            ctx.fillStyle = colors.fill;
            ctx.fillRect(x1, y1, w, h);
            ctx.globalAlpha = 1;
            ctx.strokeRect(x1, y1, w, h);

            const labelBoxHeight = 20;
            const labelY = Math.max(0, y1 - labelBoxHeight - 2);
            ctx.fillStyle = colors.stroke;
            ctx.fillRect(x1, labelY, textWidth + 8, labelBoxHeight);
            ctx.fillStyle = "black";
            ctx.fillText(labelText, x1 + 4, labelY + labelBoxHeight - 6);

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
        this.showHeaderFooterOverlay(pageNumber, overlayPayload);

        return detections;
    }

    _getStyleForClass(label) {
        switch (label) {
            case "page-header":
                return { stroke: "rgba(66, 135, 245, 0.95)", fill: "rgba(66, 135, 245, 0.18)", alpha: 1 };
            case "page-footer":
                return { stroke: "rgba(240, 99, 164, 0.95)", fill: "rgba(240, 99, 164, 0.2)", alpha: 1 };
            case "section-header":
                return { stroke: "rgba(255, 184, 77, 0.95)", fill: "rgba(255, 184, 77, 0.22)", alpha: 1 };
            default:
                return { stroke: "rgba(48, 199, 90, 0.95)", fill: "rgba(48, 199, 90, 0.18)", alpha: 0.4 };
        }
    }

    showHeaderFooterOverlay(pageNumber, overlayPayload) {
        const { detections, canvasWidth, canvasHeight } = overlayPayload;
        if (!Array.isArray(detections)) return;

        const pageContainer =
            this._pageContainers.get(pageNumber) ||
            document.querySelector(`.pdf-page-wrapper[data-page-number="${pageNumber}"]`);
        if (!pageContainer) {
            this._pendingOverlayData.set(pageNumber, overlayPayload);
            return;
        }

        let overlay = pageContainer.querySelector(".pdf-hf-overlay");
        if (!overlay) {
            overlay = document.createElement("div");
            overlay.className = "pdf-hf-overlay";
            pageContainer.appendChild(overlay);
        }

        overlay.innerHTML = "";
        overlay.dataset.pageNumber = String(pageNumber);

        if (!detections.length) {
            overlay.remove();
            return;
        }

        detections.forEach((det, index) => {
            const box = document.createElement("div");
            box.className = "pdf-hf-overlay-box";
            box.dataset.class = det.label;
            const leftPct = det.normalized.left * 100;
            const topPct = det.normalized.top * 100;
            const widthPct = (det.width / canvasWidth) * 100;
            const heightPct = (det.height / canvasHeight) * 100;

            box.style.left = `${leftPct}%`;
            box.style.top = `${topPct}%`;
            box.style.width = `${widthPct}%`;
            box.style.height = `${heightPct}%`;

            const colors = this._getStyleForClass(det.label);
            box.style.borderColor = colors.stroke;
            box.style.backgroundColor = colors.fill;

            const label = document.createElement("span");
            label.className = "pdf-hf-overlay-box-label";
            label.textContent = `${det.label} ${(det.score * 100).toFixed(1)}%`;
            label.style.backgroundColor = colors.stroke;
            box.appendChild(label);

            overlay.appendChild(box);
        });

        if (!overlay.parentElement) {
            pageContainer.appendChild(overlay);
        }
    }

    registerPageDomElement(pageObj, pageContainer) {
        if (!pageObj || typeof pageObj !== "object") {
            console.error("[registerPageDomElement] Invalid page object:", pageObj);
            return;
        }
        if (!pageContainer || !pageContainer.nodeType) {
            console.error("[registerPageDomElement] Invalid page container:", pageContainer);
            return;
        }

        pageObj.domElement = pageContainer;

        const inferredPageNumber = Number(pageContainer.dataset?.pageNumber ?? pageObj.pageNumber);
        if (Number.isFinite(inferredPageNumber)) {
            this._pageContainers.set(inferredPageNumber, pageContainer);
            const pending = this._pendingOverlayData.get(inferredPageNumber);
            if (pending) {
                this.showHeaderFooterOverlay(inferredPageNumber, pending);
                this._pendingOverlayData.delete(inferredPageNumber);
            }
        }
    }
}
