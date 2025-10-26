/**
 * PDFThumbnailCache - Manages PDF thumbnail rendering and caching
 *
 * Provides high-performance thumbnail generation for saved PDFs with:
 * - Progressive rendering using requestIdleCallback
 * - Canvas reuse from PDFRenderer pool
 * - High-resolution rendering for crisp thumbnails
 * - Error handling and retry mechanisms
 */
export class PDFThumbnailCache {
    constructor(app) {
        this.app = app;

        // Thumbnail configuration
        this.config = {
            cardWidth: 350,
            displayWidth: 200 * 1.5,
            displayHeight: 280 * 1.5,
            placeholderWidth: 200,
            placeholderHeight: 280,
            qualityMultiplier: 2, // Extra sharpness multiplier
        };

        // Active render queue
        this.renderQueue = [];
        this.isProcessingQueue = false;

        this.header = document.getElementById("previous-pdf-header");
        this.container = document.getElementById("previous-pdf-container");
        this.overlay = document.getElementById("pdf-previous-list");
        this.noPdfOverlay = document.getElementById("no-pdf-overlay");
    }

    /**
     * Show saved PDFs with progressive thumbnail loading
     */
    async showSavedPDFs() {
        if (this.header) this.header.classList.remove("hidden");

        if (this.container) this.container.innerHTML = ""; // Clear previous content

        const [savedPDFs, savedEPUBs] = await Promise.all([
            this.app.progressManager.listSavedPDFs(),
            this.app.progressManager.listSavedEPUBs(),
        ]);

        const documents = [
            ...savedPDFs.map((key) => ({ key, docType: "pdf" })),
            ...savedEPUBs.map((key) => ({ key, docType: "epub" })),
        ];

        if (!documents.length) {
            if (this.overlay) this.overlay.classList.add("hidden");
            if (this.header) this.header.classList.add("hidden");
            if (this.noPdfOverlay) this.noPdfOverlay.classList.remove("hidden");
            return;
        }

        if (this.overlay) this.overlay.classList.remove("hidden");
        if (this.noPdfOverlay) this.noPdfOverlay.classList.add("hidden");

        this.renderQueue = documents.map((entry, index) => ({ ...entry, index }));

        for (const entry of documents) {
            const card = this.createPlaceholderCard(entry);
            if (this.container) this.container.appendChild(card);
        }

        this.startProgressiveRendering(this.container);
    }

    /**
     * Start progressive thumbnail rendering using idle callbacks
     */
    startProgressiveRendering(container) {
        if (this.isProcessingQueue) return;

        this.isProcessingQueue = true;

        const renderBatch = async (deadline) => {
            while (this.renderQueue.length > 0 && deadline.timeRemaining() > 0) {
                const { key, docType, index } = this.renderQueue.shift();
                try {
                    if (container && container.children[index]) {
                        if (docType === "pdf") {
                            await this.renderPdfCard(key, container.children[index]);
                        } else if (docType === "epub") {
                            await this.renderEpubCard(key, container.children[index]);
                        }
                    }
                } catch (error) {
                    console.warn(`[PDFThumbnailCache] Failed to render card for ${docType}:${key}:`, error);
                    if (this.container && this.container.children[index]) {
                        this.markCardAsError(this.container.children[index], key, docType);
                    }
                }
            }

            // Continue processing remaining items
            if (this.renderQueue.length > 0) {
                requestIdleCallback(renderBatch, { timeout: 2000 });
            } else {
                this.isProcessingQueue = false;
            }
        };

        requestIdleCallback(renderBatch, { timeout: 2000 });
    }

    /**
     * Create placeholder card for immediate UI feedback
     */
    createPlaceholderCard({ key, docType }) {
        const card = document.createElement("div");
        card.className =
            "flex flex-col items-center gap-1 p-1 bg-white dark:bg-slate-800 rounded-md shadow-sm border border-slate-200 dark:border-slate-700 relative cursor-pointer flex-shrink-0";
        card.style.width = this.config.placeholderWidth + "px";
        card.dataset.docKey = key;
        card.dataset.docType = docType;

        // Thumbnail placeholder with loading animation
        const thumbDiv = document.createElement("div");
        thumbDiv.className = "w-full rounded-md flex items-center justify-center bg-slate-100 dark:bg-slate-700";
        thumbDiv.style.width = this.config.placeholderWidth + "px";
        thumbDiv.style.height = this.config.placeholderHeight + "px";
        const iconName = docType === "epub" ? "menu_book" : "description";
        thumbDiv.innerHTML = `
            <span class="material-symbols-outlined text-4xl text-slate-400 animate-pulse">${iconName}</span>
        `;
        card.appendChild(thumbDiv);

        // Title placeholder
        const title = document.createElement("p");
        title.textContent = "Loading...";
        title.className = "text-xs font-medium truncate text-center max-w-full px-1 text-slate-400";
        card.appendChild(title);

        // Size placeholder
        const size = document.createElement("p");
        size.textContent = "-- MB";
        size.className = "text-[9px] text-text-secondary dark:text-slate-400 text-center";
        card.appendChild(size);

        return card;
    }

    /**
     * Render actual PDF card with high-resolution thumbnail
     */
    async renderPdfCard(pdfKey, cardElement) {
        const pdfData = await this.app.progressManager.loadPdfFromIndexedDB(pdfKey);
        if (!pdfData) {
            throw new Error(`No PDF data found for key: ${pdfKey}`);
        }

        const pdfBlob = pdfData.blob;
        const pdfName = pdfData.name || pdfKey;

        // Load PDF and render first page thumbnail
        const arrayBuffer = await pdfBlob.arrayBuffer();
        const pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
        const page = await pdfDoc.getPage(1);

        // Calculate scale for high-quality rendering
        const devicePixelRatio = window.devicePixelRatio || 1;
        const pageViewport = page.getViewport({ scale: 1 });

        const baseScale = this.config.displayWidth / pageViewport.width;
        const renderScale = baseScale * devicePixelRatio * this.config.qualityMultiplier;

        const viewport = page.getViewport({ scale: renderScale });

        // Reuse canvas from renderer's pool if available
        const canvas = this.app.pdfRenderer?.acquireCanvas?.() || document.createElement("canvas");
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        canvas.className = "rounded-md";

        // Set display size (CSS) smaller than render size for crisp rendering
        canvas.style.width = this.config.displayWidth + "px";
        canvas.style.height = this.config.displayHeight + "px";
        canvas.style.objectFit = "contain";
        canvas.style.objectPosition = "top center";

        const context = canvas.getContext("2d", {
            alpha: false, // Opaque rendering is faster
            desynchronized: true,
        });

        await page.render({ canvasContext: context, viewport }).promise;

        this.populatePdfCard(cardElement, canvas, pdfBlob, pdfName, pdfKey);

        // Setup cleanup observer
        this.setupCanvasCleanup(cardElement, canvas);
    }

    populatePdfCard(cardElement, canvas, pdfBlob, pdfName, pdfKey) {
        // Update card styling
        cardElement.className =
            "group flex flex-col items-center gap-1 p-1 bg-white dark:bg-slate-800 rounded-md shadow-sm hover:shadow-md border border-slate-200 dark:border-slate-700 relative cursor-pointer flex-shrink-0 transition-shadow duration-200";
        cardElement.style.width = this.config.cardWidth + "px";

        // Replace placeholder thumbnail with actual canvas
        const thumbDiv = cardElement.querySelector("div");
        thumbDiv.className = "w-full rounded-md flex justify-center overflow-hidden bg-slate-50 dark:bg-slate-900";
        thumbDiv.style.width = this.config.displayWidth + "px";
        thumbDiv.style.height = this.config.displayHeight + "px";
        thumbDiv.innerHTML = "";
        thumbDiv.appendChild(canvas);
        thumbDiv.setAttribute("data-alt", `Page 1 of ${pdfName}`);

        // Update title
        const title = cardElement.querySelector("p:nth-of-type(1)");
        title.textContent = pdfName;
        title.className = "text-xs font-medium truncate text-center max-w-full px-1 text-slate-800 dark:text-slate-200";
        title.title = pdfName; // Tooltip for long names

        // Update size
        const size = cardElement.querySelector("p:nth-of-type(2)");
        const sizeMB = (pdfBlob.size / (1024 * 1024)).toFixed(1);
        size.textContent = `${sizeMB} MB`;
        size.className = "text-[9px] text-text-secondary dark:text-slate-400 text-center";

        // Add close button (visible on hover)
        this.addCloseButton(cardElement, pdfKey, pdfName, canvas, "pdf");

        // Add click handler to open PDF
        this.addOpenHandler(cardElement, pdfBlob, pdfName, canvas, "pdf");
    }

    async renderEpubCard(epubKey, cardElement) {
        const epubData = await this.app.progressManager.loadEpubFromIndexedDB(epubKey);
        if (!epubData) {
            throw new Error(`No EPUB data found for key: ${epubKey}`);
        }

        const epubBlob = epubData.blob;
        const epubName = epubData.name || epubKey;

        this.populateEpubCard(cardElement, epubBlob, epubName, epubKey);
    }

    populateEpubCard(cardElement, epubBlob, epubName, epubKey) {
        cardElement.className =
            "group flex flex-col items-center gap-1 p-1 bg-white dark:bg-slate-800 rounded-md shadow-sm hover:shadow-md border border-slate-200 dark:border-slate-700 relative cursor-pointer flex-shrink-0 transition-shadow duration-200";
        cardElement.style.width = this.config.cardWidth + "px";

        const thumbDiv = cardElement.querySelector("div");
        thumbDiv.className =
            "w-full rounded-md flex flex-col items-center justify-center overflow-hidden bg-gradient-to-br from-slate-50 via-slate-100 to-slate-200 dark:from-slate-900 dark:via-slate-800 dark:to-slate-700";
        thumbDiv.style.width = this.config.displayWidth + "px";
        thumbDiv.style.height = this.config.displayHeight + "px";
        thumbDiv.innerHTML = `
            <span class="material-symbols-outlined text-5xl text-slate-400 dark:text-slate-500">menu_book</span>
        `;

        const title = cardElement.querySelector("p:nth-of-type(1)");
        title.textContent = epubName;
        title.className = "text-xs font-medium truncate text-center max-w-full px-1 text-slate-800 dark:text-slate-200";
        title.title = epubName;

        const size = cardElement.querySelector("p:nth-of-type(2)");
        const sizeMB = epubBlob?.size ? (epubBlob.size / (1024 * 1024)).toFixed(1) : "--";
        size.textContent = `${sizeMB} MB`;
        size.className = "text-[9px] text-text-secondary dark:text-slate-400 text-center";

        const saved = this.app.progressManager.loadSavedPosition(epubKey, "epub");
        if (saved && typeof saved.sentenceIndex === "number" && typeof saved.totalSentences === "number") {
            const progressRatio = saved.totalSentences > 0 ? saved.sentenceIndex / saved.totalSentences : 0;
            const progressPercent = Math.max(0, Math.min(100, Math.round(progressRatio * 100)));
            let progressLabel = cardElement.querySelector("p[data-progress]");
            if (!progressLabel) {
                progressLabel = document.createElement("p");
                progressLabel.dataset.progress = "true";
                progressLabel.className = "text-[9px] text-primary dark:text-primary text-center";
                cardElement.appendChild(progressLabel);
            }
            progressLabel.textContent = `Progress: ${progressPercent}%`;
        }

        this.addCloseButton(cardElement, epubKey, epubName, null, "epub");
        this.addOpenHandler(cardElement, epubBlob, epubName, null, "epub");
    }

    /**
     * Add close button to card
     */
    addCloseButton(cardElement, pdfKey, pdfName, canvas, docType = "pdf") {
        const closeBtn = document.createElement("button");
        closeBtn.className =
            "absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-full bg-slate-200/80 dark:bg-slate-900/80 hover:bg-slate-300 dark:hover:bg-slate-700";
        closeBtn.innerHTML = `<span class="material-symbols-outlined text-text-secondary dark:text-slate-400 !text-sm">close</span>`;
        closeBtn.setAttribute("aria-label", `Delete ${pdfName}`);

        closeBtn.addEventListener("click", async (e) => {
            e.stopPropagation();

            // Confirm deletion
            if (confirm(`Delete "${pdfName}" from history?`)) {
                if (docType === "epub") {
                    await this.app.progressManager.clearEpubProgress(pdfKey);
                    await this.app.progressManager.removeEpubFromIndexedDB(pdfKey);
                } else {
                    await this.app.progressManager.clearPdfProgress(pdfKey);
                    await this.app.progressManager.removePdfFromIndexedDB(pdfKey);
                }

                // Animate removal
                cardElement.style.transition = "opacity 200ms, transform 200ms";
                cardElement.style.opacity = "0";
                cardElement.style.transform = "scale(0.95)";

                setTimeout(() => {
                    cardElement.remove();

                    // Return canvas to pool
                    if (canvas && this.app.pdfRenderer?.releaseCanvas) {
                        this.app.pdfRenderer.releaseCanvas(canvas);
                    }

                    // Check if no PDFs left
                    this.checkIfEmpty();
                }, 200);
            }
        });

        cardElement.appendChild(closeBtn);
    }

    /**
     * Add click handler to open PDF
     */
    addOpenHandler(cardElement, pdfBlob, pdfName, canvas, docType = "pdf") {
        cardElement.addEventListener("click", async () => {
            try {
                const overlay = this.overlay;
                const header = this.header;
                if (overlay) overlay.classList.add("hidden");
                if (header) header.classList.add("hidden");

                if (docType === "epub") {
                    const epubFile =
                        pdfBlob instanceof File
                            ? pdfBlob
                            : new File([pdfBlob], pdfName, { type: pdfBlob.type || "application/epub+zip" });

                    await this.app.epubLoader.loadEPUB(epubFile, { resume: true });
                } else {
                    const pdfFile =
                        pdfBlob instanceof File
                            ? pdfBlob
                            : new File([pdfBlob], pdfName, { type: pdfBlob.type || "application/pdf" });

                    await this.app.pdfLoader.loadPDF(pdfFile, { resume: true });
                }

                // Hide overlay after successful load

                if (this.noPdfOverlay) this.noPdfOverlay.classList.add("hidden");

                // Return canvas to pool
                if (canvas && this.app.pdfRenderer?.releaseCanvas) {
                    this.app.pdfRenderer.releaseCanvas(canvas);
                }
            } catch (error) {
                const docLabel = docType === "epub" ? "EPUB" : "PDF";
                console.error(`[PDFThumbnailCache] Failed to load ${docLabel} ${pdfName}:`, error);
                this.app.ui?.showInfo?.(`Failed to load ${docLabel}: ${error.message}`);
            }
        });
    }

    /**
     * Setup canvas cleanup observer
     */
    setupCanvasCleanup(cardElement, canvas) {
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.removedNodes) {
                    if (node === cardElement) {
                        if (this.app.pdfRenderer?.releaseCanvas) {
                            this.app.pdfRenderer.releaseCanvas(canvas);
                        }
                        observer.disconnect();
                    }
                }
            }
        });

        const container = document.getElementById("previous-pdf-container");
        if (container) {
            observer.observe(container, { childList: true });
        }
    }

    /**
     * Mark card as error state with retry option
     */
    markCardAsError(cardElement, pdfKey) {
        const thumbDiv = cardElement.querySelector("div");
        if (thumbDiv) {
            thumbDiv.innerHTML = '<span class="material-symbols-outlined text-4xl text-red-400">error</span>';
        }

        const title = cardElement.querySelector("p:nth-of-type(1)");
        if (title) {
            title.textContent = "Failed to load";
            title.className = "text-xs font-medium truncate text-center max-w-full px-1 text-red-500 dark:text-red-400";
        }

        // Add retry button
        const retryBtn = document.createElement("button");
        retryBtn.className = "text-xs text-primary hover:underline mt-1";
        retryBtn.textContent = "Retry";
        retryBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            try {
                await this.renderCard(pdfKey, cardElement);
            } catch (err) {
                console.error(`[PDFThumbnailCache] Retry failed for ${pdfKey}:`, err);
            }
        });
        cardElement.appendChild(retryBtn);
    }

    /**
     * Check if container is empty and update UI accordingly
     */
    checkIfEmpty() {
        const container = document.getElementById("previous-pdf-container");
        if (container && container.children.length === 0) {
            const overlay = document.getElementById("pdf-previous-list");
            const noPdfOverlay = document.getElementById("no-pdf-overlay");
            if (overlay) overlay.classList.add("hidden");
            if (noPdfOverlay) noPdfOverlay.classList.remove("hidden");
        }
    }

    /**
     * Clear render queue (call when unmounting)
     */
    clearQueue() {
        this.renderQueue = [];
        this.isProcessingQueue = false;
    }

    /**
     * Update configuration
     */
    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
    }
}
