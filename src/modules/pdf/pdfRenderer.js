import { isMobile, clamp, hexToRgb } from "../utils/helpers.js";
import { getPageDisplayScale } from "../utils/responsive.js";
import { EVENTS } from "../../constants/events.js";

export class PDFRenderer {
    constructor(app) {
        this.app = app;
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

        // Layout detection is now handled separately in PDFLoader
        // No need to run it here on every render

        return off;
    }

    async renderFullDocumentIfNeeded() {
        const { state, config } = this.app;
        if (state.viewMode !== "full") return;

        const container = document.getElementById("pdf-doc-container");
        if (!container) return;

        // Limpa container
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
        const scale = parseFloat(wrapper.dataset.scale) || 1;
        const wrapperTop = wrapper.offsetTop;
        const targetY = wrapperTop + bbox.y * scale - this.app.config.SCROLL_MARGIN;
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
            const scale = parseFloat(wrapper.dataset.scale) || 1;
            const canvas = wrapper.querySelector("canvas.page-canvas");
            if (!canvas) continue;

            // Use getBoundingClientRect for accurate positioning across devices
            const wrapperRect = wrapper.getBoundingClientRect();
            const canvasRect = canvas.getBoundingClientRect();
            const offsetTop = canvasRect.top - wrapperRect.top;
            const offsetLeft = canvasRect.left - wrapperRect.left;

            const wordsToRender = (() => {
                const readableWords = this.getReadableWords(sentence);
                return readableWords.length ? readableWords : sentence.words;
            })();

            if (!Array.isArray(wordsToRender) || !wordsToRender.length) continue;

            for (const word of wordsToRender) {
                const div = document.createElement("div");
                div.className = "persistent-highlight";
                if (sentenceIndex === state.currentSentenceIndex) div.classList.add("current-playing");
                div.style.left = offsetLeft + word.x * scale + "px";
                div.style.top = offsetTop + (word.y - word.height) * scale + "px";
                div.style.width = word.width * scale + "px";
                div.style.height = word.height * scale + "px";
                const rgb = hexToRgb(highlightData.color);
                if (rgb) div.style.backgroundColor = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.3)`;
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
        if (state.hoveredSentenceIndex === state.currentSentenceIndex) return;
        const wrapper = container.querySelector(`.pdf-page-wrapper[data-page-number="${s.pageNumber}"]`);
        if (!wrapper) return;
        const scale = parseFloat(wrapper.dataset.scale) || 1;
        const canvas = wrapper.querySelector("canvas.page-canvas");
        if (!canvas) return;

        // Use getBoundingClientRect for accurate positioning across devices
        const wrapperRect = wrapper.getBoundingClientRect();
        const canvasRect = canvas.getBoundingClientRect();
        const offsetTop = canvasRect.top - wrapperRect.top;
        const offsetLeft = canvasRect.left - wrapperRect.left;

        const highlightWords = this.getReadableWords(s);
        for (const w of highlightWords) {
            const div = document.createElement("div");
            div.className = "hover-highlight";
            div.style.left = offsetLeft + w.x * scale + "px";
            div.style.top = offsetTop + (w.y - w.height) * scale + "px";
            if (isMobile()) {
                div.style.top = offsetTop + w.y * scale + "px";
            } else {
                div.style.top = offsetTop + (w.y - w.height) * scale + "px";
            }
            div.style.width = w.width * scale + "px";
            div.style.height = w.height * scale + "px";
            wrapper.appendChild(div);
        }
    }

    updateHighlightFullDoc(sentence) {
        const { state } = this.app;
        if (state.viewMode !== "full") return;
        const container = document.getElementById("pdf-doc-container");
        if (!container || !sentence) return;

        // Clear old highlights
        container.querySelectorAll(".pdf-word-highlight").forEach((n) => n.remove());

        const wrapper = container.querySelector(`.pdf-page-wrapper[data-page-number="${sentence.pageNumber}"]`);
        if (!wrapper) return;
        const scale = parseFloat(wrapper.dataset.scale) || 1;
        const canvas = wrapper.querySelector("canvas.page-canvas");
        if (!canvas) return;

        // Ensure position relative on wrapper
        if (getComputedStyle(wrapper).position === "static") wrapper.style.position = "relative";

        // Use getBoundingClientRect for accurate positioning across devices
        const wrapperRect = wrapper.getBoundingClientRect();
        const canvasRect = canvas.getBoundingClientRect();
        const offsetTop = canvasRect.top - wrapperRect.top;
        const offsetLeft = canvasRect.left - wrapperRect.left;

        const highlightWords = this.getReadableWords(sentence);
        if (highlightWords.length) {
            for (const w of highlightWords) {
                const div = document.createElement("div");
                div.className = "pdf-word-highlight";
                div.style.position = "absolute";
                div.style.left = offsetLeft + w.x * scale + "px";
                if (isMobile()) {
                    div.style.top = offsetTop + w.y * scale + "px";
                } else {
                    div.style.top = offsetTop + (w.y - w.height) * scale + "px";
                }
                div.style.width = Math.max(1, w.width * scale) + "px";
                div.style.height = Math.max(1, w.height * scale) + "px";
                div.style.pointerEvents = "none";
                wrapper.appendChild(div);
            }
        }

        // Maintain original functions
        this.renderSavedHighlightsFullDoc();
        this.renderHoverHighlightFullDoc();
    }

    highlightSentenceSingleCanvas(ctx, sentence, offsetYDisplay) {
        const { state } = this.app;
        if (!ctx || !sentence) return;
        ctx.save();
        ctx.fillStyle = "rgba(255,255,0,0.28)";
        const highlightWords = this.getReadableWords(sentence);
        for (const w of highlightWords) {
            const xR = w.x * state.deviceScale;
            const yTopDisplay = w.y - w.height - offsetYDisplay;
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

            for (const word of highlightWords) {
                const xR = word.x * state.deviceScale;
                const yTopDisplay = word.y - word.height - offsetYDisplay;
                const yR = yTopDisplay * state.deviceScale;
                const widthR = word.width * state.deviceScale;
                const heightR = word.height * state.deviceScale;
                if (yR + heightR < 0 || yR > ctx.canvas.height) continue;
                ctx.fillRect(xR, yR, widthR, heightR);
            }

            if (sentenceIndex === state.currentSentenceIndex) {
                for (const word of highlightWords) {
                    const xR = word.x * state.deviceScale;
                    const yTopDisplay = word.y - word.height - offsetYDisplay;
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
        if (state.hoveredSentenceIndex === state.currentSentenceIndex) return;
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
        for (const w of highlightWords) {
            const xR = w.x * state.deviceScale;
            const yTopDisplay = w.y - w.height - offsetYDisplay;
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
            this.app.ui.showInfo(`Sentence ${sentence.index + 1}/${state.sentences.length} (Page ${pageNumber})`);
            this.app.ttsQueue.add(state.currentSentenceIndex, true);
            this.app.ttsQueue.run();
        }

        this.app.audioManager.updatePlayButton();
        this.app.ttsEngine.schedulePrefetch();
        this.app.progressManager.saveProgress();
        this.app.eventBus.emit(EVENTS.SENTENCE_CHANGED, { index: idx, sentence });
    }
}
