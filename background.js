// =======================
// Storage
// =======================
class SettingsStore {
    static async get() {
        return await chrome.storage.local.get([
            "apiKey",
            "model",
            "prePrompt",
            "lastAnswer",
            "lastState",             // idle | busy | ready | error
            "sessionEnabled",        // boolean
            "sessionLastResponseId"  // string|null
        ]);
    }
    static async set(obj) {
        await chrome.storage.local.set(obj);
    }
}

class StateIndicator {
    static async setIdle() {
        await chrome.action.setBadgeText({ text: "" });
        await SettingsStore.set({ lastState: "idle" });
    }
    static async setBusy() {
        await chrome.action.setBadgeText({ text: "…" });
        await chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" });
        await SettingsStore.set({ lastState: "busy" });
    }
    static async setReady() {
        await chrome.action.setBadgeText({ text: "✓" });
        await chrome.action.setBadgeBackgroundColor({ color: "#22c55e" });
        await SettingsStore.set({ lastState: "ready" });
    }
    static async setError() {
        await chrome.action.setBadgeText({ text: "ERR" });
        await chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
        await SettingsStore.set({ lastState: "error" });
    }
}

class ResponseStore {
    static async setLastAnswer(answer) {
        await SettingsStore.set({ lastAnswer: answer });
    }
    static async getLastAnswer() {
        const { lastAnswer } = await SettingsStore.get();
        return lastAnswer || "";
    }
}

// =======================
// OpenAI Responses client
// =======================
class OpenAIResponsesClient {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.endpoint = "https://api.openai.com/v1/responses";
    }

    async _post(body, timeoutMs = 20000) {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const res = await fetch(this.endpoint, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${this.apiKey}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(body),
                signal: controller.signal
            });

            if (!res.ok) {
                const errText = await res.text().catch(() => "");
                throw new Error(`OpenAI HTTP ${res.status}: ${errText || res.statusText || "No details"}`);
            }
            return await res.json();
        } catch (e) {
            if (e?.name === "AbortError") throw new Error("OpenAI request timeout.");
            throw new Error("OpenAI request failed: " + (e?.message || String(e)));
        } finally {
            clearTimeout(t);
        }
    }

    _buildBody({ model, prePrompt, previousResponseId, userContent }) {
        const input = [];

        // Injecte le pré-prompt uniquement au 1er tour (ou si session OFF)
        if (!previousResponseId && prePrompt && prePrompt.trim()) {
            input.push({ role: "developer", content: prePrompt.trim() });
        }

        input.push({ role: "user", content: userContent });

        const body = {
            model,
            temperature: 0,
            store: true,
            input
        };

        if (previousResponseId) body.previous_response_id = previousResponseId;
        return body;
    }

    async sendText({ model, prePrompt, previousResponseId = null, text }) {
        const t = (text || "").trim();
        if (!t) throw new Error("No text provided.");

        const body = this._buildBody({
            model,
            prePrompt,
            previousResponseId,
            userContent: [{ type: "input_text", text: t }]
        });

        return await this._post(body);
    }

    async sendImage({ model, prePrompt, previousResponseId = null, imageDataUrl, hintText = "" }) {
        if (!imageDataUrl) throw new Error("No image provided.");

        const content = [];
        const hint = (hintText || "").trim();
        if (hint) content.push({ type: "input_text", text: hint });
        content.push({ type: "input_image", image_url: imageDataUrl });

        const body = this._buildBody({
            model,
            prePrompt,
            previousResponseId,
            userContent: content
        });

        return await this._post(body);
    }

    static extractText(resp) {
        if (typeof resp?.output_text === "string" && resp.output_text.trim()) {
            return resp.output_text.trim();
        }
        const out = resp?.output;
        if (Array.isArray(out)) {
            const parts = [];
            for (const item of out) {
                const content = item?.content;
                if (Array.isArray(content)) {
                    for (const c of content) {
                        if (typeof c?.text === "string") parts.push(c.text);
                    }
                }
                if (typeof item?.text === "string") parts.push(item.text);
            }
            const joined = parts.join("\n").trim();
            if (joined) return joined;
        }
        return JSON.stringify(resp, null, 2);
    }

    static extractResponseId(resp) {
        return typeof resp?.id === "string" ? resp.id : null;
    }
}

// =======================
// Clipboard helpers
// =======================
class ClipboardWriter {
    static async writeTextToClipboardViaActiveTab(text) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) throw new Error("No active tab");

        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            args: [text],
            func: async (t) => { await navigator.clipboard.writeText(t); }
        });
    }
}

class ClipboardReader {
    static async readClipboardViaInjectedScript() {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) throw new Error("No active tab");

        const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async () => {
                async function blobToDataUrl(blob) {
                    const arrayBuffer = await blob.arrayBuffer();
                    const bytes = new Uint8Array(arrayBuffer);
                    let binary = "";
                    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
                    const base64 = btoa(binary);
                    return `data:${blob.type};base64,${base64}`;
                }

                // Image si possible
                if (navigator.clipboard?.read) {
                    try {
                        const items = await navigator.clipboard.read();
                        for (const item of items) {
                            const types = item.types || [];
                            const pick =
                                types.includes("image/png") ? "image/png" :
                                    types.includes("image/jpeg") ? "image/jpeg" :
                                        null;

                            if (pick) {
                                const blob = await item.getType(pick);
                                const dataUrl = await blobToDataUrl(blob);
                                return { kind: "image", dataUrl };
                            }
                        }
                    } catch (e) {
                        console.warn("Clipboard image read blocked", e);
                    }
                }

                // Texte fallback
                if (navigator.clipboard?.readText) {
                    try {
                        const text = await navigator.clipboard.readText();
                        if (text && text.trim()) return { kind: "text", text };
                    } catch (e) {
                        console.warn("Clipboard text read blocked", e);
                    }
                }

                return { kind: "empty" };
            }
        });

        return result || { kind: "empty" };
    }
}

// =======================
// Menus
// =======================
chrome.runtime.onInstalled.addListener(async () => {
    const settings = await SettingsStore.get();
    const enabled = !!settings.sessionEnabled;

    chrome.contextMenus.create({
        id: "ghostgpt-copy-last",
        title: "Copier la dernière réponse (Ghost GPT)",
        contexts: ["action"]
    });

    chrome.contextMenus.create({
        id: "ghostgpt-send-selection",
        title: "Envoyer la sélection à Ghost GPT",
        contexts: ["selection"]
    });

    chrome.contextMenus.create({
        id: "ghostgpt-toggle-session",
        title: enabled ? "Désactiver la session (Ghost GPT)" : "Activer la session (Ghost GPT)",
        contexts: ["action"]
    });

    await StateIndicator.setIdle();
});

chrome.contextMenus.onClicked.addListener(async (info) => {
    try {
        if (info.menuItemId === "ghostgpt-copy-last") {
            const answer = await ResponseStore.getLastAnswer();
            if (!answer) return;
            await ClipboardWriter.writeTextToClipboardViaActiveTab(answer);
            await StateIndicator.setIdle();
            return;
        }

        if (info.menuItemId === "ghostgpt-toggle-session") {
            const settings = await SettingsStore.get();
            const newValue = !settings.sessionEnabled;

            await SettingsStore.set({
                sessionEnabled: newValue,
                sessionLastResponseId: null // reset pour repartir proprement
            });

            chrome.contextMenus.update("ghostgpt-toggle-session", {
                title: newValue ? "Désactiver la session (Ghost GPT)" : "Activer la session (Ghost GPT)"
            });

            await StateIndicator.setIdle();
            return;
        }

        if (info.menuItemId === "ghostgpt-send-selection") {
            const selection = (info.selectionText || "").trim();
            if (!selection) return;
            await runTextFlow(selection);
        }
    } catch (e) {
        console.error(e);
        await StateIndicator.setError();
    }
});

chrome.action.onClicked.addListener(async () => {
    try {
        const { lastState } = await SettingsStore.get();

        if (lastState === "ready") {
            const answer = await ResponseStore.getLastAnswer();
            if (!answer) return;
            await ClipboardWriter.writeTextToClipboardViaActiveTab(answer);
            await StateIndicator.setIdle();
            return;
        }

        await runClipboardFlow();
    } catch (e) {
        console.error(e);
        await StateIndicator.setError();
    }
});

// =======================
// Flows
// =======================
function pickPrePrompt(settings) {
    // prePrompt nouveau ; fallback sur systemPrompt si tu n'as pas migré options
    const p = (settings.prePrompt || settings.systemPrompt || "").trim();
    return p || "Tu es un assistant concis.";
}

async function runClipboardFlow() {
    const settings = await SettingsStore.get();
    if (!settings.apiKey) throw new Error("No API key set (Options).");

    await StateIndicator.setBusy();

    const clip = await ClipboardReader.readClipboardViaInjectedScript();
    if (clip.kind === "empty") throw new Error("Clipboard is empty or blocked.");

    const client = new OpenAIResponsesClient(settings.apiKey);
    const model = (settings.model || "gpt-4o-mini").trim();
    const prePrompt = pickPrePrompt(settings);

    const sessionEnabled = !!settings.sessionEnabled;
    const previousResponseId = sessionEnabled ? (settings.sessionLastResponseId || null) : null;

    let resp;
    if (clip.kind === "image") {
        resp = await client.sendImage({
            model,
            prePrompt,
            previousResponseId,
            imageDataUrl: clip.dataUrl,
            hintText: "" // optionnel
        });
    } else {
        resp = await client.sendText({
            model,
            prePrompt,
            previousResponseId,
            text: clip.text || ""
        });
    }

    if (sessionEnabled) {
        const newId = OpenAIResponsesClient.extractResponseId(resp);
        await SettingsStore.set({ sessionLastResponseId: newId });
    }

    const answer = OpenAIResponsesClient.extractText(resp);
    await ResponseStore.setLastAnswer(answer);
    await StateIndicator.setReady();
}

async function runTextFlow(text) {
    const settings = await SettingsStore.get();
    if (!settings.apiKey) throw new Error("No API key set (Options).");

    await StateIndicator.setBusy();

    const client = new OpenAIResponsesClient(settings.apiKey);
    const model = (settings.model || "gpt-4o-mini").trim();
    const prePrompt = pickPrePrompt(settings);

    const sessionEnabled = !!settings.sessionEnabled;
    const previousResponseId = sessionEnabled ? (settings.sessionLastResponseId || null) : null;

    const resp = await client.sendText({
        model,
        prePrompt,
        previousResponseId,
        text: text || ""
    });

    if (sessionEnabled) {
        const newId = OpenAIResponsesClient.extractResponseId(resp);
        await SettingsStore.set({ sessionLastResponseId: newId });
    }

    const answer = OpenAIResponsesClient.extractText(resp);
    await ResponseStore.setLastAnswer(answer);
    await StateIndicator.setReady();
}
