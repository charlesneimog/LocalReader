import { clamp, hexToRgb } from "../utils/helpers.js";
import { getPageDisplayScale } from "../utils/responsive.js";
import { EVENTS } from "../../constants/events.js";

export class PDFRenderer {
    constructor(app) {
        this.app = app;
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

        // classify page
        if (this.app.state.generationEnabled) {
            this.app.ui.showInfo("Running layout detection...");
            this.app.pdfHeaderFooterDetector.detectHeadersAndFooters(pageNumber);
        } else {
            this.app.ui.showInfo("");
        }

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

                            // Desenha canvas offscreen escalado para a resolução correta
                            const ctx = c.getContext("2d");
                            ctx.clearRect(0, 0, c.width, c.height);
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
        const bbox = sentence.bbox;
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

            for (const word of sentence.words) {
                const div = document.createElement("div");
                div.className = "persistent-highlight";
                if (sentenceIndex === state.currentSentenceIndex) div.classList.add("current-playing");
                div.style.left = word.x * scale + "px";
                div.style.top = (word.y - word.height) * scale + "px";
                div.style.width = word.width * scale + "px";
                div.style.height = word.height * scale + "px";
                div.style.backgroundColor = highlightData.color;
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
        for (const w of s.words) {
            const div = document.createElement("div");
            div.className = "hover-highlight";
            div.style.left = w.x * scale + "px";
            div.style.top = (w.y - w.height) * scale + "px";
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
        container.querySelectorAll(".pdf-word-highlight").forEach((n) => n.remove());
        const wrapper = container.querySelector(`.pdf-page-wrapper[data-page-number="${sentence.pageNumber}"]`);
        if (!wrapper) return;
        const scale = parseFloat(wrapper.dataset.scale) || 1;
        for (const w of sentence.words) {
            const div = document.createElement("div");
            div.className = "pdf-word-highlight";
            div.style.left = w.x * scale + "px";
            div.style.top = (w.y - w.height) * scale + "px";
            div.style.width = w.width * scale + "px";
            div.style.height = w.height * scale + "px";
            wrapper.appendChild(div);
        }
        this.renderSavedHighlightsFullDoc();
        this.renderHoverHighlightFullDoc();
    }

    highlightSentenceSingleCanvas(ctx, sentence, offsetYDisplay) {
        const { state } = this.app;
        if (!ctx || !sentence) return;
        ctx.save();
        ctx.fillStyle = "rgba(255,255,0,0.28)";
        for (const w of sentence.words) {
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

            for (const word of sentence.words) {
                const xR = word.x * state.deviceScale;
                const yTopDisplay = word.y - word.height - offsetYDisplay;
                const yR = yTopDisplay * state.deviceScale;
                const widthR = word.width * state.deviceScale;
                const heightR = word.height * state.deviceScale;
                if (yR + heightR < 0 || yR > ctx.canvas.height) continue;
                ctx.fillRect(xR, yR, widthR, heightR);
            }

            if (sentenceIndex === state.currentSentenceIndex) {
                for (const word of sentence.words) {
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
        for (const w of sentence.words) {
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
        const { state } = this.app;
        if (state.viewMode === "full") {
            this.renderSavedHighlightsFullDoc();
            this.renderHoverHighlightFullDoc();
        } else {
            this.renderSentence(state.currentSentenceIndex);
        }
    }

    async renderSentence(idx) {
        const { state, config } = this.app;
        if (idx < 0 || idx >= state.sentences.length) return;
        state.currentSentenceIndex = idx;
        const sentence = state.sentences[idx];
        const pageNumber = sentence.pageNumber;

        if (!sentence.isTextToRead && sentence.layoutProcessed) {
            //console.log("Skipping non-readable sentence:", sentence.text);
            this.app.nextSentence(true);
            return;
        }

        const pdfCanvas = document.getElementById("pdf-canvas");
        const pdfDocContainer = document.getElementById("pdf-doc-container");

        if (state.viewMode === "full") {
            if (pdfCanvas) pdfCanvas.style.display = "none";
            if (pdfDocContainer) pdfDocContainer.style.display = "block";
            this.updateHighlightFullDoc(sentence);
            this.scrollSentenceIntoView(sentence);
        } else {
            alert("OLD CODE DETECTED");
            return;
        }

        this.app.ui.showInfo(`Sentence ${sentence.index + 1}/${state.sentences.length} (Page ${pageNumber})`);
        this.app.audioManager.updatePlayButton();
        this.app.ttsEngine.schedulePrefetch();
        this.app.progressManager.saveProgress();
        this.app.eventBus.emit(EVENTS.SENTENCE_CHANGED, { index: idx, sentence });
    }
}
