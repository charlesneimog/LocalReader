// Helper UI functions (info/status) separated for reuse
export class UIService {
    constructor(app) {
        this.app = app;
        this.infoBox = document.getElementById("info-box");
        this.fatalErrorBox = document.getElementById("fatal-error");
        this.hideMessageTimeout = null;
        this.hideErrorTimeout = null;
        this.playBarIcon = document.querySelector("#play-toggle span.material-symbols-outlined");
    }

    showInfo(msg) {
        if (!this.infoBox) {
            console.log(msg);
            return;
        }

        // Mostra a mensagem
        this.infoBox.textContent = msg;
        this.infoBox.style.display = "block";
        this.isLoading = false;

        // Cancela qualquer timeout anterior
        clearTimeout(this.hideMessageTimeout);

        // Inicia novo timeout para esconder depois de 2s
        this.hideMessageTimeout = setTimeout(() => {
            this.infoBox.style.display = "none";
        }, 5000);
    }

    updatePlayButton(value) {
        const { state } = this.app;
        if (!this.playBarIcon) return;

        if (value === state.playerState.LOADING) {
            this.isLoading = true;
            this.playBarIcon.textContent = "hourglass_empty";
            this.playBarIcon.classList.add("animate-spin");
            return;
        }

        this.isLoading = false;
        this.playBarIcon.classList.remove("animate-spin");

        switch (value) {
            case state.playerState.PLAY:
                this.playBarIcon.textContent = "pause";
                return;
            case state.playerState.PAUSE:
            case state.playerState.STOP:
                this.playBarIcon.textContent = "play_arrow";
                return;
            default:
                this.playBarIcon.textContent = state.isPlaying ? "pause" : "play_arrow";
        }
    }

    showFatalError(msg) {
        if (!this.fatalErrorBox) {
            alert(msg);
        }

        // Mostra a mensagem
        this.fatalErrorBox.textContent = msg;
        this.fatalErrorBox.style.display = "block";

        // Cancela qualquer timeout anterior
        clearTimeout(this.hideErrorTimeout);

        // Inicia novo timeout para esconder depois de 2s
        this.hideErrorTimeout = setTimeout(() => {
            this.fatalErrorBox.style.display = "none";
        }, 30000);
    }
}
