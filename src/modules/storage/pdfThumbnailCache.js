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

        const savedPDFs = await this.app.progressManager.listSavedPDFs();
        if (!savedPDFs.length) {
            if (this.overlay) this.overlay.classList.add("hidden");
            if (this.header) this.header.classList.add("hidden");
            if (this.noPdfOverlay) this.noPdfOverlay.classList.remove("hidden");
            return;
        }

        if (this.overlay) this.overlay.classList.remove("hidden");
        if (this.noPdfOverlay) this.noPdfOverlay.classList.add("hidden");
        if (this.container) {
            // this.container.className = "flex flex-row gap-2 overflow-x-auto p-2";
        }

        // Render PDF cards progressively using idle callbacks for better performance
        this.renderQueue = savedPDFs.map((pdfKey, index) => ({ pdfKey, index }));

        // Create placeholder cards immediately for better perceived performance
        for (const pdfKey of savedPDFs) {
            const card = this.createPlaceholderCard(pdfKey);
            if (this.container) this.container.appendChild(card);
        }

        // Start progressive rendering
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
                const { pdfKey, index } = this.renderQueue.shift();
                try {
                    if (container && container.children[index]) {
                        await this.renderCard(pdfKey, container.children[index]);
                    }
                } catch (error) {
                    console.warn(`[PDFThumbnailCache] Failed to render card for ${pdfKey}:`, error);
                    if (this.container && this.container.children[index]) {
                        this.markCardAsError(this.container.children[index], pdfKey);
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
    createPlaceholderCard(pdfKey) {
        const card = document.createElement("div");
        card.className =
            "flex flex-col items-center gap-1 p-1 bg-white dark:bg-slate-800 rounded-md shadow-sm border border-slate-200 dark:border-slate-700 relative cursor-pointer flex-shrink-0";
        card.style.width = this.config.placeholderWidth + "px";
        card.dataset.pdfKey = pdfKey;

        // Thumbnail placeholder with loading animation
        const thumbDiv = document.createElement("div");
        thumbDiv.className = "w-full rounded-md flex items-center justify-center bg-slate-100 dark:bg-slate-700";
        thumbDiv.style.width = this.config.placeholderWidth + "px";
        thumbDiv.style.height = this.config.placeholderHeight + "px";
        thumbDiv.innerHTML =
            '<span class="material-symbols-outlined text-4xl text-slate-400 animate-pulse">description</span>';
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
    async renderCard(pdfKey, cardElement) {
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

        // Update card with actual content
        this.populateCard(cardElement, canvas, pdfBlob, pdfName, pdfKey);

        // Setup cleanup observer
        this.setupCanvasCleanup(cardElement, canvas);
    }

    /**
     * Populate card element with rendered content
     */
    populateCard(cardElement, canvas, pdfBlob, pdfName, pdfKey) {
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
        this.addCloseButton(cardElement, pdfKey, pdfName, canvas);

        // Add click handler to open PDF
        this.addOpenHandler(cardElement, pdfBlob, pdfName, canvas);
    }

    /**
     * Add close button to card
     */
    addCloseButton(cardElement, pdfKey, pdfName, canvas) {
        const closeBtn = document.createElement("button");
        closeBtn.className =
            "absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-full bg-slate-200/80 dark:bg-slate-900/80 hover:bg-slate-300 dark:hover:bg-slate-700";
        closeBtn.innerHTML = `<span class="material-symbols-outlined text-text-secondary dark:text-slate-400 !text-sm">close</span>`;
        closeBtn.setAttribute("aria-label", `Delete ${pdfName}`);

        closeBtn.addEventListener("click", async (e) => {
            e.stopPropagation();

            // Confirm deletion
            if (confirm(`Delete "${pdfName}" from history?`)) {
                await this.app.progressManager.clearPdfProgress(pdfKey);

                // Animate removal
                cardElement.style.transition = "opacity 200ms, transform 200ms";
                cardElement.style.opacity = "0";
                cardElement.style.transform = "scale(0.95)";

                setTimeout(() => {
                    cardElement.remove();

                    // Return canvas to pool
                    if (this.app.pdfRenderer?.releaseCanvas) {
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
    addOpenHandler(cardElement, pdfBlob, pdfName, canvas) {
        cardElement.addEventListener("click", async () => {
            try {
                const overlay = this.overlay;
                const header = this.header;
                if (overlay) overlay.classList.add("hidden");
                if (header) header.classList.add("hidden");

                const pdfFile =
                    pdfBlob instanceof File
                        ? pdfBlob
                        : new File([pdfBlob], pdfName, { type: pdfBlob.type || "application/pdf" });

                await this.app.pdfLoader.loadPDF(pdfFile, { existingKey: pdfKey });

                // Hide overlay after successful load

                if (this.noPdfOverlay) this.noPdfOverlay.classList.add("hidden");

                // Return canvas to pool
                if (this.app.pdfRenderer?.releaseCanvas) {
                    this.app.pdfRenderer.releaseCanvas(canvas);
                }
            } catch (error) {
                console.error(`[PDFThumbnailCache] Failed to load PDF ${pdfName}:`, error);
                this.app.ui?.showInfo?.(`Failed to load PDF: ${error.message}`);
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
