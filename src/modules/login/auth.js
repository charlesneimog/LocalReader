export class Login {
    constructor(app) {
        this.app = app;
        this.client = null;
    }

    async checkProUser(client) {
        const permissions = client.getPermissions()?.permissions ?? [];
        const orgId = client.getUserOrganizations().orgCodes[0];
        if (orgId != "org_65ebf424294") {
            const warningDiv = document.getElementById("access-warning");
            warningDiv.innerHTML = `You need to subscribe to PDFCast Pro to full access!<br>You have 5 minutes of free access.`;
            warningDiv.style.display = "block";
            setTimeout(() => {
                warningDiv.style.display = "none";
            }, 10000);
            return;
        }
    }

    async init() {
        const client = await createKindeClient({
            domain: "https://pdfcastia.kinde.com",
            client_id: "28453f64b8634f94b45bcec091eadc89",
            redirect_uri: window.location.origin,
            logout_uri: window.location.origin,
        });

        const isAuthenticated = await client.isAuthenticated();
        if (isAuthenticated) {
            this._updateUserAvatar(client);
            this.checkProUser(client);
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
        img.style.width = "40px";
        img.style.height = "40px";
        img.style.borderRadius = "5px";
        avatarSpan.appendChild(img);
    }

    async signOut() {}

    async getUser() {}
}
