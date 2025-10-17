// Helper UI functions (info/status) separated for reuse
export class UIService {
    constructor(app) {
        this.app = app;
        this.infoBox = document.getElementById("info-box");
        this.fatalErrorBox = document.getElementById("fatal-error");
        this.hideMessageTimeout = null;
        this.hideErrorTimeout = null;
    }

    showInfo(msg) {
        if (!this.infoBox) {
            console.log(msg);
            return;
        }

        // Mostra a mensagem
        this.infoBox.textContent = msg;
        this.infoBox.style.display = "block";

        // Cancela qualquer timeout anterior
        clearTimeout(this.hideMessageTimeout);

        // Inicia novo timeout para esconder depois de 2s
        this.hideMessageTimeout = setTimeout(() => {
            this.infoBox.style.display = "none";
        }, 5000);
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
