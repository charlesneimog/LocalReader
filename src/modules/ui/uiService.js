// Helper UI functions (info/status) separated for reuse
export class UIService {
    constructor(app) {
        this.app = app;
        this.infoBox = document.getElementById("info-box");
        this.hideTimeout = null;
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
        clearTimeout(this.hideTimeout);

        // Inicia novo timeout para esconder depois de 2s
        this.hideTimeout = setTimeout(() => {
            this.infoBox.style.display = "none";
        }, 5000);
    }
}

