import { computePdfKeyFromSource } from "./textExtractor.js";
import { EVENTS } from "../../constants/events.js";
import { normalizeText } from "../utils/helpers.js";

export class PDFLoader {
    constructor(app) {
        this.app = app;
    }

    async preprocessPage(pageNumber) {
        const { app } = this;
        const { state } = app;

        if (state.viewportDisplayByPage.has(pageNumber)) return;
        const page = await state.pdf.getPage(pageNumber);
        state.pagesCache.set(pageNumber, page);

        const unscaled = page.getViewport({ scale: 1 });
        const BASE_WIDTH_CSS = app.config.BASE_WIDTH_CSS();
        const displayScale = BASE_WIDTH_CSS / unscaled.width;
        const viewportDisplay = page.getViewport({ scale: displayScale });
        state.viewportDisplayByPage.set(pageNumber, viewportDisplay);

        const textContent = await page.getTextContent();
        const pageWords = [];
        for (const item of textContent.items) {
            if (!item?.transform || !item.str) continue;
            if (!item.str.trim()) continue;
            const [a, , , d, e, f] = item.transform;
            const x = e * displayScale;
            const y = viewportDisplay.height - f * displayScale;
            const width = (item.width || Math.abs(a)) * displayScale;
            const height = (item.height || Math.abs(d)) * displayScale;
            const tokens = item.str.split(/(\s+)/).filter((t) => t.trim().length > 0);
            const markLineBreak = !!item.hasEOL;
            if (tokens.length <= 1) {
                pageWords.push({
                    pageNumber,
                    str: item.str.trim(),
                    x,
                    y,
                    width,
                    height,
                    lineBreak: markLineBreak,
                    font: item.fontName,
                });
            } else {
                const totalChars = tokens.reduce((acc, t) => acc + t.length, 0) || 1;
                let cursorX = x;
                for (const tk of tokens) {
                    const w = width * (tk.length / totalChars);
                    pageWords.push({
                        pageNumber,
                        str: tk.trim(),
                        x: cursorX,
                        y,
                        width: w,
                        height,
                        lineBreak: false,
                        font: item.fontName,
                    });
                    cursorX += w;
                }
                if (markLineBreak && pageWords.length) pageWords[pageWords.length - 1].lineBreak = true;
            }
        }
        page.pageWords = pageWords;
    }

    async loadPDF(file = null, { resume = true } = {}) {
        const { app } = this;
        const { state, config } = app;

        document.body.style.cursor = "wait";
        try {
            if (file instanceof File) {
                state.currentPdfDescriptor = {
                    type: "file",
                    name: file.name,
                    size: file.size,
                    lastModified: file.lastModified,
                    fileObject: file,
                };
                document.getElementById("pdf-open")?.classList.remove("fa-beat");
            } else {
                // Initialization path without file (original early init)
                if (!state.piperInstance) {
                    state.piperInstance = new window.ProperPiperTTS(config.DEFAULT_PIPER_VOICE);
                    await state.piperInstance.init();
                    await state.piperInstance.getAvailableVoices();
                }
                app.ttsEngine.initVoices();
                document.getElementById("pdf-open")?.classList.add("fa-beat");
                document.getElementById("play-toggle-icon")?.classList.toggle("disabled");
                return;
            }

            state.currentPdfKey = computePdfKeyFromSource(state.currentPdfDescriptor);
            app.cache.clearAll();
            state.sentences = [];
            state.currentSentenceIndex = -1;
            state.hoveredSentenceIndex = -1;
            state.pageSentencesIndex.clear();

            let arrayBuffer;
            if (file instanceof File) {
                arrayBuffer = await file.arrayBuffer();
            } else {
                return;
            }

            const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) });
            state.pdf = await loadingTask.promise;
            if (!state.pdf.numPages) throw new Error("PDF has no pages.");

            for (let p = 1; p <= state.pdf.numPages; p++) await this.preprocessPage(p);
            app.sentenceParser.buildSentences();

            if (state.viewMode === "full") {
                await app.pdfRenderer.renderFullDocumentIfNeeded();
            }

            let startIndex = 0;
            if (resume && state.currentPdfKey) {
                const saved = app.progressManager.loadSavedPosition(state.currentPdfKey);
                if (saved && typeof saved.sentenceIndex === "number") {
                    startIndex = Math.min(Math.max(saved.sentenceIndex, 0), state.sentences.length - 1);
                }
            }
            state.savedHighlights = app.highlightsStorage.loadSavedHighlights(state.currentPdfKey);
            await app.pdfRenderer.renderSentence(startIndex);
            app.ui.showInfo(`Total sentences: ${state.sentences.length}`);
            app.audioManager.updatePlayButton();
            app.interactionHandler.setupInteractionListeners();

            app.eventBus.emit(EVENTS.PDF_LOADED, { pages: state.pdf.numPages, sentences: state.sentences.length });
            app.eventBus.emit(EVENTS.SENTENCES_PARSED, state.sentences);
        } catch (e) {
            console.error(e);
            app.ui.showInfo("Error: " + e.message);
        }
        document.body.style.cursor = "default";
    }
}
