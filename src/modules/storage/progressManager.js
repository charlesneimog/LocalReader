export class ProgressManager {
    constructor(app) {
        this.app = app;
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

    loadSavedPosition(pdfKey) {
        return this.getProgressMap()[pdfKey] || null;
    }

    saveProgress() {
        const { state } = this.app;
        if (!state.sentences.length || state.currentSentenceIndex < 0 || !state.currentPdfKey) return;
        const map = this.getProgressMap();
        map[state.currentPdfKey] = {
            sentenceIndex: state.currentSentenceIndex,
            totalSentences: state.sentences.length,
            updated: Date.now(),
            voice: state.currentPiperVoice,
        };
        this.setProgressMap(map);
    }

    listSavedProgress() {
        return this.getProgressMap();
    }

    clearPdfProgress(key) {
        const map = this.getProgressMap();
        if (map[key]) {
            delete map[key];
            this.setProgressMap(map);
        }
    }

    async savePdfToIndexedDB(file, key) {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open("PDFStorage", 1);
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains("pdfs")) db.createObjectStore("pdfs");
            };
            request.onsuccess = (event) => {
                const db = event.target.result;
                const tx = db.transaction("pdfs", "readwrite");
                const store = tx.objectStore("pdfs");
                store.put({ blob: file, name: file.name }, key);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async loadPdfFromIndexedDB(key) {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open("PDFStorage", 1);
            request.onsuccess = (event) => {
                const db = event.target.result;
                const tx = db.transaction("pdfs", "readonly");
                const store = tx.objectStore("pdfs");
                const getRequest = store.get(key);
                getRequest.onsuccess = () => resolve(getRequest.result);
                getRequest.onerror = () => reject(getRequest.error);
            };
            request.onerror = () => reject(request.error);
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
        return new Promise((resolve, reject) => {
            const request = indexedDB.open("PDFStorage", 1);
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains("pdfs")) {
                    db.createObjectStore("pdfs");
                }
            };
            request.onsuccess = (event) => {
                const db = event.target.result;
                const tx = db.transaction("pdfs", "readonly");
                const store = tx.objectStore("pdfs");
                const keysRequest = store.getAllKeys();
                keysRequest.onsuccess = () => resolve(keysRequest.result);
                keysRequest.onerror = () => reject(keysRequest.error);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async clearPDFCache() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open("PDFStorage", 1);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains("pdfs")) {
                    db.createObjectStore("pdfs");
                }
            };

            request.onsuccess = (event) => {
                const db = event.target.result;
                const tx = db.transaction("pdfs", "readwrite");
                const store = tx.objectStore("pdfs");

                const clearRequest = store.clear();
                clearRequest.onsuccess = () => {
                    resolve();
                };
                clearRequest.onerror = () => {
                    reject(clearRequest.error);
                };
            };

            request.onerror = () => reject(request.error);
        });
    }
}

