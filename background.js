let operationRunning = false;
let creatingOffscreen;

async function callOffscreen(action, data = {}) {
    const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL('offscreen.html')]
    });
    if (!contexts.length) {
        if (!creatingOffscreen) {
            creatingOffscreen = chrome.offscreen.createDocument({
                url: 'offscreen.html', reasons: ['CLIPBOARD'],
                justification: 'Lire le texte ou l’image copiée et copier la réponse à la demande de l’utilisateur.'
            }).finally(() => { creatingOffscreen = null; });
        }
        await creatingOffscreen;
    }
    const response = await chrome.runtime.sendMessage({ target: 'offscreen', action, ...data });
    if (!response?.ok) throw new Error(response?.error || 'Le document interne ne répond pas. Rechargez l’extension.');
    return response.result;
}

async function setState(state, error = '') {
    const labels = {
        idle: ['', '#64748b', 'Ghost GPT — cliquer pour envoyer le presse-papiers'],
        busy: ['…', '#f59e0b', 'Ghost GPT — requête en cours'],
        ready: ['✓', '#22c55e', 'Ghost GPT — réponse prête, cliquer pour la copier'],
        error: ['ERR', '#ef4444', 'Ghost GPT — erreur']
    };
    const [text, color, title] = labels[state];
    await chrome.storage.local.set({ lastState: state, lastError: error });
    await chrome.action.setBadgeText({ text: error ? 'ERR' : text });
    await chrome.action.setBadgeBackgroundColor({ color: error ? '#ef4444' : color });
    await chrome.action.setTitle({ title: error ? `Ghost GPT — ${error}` : title });
}

async function exclusive(task) {
    if (operationRunning) return;
    operationRunning = true;
    try {
        await task();
    } catch (error) {
        // A failed copy must remain retryable on the next click.
        const { lastState } = await chrome.storage.local.get('lastState');
        await setState(lastState === 'ready' ? 'ready' : 'error', error.message || String(error));
    } finally {
        operationRunning = false;
    }
}

async function generate(text) {
    const settings = await chrome.storage.local.get(null);
    if (!settings.apiKey?.trim()) throw new Error('Renseignez votre clé API OpenAI dans les options.');
    await setState('busy');
    const clip = text === undefined ? await callOffscreen('read') : { kind: 'text', text };
    const result = await callOffscreen('generate', { settings: {
        apiKey: settings.apiKey.trim(), model: settings.model, prePrompt: settings.prePrompt,
        systemPrompt: settings.systemPrompt, sessionEnabled: settings.sessionEnabled,
        sessionLastResponseId: settings.sessionLastResponseId
    }, clip });
    await chrome.storage.local.set({
        lastAnswer: result.answer,
        sessionLastResponseId: settings.sessionEnabled ? result.responseId : null
    });
    await setState('ready');
}

async function copyLast() {
    const { lastAnswer } = await chrome.storage.local.get('lastAnswer');
    if (!lastAnswer) throw new Error('Aucune réponse à copier.');
    await callOffscreen('write', { text: lastAnswer });
    await setState('idle');
}

chrome.action.onClicked.addListener(() => exclusive(async () => {
    const { lastState } = await chrome.storage.local.get('lastState');
    if (lastState === 'ready') await copyLast();
    else await generate();
}));

async function updateSessionMenu(enabled) {
    await chrome.contextMenus.update('ghostgpt-toggle-session', {
        title: enabled ? 'Désactiver la session (Ghost GPT)' : 'Activer la session (Ghost GPT)'
    });
}

chrome.runtime.onInstalled.addListener(() => exclusive(async () => {
    await chrome.contextMenus.removeAll();
    const { sessionEnabled } = await chrome.storage.local.get('sessionEnabled');
    for (const menu of [
        { id: 'ghostgpt-copy-last', title: 'Copier la dernière réponse (Ghost GPT)', contexts: ['action'] },
        { id: 'ghostgpt-send-selection', title: 'Envoyer la sélection à Ghost GPT', contexts: ['selection'] },
        { id: 'ghostgpt-toggle-session', title: sessionEnabled ? 'Désactiver la session (Ghost GPT)' : 'Activer la session (Ghost GPT)', contexts: ['action'] },
        { id: 'ghostgpt-reset-session', title: 'Nouvelle session (Ghost GPT)', contexts: ['action'] }
    ]) chrome.contextMenus.create(menu);
    const { lastState } = await chrome.storage.local.get('lastState');
    await setState(lastState === 'ready' ? 'ready' : 'idle');
}));

chrome.contextMenus.onClicked.addListener(info => exclusive(async () => {
    if (info.menuItemId === 'ghostgpt-copy-last') await copyLast();
    if (info.menuItemId === 'ghostgpt-send-selection' && info.selectionText?.trim()) await generate(info.selectionText.trim());
    if (info.menuItemId === 'ghostgpt-toggle-session') {
        const { sessionEnabled } = await chrome.storage.local.get('sessionEnabled');
        await chrome.storage.local.set({ sessionEnabled: !sessionEnabled, sessionLastResponseId: null });
        await updateSessionMenu(!sessionEnabled);
        await setState('idle');
    }
    if (info.menuItemId === 'ghostgpt-reset-session') {
        await chrome.storage.local.set({ sessionLastResponseId: null });
        await setState('idle');
    }
}));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || message.target !== 'background') return;
    if (message.action === 'heartbeat') {
        sendResponse({ ok: true });
        return;
    }
    if (!['saveSettings', 'resetSession'].includes(message.action)) return;
    if (operationRunning) {
        sendResponse({ ok: false, error: 'Attendez la fin de la requête avant de modifier la configuration.' });
        return;
    }
    operationRunning = true;
    const update = async () => {
        if (message.action === 'resetSession') {
            await chrome.storage.local.set({ sessionLastResponseId: null });
        } else {
            const { apiKey, model, prePrompt, sessionEnabled } = message.settings;
            const previous = await chrome.storage.local.get(['apiKey', 'model', 'prePrompt', 'sessionEnabled']);
            const changed = previous.apiKey !== apiKey || previous.model !== model ||
                previous.prePrompt !== prePrompt || !!previous.sessionEnabled !== sessionEnabled;
            await chrome.storage.local.set({ apiKey, model, prePrompt, sessionEnabled,
                ...(changed ? { sessionLastResponseId: null } : {}) });
            await updateSessionMenu(sessionEnabled);
        }
        const { lastState } = await chrome.storage.local.get('lastState');
        await setState(lastState === 'ready' ? 'ready' : 'idle');
    };
    update().then(() => sendResponse({ ok: true }), error => sendResponse({ ok: false, error: error.message }))
        .finally(() => { operationRunning = false; });
    return true;
});
