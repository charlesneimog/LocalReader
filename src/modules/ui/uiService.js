// Helper UI functions (info/status) separated for reuse
export class UIService {
    constructor(app) {
        this.app = app;
        this.infoBox = document.getElementById("info-box");
        this.ttsStatus = document.getElementById("tts-status");
    }
    showInfo(msg) {
        if (this.infoBox) this.infoBox.textContent = msg;
        else console.log(msg);
    }
    updateStatus(msg) {
        if (this.ttsStatus) this.ttsStatus.textContent = msg || "";
        const live = document.getElementById(this.app.config.LIVE_STATUS_REGION_ID);
        if (live) live.textContent = msg || "";
    }
}