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
            this.app.ui.updateStatus("Preparing PDF export...");
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

            const highlightsByPage = new Map();
            for (const [sentenceIndex, highlightData] of state.savedHighlights.entries()) {
                const sentence = state.sentences[sentenceIndex];
                if (!sentence || !sentence.words || sentence.words.length === 0) continue;
                const pageNum = sentence.pageNumber;
                if (!highlightsByPage.has(pageNum)) highlightsByPage.set(pageNum, []);
                highlightsByPage.get(pageNum).push({
                    sentence,
                    color: highlightData.color,
                    text: sentence.text
                });
            }

            for (const [pageNum, pageHighlights] of highlightsByPage.entries()) {
                if (pageNum > pages.length) continue;
                const page = pages[pageNum - 1];
                const { width, height } = page.getSize();
                const viewportDisplay = state.viewportDisplayByPage.get(pageNum);
                if (!viewportDisplay) continue;

                const scaleX = width / viewportDisplay.width;
                const scaleY = height / viewportDisplay.height;

                for (const highlight of pageHighlights) {
                    const { sentence, color } = highlight;
                    const rgb = hexToRgb(color);
                    const pdfColor = rgb ? PDFLib.rgb(rgb.r / 255, rgb.g / 255, rgb.b / 255) : PDFLib.rgb(1, 1, 0);
                    for (const word of sentence.words) {
                        const pdfX = word.x * scaleX;
                        const pdfY = height - (word.y - word.height) * scaleY;
                        const pdfWidth = word.width * scaleX;
                        const pdfHeight = word.height * scaleY;
                        page.drawRectangle({
                            x: pdfX,
                            y: pdfY - pdfHeight,
                            width: pdfWidth,
                            height: pdfHeight,
                            color: pdfColor,
                            opacity: 0.3
                        });
                    }
                }
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
            this.app.ui.updateStatus(`Exported: ${filename}`);
        } catch (error) {
            console.error("Export failed:", error);
            this.app.ui.updateStatus("Export failed: " + error.message);
            alert("Failed to export PDF: " + error.message);
        }
    }
}