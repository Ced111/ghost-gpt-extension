class SettingsStore {
    static async get() {
        return await chrome.storage.local.get([
            "apiKey",
            "model",
            "systemPrompt",
            "imagePrompt",
            "textPrompt",
            "lastAnswer",
            "lastState",       // idle | busy | ready | error
            "sessionHistory",  // [{ kind: "image", dataUrl }, { kind: "text", text }]
            "sessionEnabled"   // boolean
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

/**
 * Client OpenAI Responses
 * - instructions = prompt de préparation
 * - historyMessages = historique de TES messages (texte + images)
 * - dernier message (image ou texte)
 * Température fixée à 0.
 */
class OpenAIResponsesClient {
    constructor(apiKey) {
        this.apiKey = apiKey;
    }

    // --- Helper interne avec timeout de 30 secondes ---
    async _postWithTimeout(body, timeoutMs = 30000) {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const res = await fetch("https://api.openai.com/v1/responses", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${this.apiKey}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(body),
                signal: controller.signal
            });

            clearTimeout(id);

            if (!res.ok) {
                const errText = await res.text().catch(() => "");
                throw new Error(
                    `La requête OpenAI a échoué (code ${res.status}). ` +
                    (errText || res.statusText || "Aucun détail supplémentaire n'a été fourni.")
                );
            }

            return await res.json();
        } catch (e) {
            clearTimeout(id);
            if (e.name === "AbortError") {
                // Timeout explicite
                throw new Error(
                    "La requête vers l'API OpenAI a dépassé 30 secondes et a été annulée. " +
                    "Cela peut venir d'un texte très long, d'une image lourde ou d'un problème de réseau / API."
                );
            }
            // Autre erreur réseau / fetch
            throw new Error(
                "Erreur lors de l'appel à l'API OpenAI : " +
                (e.message || e.toString())
            );
        }
    }

    /**
     * historyMessages : tableau déjà construit au format:
     * [
     *   { role: "user", content: [ { type: "input_text"|"input_image", ... } ] },
     *   ...
     * ]
     */
    async createVisionResponse({ model, instructions, historyMessages, imagePrompt, imageDataUrl }) {
        const input = Array.isArray(historyMessages) ? [...historyMessages] : [];

        const latestContent = [];
        if (imagePrompt && imagePrompt.trim()) {
            latestContent.push({
                type: "input_text",
                text: imagePrompt.trim()
            });
        }
        latestContent.push({
            type: "input_image",
            image_url: imageDataUrl
        });

        input.push({
            role: "user",
            content: latestContent
        });

        const body = {
            model,
            temperature: 0,
            instructions: instructions || "",
            input
        };

        // --- maintenant on passe par le helper avec timeout ---
        return await this._postWithTimeout(body, 20000);
    }

    async createTextResponse({ model, instructions, historyMessages, textPrompt, rawText }) {
        const input = Array.isArray(historyMessages) ? [...historyMessages] : [];

        const pieces = [];
        if (textPrompt && textPrompt.trim()) pieces.push(textPrompt.trim());
        if (rawText && rawText.trim()) pieces.push(rawText.trim());
        const textForThisTurn = pieces.join("\n\n").trim() || rawText || "";

        input.push({
            role: "user",
            content: [
                {
                    type: "input_text",
                    text: textForThisTurn
                }
            ]
        });

        const body = {
            model,
            temperature: 0,
            instructions: instructions || "",
            input
        };

        // --- idem, on passe par le helper avec timeout ---
        return await this._postWithTimeout(body, 20000);
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

// clic droit sur icône → copier / activer session / désactiver session
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
            const enabled = !!settings.sessionEnabled;
            const newValue = !enabled;

            // On bascule l'état + on reset l'historique à chaque bascule
            await SettingsStore.set({
                sessionEnabled: newValue,
                sessionHistory: []
            });

            chrome.contextMenus.update("ghostgpt-toggle-session", {
                title: newValue
                    ? "Désactiver la session (Ghost GPT)"
                    : "Activer la session (Ghost GPT)"
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

// ===== Utilitaires session → messages OpenAI =====

function buildHistoryMessages(sessionHistory) {
    if (!Array.isArray(sessionHistory)) return [];

    const msgs = [];
    for (const item of sessionHistory) {
        if (!item || !item.kind) continue;

        if (item.kind === "image" && item.dataUrl) {
            msgs.push({
                role: "user",
                content: [
                    { type: "input_image", image_url: item.dataUrl }
                ]
            });
        } else if (item.kind === "text" && item.text) {
            msgs.push({
                role: "user",
                content: [
                    { type: "input_text", text: item.text }
                ]
            });
        }
    }
    return msgs;
}

// ===== Flows =====

async function runClipboardFlow() {
    const settings = await SettingsStore.get();
    if (!settings.apiKey) throw new Error("No API key set (Options).");

    await StateIndicator.setBusy();

    const clip = await ClipboardReader.readClipboardViaInjectedScript();

    const client = new OpenAIResponsesClient(settings.apiKey);
    const model = (settings.model || "gpt-4o-mini").trim();
    const systemPrompt = settings.systemPrompt || "Tu es un assistant concis.";
    const sessionEnabled = !!settings.sessionEnabled;

    const sessionHistory = sessionEnabled && Array.isArray(settings.sessionHistory)
        ? [...settings.sessionHistory]
        : [];

    const historyMessages = sessionEnabled ? buildHistoryMessages(sessionHistory) : [];

    let responseJson;

    if (clip.kind === "image") {
        responseJson = await client.createVisionResponse({
            model,
            instructions: systemPrompt,
            historyMessages,
            imagePrompt: settings.imagePrompt || "",
            imageDataUrl: clip.dataUrl
        });

        if (sessionEnabled) {
            sessionHistory.push({ kind: "image", dataUrl: clip.dataUrl });
            await SettingsStore.set({ sessionHistory });
        }

    } else if (clip.kind === "text") {
        responseJson = await client.createTextResponse({
            model,
            instructions: systemPrompt,
            historyMessages,
            textPrompt: settings.textPrompt || "",
            rawText: clip.text || ""
        });

        if (sessionEnabled) {
            sessionHistory.push({ kind: "text", text: clip.text || "" });
            await SettingsStore.set({ sessionHistory });
        }

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
    const sessionEnabled = !!settings.sessionEnabled;

    const sessionHistory = sessionEnabled && Array.isArray(settings.sessionHistory)
        ? [...settings.sessionHistory]
        : [];

    const historyMessages = sessionEnabled ? buildHistoryMessages(sessionHistory) : [];

    const responseJson = await client.createTextResponse({
        model,
        instructions: systemPrompt,
        historyMessages,
        textPrompt: settings.textPrompt || "",
        rawText: text || ""
    });

    if (sessionEnabled) {
        sessionHistory.push({ kind: "text", text: text || "" });
        await SettingsStore.set({ sessionHistory });
    }

    const answer = OpenAIResponsesClient.extractOutputText(responseJson);
    await ResponseStore.setLastAnswer(answer);
    await StateIndicator.setReady();
}
