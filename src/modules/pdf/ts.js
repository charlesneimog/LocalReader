import { AutoModel, AutoProcessor, RawImage, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5";

let model;
let processor;
let initPromise = null;
const MODEL_VERSION = "yolov10m-doclaynet-v1";

const serializeError = (error) => ({
    message: error?.message || String(error),
    stack: error?.stack || null,
    name: error?.name || "Error",
});

function ensureInitialized(config) {
    if (!initPromise) {
        initPromise = (async () => {
            env.backends.onnx.wasm.numThreads = config.threads;
            env.backends.onnx.wasm.simd = true;
            env.backends.onnx.backend = config.webgpu ? "webgpu" : "wasm";
            env.backends.onnx.logLevel = "error";
            env.allowLocalModels = false;
            model = await AutoModel.from_pretrained("Oblix/yolov10m-doclaynet_ONNX_document-layout-analysis", {
                dtype: "fp32",
            });
            processor = await AutoProcessor.from_pretrained("Oblix/yolov10m-doclaynet_ONNX_document-layout-analysis");
        })()
            .then(() => {
                self.postMessage({ status: "ready" });
            })
            .catch((error) => {
                self.postMessage({ status: "error", error: serializeError(error) });
                throw error;
            });
    }
    return initPromise;
}

async function runDetection(payload) {
    const {
        requestId,
        pageNumber,
        imageData,
        originalWidth,
        originalHeight,
        scaledWidth,
        scaledHeight,
        detectionThreshold,
        detectionClasses,
    } = payload;

    // Create an OffscreenCanvas inside the worker
    const offscreenCanvas = new OffscreenCanvas(imageData.width, imageData.height);
    const ctx = offscreenCanvas.getContext("2d");
    ctx.putImageData(imageData, 0, 0);

    // Use RawImage.fromCanvas instead of RawImage.read
    const rawImage = RawImage.fromCanvas(offscreenCanvas);

    const { pixel_values, reshaped_input_sizes } = await processor(rawImage);
    const modelOutput = await model({ images: pixel_values });
    const predictions = modelOutput.output0.tolist()[0] || [];

    const [newHeight, newWidth] = reshaped_input_sizes?.[0] || [scaledHeight, scaledWidth];
    const scaleX = originalWidth / newWidth;
    const scaleY = originalHeight / newHeight;

    const detections = [];
    for (const prediction of predictions) {
        const [xmin, ymin, xmax, ymax, score, id] = prediction;
        if (score < detectionThreshold) continue;

        const x1 = Math.max(0, xmin * scaleX);
        const y1 = Math.max(0, ymin * scaleY);
        const x2 = Math.min(originalWidth, xmax * scaleX);
        const y2 = Math.min(originalHeight, ymax * scaleY);
        const width = Math.max(0, x2 - x1);
        const height = Math.max(0, y2 - y1);

        const label = detectionClasses[id] || `class-${id}`;

        detections.push({
            classId: id,
            label,
            score,
            x1,
            y1,
            x2,
            y2,
            width,
            height,
            normalized: {
                left: x1 / originalWidth,
                top: y1 / originalHeight,
                right: x2 / originalWidth,
                bottom: y2 / originalHeight,
            },
        });
    }

    self.postMessage({
        status: "detections",
        requestId,
        pageNumber,
        detections,
        modelVersion: MODEL_VERSION,
    });
}

self.onmessage = (event) => {
    const { action } = event.data || {};

    if (action === "init") {
        ensureInitialized(event.data).catch(() => {});
        return;
    }

    if (action === "detect") {
        (initPromise || Promise.reject(new Error("Worker not initialized")))
            .then(() => runDetection(event.data))
            .catch((error) => {
                self.postMessage({
                    status: "error",
                    requestId: event.data.requestId,
                    pageNumber: event.data.pageNumber,
                    error: serializeError(error),
                });
            });
    }
};
