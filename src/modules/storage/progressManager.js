export class ProgressManager {
    constructor(app) {
        this.app = app;
    }

    _progressKey(docType, key) {
        return `${docType}::${key}`;
    }

    getProgressMap() {
        const { config } = this.app;
        try {
            return JSON.parse(localStorage.getItem(config.PROGRESS_STORAGE_KEY) || "{}");
        } catch {
            return {};
        }
    }

    setProgressMap(map) {
        const { config } = this.app;
        try {
            localStorage.setItem(config.PROGRESS_STORAGE_KEY, JSON.stringify(map));
        } catch (e) {
            console.warn("Failed to write progress map:", e);
        }
    }

    loadSavedPosition(key, docType = "pdf") {
        if (!key) return null;
        const map = this.getProgressMap();
        const compoundKey = this._progressKey(docType, key);
        if (compoundKey in map) {
            return map[compoundKey];
        }

        if (docType === "pdf" && key in map) {
            return map[key];
        }
        return null;
    }

    saveProgress() {
        const { state } = this.app;
        if (!state.sentences.length || state.currentSentenceIndex < 0) return;

        const docType = state.currentDocumentType === "epub" ? "epub" : "pdf";
        const storageKey = docType === "epub" ? state.currentEpubKey : state.currentPdfKey;
        if (!storageKey) return;

        const map = this.getProgressMap();
        const compoundKey = this._progressKey(docType, storageKey);
        const existingEntry = map[compoundKey] || {};

        let coverData = null;
        if (docType === "epub") {
            if (typeof state.bookCoverDataUrl === "string" && state.bookCoverDataUrl.startsWith("data:")) {
                coverData = state.bookCoverDataUrl;
            } else if (typeof state.bookCover === "string" && state.bookCover.startsWith("data:")) {
                coverData = state.bookCover;
            } else if (typeof existingEntry.cover === "string" && existingEntry.cover.startsWith("data:")) {
                coverData = existingEntry.cover;
            }
        }

        map[compoundKey] = {
            sentenceIndex: state.currentSentenceIndex,
            totalSentences: state.sentences.length,
            updated: Date.now(),
            voice: state.currentPiperVoice,
            title: state.bookTitle || existingEntry.title || null,
            cover: coverData,
            docType,
        };
        if (docType === "pdf" && storageKey in map) {
            delete map[storageKey];
        }
        this.setProgressMap(map);

        // Sync to server if enabled
        if (this.app.serverSync?.isEnabled()) {
            const fileId = docType === "epub" ? state.currentEpubKey : state.currentPdfKey;
            if (fileId) {
                this.app.serverSync.queuePositionSync(fileId, state.currentSentenceIndex);
                if (state.currentPiperVoice) this.app.serverSync.queueVoiceSync(fileId, state.currentPiperVoice);
            }
        }
    }

    listSavedProgress() {
        return this.getProgressMap();
    }

    clearPdfProgress(key) {
        this.clearDocumentProgress("pdf", key);
    }

    clearEpubProgress(key) {
        this.clearDocumentProgress("epub", key);
    }

    clearDocumentProgress(docType, key) {
        if (!key) return;
        const map = this.getProgressMap();
        const compoundKey = this._progressKey(docType, key);
        let modified = false;
        if (compoundKey in map) {
            delete map[compoundKey];
            modified = true;
        }
        if (docType === "pdf" && key in map) {
            delete map[key];
            modified = true;
        }
        if (modified) {
            this.setProgressMap(map);
        }
    }

    async _openDb() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open("PDFStorage", 2);
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains("pdfs")) {
                    db.createObjectStore("pdfs");
                }
                if (!db.objectStoreNames.contains("epubs")) {
                    db.createObjectStore("epubs");
                }
            };
            request.onsuccess = (event) => resolve(event.target.result);
            request.onerror = () => reject(request.error);
        });
    }

    async savePdfToIndexedDB(file, key) {
        const db = await this._openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction("pdfs", "readwrite");
            const store = tx.objectStore("pdfs");
            store.put({ blob: file, name: file.name }, key);
            tx.oncomplete = () => {
                db.close();
                resolve();
            };
            tx.onerror = () => {
                const { error } = tx;
                db.close();
                reject(error);
            };
        });
    }

    async loadPdfFromIndexedDB(key) {
        const db = await this._openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction("pdfs", "readonly");
            const store = tx.objectStore("pdfs");
            const getRequest = store.get(key);
            getRequest.onsuccess = () => {
                db.close();
                resolve(getRequest.result);
            };
            getRequest.onerror = () => {
                db.close();
                reject(getRequest.error);
            };
        });
    }

    async removePdfFromIndexedDB(key) {
        const db = await this._openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction("pdfs", "readwrite");
            const store = tx.objectStore("pdfs");
            const deleteRequest = store.delete(key);
            deleteRequest.onsuccess = () => {
                db.close();
                resolve();
            };
            deleteRequest.onerror = () => {
                db.close();
                reject(deleteRequest.error);
            };
        });
    }

    async loadPdfOrFile(file, pdfKey) {
        if (!file) return null;

        let pdfBlob = await this.loadPdfFromIndexedDB(pdfKey);
        if (pdfBlob) {
            this.app.ui.showInfo("PDF loaded from IndexedDB");
        } else {
            this.app.ui.showInfo("Pdf not found in IndexedDB, saving new file...");
            pdfBlob = file;
            await this.savePdfToIndexedDB(file, pdfKey);
        }
        return pdfBlob;
    }

    async listSavedPDFs() {
        const db = await this._openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction("pdfs", "readonly");
            const store = tx.objectStore("pdfs");
            const keysRequest = store.getAllKeys();
            keysRequest.onsuccess = () => {
                db.close();
                resolve(keysRequest.result);
            };
            keysRequest.onerror = () => {
                db.close();
                reject(keysRequest.error);
            };
        });
    }

    async clearPDFCache() {
        const db = await this._openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction("pdfs", "readwrite");
            const store = tx.objectStore("pdfs");
            const clearRequest = store.clear();
            clearRequest.onsuccess = () => {
                db.close();
                resolve();
            };
            clearRequest.onerror = () => {
                db.close();
                reject(clearRequest.error);
            };
        });
    }

    async saveEpubToIndexedDB(file, key) {
        let coverDataUrl = null;
        if (file instanceof Blob) {
            try {
                coverDataUrl = await this._extractEpubCoverDataUrl(file);
            } catch (error) {
                console.debug("[ProgressManager] Unable to extract EPUB cover", error);
            }
        }

        const db = await this._openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction("epubs", "readwrite");
            const store = tx.objectStore("epubs");
            const payload = {
                blob: file,
                name: file?.name || key,
                size: file?.size ?? null,
                lastModified: file?.lastModified ?? Date.now(),
                cover: coverDataUrl,
            };
            store.put(payload, key);
            tx.oncomplete = () => {
                db.close();
                resolve();
            };
            tx.onerror = () => {
                const { error } = tx;
                db.close();
                reject(error);
            };
        });
    }

    async loadEpubFromIndexedDB(key) {
        const db = await this._openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction("epubs", "readonly");
            const store = tx.objectStore("epubs");
            const getRequest = store.get(key);
            getRequest.onsuccess = () => {
                const record = getRequest.result;
                db.close();
                this._postProcessEpubRecord(key, record).then(resolve).catch(reject);
            };
            getRequest.onerror = () => {
                db.close();
                reject(getRequest.error);
            };
        });
    }

    async removeEpubFromIndexedDB(key) {
        const db = await this._openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction("epubs", "readwrite");
            const store = tx.objectStore("epubs");
            const deleteRequest = store.delete(key);
            deleteRequest.onsuccess = () => {
                db.close();
                resolve();
            };
            deleteRequest.onerror = () => {
                db.close();
                reject(deleteRequest.error);
            };
        });
    }

    async updateEpubCover(key, coverDataUrl) {
        if (!key || !coverDataUrl) return;

        const db = await this._openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction("epubs", "readwrite");
            const store = tx.objectStore("epubs");
            const getRequest = store.get(key);

            getRequest.onsuccess = () => {
                const record = getRequest.result;
                if (!record) {
                    return;
                }
                if (record.cover === coverDataUrl) {
                    return;
                }
                record.cover = coverDataUrl;
                store.put(record, key);
            };

            getRequest.onerror = () => {
                db.close();
                reject(getRequest.error);
            };

            tx.oncomplete = () => {
                db.close();
                resolve();
            };

            tx.onerror = () => {
                db.close();
                reject(tx.error);
            };
        });
    }

    _blobToDataURL(blob, fallbackType) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                resolve(reader.result);
            };
            reader.onerror = () => {
                reject(reader.error);
            };
            if (fallbackType) {
                const newBlob = blob.slice(0, blob.size, fallbackType);
                reader.readAsDataURL(newBlob);
            }
            else {
                reader.readAsDataURL(blob);
            }
        });
    }

    async convertBlobToDataURL(blob, fallbackType) {
        if (!(blob instanceof Blob)) return null;
        return this._blobToDataURL(blob, fallbackType);
    }

    async _postProcessEpubRecord(key, record) {
        if (!record) return null;
        if (!record.cover && record.blob instanceof Blob) {
            try {
                const coverDataUrl = await this._extractEpubCoverDataUrl(record.blob);
                if (coverDataUrl) {
                    record.cover = coverDataUrl;
                    await this.updateEpubCover(key, coverDataUrl);
                }
            } catch (error) {
                console.debug("[ProgressManager] Unable to derive cover for stored EPUB", error);
            }
        }
        return record;
    }

    async _extractEpubCoverDataUrl(file) {
        return null;
    }

    async listSavedEPUBs() {
        const db = await this._openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction("epubs", "readonly");
            const store = tx.objectStore("epubs");
            const keysRequest = store.getAllKeys();
            keysRequest.onsuccess = () => {
                db.close();
                resolve(keysRequest.result);
            };
            keysRequest.onerror = () => {
                db.close();
                reject(keysRequest.error);
            };
        });
    }

    async clearEPUBCache() {
        const db = await this._openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction("epubs", "readwrite");
            const store = tx.objectStore("epubs");
            const clearRequest = store.clear();
            clearRequest.onsuccess = () => {
                db.close();
                resolve();
            };
            clearRequest.onerror = () => {
                db.close();
                reject(clearRequest.error);
            };
        });
    }
}
