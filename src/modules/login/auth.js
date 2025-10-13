export class Login {
    constructor(app) {
        this.app = app;
        this.client = null;
        this.allow_read = true;
    }

    async checkProUser(client) {
        try {
            const orgs = await client.getUserOrganizations();
            const orgId = orgs.orgCodes[0];
            console.log(orgId);
            if (orgId !== "org_65ebf424294") {
                setTimeout(() => {
                    const warningDiv = document.getElementById("access-warning");
                    warningDiv.innerHTML = `You need to subscribe to PDFCastia Pro to get full access!<br>You have 5 minutes of free access.`;
                    warningDiv.style.display = "block";
                    warningDiv.style.textAlign = "center";
                    this.allow_read = false;
                    this.app.ttsEngine.client.freeUserTimeLimit();
                }, 300000);
            }
        } catch (err) {
            console.error("Failed to check Pro user:", err);
        }
    }

    async init() {
        let returnUrl = window.location.href;
        if (window.location.href.includes("charlesneimog")) {
            returnUrl = "https://charlesneimog.github.io/pdf-tts-reader/";
        }

        this.client = await createKindeClient({
            domain: "https://pdfcastia.kinde.com",
            client_id: "28453f64b8634f94b45bcec091eadc89",
            redirect_uri: returnUrl,
        });

        // Check required configurations
        const isAuthenticated = await this.client.isAuthenticated();
        if (isAuthenticated) {
            this._updateUserAvatar(this.client);
            await this.checkProUser(this.client);
        }
    }

    async _updateUserAvatar(client) {
        const avatarImg = document.getElementById("user-avatar");
        const user = await client.getUserProfile();
        if (avatarImg) {
            avatarImg.src = user?.picture || "./assets/images/default-user.png";
        }
    }

    async login() {
        this.client.login();
    }

    async logout() {
        const client = this.client;
        if (client) await client.logout();
    }

    async subscribe() {
        console.log(this.client);
        const client = this.client;
        if (client) await client.register();
    }

    async getUser() {
        const client = this.client;
        return client ? client.getUserProfile() : null;
    }
}
