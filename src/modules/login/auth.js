export class Login {
    constructor(app) {
        this.app = app;
        this.client = null;
    }

    async checkProUser(client) {
        try {
            const orgs = await client.getUserOrganizations();
            const orgId = orgs.orgCodes[0];
            if (orgId !== "org_65ebf424294") {
                const warningDiv = document.getElementById("access-warning");
                warningDiv.innerHTML = `You need to subscribe to PDFCast Pro to get full access!<br>You have 5 minutes of free access.`;
                warningDiv.style.display = "block";
                setTimeout(() => {
                    warningDiv.style.display = "none";
                }, 10000);
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

        const client = await createKindeClient({
            domain: "https://pdfcastia.kinde.com",
            client_id: "28453f64b8634f94b45bcec091eadc89",
            redirect_uri: returnUrl,
        });

        const isAuthenticated = await client.isAuthenticated();
        if (isAuthenticated) {
            this._updateUserAvatar(client);
            await this.checkProUser(client);
        } else {
            client.login();
        }
    }

    async _updateUserAvatar(client) {
        const avatarSpan = document.getElementById("user-avatar");
        const user = await client.getUserProfile();
        avatarSpan.innerHTML = "";

        const img = document.createElement("img");
        img.src = user?.picture || "default-avatar.png";
        img.alt = user?.given_name || "User avatar";
        img.id = "login-user";
        img.className = "w-7 h-7 rounded-full object-cover border border-slate-300 dark:border-slate-600";

        avatarSpan.appendChild(img);
    }

    async signOut() {
        const client = this.client;
        if (client) await client.logout();
    }

    async getUser() {
        const client = this.client;
        return client ? client.getUserProfile() : null;
    }
}
