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

        // Unified coordinate mapping: CSS pixels to display coordinates
        const cssWidth = rect.width;
        const cssHeight = rect.height;
        const scaleCSS = cssWidth / viewportDisplay.width;
        const xDisplay = (xClient - rect.left) / scaleCSS;
        const yDisplay = (yClient - rect.top) / scaleCSS;
        
        // For single view mode, add scroll offset
        const adjustedYDisplay = state.viewMode === "single" ? yDisplay + state.currentSingleViewOffsetY : yDisplay;
        
        return {
            pageNumber: state.currentSingleViewPageNumber,
            xDisplay,
            yDisplay: adjustedYDisplay
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
        
        // Unified coordinate mapping: CSS pixels to display coordinates
        // The scale factor converts from CSS pixels to display coordinates
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