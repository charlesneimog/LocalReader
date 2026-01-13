export class ServerSync {
    constructor(app) {
        this.app = app;
        this.syncInterval = null;
        this.syncIntervalMs = 5000; // Sync every 5 seconds
        this.lastSyncTime = 0;
        this.isSyncing = false;
    }

    getServerUrl() {
        const serverLink = this.app.controlsManager?.getServerLink();
        return serverLink ? serverLink.replace(/\/$/, "") : null;
    }

    isEnabled() {
        return !!this.getServerUrl();
    }

    async checkFileExists(fileId) {
        const serverUrl = this.getServerUrl();
        if (!serverUrl) return false;

        try {
            const response = await fetch(`${serverUrl}/api/files/${fileId}`, {
                method: "GET",
                headers: {
                    "Content-Type": "application/json",
                },
            });

            return response.ok;
        } catch (error) {
            console.warn("[ServerSync] Failed to check if file exists:", error);
            return false;
        }
    }

    async uploadFile(file, fileId, format, voice = null) {
        const serverUrl = this.getServerUrl();
        if (!serverUrl) {
            console.warn("[ServerSync] No server URL configured");
            return false;
        }

        try {
            const { state } = this.app;
            const title = state.bookTitle || file.name || "Untitled";

            const formData = new FormData();
            formData.append("file", file);
            formData.append("file_id", fileId);
            formData.append("title", title);
            formData.append("format", format);
            if (voice) {
                formData.append("voice", voice);
            }

            const response = await fetch(`${serverUrl}/api/files`, {
                method: "POST",
                body: formData,
            });

            if (response.ok) {
                const result = await response.json();
                console.log("[ServerSync] File uploaded successfully:", result);
                this.app.ui?.showInfo?.("File synced to server");
                return true;
            } else {
                const errorText = await response.text();
                console.error("[ServerSync] Upload failed:", errorText);
                this.app.ui?.showInfo?.("Failed to sync file to server");
                return false;
            }
        } catch (error) {
            console.error("[ServerSync] Upload error:", error);
            this.app.ui?.showInfo?.("Error syncing file to server");
            return false;
        }
    }

    async syncPosition(fileId, sentenceIndex) {
        const serverUrl = this.getServerUrl();
        if (!serverUrl || !fileId || sentenceIndex < 0) return false;

        try {
            // Find the actual file_id on server (may have different timestamp)
            const actualFileIdOnServer = await this.findFileIdOnServer(fileId);
            if (!actualFileIdOnServer) {
                console.warn("[ServerSync] File not found on server for position sync");
                return false;
            }

            const response = await fetch(`${serverUrl}/api/files/${encodeURIComponent(actualFileIdOnServer)}/position`, {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    position: sentenceIndex.toString(),
                }),
            });

            if (response.ok) {
                console.log("[ServerSync] Position synced:", sentenceIndex);
                return true;
            } else {
                console.warn("[ServerSync] Position sync failed:", response.statusText);
                return false;
            }
        } catch (error) {
            console.warn("[ServerSync] Position sync error:", error);
            return false;
        }
    }

    async syncVoice(fileId, voice) {
        const serverUrl = this.getServerUrl();
        if (!serverUrl || !fileId || !voice) return false;

        try {
            // Find the actual file_id on server (may have different timestamp)
            const actualFileIdOnServer = await this.findFileIdOnServer(fileId);
            if (!actualFileIdOnServer) {
                console.warn("[ServerSync] File not found on server for voice sync");
                return false;
            }

            const response = await fetch(`${serverUrl}/api/files/${encodeURIComponent(actualFileIdOnServer)}/voice`, {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    voice: voice,
                }),
            });

            if (response.ok) {
                console.log("[ServerSync] Voice synced:", voice);
                return true;
            } else {
                console.warn("[ServerSync] Voice sync failed:", response.statusText);
                return false;
            }
        } catch (error) {
            console.warn("[ServerSync] Voice sync error:", error);
            return false;
        }
    }

    async syncHighlights(fileId, highlights) {
        const serverUrl = this.getServerUrl();
        if (!serverUrl || !fileId) return false;

        try {
            // Find the actual file_id on server (may have different timestamp)
            const actualFileIdOnServer = await this.findFileIdOnServer(fileId);
            if (!actualFileIdOnServer) {
                console.warn("[ServerSync] File not found on server for highlights sync");
                return false;
            }

            const highlightsArray = [];
            for (const [sentenceIndex, data] of highlights.entries()) {
                highlightsArray.push({
                    sentenceIndex,
                    color: data.color || "#ffda76",
                    text: data.text || "",
                });
            }

            const response = await fetch(`${serverUrl}/api/files/${encodeURIComponent(actualFileIdOnServer)}/highlights`, {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    highlights: highlightsArray,
                }),
            });

            if (response.ok) {
                console.log("[ServerSync] Highlights synced:", highlightsArray.length);
                return true;
            } else {
                console.warn("[ServerSync] Highlights sync failed:", response.statusText);
                return false;
            }
        } catch (error) {
            console.warn("[ServerSync] Highlights sync error:", error);
            return false;
        }
    }

    async loadPositionAndHighlightsFromServer(fileId) {
        const serverUrl = this.getServerUrl();
        if (!serverUrl || !fileId) {
            console.log("[ServerSync] Cannot load from server - no URL or file ID");
            return { position: null, voice: null, highlights: null };
        }

        try {
            // Find the actual file_id on server (may have different timestamp)
            const actualFileIdOnServer = await this.findFileIdOnServer(fileId);
            if (!actualFileIdOnServer) {
                console.log("[ServerSync] File not found on server");
                return { position: null, voice: null, highlights: null };
            }

            // Fetch file metadata (includes position and voice)
            const metaResponse = await fetch(`${serverUrl}/api/files/${encodeURIComponent(actualFileIdOnServer)}`, {
                method: "GET",
                headers: { "Content-Type": "application/json" },
            });

            let position = null;
            let voice = null;

            if (metaResponse.ok) {
                const fileData = await metaResponse.json();
                position = fileData.reading_position ? parseInt(fileData.reading_position, 10) : null;
                voice = fileData.voice || null;
                console.log(`[ServerSync] Loaded from server - position: ${position}, voice: ${voice}`);
            }

            // Fetch highlights
            const highlightsResponse = await fetch(`${serverUrl}/api/files/${encodeURIComponent(actualFileIdOnServer)}/highlights`, {
                method: "GET",
                headers: { "Content-Type": "application/json" },
            });

            let highlights = null;
            if (highlightsResponse.ok) {
                const highlightsData = await highlightsResponse.json();
                if (highlightsData.highlights && Array.isArray(highlightsData.highlights)) {
                    highlights = new Map();
                    highlightsData.highlights.forEach(h => {
                        highlights.set(h.sentenceIndex, {
                            color: h.color,
                            text: h.text || "",
                        });
                    });
                    console.log(`[ServerSync] Loaded ${highlights.size} highlights from server`);
                }
            }

            return { position, voice, highlights };
        } catch (error) {
            console.warn("[ServerSync] Failed to load data from server:", error);
            return { position: null, voice: null, highlights: null };
        }
    }

    async findFileIdOnServer(localFileId) {
        const serverUrl = this.getServerUrl();
        if (!serverUrl) return null;

        // Extract actual filename from local file ID
        let actualFilename = localFileId;
        if (localFileId.startsWith("file::")) {
            const parts = localFileId.split("::");
            if (parts.length >= 2) {
                actualFilename = parts[1];
            }
        }

        try {
            const response = await fetch(`${serverUrl}/api/files`, {
                method: "GET",
                headers: { "Content-Type": "application/json" },
            });
            
            if (response.ok) {
                const data = await response.json();
                const serverFiles = data.files || [];
                
                // Find file by matching actual filename
                const matchingFile = serverFiles.find(f => {
                    if (f.filename === localFileId) return true; // Exact match
                    
                    // Check if actual filenames match
                    let serverActualName = f.filename;
                    if (f.filename.startsWith("file::")) {
                        const parts = f.filename.split("::");
                        if (parts.length >= 2) {
                            serverActualName = parts[1];
                        }
                    }
                    return serverActualName === actualFilename;
                });
                
                return matchingFile ? matchingFile.filename : null;
            }
        } catch (error) {
            console.warn("[ServerSync] Failed to find file on server:", error);
        }
        
        return null;
    }

    async ensureFileOnServer() {
        const { state } = this.app;
        if (!this.isEnabled()) return false;

        const docType = state.currentDocumentType;
        if (!docType) return false;

        const fileId = docType === "epub" ? state.currentEpubKey : state.currentPdfKey;
        if (!fileId) return false;

        // Extract actual filename for existence check
        let actualFilename = fileId;
        if (fileId.startsWith("file::")) {
            const parts = fileId.split("::");
            if (parts.length >= 2) {
                actualFilename = parts[1];
            }
        }

        // First check if a file with the same actual filename already exists
        const serverUrl = this.getServerUrl();
        try {
            const response = await fetch(`${serverUrl}/api/files`, {
                method: "GET",
                headers: { "Content-Type": "application/json" },
            });
            
            if (response.ok) {
                const data = await response.json();
                const serverFiles = data.files || [];
                
                // Check if any server file matches the actual filename
                const existingFile = serverFiles.find(f => {
                    if (f.filename === fileId) return true; // Exact match
                    
                    // Check if actual filenames match
                    let serverActualName = f.filename;
                    if (f.filename.startsWith("file::")) {
                        const parts = f.filename.split("::");
                        if (parts.length >= 2) {
                            serverActualName = parts[1];
                        }
                    }
                    return serverActualName === actualFilename;
                });
                
                if (existingFile) {
                    console.log("[ServerSync] File with same name already exists on server:", existingFile.filename);
                    return true;
                }
            }
        } catch (error) {
            console.warn("[ServerSync] Failed to check for existing files:", error);
        }

        // File doesn't exist, upload it
        console.log("[ServerSync] File not on server, uploading...");

        try {
            let file = null;
            const format = docType === "epub" ? "epub" : "pdf";

            // Try to get file from IndexedDB
            if (docType === "epub") {
                const record = await this.app.progressManager.loadEpubFromIndexedDB(fileId);
                file = record?.blob;
            } else {
                const record = await this.app.progressManager.loadPdfFromIndexedDB(fileId);
                file = record?.blob;
            }

            if (!file) {
                console.warn("[ServerSync] Cannot upload file - not found in IndexedDB");
                return false;
            }

            const voice = state.currentPiperVoice;
            return await this.uploadFile(file, fileId, format, voice);
        } catch (error) {
            console.error("[ServerSync] Error uploading file:", error);
            return false;
        }
    }

    async syncAll() {
        if (this.isSyncing || !this.isEnabled()) return;

        const { state } = this.app;
        const docType = state.currentDocumentType;
        if (!docType) return;

        const fileId = docType === "epub" ? state.currentEpubKey : state.currentPdfKey;
        if (!fileId) return;

        this.isSyncing = true;

        try {
            // Ensure file is on server
            const fileOnServer = await this.ensureFileOnServer();
            if (!fileOnServer) {
                console.warn("[ServerSync] File not on server, skipping sync");
                this.isSyncing = false;
                return;
            }

            // Sync position
            if (state.currentSentenceIndex >= 0) {
                await this.syncPosition(fileId, state.currentSentenceIndex);
            }

            // Sync voice
            if (state.currentPiperVoice) {
                await this.syncVoice(fileId, state.currentPiperVoice);
            }

            // Sync highlights
            if (state.savedHighlights && state.savedHighlights.size > 0) {
                await this.syncHighlights(fileId, state.savedHighlights);
            }

            this.lastSyncTime = Date.now();
        } catch (error) {
            console.error("[ServerSync] Sync error:", error);
        } finally {
            this.isSyncing = false;
        }
    }

    startAutoSync() {
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
        }

        if (!this.isEnabled()) {
            console.log("[ServerSync] Auto-sync disabled - no server configured");
            return;
        }

        console.log("[ServerSync] Starting auto-sync");
        this.syncInterval = setInterval(() => {
            this.syncAll();
        }, this.syncIntervalMs);

        // Do initial sync to server after a short delay
        setTimeout(async () => {
            await this.syncAll();
        }, 1000);
    }

    stopAutoSync() {
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
            this.syncInterval = null;
            console.log("[ServerSync] Auto-sync stopped");
        }
    }

    async manualSync() {
        this.app.ui?.showInfo?.("Syncing to server...");
        await this.syncAll();
        if (this.lastSyncTime > 0) {
            this.app.ui?.showInfo?.("Sync complete");
        }
    }

    async syncFromServer() {
        const serverUrl = this.getServerUrl();
        if (!serverUrl) {
            console.log("[ServerSync] No server configured for download");
            return;
        }

        try {
            // Get list of files from server
            const response = await fetch(`${serverUrl}/api/files`, {
                method: "GET",
                headers: {
                    "Content-Type": "application/json",
                },
            });

            if (!response.ok) {
                console.warn("[ServerSync] Failed to fetch file list from server");
                return;
            }

            const data = await response.json();
            const serverFiles = data.files || [];

            console.log(`[ServerSync] Found ${serverFiles.length} files on server`);

            // Get local files
            const localPdfKeys = await this.app.progressManager.listSavedPDFs();
            const localEpubKeys = await this.app.progressManager.listSavedEPUBs();
            const allLocalKeys = [...localPdfKeys, ...localEpubKeys];

            // Extract actual filenames from local keys
            const localActualFilenames = new Set();
            for (const key of allLocalKeys) {
                let actualName = key;
                if (key.startsWith("file::")) {
                    const parts = key.split("::");
                    if (parts.length >= 2) {
                        actualName = parts[1];
                    }
                }
                localActualFilenames.add(actualName);
            }

            // Find missing files by comparing actual filenames
            const missingFiles = serverFiles.filter(f => {
                let serverActualName = f.filename;
                if (f.filename.startsWith("file::")) {
                    const parts = f.filename.split("::");
                    if (parts.length >= 2) {
                        serverActualName = parts[1];
                    }
                }
                return !localActualFilenames.has(serverActualName);
            });

            if (missingFiles.length === 0) {
                console.log("[ServerSync] All server files are already cached locally");
                this.app.ui?.showInfo?.("Already synced with server");
                return;
            }

            console.log(`[ServerSync] Downloading ${missingFiles.length} missing files...`);
            this.app.ui?.showInfo?.(`Downloading ${missingFiles.length} files from server...`);

            // Download each missing file
            let downloaded = 0;
            for (const fileInfo of missingFiles) {
                try {
                    await this.downloadFile(fileInfo);
                    downloaded++;
                    this.app.ui?.showInfo?.(`Downloaded ${downloaded}/${missingFiles.length} files`);
                } catch (error) {
                    console.error(`[ServerSync] Failed to download ${fileInfo.filename}:`, error);
                }
            }

            if (downloaded > 0) {
                this.app.ui?.showInfo?.(`Downloaded ${downloaded} files from server`);
                console.log(`[ServerSync] Download complete: ${downloaded}/${missingFiles.length} files`);
                // Only refresh the saved PDFs view if no document is currently open
                if (!this.app.state.currentDocumentType) {
                    setTimeout(() => {
                        this.app.showSavedPDFs?.();
                    }, 500);
                }
            }
        } catch (error) {
            console.error("[ServerSync] Sync from server failed:", error);
            this.app.ui?.showInfo?.("Failed to sync from server");
        }
    }

    async downloadFile(fileInfo) {
        const serverUrl = this.getServerUrl();
        if (!serverUrl) return;

        const { filename, title, format, reading_position, voice } = fileInfo;

        // Extract actual filename from file_id format (file::actualname::size::timestamp)
        let actualFilename = filename;
        if (filename.startsWith("file::")) {
            const parts = filename.split("::");
            if (parts.length >= 2) {
                actualFilename = parts[1]; // Get the actual filename without prefix
            }
        }

        // Download file blob
        const response = await fetch(`${serverUrl}/api/files/${encodeURIComponent(filename)}/download`, {
            method: "GET",
        });

        if (!response.ok) {
            throw new Error(`Download failed: ${response.statusText}`);
        }

        const blob = await response.blob();
        const file = new File([blob], actualFilename, { 
            type: format === "pdf" ? "application/pdf" : "application/epub+zip" 
        });

        // Save to IndexedDB using the full filename key from server
        if (format === "pdf") {
            await this.app.progressManager.savePdfToIndexedDB(file, filename);
        } else if (format === "epub") {
            await this.app.progressManager.saveEpubToIndexedDB(file, filename);
        }

        // Restore progress if available
        if (reading_position) {
            const progressMap = this.app.progressManager.getProgressMap();
            const docType = format === "epub" ? "epub" : "pdf";
            const compoundKey = `${docType}::${filename}`;
            
            progressMap[compoundKey] = {
                sentenceIndex: parseInt(reading_position, 10) || 0,
                updated: Date.now(),
                voice: voice || null,
                title: title || null,
                docType: docType,
            };
            
            this.app.progressManager.setProgressMap(progressMap);
        }

        console.log(`[ServerSync] Downloaded and cached: ${actualFilename}`);
    }
}
