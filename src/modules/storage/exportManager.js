import { hexToRgb } from "../utils/helpers.js";

export class ExportManager {
    constructor(app) {
        this.app = app;
    }

    async exportPdfWithHighlights() {
        const { state } = this.app;
        if (!state.currentPdfDescriptor || state.savedHighlights.size === 0) {
            alert("No highlights to export or no PDF loaded.");
            return;
        }
        try {
            this.app.ui.showInfo("Preparing PDF export...");
            let pdfBytes;
            if (state.currentPdfDescriptor.type === "file") {
                if (state.currentPdfDescriptor.fileObject) {
                    pdfBytes = await state.currentPdfDescriptor.fileObject.arrayBuffer();
                } else {
                    throw new Error("Original file object not available for export");
                }
            } else if (state.currentPdfDescriptor.type === "url") {
                const response = await fetch(state.currentPdfDescriptor.url);
                pdfBytes = await response.arrayBuffer();
            } else {
                throw new Error("Cannot export: unsupported PDF source");
            }

            const pdfDoc = await PDFLib.PDFDocument.load(pdfBytes);
            const pages = pdfDoc.getPages();
            const { PDFName, PDFString, PDFNumber, PDFArray } = PDFLib;

            // For each saved highlight (by sentence index), create a single Highlight annotation
            for (const [sentenceIndex, highlightData] of state.savedHighlights.entries()) {
                const sentence = state.sentences[sentenceIndex];
                if (!sentence || !sentence.words || sentence.words.length === 0) continue;
                const pageNum = sentence.pageNumber;
                if (pageNum > pages.length) continue;
                const page = pages[pageNum - 1];
                const { width, height } = page.getSize();
                const viewportDisplay = state.viewportDisplayByPage.get(pageNum);
                if (!viewportDisplay) continue;

                const scaleX = width / viewportDisplay.width;
                const scaleY = height / viewportDisplay.height;

                // Convert hex color to rgb 0-1 values
                const rgb = hexToRgb(highlightData.color) || { r: 255, g: 255, b: 0 };
                const colorArray = [rgb.r / 255, rgb.g / 255, rgb.b / 255];

                // Collect QuadPoints for all words in the sentence
                // PDF QuadPoints are arrays of numbers in user space: [x1,y1, x2,y2, x3,y3, x4,y4] per rectangle
                const quadPoints = [];
                const wordsToAnnotate =
                    Array.isArray(sentence.readableWords) && sentence.readableWords.length
                        ? sentence.readableWords
                        : sentence.words;

                // Detect the coordinate reference used for this page so we can convert to PDF space (origin bottom-left)
                const renderer = this.app?.pdfRenderer;
                let coordSystem = renderer?.pageCoordinateSystems?.get(pageNum) || null;
                if (!coordSystem && renderer && typeof renderer.detectPageCoordinateSystem === "function") {
                    coordSystem = renderer.detectPageCoordinateSystem(pageNum, wordsToAnnotate) || null;
                    if (coordSystem && renderer.pageCoordinateSystems) {
                        renderer.pageCoordinateSystems.set(pageNum, coordSystem);
                    }
                }
                coordSystem = coordSystem || "baseline";

                // Prefer exporting merged per-line highlights (matches on-screen rendering)
                let lineRects = [];
                if (renderer && typeof renderer.getMergedLineRects === "function") {
                    // Use a slightly looser tolerance for export to avoid splitting a single visual line.
                    lineRects = renderer.getMergedLineRects(wordsToAnnotate, pageNum, { offsetYDisplay: 1, yTolerance: 3 }) || [];
                }

                if (Array.isArray(lineRects) && lineRects.length) {
                    for (const r of lineRects) {
                        const x1 = r.x * scaleX;
                        const x2 = (r.x + r.width) * scaleX;

                        const displayTop = r.y;
                        const displayBottom = r.y + r.height;

                        const yTop = height - displayTop * scaleY;
                        const yBottom = height - displayBottom * scaleY;

                        quadPoints.push(x1, yTop, x2, yTop, x2, yBottom, x1, yBottom);
                    }
                } else {
                    // Fallback: per-word quads (older behavior)
                    for (const word of wordsToAnnotate) {
                        const x1 = word.x * scaleX;
                        const x2 = x1 + word.width * scaleX;

                        const displayTop = coordSystem === "top-based" ? word.y : word.y - word.height;
                        const displayBottom = displayTop + word.height;

                        const yTop = height - displayTop * scaleY;
                        const yBottom = height - displayBottom * scaleY;

                        quadPoints.push(x1, yTop, x2, yTop, x2, yBottom, x1, yBottom);
                    }
                }

                if (quadPoints.length === 0) continue;

                // Compute bounding rect for the annotation: [xMin, yMin, xMax, yMax]
                const xs = quadPoints.filter((_, i) => i % 2 === 0);
                const ys = quadPoints.filter((_, i) => i % 2 === 1);
                const xMin = Math.min(...xs);
                const xMax = Math.max(...xs);
                const yMin = Math.min(...ys);
                const yMax = Math.max(...ys);

                const createdAt = highlightData?.timestamp ? new Date(highlightData.timestamp) : new Date();
                const modifiedAt = new Date();
                const annotationContents = sentence?.text ? sentence.text.slice(0, 1024) : "";

                // TODO: Add login userName or identifier here
                const annotationAuthor = "LocalReader";
                const uniqueId = `hl-${pageNum}-${sentenceIndex}-${createdAt.getTime()}`;

                const highlightDict = pdfDoc.context.obj({
                    Type: PDFName.of("Annot"),
                    Subtype: PDFName.of("Highlight"),
                    Rect: pdfDoc.context.obj([xMin, yMin, xMax, yMax]),
                    QuadPoints: pdfDoc.context.obj(quadPoints),
                    C: pdfDoc.context.obj(colorArray),
                    F: PDFNumber.of(4),
                    CA: PDFNumber.of(1),
                    NM: PDFString.of(uniqueId),
                    T: PDFString.of(annotationAuthor),
                    Contents: PDFString.of(annotationContents),
                    CreationDate: PDFString.fromDate(createdAt),
                    M: PDFString.fromDate(modifiedAt),
                });

                const highlightRef = pdfDoc.context.register(highlightDict);

                const annotsKey = PDFName.of("Annots");
                let annots = page.node.get(annotsKey);
                let annotsArray;

                if (!annots) {
                    annotsArray = PDFArray.withContext(pdfDoc.context);
                    const annotsRef = pdfDoc.context.register(annotsArray);
                    page.node.set(annotsKey, annotsRef);
                } else if (annots instanceof PDFArray) {
                    annotsArray = annots;
                } else {
                    annotsArray = pdfDoc.context.lookup(annots, PDFArray);
                }

                annotsArray.push(highlightRef);
            }

            const originalName = state.currentPdfDescriptor.name || "document";
            const baseName = originalName.replace(/\.pdf$/i, "");
            const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
            const filename = `${baseName}_highlighted_${timestamp}.pdf`;

            const highlightedPdfBytes = await pdfDoc.save();
            const blob = new Blob([highlightedPdfBytes], { type: "application/pdf" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);
            this.app.ui.showInfo(`Exported: ${filename}`);
        } catch (error) {
            console.error("Export failed:", error);
            this.app.ui.showInfo("Export failed: " + error.message);
            alert("Failed to export PDF: " + error.message);
        }
    }
}
