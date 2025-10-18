import { EVENTS } from "../../constants/events.js";
import { normalizeText, cooperativeYield } from "../utils/helpers.js";

export class PDFLoader {
    constructor(app) {
        this.app = app;
        this._headerFooterStylesInjected = false;
        // this._pendingHFResults = new Map();
    }

    computePdfKeyFromSource(source) {
        if (!source) return null;
        if (source.type === "url") return `url::${source.name}`;
        if (source.type === "file") {
            const { name, size = 0, lastModified = 0 } = source;
            return `file::${name}::${size}::${lastModified}`;
        }
        return null;
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

        // Store base/unscaled metrics to support lazy rescaling later
        page.unscaledWidth = unscaled.width;
        page.unscaledHeight = unscaled.height;
        page.baseDisplayScale = displayScale; // initial scale used to compute pageWords below
        page.currentDisplayScale = displayScale; // will change on orientation/resize
        page.needsWordRescale = false; // becomes true when display scale changes

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

            // Canonical (unscaled) values relative to unscaled page coordinates
            // Such that: scaledValue = canonicalValue * page.currentDisplayScale
            const canonX = e; // already in unscaled units
            const canonYDisplay = unscaled.height - f; // matches computation above before scaling
            const canonWidth = item.width || Math.abs(a);
            const canonHeight = item.height || Math.abs(d);

            const tokens = item.str.split(/(\s+)/).filter((t) => t.trim().length > 0);
            const markLineBreak = !!item.hasEOL;

            const createWord = ({ str, x: xPos, width: wordWidth, lineBreak }) => {
                const bboxTop = y - height;
                const word = {
                    pageNumber,
                    str: str.trim(),
                    x: xPos,
                    y,
                    width: wordWidth,
                    height,
                    lineBreak: !!lineBreak,
                    font: item.fontName,
                    bbox: {
                        x: xPos,
                        y: bboxTop,
                        width: wordWidth,
                        height,
                        x1: xPos,
                        y1: bboxTop,
                        x2: xPos + wordWidth,
                        y2: bboxTop + height,
                    },
                    isReadable: null,

                    // Canonical base geometry (for lazy rescaling)
                    _baseX: canonX,
                    _baseYDisplay: canonYDisplay,
                    _baseWidth: canonWidth,
                    _baseHeight: canonHeight,
                };
                pageWords.push(word);
                return word;
            };

            if (tokens.length <= 1) {
                createWord({ str: item.str, x, width, lineBreak: markLineBreak });
            } else {
                const totalChars = tokens.reduce((acc, t) => acc + t.length, 0) || 1;
                let cursorX = x;
                for (const tk of tokens) {
                    const w = width * (tk.length / totalChars);
                    createWord({ str: tk, x: cursorX, width: w, lineBreak: false });
                    cursorX += w;
                }
                if (markLineBreak && pageWords.length) {
                    pageWords[pageWords.length - 1].lineBreak = true;
                }
            }
        }

        page.pageWords = pageWords;
    }

    async loadPDF(file = null, { resume = true } = {}) {
        const { app } = this;
        const { state, config } = app;

        const icon = document.querySelector("#play-toggle span.material-symbols-outlined");
        if (icon) {
            icon.textContent = "hourglass_empty";
            icon.classList.add("animate-spin");
        }

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
                if (!state.piperInstance) {
                    try {
                        await app.ttsEngine.ensurePiper(config.DEFAULT_PIPER_VOICE);
                    } catch (err) {
                        console.error("Error ensuring Piper instance:", err);
                        app.ui.showInfo("Error: " + err.message);
                        document.body.style.cursor = "default";
                        if (icon) {
                            icon.textContent = this.app.state.isPlaying ? "pause" : "play_arrow";
                            icon.classList.remove("animate-spin");
                        }
                        return;
                    }
                }
                await app.ttsEngine.initVoices();
                document.getElementById("pdf-open")?.classList.add("fa-beat");
                document.getElementById("play-toggle-icon")?.classList.toggle("disabled");
                return;
            }

            state.currentPdfKey = this.computePdfKeyFromSource(state.currentPdfDescriptor);
            app.cache.clearAll();
            state.layoutDetectionCache.clear();
            state.layoutDetectionInProgress.clear();
            state.layoutCacheVersion += 1;
            state.layoutFilteringReady = false;
            state.layoutFilteringPromise = null;
            state.generationEnabled = false;
            state.sentences = [];
            state.currentSentenceIndex = -1;
            state.hoveredSentenceIndex = -1;
            state.pageSentencesIndex.clear();
            state.prefetchedPages.clear();
            app.ttsQueue.reset();

            let arrayBuffer;
            if (file instanceof File) {
                arrayBuffer = await file.arrayBuffer();
            } else {
                return;
            }

            const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) });
            state.pdf = await loadingTask.promise;
            if (!state.pdf.numPages) throw new Error("PDF has no pages.");

            for (let p = 1; p <= state.pdf.numPages; p++) {
                await this.preprocessPage(p);
            }

            // Build sentences (now with layout filtering)
            await app.sentenceParser.buildSentences(1);

            let startIndex = 0;
            if (state.currentPdfKey) {
                const saved = app.progressManager.loadSavedPosition(state.currentPdfKey);
                if (saved && typeof saved.sentenceIndex === "number") {
                    startIndex = Math.min(Math.max(saved.sentenceIndex, 0), state.sentences.length - 1);
                }
            }

            if (state.viewMode === "full") {
                await app.pdfRenderer.renderFullDocumentIfNeeded();
            }

            state.savedHighlights = app.highlightsStorage.loadSavedHighlights(state.currentPdfKey);
            if (state.savedHighlights.size) {
                const lastSaved = Array.from(state.savedHighlights.values()).pop();
                if (lastSaved?.color) state.selectedHighlightColor = lastSaved.color;
            }
            await app.pdfRenderer.renderSentence(startIndex);
            app.ui.showInfo(`Total sentences: ${state.sentences.length}`);
            app.audioManager.updatePlayButton();
            app.interactionHandler.setupInteractionListeners();
            app.controlsManager.reflectSelectedHighlightColor();

            app.eventBus.emit(EVENTS.PDF_LOADED, { pages: state.pdf.numPages, sentences: state.sentences.length });
            app.eventBus.emit(EVENTS.SENTENCES_PARSED, state.sentences);
        } catch (e) {
            console.error(e);
            app.ui.showInfo("Error: " + e.message);
        } finally {
            document.body.style.cursor = "default";
            if (icon) {
                icon.textContent = this.app.state.isPlaying ? "pause" : "play_arrow";
                icon.classList.remove("animate-spin");
            }
        }
    }

    async ensureLayoutFilteringReady({ forceRebuild = false } = {}) {
        const { app } = this;
        const { state } = app;

        if (!state.pdf) {
            throw new Error("No PDF is loaded.");
        }

        if (state.layoutFilteringReady && !forceRebuild) {
            return;
        }

        if (state.layoutFilteringPromise) {
            app.ui.showInfo("Finishing layout analysis...");
            return state.layoutFilteringPromise;
        }

        const promise = this._prepareLayoutFiltering({ forceRebuild });
        state.layoutFilteringPromise = promise;
        try {
            await promise;
        } finally {
            state.layoutFilteringPromise = null;
        }
    }

    async _prepareLayoutFiltering({ forceRebuild = false } = {}) {
        const { app } = this;
        const { state } = app;

        app.audioManager.stopPlayback(true);
        state.autoAdvanceActive = false;
        state.layoutFilteringReady = false;
        state.generationEnabled = true;
        state.audioCache.clear();
        app.ttsQueue.reset();
        state.prefetchedPages.clear();

        for (const sentence of state.sentences) {
            if (!sentence) continue;
            sentence.layoutProcessed = false;
            sentence.isTextToRead = false;
            sentence.readableWords = [];
            sentence.readableText = "";
            if (sentence.originalText) sentence.text = sentence.originalText;
            sentence.layoutProcessingPromise = null;
        }

        if (forceRebuild) {
            state.layoutDetectionCache.clear();
            state.layoutDetectionInProgress.clear();
            state.layoutCacheVersion += 1;
            for (const page of state.pagesCache.values()) {
                if (!page?.pageWords) continue;
                for (const word of page.pageWords) {
                    if (word) word.isReadable = null;
                }
            }
        }

        const prevSentence = state.currentSentence || null;
        const prevIndex = state.currentSentenceIndex;

        const icon = document.querySelector("#play-toggle span.material-symbols-outlined");
        if (icon) {
            icon.textContent = "hourglass_empty";
            icon.classList.add("animate-spin");
        }
        app.ui.showInfo("Preparing current page for playback...");

        const targetPages = new Set();
        if (prevSentence) {
            targetPages.add(prevSentence.pageNumber);
        } else if (state.sentences.length) {
            targetPages.add(state.sentences[0].pageNumber);
        }

        for (const pageNumber of targetPages) {
            await app.pdfRenderer.ensureFullPageRendered(pageNumber);
            await app.pdfHeaderFooterDetector.ensureReadabilityForPage(pageNumber, { force: forceRebuild });
            await cooperativeYield();
        }

        if (!state.sentences.length) {
            app.ui.showInfo("No sentences available in document.");
            state.currentSentenceIndex = -1;
            state.hoveredSentenceIndex = -1;
            state.layoutFilteringReady = true;
            app.audioManager.updatePlayButton();
            return;
        }

        const nextIndex = this._resolveResumeIndex(prevSentence, prevIndex);
        const clampedIndex = Math.min(Math.max(nextIndex, 0), state.sentences.length - 1);
        let resolvedIndex = this._findNextReadableSentence(clampedIndex);

        if (resolvedIndex < 0) {
            // Attempt to find the next readable sentence by processing pages on demand
            for (let i = 0; i < state.sentences.length; i++) {
                const sentence = state.sentences[i];
                if (!sentence || sentence.layoutProcessed) continue;
                await app.pdfRenderer.ensureFullPageRendered(sentence.pageNumber);
                await app.pdfHeaderFooterDetector.ensureReadabilityForPage(sentence.pageNumber, {
                    force: forceRebuild,
                });
                if (sentence.layoutProcessed && sentence.isTextToRead) {
                    resolvedIndex = sentence.index;
                    break;
                }
                await cooperativeYield();
            }
        }

        if (resolvedIndex >= 0) {
            await app.pdfRenderer.renderSentence(resolvedIndex);
            state.layoutFilteringReady = true;
            app.ui.showInfo(
                `Layout analysis ready. Starting from sentence ${state.currentSentenceIndex + 1}/${state.sentences.length}.`,
            );
        } else {
            state.currentSentenceIndex = -1;
            state.hoveredSentenceIndex = -1;
            state.layoutFilteringReady = true;
            app.ui.showInfo("No readable sentences found after layout filtering.");
            app.audioManager.updatePlayButton();
        }
    }

    _resolveResumeIndex(prevSentence, prevIndex) {
        const { state } = this.app;

        if (!prevSentence) {
            return prevIndex >= 0 ? prevIndex : 0;
        }

        const targetText = normalizeText(prevSentence.text);
        const directMatch = state.sentences.findIndex((s) => normalizeText(s.text) === targetText);
        if (directMatch >= 0) {
            return directMatch;
        }

        if (prevSentence.bbox) {
            let bestIdx = -1;
            let bestDelta = Number.POSITIVE_INFINITY;
            for (let i = 0; i < state.sentences.length; i++) {
                const s = state.sentences[i];
                if (s.pageNumber !== prevSentence.pageNumber || !s.bbox) continue;
                const dy = Math.abs(s.bbox.centerY - prevSentence.bbox.centerY);
                const dx = Math.abs(s.bbox.centerX - prevSentence.bbox.centerX);
                const delta = dx + dy;
                if (delta < bestDelta) {
                    bestDelta = delta;
                    bestIdx = i;
                }
            }
            if (bestIdx >= 0) {
                return bestIdx;
            }
        }

        const forwardIdx = state.sentences.findIndex((s) => s.pageNumber >= prevSentence.pageNumber);
        if (forwardIdx >= 0) {
            return forwardIdx;
        }

        return state.sentences.length - 1;
    }

    _findNextReadableSentence(startIndex = 0) {
        const { state } = this.app;
        if (!state.sentences.length) return -1;
        const clampStart = Math.min(Math.max(startIndex, 0), state.sentences.length - 1);

        for (let i = clampStart; i < state.sentences.length; i++) {
            const sentence = state.sentences[i];
            if (sentence?.layoutProcessed && sentence.isTextToRead) {
                return i;
            }
        }

        for (let i = clampStart - 1; i >= 0; i--) {
            const sentence = state.sentences[i];
            if (sentence?.layoutProcessed && sentence.isTextToRead) {
                return i;
            }
        }

        return -1;
    }
}
