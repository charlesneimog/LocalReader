export class ServerSync {
    constructor(app) {
        this.app = app;
        this.syncInterval = null;
        this.lastSyncTime = 0;
        this.isSyncing = false;

        this._autoSyncEnabled = false;
        this._autoSyncListeners = [];

        // Debounced client -> server updates
        this.positionSyncDebounceMs = 900;
        this.voiceSyncDebounceMs = 900;
        this._pendingPositionByFile = new Map();
        this._pendingVoiceByFile = new Map();
        this._positionSyncTimers = new Map();
        this._voiceSyncTimers = new Map();

        // Throttle server -> client state pulls (position/highlights/voice)
        this.serverPullIntervalMs = 30000; // Check every 30 seconds
        this.lastServerPullCheck = 0;

        try {
            if (localStorage.getItem("localreaderAuthToken")) {
                this.pingServer(true).catch(() => {});
            }
        } catch {
            // ignore
        }
    }

    _setReloadSuppressionWindow(ms = 15000) {
        // Some service-worker helpers (e.g. coi-serviceworker) may trigger reloads on certain
        // update/degrade events; avoid reloading while an API call is in flight.
        try {
            if (typeof window === "undefined") return;
            const suppressUntil = Date.now() + ms;
            window.__localreaderSuppressReloadUntil = Math.max(
                Number(window.__localreaderSuppressReloadUntil || 0),
                suppressUntil,
            );
        } catch {
            // ignore
        }
    }

    _setAuthToken(token) {
        try {
            const value = (token || "").toString();
            if (value) localStorage.setItem("localreaderAuthToken", value);
            else localStorage.removeItem("localreaderAuthToken");
        } catch {
            // ignore
        }
    }

    clearAuthToken() {
        this._setAuthToken("");
    }

    async apiFetch(path, { method = "GET", body = null, withAuth = true } = {}) {
        const serverUrl = this.getServerUrl();
        if (!serverUrl) throw new Error("No server URL configured");

        this._setReloadSuppressionWindow();

        const headers = { "Content-Type": "application/json" };
        const finalHeaders = withAuth ? this._withAuthHeaders(headers) : headers;

        const res = await fetch(`${serverUrl}${path}`, {
            method,
            headers: finalHeaders,
            body: body ? JSON.stringify(body) : undefined,
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const msg = data?.error || `${res.status} ${res.statusText}`;
            throw new Error(msg);
        }
        return data;
    }

    async authMe() {
        return await this.apiFetch("/api/auth/me", { method: "GET", withAuth: true });
    }

    async authLogin(email, password, { persistToken = true } = {}) {
        const data = await this.apiFetch("/api/auth/login", {
            method: "POST",
            body: { email, password },
            withAuth: false,
        });
        if (persistToken && data?.token) this._setAuthToken(data.token);
        return data;
    }

    async authSignup(email, password, { persistToken = true } = {}) {
        const data = await this.apiFetch("/api/auth/signup", {
            method: "POST",
            body: { email, password },
            withAuth: false,
        });
        if (persistToken && data?.token) this._setAuthToken(data.token);
        return data;
    }

    async requestPasswordReset(email) {
        return await this.apiFetch("/api/auth/request-password-reset", {
            method: "POST",
            body: { email },
            withAuth: false,
        });
    }

    async resetPassword(email, token, newPassword, { persistToken = true } = {}) {
        const data = await this.apiFetch("/api/auth/reset-password", {
            method: "POST",
            body: { email, token, newPassword },
            withAuth: false,
        });
        if (persistToken && data?.token) this._setAuthToken(data.token);
        return data;
    }

    _getAuthToken() {
        try {
            return localStorage.getItem("localreaderAuthToken") || "";
        } catch {
            return "";
        }
    }

    _withAuthHeaders(headers = {}) {
        const token = this._getAuthToken();
        if (!token) return headers;
        return { ...headers, Authorization: `Bearer ${token}` };
    }

    _fetch(url, options = {}) {
        const headers = this._withAuthHeaders(options.headers || {});
        return fetch(url, { ...options, headers });
    }

    _addAutoSyncListener(element, type, handler, options) {
        element.addEventListener(type, handler, options);
        this._autoSyncListeners.push({ element, type, handler, options });
    }

    _clearAutoSyncListeners() {
        for (const { element, type, handler, options } of this._autoSyncListeners) {
            element.removeEventListener(type, handler, options);
        }
        this._autoSyncListeners = [];
    }

    getServerUrl() {
        const serverLink = this.app.controlsManager?.getServerLink();
        return serverLink ? serverLink.replace(/\/$/, "") : null;
    }

    isEnabled() {
        return !!this.getServerUrl();
    }

    _parseIsoToMs(value) {
        if (!value || typeof value !== "string") return 0;
        const ms = Date.parse(value);
        return Number.isFinite(ms) ? ms : 0;
    }

    _extractActualFilename(key) {
        if (typeof key !== "string") return key;
        if (!key.startsWith("file::")) return key;
        const parts = key.split("::");
        return parts.length >= 2 ? parts[1] : key;
    }

    _parseFileKeyParts(key) {
        if (typeof key !== "string") return null;
        if (!key.startsWith("file::")) return null;
        const parts = key.split("::");
        if (parts.length < 4) return null;
        const name = parts[1] ?? "";
        const sizeRaw = Number(parts[2] ?? 0);
        const lastModifiedRaw = Number(parts[3] ?? 0);
        const size = Number.isFinite(sizeRaw) ? sizeRaw : 0;
        const lastModified = Number.isFinite(lastModifiedRaw) ? lastModifiedRaw : 0;
        return { name, size, lastModified };
    }

    async _purgeLocalByActualFilename(actualFilename, docTypeHint) {
        const actual = (actualFilename || "").toString();
        if (!actual) return;

        const docType = docTypeHint === "epub" ? "epub" : "pdf";

        try {
            const keys =
                docType === "epub"
                    ? await this.app.progressManager.listSavedEPUBs()
                    : await this.app.progressManager.listSavedPDFs();

            const matching = keys.filter((k) => this._extractActualFilename(k) === actual);
            for (const k of matching) {
                if (docType === "epub") {
                    this.app.progressManager.clearEpubProgress(k);
                    await this.app.progressManager.removeEpubFromIndexedDB(k);
                } else {
                    this.app.progressManager.clearPdfProgress(k);
                    this.app.highlightsStorage?.clearPdfHighlights?.(k);
                    await this.app.progressManager.removePdfFromIndexedDB(k);
                }
            }
        } catch (e) {
            console.warn("[ServerSync] Failed to purge local copies by actual filename:", e);
        }
    }

    async _maybePullServerStateUpdates() {
        const now = Date.now();
        if (now - this.lastServerPullCheck < this.serverPullIntervalMs) return;
        this.lastServerPullCheck = now;

        const serverAvailable = await this.checkServerAvailability();
        if (!serverAvailable) return;

        await this.pullServerStateUpdates();
    }

    queuePositionSync(fileId, sentenceIndex, { debounceMs } = {}) {
        if (!this.isEnabled()) return;
        if (!fileId) return;
        if (!Number.isFinite(sentenceIndex) || sentenceIndex < 0) return;

        this._pendingPositionByFile.set(fileId, sentenceIndex);

        const delay = Number.isFinite(debounceMs) ? debounceMs : this.positionSyncDebounceMs;
        const existing = this._positionSyncTimers.get(fileId);
        if (existing) clearTimeout(existing);

        const t = setTimeout(() => {
            this._positionSyncTimers.delete(fileId);
            const latest = this._pendingPositionByFile.get(fileId);
            if (!Number.isFinite(latest)) return;
            this.syncPosition(fileId, latest).catch((err) => {
                console.warn("[ServerSync] Position sync failed:", err);
            });
        }, delay);
        this._positionSyncTimers.set(fileId, t);
    }

    queueVoiceSync(fileId, voice, { debounceMs } = {}) {
        if (!this.isEnabled()) return;
        if (!fileId) return;
        if (typeof voice !== "string" || !voice.trim()) return;

        this._pendingVoiceByFile.set(fileId, voice.trim());

        const delay = Number.isFinite(debounceMs) ? debounceMs : this.voiceSyncDebounceMs;
        const existing = this._voiceSyncTimers.get(fileId);
        if (existing) clearTimeout(existing);

        const t = setTimeout(() => {
            this._voiceSyncTimers.delete(fileId);
            const latest = this._pendingVoiceByFile.get(fileId);
            if (typeof latest !== "string" || !latest.trim()) return;
            this.syncVoice(fileId, latest.trim()).catch((err) => {
                console.warn("[ServerSync] Voice sync failed:", err);
            });
        }, delay);
        this._voiceSyncTimers.set(fileId, t);
    }

    async pullServerStateUpdates() {
        const serverUrl = this.getServerUrl();
        if (!serverUrl) return;

        try {
            const response = await this._fetch(`${serverUrl}/api/files`, {
                method: "GET",
                headers: { "Content-Type": "application/json" },
            });

            if (!response.ok) {
                console.warn("[ServerSync] Failed to fetch server files for state sync");
                return;
            }

            const data = await response.json();
            const serverFiles = data.files || [];

            // Server tombstones (deleted/excluded) should purge local copies, not be downloaded.
            const tombstones = serverFiles.filter((f) => f && f.deleted);
            for (const t of tombstones) {
                const actualName = this._extractActualFilename(t.filename);
                const docType = t.format === "epub" ? "epub" : "pdf";
                await this._purgeLocalByActualFilename(actualName, docType);
            }

            const [localPdfKeys, localEpubKeys] = await Promise.all([
                this.app.progressManager.listSavedPDFs(),
                this.app.progressManager.listSavedEPUBs(),
            ]);
            const allLocalKeys = [...localPdfKeys, ...localEpubKeys];

            // Map actual filename -> local key for matching when timestamps differ.
            const localByActualName = new Map();
            for (const k of allLocalKeys) {
                const actual = this._extractActualFilename(k);
                if (!localByActualName.has(actual)) localByActualName.set(actual, k);
            }

            const progressMap = this.app.progressManager.getProgressMap();

            const deleteLocalDoc = async (docType, localKey, actualNameForMessage) => {
                try {
                    if (docType === "epub") {
                        this.app.progressManager.clearEpubProgress(localKey);
                        await this.app.progressManager.removeEpubFromIndexedDB(localKey);
                    } else {
                        this.app.progressManager.clearPdfProgress(localKey);
                        this.app.highlightsStorage?.clearPdfHighlights?.(localKey);
                        await this.app.progressManager.removePdfFromIndexedDB(localKey);
                    }
                    if (actualNameForMessage) {
                        this.app.ui?.showInfo?.(`Removed deleted file: ${actualNameForMessage}`);
                    }
                } catch (e) {
                    console.warn("[ServerSync] Failed to delete local document:", e);
                }
            };

            let updatedCount = 0;
            for (const fileInfo of serverFiles) {
                const serverKey = fileInfo.filename;
                const actualName = this._extractActualFilename(serverKey);

                // Find local key: exact match first, else match by actual filename.
                const localKey = allLocalKeys.includes(serverKey) ? serverKey : localByActualName.get(actualName);
                if (!localKey) continue;

                const docType = fileInfo.format === "epub" ? "epub" : "pdf";

                // Server tombstone: remove local copies and skip state pulls.
                if (fileInfo && fileInfo.deleted) {
                    await deleteLocalDoc(docType, localKey, actualName);
                    updatedCount++;
                    continue;
                }

                const compoundKey = `${docType}::${localKey}`;
                const localEntry = progressMap[compoundKey] || {};

                const serverPosMs = this._parseIsoToMs(fileInfo.position_updated_at || fileInfo.updated_at);
                const serverHlMs = this._parseIsoToMs(fileInfo.highlights_updated_at || fileInfo.updated_at);
                const serverVoiceMs = this._parseIsoToMs(fileInfo.voice_updated_at || fileInfo.updated_at);

                const localServerPosMs = Number(localEntry.serverPositionUpdatedAt || 0);
                const localServerHlMs = Number(localEntry.serverHighlightsUpdatedAt || 0);
                const localServerVoiceMs = Number(localEntry.serverVoiceUpdatedAt || 0);

                // Position: if server has newer position than last pulled, update local.
                if (serverPosMs > localServerPosMs) {
                    const pos = fileInfo.reading_position != null ? parseInt(fileInfo.reading_position, 10) : null;
                    if (Number.isFinite(pos) && pos >= 0) {
                        localEntry.sentenceIndex = pos;
                        // Use server timestamp so "last timed sync" matches server.
                        localEntry.updated = serverPosMs;
                    }
                    localEntry.serverPositionUpdatedAt = serverPosMs;
                    updatedCount++;
                }

                // Voice: if newer.
                if (serverVoiceMs > localServerVoiceMs) {
                    if (typeof fileInfo.voice === "string" && fileInfo.voice.trim()) {
                        localEntry.voice = fileInfo.voice.trim();
                    }
                    localEntry.serverVoiceUpdatedAt = serverVoiceMs;
                    updatedCount++;
                }

                // Title: keep if server provides.
                if (typeof fileInfo.title === "string" && fileInfo.title.trim()) {
                    localEntry.title = fileInfo.title.trim();
                }
                localEntry.docType = docType;

                // Highlights: only fetch when highlights timestamp advanced.
                if (serverHlMs > localServerHlMs) {
                    try {
                        const hlResp = await this._fetch(
                            `${serverUrl}/api/files/${encodeURIComponent(serverKey)}/highlights`,
                            { method: "GET", headers: { "Content-Type": "application/json" } },
                        );
                        if (hlResp.ok) {
                            const hlData = await hlResp.json();
                            if (hlData?.highlights && Array.isArray(hlData.highlights)) {
                                const highlightsMap = new Map();
                                for (const h of hlData.highlights) {
                                    const idx = h?.sentence_index ?? h?.sentenceIndex;
                                    const sentenceIndex = typeof idx === "number" ? idx : parseInt(idx, 10);
                                    if (Number.isFinite(sentenceIndex)) {
                                        highlightsMap.set(sentenceIndex, {
                                            color: h.color,
                                            text: h.text || "",
                                            comment: typeof h.comment === "string" ? h.comment : "",
                                        });
                                    }
                                }
                                // Save under the local key we will open with.
                                this.app.highlightsStorage?.saveHighlights?.(localKey, highlightsMap);
                            }
                        }
                    } catch (e) {
                        console.warn("[ServerSync] Failed to pull highlights:", e);
                    }
                    localEntry.serverHighlightsUpdatedAt = serverHlMs;
                    updatedCount++;
                }

                progressMap[compoundKey] = localEntry;
            }

            this.app.progressManager.setProgressMap(progressMap);
        } catch (e) {
            console.warn("[ServerSync] pullServerStateUpdates failed:", e);
        }
    }

    async deleteFileOnServer(fileId) {
        const serverUrl = this.getServerUrl();
        if (!serverUrl || !fileId) return false;

        try {
            const response = await this._fetch(`${serverUrl}/api/files/${encodeURIComponent(fileId)}`, {
                method: "DELETE",
            });

            if (response.ok) return true;
            const data = await response.json().catch(() => ({}));
            const msg = data?.error || `${response.status} ${response.statusText}`;
            throw new Error(msg);
        } catch (e) {
            console.warn("[ServerSync] Failed to delete file on server:", e);
            return false;
        }
    }

    async checkServerAvailability() {
        return await this.pingServer(false);
    }

    async pingServer(showMessages = true) {
        const serverUrl = this.getServerUrl();
        if (!serverUrl) {
            const msg = "No server URL configured";
            console.error("[ServerSync] Ping failed:", msg);
            if (showMessages) {
                this.app.ui?.showInfo?.("❌ Ping failed: No server URL configured");
            }
            return false;
        }

        // console.log(`[ServerSync] Pinging server: ${serverUrl}`);
        if (showMessages) {
            this.app.ui?.showInfo?.("Pinging server...");
        }

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);
            
            const startTime = Date.now();
            const response = await this._fetch(`${serverUrl}/api/ping`, {
                method: "GET",
                signal: controller.signal,
            });

            clearTimeout(timeoutId);
            const pingTime = Date.now() - startTime;

            if (response.ok) {
                const data = await response.json();
                // console.log(`[ServerSync] ✓ Ping successful (${pingTime}ms):`, data.message);
                if (showMessages) {
                    //this.app.ui?.showInfo?.(`✓ Server is accessible (${pingTime}ms)`);
                    console.log(`[ServerSync] ✓ Ping successful (${pingTime}ms):`, data.message);
                }
                return true;
            } else {
                const msg = `Server returned ${response.status} ${response.statusText}`;
                console.error("[ServerSync] ✗ Ping failed:", msg);
                if (showMessages) {
                    this.app.ui?.showInfo?.(`❌ Ping failed: ${msg}`);
                }
                return false;
            }
        } catch (error) {
            let errorMsg = error.message;
            if (error.name === "AbortError") {
                errorMsg = "Connection timeout (server not responding)";
            }
            console.error("[ServerSync] ✗ Ping failed:", errorMsg);
            if (showMessages) {
                this.app.ui?.showInfo?.(`❌ Ping failed: ${errorMsg}`);
            }
            return false;
        }
    }

    async translateText(text, { target = null } = {}) {
        const serverUrl = this.getServerUrl();
        if (!serverUrl) {
            this.app.ui?.showInfo?.("⚠️ No server URL configured");
            return null;
        }
        const payloadText = (text || "").trim();
        if (!payloadText) return null;

        try {
            const response = await this._fetch(`${serverUrl}/api/translate`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: payloadText, target }),
            });

            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                const msg = data?.error || `Translate failed: ${response.status} ${response.statusText}`;
                this.app.ui?.showInfo?.(msg);
                return null;
            }
            return data;
        } catch (e) {
            this.app.ui?.showInfo?.("⚠️ Translate request failed");
            return null;
        }
    }

    async checkFileExists(fileId) {
        const serverUrl = this.getServerUrl();
        if (!serverUrl) return false;

        try {
            const response = await this._fetch(`${serverUrl}/api/files/${fileId}`, {
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

            const response = await this._fetch(`${serverUrl}/api/files`, {
                method: "POST",
                body: formData,
            });

            if (response.ok) {
                const result = await response.json();
                // console.log("[ServerSync] File uploaded successfully:", result);
                this.app.ui?.showInfo?.("File synced to server");
                return true;
            } else {
                if (response.status === 410) {
                    const actualName = this._extractActualFilename(fileId);
                    const docType = format === "epub" ? "epub" : "pdf";
                    await this._purgeLocalByActualFilename(actualName, docType);
                    this.app.ui?.showInfo?.(`Server has deleted: ${actualName}`);
                    return false;
                }

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
            let actualFileIdOnServer = await this.findFileIdOnServer(fileId);
            if (!actualFileIdOnServer) {
                console.warn("[ServerSync] File not found on server for position sync; trying ensureFileOnServer()");
                try {
                    await this.ensureFileOnServer();
                } catch (e) {
                    // ignore
                }
                actualFileIdOnServer = await this.findFileIdOnServer(fileId);
                if (!actualFileIdOnServer) {
                    console.warn("[ServerSync] Still no matching file on server; position not synced", { fileId });
                    return false;
                }
            }

            const response = await this._fetch(`${serverUrl}/api/files/${encodeURIComponent(actualFileIdOnServer)}/position`, {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    position: sentenceIndex.toString(),
                }),
            });

            if (response.ok) {
                //console.log("[ServerSync] Position synced:", sentenceIndex);
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
            let actualFileIdOnServer = await this.findFileIdOnServer(fileId);
            if (!actualFileIdOnServer) {
                console.warn("[ServerSync] File not found on server for voice sync; trying ensureFileOnServer()");
                try {
                    await this.ensureFileOnServer();
                } catch (e) {
                    // ignore
                }
                actualFileIdOnServer = await this.findFileIdOnServer(fileId);
                if (!actualFileIdOnServer) {
                    console.warn("[ServerSync] Still no matching file on server; voice not synced", { fileId });
                    return false;
                }
            }

            const response = await this._fetch(`${serverUrl}/api/files/${encodeURIComponent(actualFileIdOnServer)}/voice`, {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    voice: voice,
                }),
            });

            if (response.ok) {
                //// console.log("[ServerSync] Voice synced:", voice);
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

        //console.log("[ServerSync] syncHighlights: start", {
        //    fileId,
        //    serverUrl,
        //    count: highlights?.size ?? 0,
        //});

        try {
            // Find the actual file_id on server (may have different timestamp)
            let actualFileIdOnServer = await this.findFileIdOnServer(fileId);
            if (!actualFileIdOnServer) {
                console.warn("[ServerSync] File not found on server for highlights sync; trying ensureFileOnServer()");
                try {
                    await this.ensureFileOnServer();
                } catch (e) {
                    // ignore
                }
                actualFileIdOnServer = await this.findFileIdOnServer(fileId);
                if (!actualFileIdOnServer) {
                    console.warn("[ServerSync] Still no matching file on server; highlights not synced", { fileId });
                    return false;
                }
            }

            const highlightsArray = [];
            for (const [sentenceIndex, data] of highlights.entries()) {
                highlightsArray.push({
                    sentenceIndex,
                    color: data.color || "#ffda76",
                    text: data.text || data.sentenceText || "",
                    comment: typeof data.comment === "string" ? data.comment : "",
                });
            }

            const response = await this._fetch(`${serverUrl}/api/files/${encodeURIComponent(actualFileIdOnServer)}/highlights`, {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    highlights: highlightsArray,
                }),
            });

            if (response.ok) {
                // console.log("[ServerSync] syncHighlights: OK", {
                //    fileId,
                //    actualFileIdOnServer,
                //    count: highlightsArray.length,
                //});
                return true;
            } else {
                console.warn("[ServerSync] syncHighlights: FAILED", {
                    status: response.status,
                    statusText: response.statusText,
                    fileId,
                    actualFileIdOnServer,
                });
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
            // console.log("[ServerSync] Cannot load from server - no URL or file ID");
            return { position: null, voice: null, highlights: null };
        }

        try {
            // Find the actual file_id on server (may have different timestamp)
            const actualFileIdOnServer = await this.findFileIdOnServer(fileId);
            if (!actualFileIdOnServer) {
                // console.log("[ServerSync] File not found on server");
                return { position: null, voice: null, highlights: null };
            }

            // Fetch file metadata (includes position and voice)
            const metaResponse = await this._fetch(`${serverUrl}/api/files/${encodeURIComponent(actualFileIdOnServer)}`, {
                method: "GET",
                headers: { "Content-Type": "application/json" },
            });

            let position = null;
            let voice = null;

            if (metaResponse.ok) {
                const fileData = await metaResponse.json();
                position = fileData.reading_position ? parseInt(fileData.reading_position, 10) : null;
                voice = fileData.voice || null;
                // console.log(`[ServerSync] Loaded from server - position: ${position}, voice: ${voice}`);
            }

            // Fetch highlights
            const highlightsResponse = await this._fetch(`${serverUrl}/api/files/${encodeURIComponent(actualFileIdOnServer)}/highlights`, {
                method: "GET",
                headers: { "Content-Type": "application/json" },
            });

            let highlights = null;
            if (highlightsResponse.ok) {
                const highlightsData = await highlightsResponse.json();
                if (highlightsData.highlights && Array.isArray(highlightsData.highlights)) {
                    highlights = new Map();
                    highlightsData.highlights.forEach((h) => {
                        const idxRaw = h?.sentence_index ?? h?.sentenceIndex;
                        const idx = Number.isFinite(idxRaw) ? idxRaw : parseInt(String(idxRaw), 10);
                        if (!Number.isFinite(idx) || idx < 0) return;
                        highlights.set(idx, {
                            color: h?.color,
                            text: h?.text || "",
                        });
                    });
                    // console.log(`[ServerSync] Loaded ${highlights.size} highlights from server`);
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
            const response = await this._fetch(`${serverUrl}/api/files`, {
                method: "GET",
                headers: { "Content-Type": "application/json" },
            });
            
            if (response.ok) {
                const data = await response.json();
                const serverFiles = data.files || [];
                
                // Find file by matching actual filename
                const matchingFile = serverFiles.find(f => {
                    if (f && f.deleted) return false;
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
            const response = await this._fetch(`${serverUrl}/api/files`, {
                method: "GET",
                headers: { "Content-Type": "application/json" },
            });
            
            if (response.ok) {
                const data = await response.json();
                const serverFiles = data.files || [];
                
                // Check if any server file matches the actual filename
                const existingFile = serverFiles.find(f => {
                    if (f && f.deleted) return false;
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
                    // console.log("[ServerSync] File with same name already exists on server:", existingFile.filename);
                    return true;
                }
            }
        } catch (error) {
            console.warn("[ServerSync] Failed to check for existing files:", error);
        }

        // File doesn't exist, upload it
        // console.log("[ServerSync] File not on server, uploading...");

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

            // Fallback 1: if the active document was opened from a File object, use it.
            if (!file && docType === "pdf") {
                const desc = state.currentPdfDescriptor;
                const candidate = desc?.type === "file" ? desc.fileObject : null;
                if (candidate instanceof Blob) {
                    file = candidate;
                    // Best-effort repair so future syncs can find it.
                    try {
                        await this.app.progressManager.savePdfToIndexedDB(file, fileId);
                    } catch {
                        // ignore
                    }
                }
            }

            // Fallback 2: the current key might point to progress/highlights, but the blob may be stored
            // under a sibling key (same filename+size, different timestamp). Try to locate it.
            if (!file && fileId.startsWith("file::")) {
                const target = this._parseFileKeyParts(fileId);
                if (target?.name && target.size > 0) {
                    const keys =
                        docType === "epub"
                            ? await this.app.progressManager.listSavedEPUBs()
                            : await this.app.progressManager.listSavedPDFs();

                    const candidates = keys.filter((k) => {
                        const p = this._parseFileKeyParts(k);
                        return p && p.name === target.name && p.size === target.size;
                    });

                    for (const k of candidates) {
                        try {
                            const record =
                                docType === "epub"
                                    ? await this.app.progressManager.loadEpubFromIndexedDB(k)
                                    : await this.app.progressManager.loadPdfFromIndexedDB(k);
                            if (record?.blob) {
                                file = record.blob;
                                // Best-effort repair for the active key.
                                if (k !== fileId && docType === "pdf") {
                                    try {
                                        await this.app.progressManager.savePdfToIndexedDB(file, fileId);
                                    } catch {
                                        // ignore
                                    }
                                }
                                break;
                            }
                        } catch {
                            // ignore and keep trying
                        }
                    }
                }
            }

            if (!file) {
                console.warn("[ServerSync] Cannot upload file - missing local blob", { fileId });
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
        this.stopAutoSync();

        if (!this.isEnabled()) {
            // console.log("[ServerSync] Auto-sync disabled - no server configured");
            return;
        }
        this._autoSyncEnabled = true;

        const onWake = async () => {
            if (!this._autoSyncEnabled) return;
            await this._maybePullServerStateUpdates();
            // Keep downloads up to date when the app regains focus/network.
            await this.syncFromServer();
        };

        // When the app becomes active again, do a lightweight pull + download.
        this._addAutoSyncListener(window, "focus", () => {
            onWake().catch(() => {});
        });
        this._addAutoSyncListener(window, "online", () => {
            onWake().catch(() => {});
        });
        this._addAutoSyncListener(document, "visibilitychange", () => {
            if (document.visibilityState === "visible") {
                onWake().catch(() => {});
            }
        });

        // Do initial sync: check server availability, pull server state (position/highlights), download books.
        setTimeout(async () => {
            const serverAvailable = await this.checkServerAvailability();

            if (serverAvailable) {
                // console.log("[ServerSync] Server is accessible, downloading books...");
                await this.pullServerStateUpdates();
                await this.syncFromServer();
            } else {
                console.warn("[ServerSync] Server is not accessible");
            }
        }, 600);
    }

    stopAutoSync() {
        this._autoSyncEnabled = false;
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
            this.syncInterval = null;
        }
        this._clearAutoSyncListeners();
        // console.log("[ServerSync] Auto-sync stopped");
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
            // console.log("[ServerSync] No server configured for download");
            return;
        }

        try {
            // Get list of files from server
            const response = await this._fetch(`${serverUrl}/api/files`, {
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

            // console.log(`[ServerSync] Found ${serverFiles.length} files on server`);

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
            const missingFiles = serverFiles.filter((f) => f && !f.deleted).filter(f => {
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
                // console.log("[ServerSync] All server files are already cached locally");
                //this.app.ui?.showInfo?.("Already synced with server");
                return;
            }

            // console.log(`[ServerSync] Downloading ${missingFiles.length} missing files...`);
            this.app.ui?.showInfo?.(`Downloading ${missingFiles.length} files from server...`);

            // Download each missing file
            let downloaded = 0;
            for (const fileInfo of missingFiles) {
                try {
                    const ok = await this.downloadFile(fileInfo);
                    if (ok) {
                        downloaded++;
                        this.app.ui?.showInfo?.(`Downloaded ${downloaded}/${missingFiles.length} files`);
                    }
                } catch (error) {
                    console.error(`[ServerSync] Failed to download ${fileInfo.filename}:`, error);
                }
            }

            if (downloaded > 0) {
                this.app.ui?.showInfo?.(`Downloaded ${downloaded} files from server`);
                // console.log(`[ServerSync] Download complete: ${downloaded}/${missingFiles.length} files`);
                
                // Refresh the saved PDFs view to show new downloads
                // console.log("[ServerSync] Refreshing library view with new downloads");
                // console.log("[ServerSync] Current document type:", this.app.state.currentDocumentType);
                // console.log("[ServerSync] App methods available:", {
                    //showSavedPDFs: typeof this.app.showSavedPDFs,
                   // pdfThumbnailCache: typeof this.app.pdfThumbnailCache,
                   // showSavedPDFsOnCache: this.app.pdfThumbnailCache ? typeof this.app.pdfThumbnailCache.showSavedPDFs : 'undefined'
               // });
                
                setTimeout(() => {
                    try {
                        // console.log("[ServerSync] Attempting to refresh library...");
                        
                        // Try to refresh the library view
                        if (typeof this.app.showSavedPDFs === 'function') {
                            // console.log("[ServerSync] Calling app.showSavedPDFs()");
                            this.app.showSavedPDFs();
                        } else if (this.app.pdfThumbnailCache && typeof this.app.pdfThumbnailCache.showSavedPDFs === 'function') {
                            // console.log("[ServerSync] Calling pdfThumbnailCache.showSavedPDFs()");
                            this.app.pdfThumbnailCache.showSavedPDFs();
                        } else {
                            console.warn("[ServerSync] No method found to refresh library view");
                        }
                        
                        // console.log("[ServerSync] Library view refresh initiated");
                    } catch (error) {
                        console.error("[ServerSync] Failed to refresh library view:", error);
                        console.error("[ServerSync] Error details:", {
                            name: error.name,
                            message: error.message,
                            stack: error.stack
                        });
                    }
                }, 1000);
            }
        } catch (error) {
            console.error("[ServerSync] Sync from server failed:", error);
            this.app.ui?.showInfo?.("Failed to sync from server");
        }
    }

    async downloadFile(fileInfo) {
        const serverUrl = this.getServerUrl();
        if (!serverUrl) return false;

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
        const response = await this._fetch(`${serverUrl}/api/files/${encodeURIComponent(filename)}/download`, {
            method: "GET",
        });

        if (!response.ok) {
            if (response.status === 410) {
                const docType = format === "epub" ? "epub" : "pdf";
                await this._purgeLocalByActualFilename(actualFilename, docType);
                // Not an error: the server intentionally removed/excluded this file.
                return false;
            }

            if (response.status === 404) {
                console.warn("[ServerSync] File not found on server; skipping download", { filename });
                return false;
            }

            const details = await response.text().catch(() => "");
            throw new Error(`Download failed (${response.status}): ${details || response.statusText}`);
        }

        const blob = await response.blob();
        
        // Create a proper File object with correct type and name
        const fileType = format === "pdf" ? "application/pdf" : "application/epub+zip";
        const file = new File([blob], actualFilename, { type: fileType });

        // Save to IndexedDB using the full filename key from server.
        // Avoid duplicates: if it already exists under this key, don't save again.
        if (format === "pdf") {
            const existing = await this.app.progressManager.loadPdfFromIndexedDB(filename);
            if (!existing) {
                await this.app.progressManager.savePdfToIndexedDB(file, filename);
            }
        } else if (format === "epub") {
            const existing = await this.app.progressManager.loadEpubFromIndexedDB(filename);
            if (!existing) {
                await this.app.progressManager.saveEpubToIndexedDB(file, filename);
            }
        }

        // Restore progress if available
        const progressMap = this.app.progressManager.getProgressMap();
        const docType = format === "epub" ? "epub" : "pdf";
        const compoundKey = `${docType}::${filename}`;
        
        progressMap[compoundKey] = {
            sentenceIndex: parseInt(reading_position, 10) || 0,
            updated: Date.now(),
            voice: voice || null,
            title: title || actualFilename,
            docType: docType,
        };
        
        this.app.progressManager.setProgressMap(progressMap);

        // Pull highlights from server and persist locally so the device has an offline copy
        // without needing to open the document.
        try {
            const highlightsResponse = await this._fetch(
                `${serverUrl}/api/files/${encodeURIComponent(filename)}/highlights`,
                { method: "GET", headers: { "Content-Type": "application/json" } },
            );
            if (highlightsResponse.ok) {
                const highlightsData = await highlightsResponse.json();
                if (highlightsData?.highlights && Array.isArray(highlightsData.highlights)) {
                    const highlightsMap = new Map();
                    for (const h of highlightsData.highlights) {
                        if (h && Number.isFinite(h.sentenceIndex)) {
                            highlightsMap.set(h.sentenceIndex, {
                                color: h.color,
                                text: h.text || "",
                            });
                        }
                    }
                    this.app.highlightsStorage?.saveHighlights?.(filename, highlightsMap);
                }
            }
        } catch (e) {
            console.warn("[ServerSync] Failed to fetch/save highlights:", e);
        }

        // console.log(`[ServerSync] Downloaded and cached: ${actualFilename}`);

        return true;
    }
}
