import { isMobile, clamp, hexToRgb } from "../utils/helpers.js";
import { getPageDisplayScale } from "../utils/responsive.js";
import { EVENTS } from "../../constants/events.js";

export class PDFRenderer {
    constructor(app) {
        this.app = app;
        this.pageCoordinateSystems = new Map(); // Track coordinate system per page
    }

    getReadableWords(sentence) {
        if (!sentence) return [];
        if (Array.isArray(sentence.readableWords) && sentence.readableWords.length) {
            return sentence.readableWords;
        }
        if (sentence?.layoutProcessed) {
            return [];
        }
        return Array.isArray(sentence.words) ? sentence.words : [];
    }

    getSentenceBoundingBox(sentence) {
        if (!sentence) return null;
        if (sentence.bboxReadable && sentence.bboxReadable.width && sentence.bboxReadable.height) {
            return sentence.bboxReadable;
        }
        return sentence.bbox || null;
    }

    // NEW: Detect coordinate system for each page
    detectPageCoordinateSystem(pageNumber, words) {
        if (!words || words.length === 0) return "baseline"; // Default assumption

        // Sample a few words to detect coordinate system
        const sampleWords = words.slice(0, Math.min(5, words.length));

        // Check if words have transform matrices (more reliable)
        const hasTransforms = sampleWords.some((w) => w.transform && Array.isArray(w.transform));

        if (hasTransforms) {
            // PDF.js uses different coordinate systems - we need to check the actual rendering
            return "top-based";
        }

        // Check if y coordinates seem reasonable for top-based system
        // In top-based systems, y typically starts from top and increases downward
        // In baseline systems, y represents the baseline
        const avgHeight = sampleWords.reduce((sum, w) => sum + w.height, 0) / sampleWords.length;
        const minY = Math.min(...sampleWords.map((w) => w.y));

        // If the minimum y is very small, it's likely top-based
        if (minY < avgHeight * 2) {
            return "top-based";
        }

        return "baseline";
    }

    // NEW: Get corrected vertical position based on detected coordinate system
    getCorrectedVerticalPosition(word, scale = 1, pageNumber) {
        const coordSystem = this.pageCoordinateSystems.get(pageNumber) || "baseline";

        if (coordSystem === "top-based") {
            // For top-based coordinate system, use y directly
            return word.y * scale;
        } else {
            // For baseline coordinate system, subtract height
            return (word.y - word.height) * scale;
        }
    }

    getViewportHeight() {
        return this.app?.state?.viewportHeight || (window.visualViewport ? window.visualViewport.height : window.innerHeight);
    }

    getPageScaleFactors(wrapper, canvas, pageNumber) {
        const { state } = this.app;
        const viewportDisplay = state.viewportDisplayByPage.get(pageNumber);
        const fallbackScale = parseFloat(wrapper?.dataset?.scale) || 1;
        if (!viewportDisplay) {
            return {
                scaleX: fallbackScale,
                scaleY: fallbackScale,
            };
        }

        const canvasRect = canvas ? canvas.getBoundingClientRect() : null;
        const wrapperRect = wrapper ? wrapper.getBoundingClientRect() : null;
        const width = canvasRect?.width || wrapperRect?.width || viewportDisplay.width * fallbackScale;
        const height = canvasRect?.height || wrapperRect?.height || viewportDisplay.height * fallbackScale;

        return {
            scaleX: width / viewportDisplay.width,
            scaleY: height / viewportDisplay.height,
        };
    }

    // NEW: Test and calibrate coordinate system for a page
    calibratePageCoordinateSystem(pageNumber, sentence) {
        const words = this.getReadableWords(sentence);
        if (words.length > 0) {
            const detectedSystem = this.detectPageCoordinateSystem(pageNumber, words);
            this.pageCoordinateSystems.set(pageNumber, detectedSystem);
            console.log(`[PDFRenderer] Page ${pageNumber} coordinate system: ${detectedSystem}`);
        }
    }

    async findNextReadableSentenceForward(startIdx, visited) {
        const { state } = this.app;
        const seen = visited ?? new Set();
        for (let i = startIdx + 1; i < state.sentences.length; i++) {
            if (seen.has(i)) continue;
            let candidate = state.sentences[i];
            if (!candidate) continue;

            if (state.generationEnabled && !candidate.layoutProcessed) {
                await this.app.pdfHeaderFooterDetector.ensureReadabilityForPage(candidate.pageNumber);
                candidate = state.sentences[i];
            }

            if (!state.generationEnabled || candidate.isTextToRead) {
                return i;
            }

            seen.add(i);
        }
        return -1;
    }

    async ensureFullPageRendered(pageNumber) {
        const { state } = this.app;
        if (state.fullPageRenderCache.has(pageNumber)) return state.fullPageRenderCache.get(pageNumber);
        const page = state.pagesCache.get(pageNumber) || (await state.pdf.getPage(pageNumber));
        const viewportDisplay = state.viewportDisplayByPage.get(pageNumber);
        const fullW = Math.round(viewportDisplay.width * state.deviceScale);
        const fullH = Math.round(viewportDisplay.height * state.deviceScale);
        const scale = (viewportDisplay.width / page.getViewport({ scale: 1 }).width) * state.deviceScale;
        const viewportRender = page.getViewport({ scale });
        const off = document.createElement("canvas");
        off.width = fullW;
        off.height = fullH;
        const offCtx = off.getContext("2d");
        await page.render({ canvasContext: offCtx, viewport: viewportRender }).promise;
        state.fullPageRenderCache.set(pageNumber, off);
        return off;
    }

    async renderFullDocumentIfNeeded() {
        const { state, config } = this.app;
        if (state.viewMode !== "full") return;

        const container = document.getElementById("pdf-doc-container");
        if (!container) return;
        container.innerHTML = "";

        // IntersectionObserver para renderização virtual
        const observer = new IntersectionObserver(
            async (entries) => {
                for (const entry of entries) {
                    const pageNumber = parseInt(entry.target.dataset.pageNumber, 10);
                    const wrapper = entry.target;
                    const viewportDisplay = state.viewportDisplayByPage.get(pageNumber);
                    const scale = getPageDisplayScale(viewportDisplay, config);

                    if (entry.isIntersecting) {
                        // Renderiza canvas se ainda não existir
                        if (!wrapper.querySelector("canvas.page-canvas")) {
                            const fullPageCanvas = await this.ensureFullPageRendered(pageNumber);

                            const c = document.createElement("canvas");
                            c.className = "page-canvas";
                            c.width = Math.round(fullPageCanvas.width);
                            c.height = Math.round(fullPageCanvas.height);

                            const ctx = c.getContext("2d");
                            ctx.drawImage(
                                fullPageCanvas,
                                0,
                                0,
                                fullPageCanvas.width,
                                fullPageCanvas.height,
                                0,
                                0,
                                c.width,
                                c.height,
                            );

                            wrapper.insertBefore(c, wrapper.firstChild);
                        }
                    } else {
                        // Remove canvas pesado quando sai do viewport
                        const c = wrapper.querySelector("canvas.page-canvas");
                        if (c) c.remove();
                        state.fullPageRenderCache.delete(pageNumber);
                    }

                    // Aplica escala CSS correta no wrapper e no canvas
                    wrapper.dataset.scale = scale.toString();
                    wrapper.style.width = viewportDisplay.width * scale + "px";
                    wrapper.style.height = viewportDisplay.height * scale + "px";

                    const c = wrapper.querySelector("canvas.page-canvas");
                    if (c) {
                        c.style.width = "100%";
                        c.style.height = "100%";
                    }
                }
            },
            {
                root: container,
                rootMargin: "300px", // pré-carrega antes da página aparecer
                threshold: 0.1,
            },
        );

        // Cria wrappers para todas as páginas
        for (let p = 1; p <= state.pdf.numPages; p++) {
            const viewportDisplay = state.viewportDisplayByPage.get(p);
            const wrapper = document.createElement("div");
            wrapper.className = "pdf-page-wrapper";
            wrapper.dataset.pageNumber = p;

            // Reserva altura mínima para scroll contínuo
            wrapper.style.position = "relative";
            wrapper.style.minHeight = viewportDisplay.height + "px";
            wrapper.style.width = viewportDisplay.width + "px";

            container.appendChild(wrapper);
            observer.observe(wrapper);

            const pageObject = state.pagesCache.get(p);
            if (pageObject) {
                this.app.pdfHeaderFooterDetector.registerPageDomElement(pageObject, wrapper);
            } else {
                console.warn(`[renderFullDocumentIfNeeded] No page object found in cache for page ${p}`);
            }
        }
    }

    applyPageScale(wrapper, viewportDisplay) {
        const { state, config } = this.app;
        const scale = getPageDisplayScale(viewportDisplay, config);
        wrapper.dataset.scale = String(scale);
        wrapper.style.width = viewportDisplay.width * scale + "px";
        wrapper.style.height = viewportDisplay.height * scale + "px";
        const c = wrapper.querySelector("canvas");
        if (c) {
            c.style.width = "100%";
            c.style.height = "100%";
        }
    }

    rescaleAllPages() {
        const { state } = this.app;
        if (state.viewMode !== "full") return;
        const container = document.getElementById("pdf-doc-container");
        if (!container) return;
        container.querySelectorAll(".pdf-page-wrapper").forEach((wrapper) => {
            const p = parseInt(wrapper.dataset.pageNumber, 10);
            const viewportDisplay = state.viewportDisplayByPage.get(p);
            if (viewportDisplay) this.applyPageScale(wrapper, viewportDisplay);
        });
        this.updateHighlightFullDoc(state.currentSentence);
    }

    scrollSentenceIntoView(sentence) {
        const { state, config } = this.app;
        if (state.viewMode !== "full") return;
        const container = document.getElementById("pdf-doc-container");
        if (!container) return;
        const wrapper = container.querySelector(`.pdf-page-wrapper[data-page-number="${sentence.pageNumber}"]`);
        if (!wrapper) return;
        const bbox = this.getSentenceBoundingBox(sentence);
        if (!bbox) {
            wrapper.scrollIntoView({ behavior: "smooth", block: "center" });
            return;
        }
        const canvas = wrapper.querySelector("canvas.page-canvas");
        const { scaleY } = this.getPageScaleFactors(wrapper, canvas, sentence.pageNumber);
        const wrapperTop = wrapper.offsetTop;
        const targetY = wrapperTop + bbox.y * scaleY - this.app.config.SCROLL_MARGIN;
        const maxScroll = container.scrollHeight - container.clientHeight;
        container.scrollTo({ top: clamp(targetY, 0, maxScroll), behavior: "smooth" });
    }

    clearFullDocHighlights() {
        const container = document.getElementById("pdf-doc-container");
        if (!container) return;
        container
            .querySelectorAll(".pdf-word-highlight,.persistent-highlight,.hover-highlight")
            .forEach((n) => n.remove());
    }

    renderSavedHighlightsFullDoc() {
        const { state } = this.app;
        if (state.viewMode !== "full") return;
        const container = document.getElementById("pdf-doc-container");
        if (!container) return;
        container.querySelectorAll(".persistent-highlight").forEach((n) => n.remove());

        for (const [sentenceIndex, highlightData] of state.savedHighlights.entries()) {
            const sentence = state.sentences[sentenceIndex];
            if (!sentence) continue;
            const wrapper = container.querySelector(`.pdf-page-wrapper[data-page-number="${sentence.pageNumber}"]`);
            if (!wrapper) continue;
            const canvas = wrapper.querySelector("canvas.page-canvas");
            if (!canvas) continue;

            // Use getBoundingClientRect for accurate positioning across devices
            const wrapperRect = wrapper.getBoundingClientRect();
            const canvasRect = canvas.getBoundingClientRect();
            const offsetTop = canvasRect.top - wrapperRect.top;
            const offsetLeft = canvasRect.left - wrapperRect.left;
            const { scaleX, scaleY } = this.getPageScaleFactors(wrapper, canvas, sentence.pageNumber);

            const wordsToRender = (() => {
                const readableWords = this.getReadableWords(sentence);
                return readableWords.length ? readableWords : sentence.words;
            })();

            if (!Array.isArray(wordsToRender) || !wordsToRender.length) continue;

            // Calibrate coordinate system for this page if not already done
            if (!this.pageCoordinateSystems.has(sentence.pageNumber) && wordsToRender.length > 0) {
                this.calibratePageCoordinateSystem(sentence.pageNumber, sentence);
            }

            const currentIdx =
                state.playingSentenceIndex >= 0 ? state.playingSentenceIndex : state.currentSentenceIndex;

            for (const word of wordsToRender) {
                const div = document.createElement("div");
                div.className = "persistent-highlight";
                if (sentenceIndex === currentIdx) div.classList.add("current-playing");
                div.style.left = offsetLeft + word.x * scaleX + "px";

                // FIX: Use calibrated vertical positioning
                const correctedTop = this.getCorrectedVerticalPosition(word, 1, sentence.pageNumber);
                div.style.top = offsetTop + correctedTop * scaleY + "px";

                div.style.width = Math.max(1, word.width * scaleX) + "px";
                div.style.height = Math.max(1, word.height * scaleY) + "px";
                const rgb = hexToRgb(highlightData.color);
                if (rgb) div.style.backgroundColor = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.8)`;
                else div.style.backgroundColor = "rgba(255, 235, 59, 0.3)";
                div.style.borderRadius = "2px";
                div.title = `Highlighted: ${sentence.text.substring(0, 50)}...`;
                wrapper.appendChild(div);
            }
        }
    }

    renderHoverHighlightFullDoc() {
        const { state } = this.app;
        if (state.viewMode !== "full") return;
        const container = document.getElementById("pdf-doc-container");
        if (!container) return;
        container.querySelectorAll(".hover-highlight").forEach((n) => n.remove());
        if (state.hoveredSentenceIndex < 0 || state.hoveredSentenceIndex >= state.sentences.length) return;
        const s = state.sentences[state.hoveredSentenceIndex];
        if (!s) return;
        const currentIdx = state.playingSentenceIndex >= 0 ? state.playingSentenceIndex : state.currentSentenceIndex;
        if (state.hoveredSentenceIndex === currentIdx) return;
        const wrapper = container.querySelector(`.pdf-page-wrapper[data-page-number="${s.pageNumber}"]`);
        if (!wrapper) return;
        const canvas = wrapper.querySelector("canvas.page-canvas");
        if (!canvas) return;

        // Use getBoundingClientRect for accurate positioning across devices
        const wrapperRect = wrapper.getBoundingClientRect();
        const canvasRect = canvas.getBoundingClientRect();
        const offsetTop = canvasRect.top - wrapperRect.top;
        const offsetLeft = canvasRect.left - wrapperRect.left;
    const { scaleX, scaleY } = this.getPageScaleFactors(wrapper, canvas, s.pageNumber);

        const highlightWords = this.getReadableWords(s);

        // Calibrate coordinate system for this page if not already done
        if (!this.pageCoordinateSystems.has(s.pageNumber) && highlightWords.length > 0) {
            this.calibratePageCoordinateSystem(s.pageNumber, s);
        }

        for (const w of highlightWords) {
            const div = document.createElement("div");
            div.className = "hover-highlight";
            div.style.left = offsetLeft + w.x * scaleX + "px";

            // FIX: Use calibrated vertical positioning
            const correctedTop = this.getCorrectedVerticalPosition(w, 1, s.pageNumber);
            div.style.top = offsetTop + correctedTop * scaleY + "px";

            div.style.width = Math.max(1, w.width * scaleX) + "px";
            div.style.height = Math.max(1, w.height * scaleY) + "px";
            wrapper.appendChild(div);
        }
    }

    updateHighlightFullDoc(sentence) {
        const { state } = this.app;
        if (state.viewMode !== "full") return;
        const container = document.getElementById("pdf-doc-container");
        if (!container) return;

        const activeIndex = state.playingSentenceIndex >= 0 ? state.playingSentenceIndex : state.currentSentenceIndex;
        const targetSentence = sentence || (activeIndex >= 0 ? state.sentences[activeIndex] : null);

        // Clear old highlights
        container.querySelectorAll(".pdf-word-highlight").forEach((n) => n.remove());

        if (!targetSentence) {
            this.renderSavedHighlightsFullDoc();
            this.renderHoverHighlightFullDoc();
            return;
        }

        const wrapper = container.querySelector(`.pdf-page-wrapper[data-page-number="${targetSentence.pageNumber}"]`);
        if (!wrapper) return;
        const canvas = wrapper.querySelector("canvas.page-canvas");
        if (!canvas) return;

        // Ensure position relative on wrapper
        if (getComputedStyle(wrapper).position === "static") wrapper.style.position = "relative";

        // Use getBoundingClientRect for accurate positioning across devices
        const wrapperRect = wrapper.getBoundingClientRect();
        const canvasRect = canvas.getBoundingClientRect();
        const offsetTop = canvasRect.top - wrapperRect.top;
        const offsetLeft = canvasRect.left - wrapperRect.left;
    const { scaleX, scaleY } = this.getPageScaleFactors(wrapper, canvas, targetSentence.pageNumber);

        const highlightWords = this.getReadableWords(targetSentence);

        // Calibrate coordinate system for this page if not already done
        if (!this.pageCoordinateSystems.has(targetSentence.pageNumber) && highlightWords.length > 0) {
            this.calibratePageCoordinateSystem(targetSentence.pageNumber, targetSentence);
        }

        if (highlightWords.length) {
            for (const w of highlightWords) {
                const div = document.createElement("div");
                div.className = "pdf-word-highlight";
                div.style.position = "absolute";
                div.style.left = offsetLeft + w.x * scaleX + "px";

                // FIX: Use calibrated vertical positioning
                const correctedTop = this.getCorrectedVerticalPosition(w, 1, targetSentence.pageNumber);
                div.style.top = offsetTop + correctedTop * scaleY + "px";

                div.style.width = Math.max(1, w.width * scaleX) + "px";
                div.style.height = Math.max(1, w.height * scaleY) + "px";
                div.style.pointerEvents = "none";
                wrapper.appendChild(div);
            }
        }

        // Maintain original functions
        this.renderSavedHighlightsFullDoc();
        this.renderHoverHighlightFullDoc();
    }

    // NEW: Get corrected vertical position for canvas rendering
    getCanvasVerticalPosition(word, offsetYDisplay, pageNumber) {
        const coordSystem = this.pageCoordinateSystems.get(pageNumber) || "baseline";

        if (coordSystem === "top-based") {
            // For top-based coordinate system
            return word.y - offsetYDisplay;
        } else {
            // For baseline coordinate system
            return word.y - word.height - offsetYDisplay;
        }
    }

    highlightSentenceSingleCanvas(ctx, sentence, offsetYDisplay) {
        const { state } = this.app;
        if (!ctx || !sentence) return;
        ctx.save();
        ctx.fillStyle = "rgba(255,255,0,0.28)";
        const highlightWords = this.getReadableWords(sentence);

        // Calibrate coordinate system for this page if not already done
        if (!this.pageCoordinateSystems.has(sentence.pageNumber) && highlightWords.length > 0) {
            this.calibratePageCoordinateSystem(sentence.pageNumber, sentence);
        }

        for (const w of highlightWords) {
            const xR = w.x * state.deviceScale;
            const yTopDisplay = this.getCanvasVerticalPosition(w, offsetYDisplay, sentence.pageNumber);
            const yR = yTopDisplay * state.deviceScale;
            const widthR = w.width * state.deviceScale;
            const heightR = w.height * state.deviceScale;
            if (yR + heightR < 0 || yR > ctx.canvas.height) continue;
            ctx.fillRect(xR, yR, widthR, heightR);
        }
        ctx.restore();
    }

    renderSavedHighlightsSingleCanvas(ctx, pageNumber, offsetYDisplay) {
        const { state } = this.app;
        if (!ctx) return;
        ctx.save();
        for (const [sentenceIndex, highlightData] of state.savedHighlights.entries()) {
            const sentence = state.sentences[sentenceIndex];
            if (!sentence || sentence.pageNumber !== pageNumber) continue;
            const rgb = hexToRgb(highlightData.color);
            if (rgb) ctx.fillStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b},0.3)`;
            else ctx.fillStyle = "rgba(255,235,59,0.3)";

            const highlightWords = (() => {
                const readableWords = this.getReadableWords(sentence);
                return readableWords.length ? readableWords : sentence.words;
            })();

            // Calibrate coordinate system for this page if not already done
            if (!this.pageCoordinateSystems.has(pageNumber) && highlightWords.length > 0) {
                this.calibratePageCoordinateSystem(pageNumber, sentence);
            }

            for (const word of highlightWords) {
                const xR = word.x * state.deviceScale;
                const yTopDisplay = this.getCanvasVerticalPosition(word, offsetYDisplay, pageNumber);
                const yR = yTopDisplay * state.deviceScale;
                const widthR = word.width * state.deviceScale;
                const heightR = word.height * state.deviceScale;
                if (yR + heightR < 0 || yR > ctx.canvas.height) continue;
                ctx.fillRect(xR, yR, widthR, heightR);
            }

            const currentIdx =
                state.playingSentenceIndex >= 0 ? state.playingSentenceIndex : state.currentSentenceIndex;

            if (sentenceIndex === currentIdx) {
                for (const word of highlightWords) {
                    const xR = word.x * state.deviceScale;
                    const yTopDisplay = this.getCanvasVerticalPosition(word, offsetYDisplay, pageNumber);
                    const yR = yTopDisplay * state.deviceScale;
                    const widthR = word.width * state.deviceScale;
                    const heightR = word.height * state.deviceScale;
                    if (yR + heightR < 0 || yR > ctx.canvas.height) continue;
                    ctx.strokeRect(xR, yR, widthR, heightR);
                }
            }
        }
        ctx.restore();
    }

    drawHoveredSentenceSingleCanvas(ctx, pageNumber, offsetYDisplay) {
        const { state } = this.app;
        if (!ctx) return;
        if (state.hoveredSentenceIndex < 0 || state.hoveredSentenceIndex >= state.sentences.length) return;
        const currentIdx = state.playingSentenceIndex >= 0 ? state.playingSentenceIndex : state.currentSentenceIndex;
        if (state.hoveredSentenceIndex === currentIdx) return;
        const sentence = state.sentences[state.hoveredSentenceIndex];
        if (!sentence || sentence.pageNumber !== pageNumber) return;
        ctx.save();

        // TODO: update to use style.css
        const cssVal =
            getComputedStyle(document.documentElement).getPropertyValue("--hover-highlight-color") ||
            "rgba(0,150,255,0.18)";
        ctx.fillStyle = cssVal;
        ctx.strokeStyle =
            getComputedStyle(document.documentElement).getPropertyValue("--hover-highlight-stroke") ||
            "rgba(0,150,255,0.9)";
        ctx.lineWidth = 1.2;
        const highlightWords = this.getReadableWords(sentence);

        // Calibrate coordinate system for this page if not already done
        if (!this.pageCoordinateSystems.has(pageNumber) && highlightWords.length > 0) {
            this.calibratePageCoordinateSystem(pageNumber, sentence);
        }

        for (const w of highlightWords) {
            const xR = w.x * state.deviceScale;
            const yTopDisplay = this.getCanvasVerticalPosition(w, offsetYDisplay, pageNumber);
            const yR = yTopDisplay * state.deviceScale;
            const widthR = w.width * state.deviceScale;
            const heightR = w.height * state.deviceScale;
            if (yR + heightR < 0 || yR > ctx.canvas.height) continue;
            ctx.fillRect(xR, yR, widthR, heightR);
            ctx.strokeRect(xR, yR, widthR, heightR);
        }
        ctx.restore();
    }

    updateHighlightDisplay() {
        this.renderSavedHighlightsFullDoc();
        this.renderHoverHighlightFullDoc();
    }

    handleViewportHeightChange(height) {
        if (this._viewportHeightRaf) cancelAnimationFrame(this._viewportHeightRaf);
        this._viewportHeightRaf = requestAnimationFrame(() => {
            this._viewportHeightRaf = null;
            const { state } = this.app;
            if (window.__freezeViewportUpdates) return;
            if (state.awaitingOrientationDecision) return;
            if (state.viewMode === "full") {
                this.rescaleAllPages();
                this.updateHighlightFullDoc(state.currentSentence);
                if (state.currentSentence) this.scrollSentenceIntoView(state.currentSentence);
            }
        });
    }

    async renderSentence(idx, options = {}) {
        const { state } = this.app;
        const { autoAdvance = false } = options;
        const visited = options.visited ?? new Set();

        if (idx < 0 || idx >= state.sentences.length) return;
        if (visited.has(idx)) return;
        visited.add(idx);

        let sentence = state.sentences[idx];
        if (!sentence) return;

        const pageNumber = sentence.pageNumber;
        const pdfCanvas = document.getElementById("pdf-canvas");
        const pdfDocContainer = document.getElementById("pdf-doc-container");

        if (state.generationEnabled && !sentence.layoutProcessed) {
            await this.app.pdfHeaderFooterDetector.ensureReadabilityForPage(pageNumber);
            sentence = state.sentences[idx];
        }

        if (state.generationEnabled && !sentence.isTextToRead && autoAdvance) {
            const nextIdx = await this.findNextReadableSentenceForward(idx, visited);
            if (nextIdx >= 0 && nextIdx !== idx) {
                return this.renderSentence(nextIdx, { autoAdvance: true, visited });
            }
        }

        state.currentSentenceIndex = idx;
        sentence = state.sentences[idx];

        // Calibrate coordinate system when rendering a sentence
        if (!this.pageCoordinateSystems.has(sentence.pageNumber)) {
            this.calibratePageCoordinateSystem(sentence.pageNumber, sentence);
        }

        if (pdfCanvas) pdfCanvas.style.display = "none";
        if (pdfDocContainer) pdfDocContainer.style.display = "block";
        this.updateHighlightFullDoc(sentence);
        this.scrollSentenceIntoView(sentence);

        if (state.generationEnabled) {
            let nextReadableIdx = -1;
            try {
                nextReadableIdx = await this.findNextReadableSentenceForward(idx, new Set([idx]));
            } catch (err) {
                console.warn("[renderSentence] Failed to resolve next readable sentence", err);
            }

            if (nextReadableIdx >= 0) {
                const readableSentence = state.sentences[nextReadableIdx];
                if (readableSentence && readableSentence.pageNumber !== pageNumber) {
                    const targetPage = readableSentence.pageNumber;
                    if (!state.prefetchedPages.has(targetPage)) {
                        state.prefetchedPages.add(targetPage);

                        const queueSentence = () => {
                            const candidate = state.sentences[nextReadableIdx];
                            if (!candidate) return;
                            if (!candidate.layoutProcessed || !candidate.isTextToRead) return;
                            if (!candidate.audioReady && !candidate.audioInProgress) {
                                this.app.ttsQueue.add(nextReadableIdx, true);
                                this.app.ttsQueue.run();
                            }
                        };

                        try {
                            await this.ensureFullPageRendered(targetPage);
                            await this.app.pdfHeaderFooterDetector.ensureReadabilityForPage(targetPage);
                            queueSentence();
                        } catch (err) {
                            console.warn("[renderSentence] Prefetch workflow failed for page", targetPage, err);
                            state.prefetchedPages.delete(targetPage);
                        }
                    }
                }
            }
        }

        if (state.generationEnabled && !sentence.isTextToRead) {
            this.app.ui.showInfo(
                `Sentence ${sentence.index + 1} is outside readable layout regions. Select another sentence to play.`,
            );
        } else {
            this.app.ttsQueue.add(state.currentSentenceIndex, true);
            this.app.ttsQueue.run();
        }

        this.app.audioManager.updatePlayButton();
        this.app.ttsEngine.schedulePrefetch();
        this.app.progressManager.saveProgress();
        this.app.eventBus.emit(EVENTS.SENTENCE_CHANGED, { index: idx, sentence });
    }
}
