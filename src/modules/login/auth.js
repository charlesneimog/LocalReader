// Dynamic import for optional authentication - will only load when online
let createKindeClient = null;

// Lazy load the auth library
async function loadKindeClient() {
    if (createKindeClient) return createKindeClient;
    
    try {
        const module = await import("https://cdn.jsdelivr.net/npm/@kinde-oss/kinde-auth-pkce-js@4.3.0/dist/kinde-auth-pkce-js.esm.js");
        createKindeClient = module.default;
        return createKindeClient;
    } catch (error) {
        console.warn('[Auth] Failed to load Kinde client (offline?):', error);
        return null;
    }
}

export class Login {
    constructor(app) {
        this.app = app;
        this.client = null;
        this.allow_read = true;
        this.name = null;
        this.isOffline = !navigator.onLine;
        
        // Monitor online/offline status
        window.addEventListener('online', () => {
            this.isOffline = false;
            console.log('[Auth] Online - authentication available');
        });
        
        window.addEventListener('offline', () => {
            this.isOffline = true;
            console.log('[Auth] Offline - authentication unavailable');
        });
    }

    async init() {
        if (this.isOffline) {
            console.log('[Auth] Skipping initialization - offline mode');
            return;
        }

        try {
            const kindeFactory = await loadKindeClient();
            if (!kindeFactory) {
                console.warn('[Auth] Could not load authentication library');
                return;
            }

            let returnUrl = window.location.href;
            if (window.location.href.includes("charlesneimog")) {
                returnUrl = "https://charlesneimog.github.io/pdf-tts-reader/";
            }

            this.client = await kindeFactory({
                domain: "https://pdfcastia.kinde.com",
                client_id: "28453f64b8634f94b45bcec091eadc89",
                redirect_uri: returnUrl,
            });

            if (await this.client.isAuthenticated()) {
                const user = await this.client.getUser();
                if (user) {
                    const avatarEl = document.getElementById("user-avatar");
                    if (avatarEl) {
                        avatarEl.src = user.picture;
                    }
                    this.name = user.given_name + " " + user.family_name;
                    console.log('[Auth] User authenticated:', this.name);
                }
            } else {
                // Don't auto-login, let user click login button
                console.log('[Auth] User not authenticated');
            }
        } catch (error) {
            console.error('[Auth] Initialization error:', error);
        }
    }

    getUserName() {
        return this.name;
    }

    async login() {
        if (this.isOffline) {
            alert('Login requires an internet connection. Please connect and try again.');
            return;
        }

        if (!this.client) {
            alert('Authentication service not available. Please reload the page.');
            return;
        }

        try {
            await this.client.login();
        } catch (error) {
            console.error('[Auth] Login error:', error);
            alert('Login failed. Please try again.');
        }
    }

    async logout() {
        if (this.isOffline) {
            alert('Logout requires an internet connection.');
            return;
        }

        if (!this.client) {
            return;
        }

        try {
            await this.client.logout();
            this.name = null;
        } catch (error) {
            console.error('[Auth] Logout error:', error);
        }
    }

    async subscribe() {
        if (this.isOffline) {
            alert('Subscription management requires an internet connection.');
            return;
        }

        // Implement subscription logic here
        alert('Subscription management coming soon!');
    }
}
