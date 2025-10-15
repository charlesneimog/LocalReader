import createKindeClient from "https://cdn.jsdelivr.net/npm/@kinde-oss/kinde-auth-pkce-js@4.3.0/dist/kinde-auth-pkce-js.esm.js";

export class Login {
    constructor(app) {
        this.app = app;
        this.client = null;
        this.allow_read = true;
        this.name = null;
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

        if (await this.client.isAuthenticated()) {
        } else {
            this.client.login();
        }
        const user = await this.client.getUser();
        document.getElementById("user-avatar").src = user?.picture;
        this.name = user.given_name + " " + user.family_name;
    }

    getUserName() {
        return this.name;
    }

    async login() {}

    async logout() {}

    async subscribe() {}
}
