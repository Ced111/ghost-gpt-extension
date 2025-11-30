class SettingsStore {
    static async get() {
        return await chrome.storage.local.get([
            "apiKey",
            "model",
            "systemPrompt",
            "imagePrompt",
            "textPrompt",
            "lastAnswer",
            "lastState" // idle | busy | ready | error
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
        await chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" }); // orange
        await SettingsStore.set({ lastState: "busy" });
    }

    static async setReady() {
        await chrome.action.setBadgeText({ text: "✓" });
        await chrome.action.setBadgeBackgroundColor({ color: "#22c55e" }); // vert
        await SettingsStore.set({ lastState: "ready" });
    }

    static async setError() {
        await chrome.action.setBadgeText({ text: "ERR" });
        await chrome.action.setBadgeBackgroundColor({ color: "#ef4444" }); // rouge
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

// ==== Client OpenAI Responses (vision + texte), temperature = 0 en dur ====

class OpenAIResponsesClient {
    constructor(apiKey) {
        this.apiKey = apiKey;
    }

    // IMAGE : préparation + prompt image + image
    async createVisionResponse({ model, systemPrompt, imagePrompt, imageDataUrl }) {
        const prep = systemPrompt || "";
        const imgPrompt = imagePrompt || "";

        const body = {
            model,
            temperature: 0,
            input: [
                {
                    role: "user",
                    content: [
                        {
                            type: "input_text",
                            text: `${prep}\n\n${imgPrompt}`.trim()
                        },
                        {
                            type: "input_image",
                            image_url: imageDataUrl
                        }
                    ]
                }
            ]
        };

        const res = await fetch("https://api.openai.com/v1/responses", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${this.apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
        });

        if (!res.ok) {
            const errText = await res.text().catch(() => "");
            throw new Error(`OpenAI error ${res.status}: ${errText || res.statusText}`);
        }

        return await res.json();
    }

    // TEXTE : préparation + prompt texte + texte sélectionné
    async createTextResponse({ model, systemPrompt, textPrompt, rawText }) {
        const prep = systemPrompt || "";
        const tPrompt = textPrompt || "";
        const contentText = `${prep}\n\n${tPrompt}\n\n${rawText || ""}`.trim();

        const body = {
            model,
            temperature: 0,
            input: [
                {
                    role: "user",
                    content: [
                        {
                            type: "input_text",
                            text: contentText
                        }
                    ]
                }
            ]
        };

        const res = await fetch("https://api.openai.com/v1/responses", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${this.apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
        });

        if (!res.ok) {
            const errText = await res.text().catch(() => "");
            throw new Error(`OpenAI error ${res.status}: ${errText || res.statusText}`);
        }

        return await res.json();
    }

    static extractOutputText(responseJson) {
        if (typeof responseJson?.output_text === "string" && responseJson.output_text.trim()) {
            return responseJson.output_text.trim();
        }

        const output = responseJson?.output;
        if (Array.isArray(output)) {
            const chunks = [];
            for (const item of output) {
                const content = item?.content;
                if (Array.isArray(content)) {
                    for (const c of content) {
                        if (typeof c?.text === "string") chunks.push(c.text);
                    }
                }
                if (typeof item?.text === "string") chunks.push(item.text);
            }

            const joined = chunks.join("\n").trim();
            if (joined) return joined;
        }

        return JSON.stringify(responseJson, null, 2);
    }
}

// ===== Clipboard helpers =====

class ClipboardWriter {
    static async writeTextToClipboardViaActiveTab(text) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) throw new Error("No active tab");

        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            args: [text],
            func: async (t) => {
                await navigator.clipboard.writeText(t);
            }
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
                    for (let i = 0; i < bytes.length; i++) {
                        binary += String.fromCharCode(bytes[i]);
                    }
                    const base64 = btoa(binary);
                    return `data:${blob.type};base64,${base64}`;
                }

                async function readClipboardBestEffort() {
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

                return await readClipboardBestEffort();
            }
        });

        if (!result) return { kind: "empty" };
        return result;
    }
}

// ===== Menus contextuels =====

chrome.runtime.onInstalled.addListener(async () => {
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

    await StateIndicator.setIdle();
});

// clic droit sur icône → copier dernière réponse
chrome.contextMenus.onClicked.addListener(async (info) => {
    try {
        if (info.menuItemId === "ghostgpt-copy-last") {
            const answer = await ResponseStore.getLastAnswer();
            if (!answer) return;
            await ClipboardWriter.writeTextToClipboardViaActiveTab(answer);
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

// clic gauche sur icône → si READY => copie ; sinon => envoie clipboard (image ou texte)
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

// ===== Flows =====

async function runClipboardFlow() {
    const settings = await SettingsStore.get();
    if (!settings.apiKey) throw new Error("No API key set (Options).");

    await StateIndicator.setBusy();

    const clip = await ClipboardReader.readClipboardViaInjectedScript();

    const client = new OpenAIResponsesClient(settings.apiKey);
    const model = (settings.model || "gpt-4o-mini").trim();
    const systemPrompt = settings.systemPrompt || "Tu es un assistant concis.";

    let responseJson;

    if (clip.kind === "image") {
        responseJson = await client.createVisionResponse({
            model,
            systemPrompt,
            imagePrompt: settings.imagePrompt || "",
            imageDataUrl: clip.dataUrl
        });

    } else if (clip.kind === "text") {
        responseJson = await client.createTextResponse({
            model,
            systemPrompt,
            textPrompt: settings.textPrompt || "",
            rawText: clip.text || ""
        });

    } else {
        throw new Error("Clipboard is empty or blocked.");
    }

    const answer = OpenAIResponsesClient.extractOutputText(responseJson);
    await ResponseStore.setLastAnswer(answer);
    await StateIndicator.setReady();
}

async function runTextFlow(text) {
    const settings = await SettingsStore.get();
    if (!settings.apiKey) throw new Error("No API key set (Options).");

    await StateIndicator.setBusy();

    const client = new OpenAIResponsesClient(settings.apiKey);
    const model = (settings.model || "gpt-4o-mini").trim();
    const systemPrompt = settings.systemPrompt || "Tu es un assistant concis.";

    const responseJson = await client.createTextResponse({
        model,
        systemPrompt,
        textPrompt: settings.textPrompt || "",
        rawText: text || ""
    });

    const answer = OpenAIResponsesClient.extractOutputText(responseJson);
    await ResponseStore.setLastAnswer(answer);
    await StateIndicator.setReady();
}
