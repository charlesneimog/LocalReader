import test from "node:test";
import assert from "node:assert/strict";

import { ServerSync } from "../src/modules/storage/serverSync.js";

const makeStorage = () => ({
    getItem: () => null,
    setItem() {},
    removeItem() {},
});

const makeSync = () => {
    const sync = Object.create(ServerSync.prototype);
    sync.app = { ui: { showInfo() {} } };
    sync.getServerUrl = () => null;
    return sync;
};

test("uses Google translation first", async () => {
    const previousStorage = globalThis.localStorage;
    const previousFetch = globalThis.fetch;
    globalThis.localStorage = makeStorage();

    let requestedUrl = "";
    globalThis.fetch = async (url) => {
        requestedUrl = String(url);
        return {
            ok: true,
            json: async () => [[["Olá amigos", "Hello friends"]], null, "en"],
        };
    };

    try {
        const result = await makeSync().translateText("Hello friends", { target: "pt-BR" });
        assert.match(requestedUrl, /^https:\/\/translate\.googleapis\.com\/translate_a\/single\?/);
        assert.match(requestedUrl, /tl=pt-BR/);
        assert.deepEqual(result, {
            translatedText: "Olá amigos",
            target: "pt-BR",
            detectedSource: "en",
        });
    } finally {
        globalThis.localStorage = previousStorage;
        globalThis.fetch = previousFetch;
    }
});

test("falls back to the configured server API when Google fails", async () => {
    const previousStorage = globalThis.localStorage;
    const previousFetch = globalThis.fetch;
    globalThis.localStorage = makeStorage();
    globalThis.fetch = async () => {
        throw new TypeError("Google request blocked by CORS");
    };

    const sync = makeSync();
    sync.getServerUrl = () => "https://reader.example";
    let serverRequest = null;
    sync._fetch = async (url, options) => {
        serverRequest = { url, options };
        return {
            ok: true,
            json: async () => ({
                translatedText: "Olá amigos",
                detectedSource: "en",
                target: "pt",
            }),
        };
    };

    try {
        const result = await sync.translateText("Hello friends", { target: "pt" });
        assert.equal(serverRequest.url, "https://reader.example/api/translate");
        assert.equal(serverRequest.options.method, "POST");
        assert.equal(serverRequest.options.skipAvailabilityGate, true);
        assert.deepEqual(JSON.parse(serverRequest.options.body), {
            text: "Hello friends",
            target: "pt",
        });
        assert.equal(result.translatedText, "Olá amigos");
    } finally {
        globalThis.localStorage = previousStorage;
        globalThis.fetch = previousFetch;
    }
});

test("availability accepts either Google or the server fallback", async () => {
    const sync = makeSync();
    let receivedOptions = null;
    sync.translateText = async (text, options) => {
        assert.equal(text, "ok");
        receivedOptions = options;
        return { translatedText: "certo" };
    };

    assert.equal(await sync.checkTranslationAvailability("pt"), true);
    assert.equal(receivedOptions.target, "pt");
    assert.equal(receivedOptions.silent, true);
    assert.ok(receivedOptions.signal instanceof AbortSignal);
});
