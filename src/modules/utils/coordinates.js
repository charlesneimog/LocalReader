import { isMobile } from "./helpers.js";

export function mapClientPointToPdf(e, state, config) {
    if (state.viewMode === "single") {
        const pdfCanvas = document.getElementById("pdf-canvas");
        if (!pdfCanvas) return null;
        const rect = pdfCanvas.getBoundingClientRect();
        const xClient = e.clientX;
        const yClient = e.clientY;
        if (xClient < rect.left || xClient > rect.right || yClient < rect.top || yClient > rect.bottom) return null;

        const viewportDisplay = state.viewportDisplayByPage.get(state.currentSingleViewPageNumber);
        if (!viewportDisplay) return null;

        const cssWidth = rect.width;
        let xDisplay, yDisplay;
        if (isMobile(config)) {
            const scaleCSS = cssWidth / viewportDisplay.width;
            xDisplay = (xClient - rect.left) / scaleCSS;
            yDisplay = (yClient - rect.top) / scaleCSS;
        } else {
            xDisplay = xClient - rect.left;
            yDisplay = yClient - rect.top + state.currentSingleViewOffsetY;
        }
        return {
            pageNumber: state.currentSingleViewPageNumber,
            xDisplay,
            yDisplay
        };
    } else {
        const container = document.getElementById("pdf-doc-container");
        if (!container) return null;
        const target = e.target.closest(".pdf-page-wrapper");
        if (!target) return null;
        const pageNumber = parseInt(target.dataset.pageNumber, 10);
        const scale = parseFloat(target.dataset.scale) || 1;
        
        // Get the canvas element for more accurate positioning
        const canvas = target.querySelector("canvas.page-canvas");
        const viewportDisplay = state.viewportDisplayByPage.get(pageNumber);
        if (!viewportDisplay) return null;
        
        // Use canvas rect if available, otherwise use wrapper rect
        const rect = canvas ? canvas.getBoundingClientRect() : target.getBoundingClientRect();
        const xClient = e.clientX;
        const yClient = e.clientY;
        
        if (xClient < rect.left || xClient > rect.right || yClient < rect.top || yClient > rect.bottom) return null;
        
        // Calculate display coordinates accounting for actual rendered size
        // The canvas is rendered at deviceScale but displayed at CSS scale
        const xDisplay = (xClient - rect.left) / scale;
        const yDisplay = (yClient - rect.top) / scale;
        
        return { pageNumber, xDisplay, yDisplay };
    }
}

export function hitTestSentence(state, pageNumber, xDisplay, yDisplay) {
    const indices = state.pageSentencesIndex.get(pageNumber);
    if (!indices) return -1;
    for (const idx of indices) {
        const s = state.sentences[idx];
        if (!s?.bbox) continue;
        const b = s.bbox;
        if (xDisplay >= b.x && xDisplay <= b.x + b.width && yDisplay >= b.y && yDisplay <= b.y + b.height) {
            for (const w of s.words) {
                const top = w.y - w.height;
                if (xDisplay >= w.x && xDisplay <= w.x + w.width && yDisplay >= top && yDisplay <= w.y) {
                    return idx;
                }
            }
        }
    }
    return -1;
}