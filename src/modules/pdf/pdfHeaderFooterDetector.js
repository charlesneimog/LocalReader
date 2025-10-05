export class PDFHeaderFooterDetector {
    constructor(app) {
        this.app = app;

        this.MIN_REPETITION_RATIO = 0.4;
        this.MAX_VERTICAL_VARIANCE = 0.012;
        this.STYLE_RARITY_WEIGHT = 0.6;
        this.REPETITION_WEIGHT = 1.8;
        this.CLUSTER_EXTREMITY_WEIGHT = 1.0;
        this.GAP_HINT_WEIGHT = 0.7;
        this.PAGE_NUMBER_BONUS = 1.2;
    }

    // ---------- Helpers ----------
    average(arr) {
        return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    }

    median(arr) {
        if (!arr.length) return 0;
        const s = [...arr].sort((a, b) => a - b);
        const m = Math.floor(s.length / 2);
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    }

    variance(arr) {
        if (arr.length < 2) return 0;
        const avg = this.average(arr);
        return arr.reduce((a, b) => a + (b - avg) ** 2, 0) / arr.length;
    }

    normalizeToken(t) {
        if (/^\d+$/.test(t)) return "<NUM>";
        if (/^(page|p\.?)\s*\d+$/i.test(t)) return "<PAGE_NUM>";
        if (/^[IVXLCDM]+$/i.test(t)) return "<ROMAN_NUM>";
        return t.toLowerCase();
    }

    // ---------- Main Detection ----------
    detectHeadersAndFooters(pagesOrSingle) {
        const pagesWordData = Array.isArray(pagesOrSingle) ? pagesOrSingle : [pagesOrSingle];
        if (!pagesWordData.length) {
            console.warn("[detectHeadersAndFooters] No pages provided.");
            return { header: null, footer: null, debug: { reason: "no_pages" } };
        }

        const normalizedPages = pagesWordData.map((page, i) => {
            if (Array.isArray(page)) return page;
            if (page.pageWords && Array.isArray(page.pageWords)) return page.pageWords;
            console.warn(`[detectHeadersAndFooters] Could not coerce page ${i} to word array.`);
            return [];
        });

        // Aqui entraria a detecção real (simplificada aqui):
        const firstPage = normalizedPages[0];
        const lastPage = normalizedPages[normalizedPages.length - 1];
        const height = this.median(firstPage.map((w) => w.y + w.height));

        const header = { lines: [] };
        const footer = { lines: [] };

        // Heurística simples só pra visual feedback:
        if (firstPage.length) {
            const topWords = firstPage.filter((w) => w.y < height * 0.1);
            const bottomWords = lastPage.filter((w) => w.y > height * 0.9);
            if (topWords.length)
                header.lines.push({
                    words: topWords,
                    xLeft: 0,
                    xRight: 800,
                    yTop: topWords[0].y,
                    yBottom: topWords[0].y + 20,
                });
            if (bottomWords.length)
                footer.lines.push({
                    words: bottomWords,
                    xLeft: 0,
                    xRight: 800,
                    yTop: bottomWords[0].y,
                    yBottom: bottomWords[0].y + 20,
                });
        }

        return { header, footer, debug: { pagesAnalyzed: normalizedPages.length } };
    }

    // ---------- Overlay ----------
    ensureHeaderFooterStyles() {
        if (document.getElementById("pdf-hf-styles")) return;
        const style = document.createElement("style");
        style.id = "pdf-hf-styles";
        style.innerHTML = `
            .pdf-hf-overlay-container { position: absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; }
            .pdf-hf-overlay-line-header { background: rgba(255,0,0,0.25); position: absolute; border: 1px solid red; }
            .pdf-hf-overlay-line-footer { background: rgba(0,0,255,0.25); position: absolute; border: 1px solid blue; }
            .pdf-hf-overlay-word { border: 1px dotted rgba(0,0,0,0.2); position: absolute; }
        `;
        document.head.appendChild(style);
    }

    showHeaderFooterOverlay(pages, headerFooterResult) {
        this.ensureHeaderFooterStyles();

        pages.forEach((page, i) => {
            if (!page.domElement) {
                console.warn("[showHeaderFooterOverlay] Missing domElement for page", i);
                return;
            }

            let overlay = page.domElement.querySelector(".pdf-hf-overlay-container");
            if (!overlay) {
                overlay = document.createElement("div");
                overlay.className = "pdf-hf-overlay-container";
                page.domElement.style.position = "relative";
                page.domElement.appendChild(overlay);
            } else {
                overlay.innerHTML = "";
            }

            const addLineRect = (line, role) => {
                const rect = document.createElement("div");
                rect.className = "pdf-hf-overlay-line-" + (role === "header" ? "header" : "footer");
                rect.dataset.role = role + "-line";
                rect.style.left = `${line.xLeft}px`;
                rect.style.top = `${line.yTop}px`;
                rect.style.width = `${line.xRight - line.xLeft}px`;
                rect.style.height = `${line.yBottom - line.yTop}px`;
                overlay.appendChild(rect);

                line.words.forEach((w) => {
                    const wDiv = document.createElement("div");
                    wDiv.className = "pdf-hf-overlay-word";
                    wDiv.dataset.role = role + "-word";
                    wDiv.title = `${role.toUpperCase()}: ${w.str}`;
                    wDiv.style.left = `${w.x}px`;
                    wDiv.style.top = `${w.y}px`;
                    wDiv.style.width = `${w.width}px`;
                    wDiv.style.height = `${w.height}px`;
                    overlay.appendChild(wDiv);
                });
            };

            if (headerFooterResult.header?.lines) {
                headerFooterResult.header.lines.forEach((l) => addLineRect(l, "header"));
            }
            if (headerFooterResult.footer?.lines) {
                headerFooterResult.footer.lines.forEach((l) => addLineRect(l, "footer"));
            }
        });
    }

    // ---------- Page Registration ----------
    registerPageDomElement(pageObj, pageContainer) {
        if (!pageObj || typeof pageObj !== "object") {
            console.error("[registerPageDomElement] Invalid page object:", pageObj);
            return;
        }
        pageObj.domElement = pageContainer;
    }

    // ---------- Example Integration ----------
    async preprocessPage(pdfPage, pageNumber, pdfViewerContainer) {
        const viewport = pdfPage.getViewport({ scale: 1.5 });
        const textContent = await pdfPage.getTextContent();

        // Cria container DOM
        const container = document.createElement("div");
        container.id = `page-container-${pageNumber}`;
        container.className = "pdf-page-container";
        container.style.position = "relative";
        container.style.width = `${viewport.width}px`;
        container.style.height = `${viewport.height}px`;
        pdfViewerContainer.appendChild(container);

        // Extrai palavras
        const pageWords = textContent.items.map((item) => ({
            str: item.str,
            x: item.transform[4],
            y: viewport.height - item.transform[5],
            width: item.width,
            height: item.height || 10,
            fontName: item.fontName,
        }));

        // Registra DOM e palavras
        pdfPage.pageWords = pageWords;
        this.registerPageDomElement(pdfPage, container);

        // Detecta e mostra overlay
        const hfResult = this.detectHeadersAndFooters(pdfPage);
        this.showHeaderFooterOverlay([pdfPage], hfResult);
    }
}
