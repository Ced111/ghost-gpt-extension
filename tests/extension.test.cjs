const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

function api(fetch) {
    const scope = vm.createContext({ fetch, AbortController, setTimeout, clearTimeout });
    vm.runInContext(source('api.js'), scope);
    return vm.runInContext('new OpenAIResponsesClient("test-key")', scope);
}
const clip = { kind: 'text', text: 'Bonjour' };

test('modern models omit temperature, legacy models preserve it and sessions keep their prompt', () => {
    const client = api();
    const first = client.buildBody({ model: 'gpt-6.1-sol', prePrompt: 'Consigne', sessionEnabled: true }, clip);
    assert.equal(first.temperature, undefined);
    assert.equal(first.input[0].content, 'Consigne');
    const next = client.buildBody({ model: 'gpt-4o-mini', prePrompt: 'Consigne', sessionEnabled: true, sessionLastResponseId: 'resp_1' }, clip);
    assert.equal(next.temperature, 0);
    assert.equal(next.previous_response_id, 'resp_1');
    assert.equal(next.input.length, 1);
    const off = client.buildBody({ sessionEnabled: false, sessionLastResponseId: 'resp_old', systemPrompt: 'Ancienne consigne' }, clip);
    assert.equal(off.previous_response_id, undefined);
    assert.equal(off.input[0].content, 'Ancienne consigne');
    assert.equal(client.buildBody({ prePrompt: '' }, clip).input.length, 1);
});

test('image requests use input_image and text output is extracted', async () => {
    let sent;
    const client = api(async (url, request) => {
        sent = JSON.parse(request.body);
        return { ok: true, json: async () => ({ id: 'resp_1', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Résultat' }] }] }) };
    });
    const result = await client.generate({}, { kind: 'image', dataUrl: 'data:image/png;base64,AAAA' });
    assert.equal(sent.input.at(-1).content[0].type, 'input_image');
    assert.equal(result.answer, 'Résultat');
    assert.equal(result.responseId, 'resp_1');
});

test('HTTP failures and incomplete responses remain errors, never successful JSON answers', async () => {
    for (const status of [401, 403, 404, 429, 500]) {
        const client = api(async () => ({ ok: false, status, json: async () => ({ error: { message: 'Detail' } }) }));
        await assert.rejects(client.generate({}, clip), new RegExp(`${status}.*Detail`));
    }
    const client = api(async () => ({ ok: true, json: async () => ({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }) }));
    await assert.rejects(client.generate({}, clip), /max_output_tokens/);
});

function extension() {
    const state = { apiKey: 'test-key', model: 'gpt-6.1-sol', prePrompt: 'Consigne', sessionEnabled: true };
    const listeners = {};
    let clipboard = 'Question';
    let writesFail = false;
    let posts = 0;
    let fetchError = false;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const chrome = {
        runtime: {
            id: 'extension-test', getURL: name => `chrome-extension://extension-test/${name}`,
            getContexts: async () => [{ contextType: 'OFFSCREEN_DOCUMENT' }],
            onInstalled: { addListener: fn => { listeners.installed = fn; } },
            onMessage: { addListener: fn => { listeners.message = fn; } },
            sendMessage: async message => {
                if (message.action === 'read') return { ok: true, result: clipboard ? { kind: 'text', text: clipboard } : { kind: 'empty' } };
                if (message.action === 'write') {
                    if (writesFail) return { ok: false, error: 'Copie refusée' };
                    clipboard = message.text; return { ok: true };
                }
                if (message.action === 'generate') {
                    posts++;
                    await gate;
                    if (fetchError) return { ok: false, error: 'OpenAI 401 — clé invalide' };
                    return { ok: true, result: { answer: 'Réponse', responseId: 'resp_1' } };
                }
            }
        },
        storage: { local: { get: async keys => keys === null ? { ...state } : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, state[k]])), set: async values => { Object.assign(state, values); } } },
        action: { onClicked: { addListener: fn => { listeners.click = fn; } }, setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
        contextMenus: { onClicked: { addListener: fn => { listeners.menu = fn; } }, update: async () => {}, removeAll: async () => {}, create: () => {} }
    };
    const scope = vm.createContext({ chrome });
    vm.runInContext(source('background.js'), scope);
    const message = body => new Promise(resolve => listeners.message({ target: 'background', ...body }, { id: chrome.runtime.id }, resolve));
    return { state, listeners, message, release, get posts() { return posts; }, get clipboard() { return clipboard; }, failCopy(value) { writesFail = value; }, failAPI() { fetchError = true; } };
}

test('first click sends once, concurrent click is ignored, second click copies; failed copy can be retried', async () => {
    const app = extension();
    const request = app.listeners.click();
    await app.listeners.click();
    const blocked = await app.message({ action: 'resetSession' });
    assert.equal(blocked.ok, false);
    app.release(); await request;
    assert.equal(app.posts, 1);
    assert.equal(app.state.lastState, 'ready');
    assert.equal(app.state.sessionLastResponseId, 'resp_1');
    app.failCopy(true); await app.listeners.click();
    assert.equal(app.state.lastState, 'ready');
    assert.match(app.state.lastError, /Copie refusée/);
    app.failCopy(false); await app.listeners.click();
    assert.equal(app.clipboard, 'Réponse');
    assert.equal(app.state.lastState, 'idle');
    assert.equal(app.posts, 1);
});

test('API error is displayed and a later click can retry', async () => {
    const app = extension(); app.failAPI(); app.release();
    await app.listeners.click();
    assert.equal(app.state.lastState, 'error');
    assert.match(app.state.lastError, /401/);
    assert.equal(app.state.sessionLastResponseId, undefined);
    await app.listeners.click();
    assert.equal(app.posts, 2);
});

test('settings migration and new session preserve saved answers', async () => {
    const app = extension(); app.release(); await app.listeners.click();
    const answer = app.state.lastAnswer;
    const result = await app.message({ action: 'saveSettings', settings: { apiKey: 'test-key', model: 'gpt-4.1', prePrompt: '', sessionEnabled: true } });
    assert.equal(result.ok, true);
    assert.equal(app.state.sessionLastResponseId, null);
    assert.equal(app.state.prePrompt, '');
    assert.equal(app.state.lastAnswer, answer);
    assert.equal(app.state.lastState, 'ready');
});

test('offscreen clipboard uses paste event data, prevents HTML insertion and clears temporary text', async () => {
    let pasteListener;
    let prevented = false;
    const paste = { textContent: '', focus() {}, addEventListener(event, fn) { pasteListener = fn; }, removeEventListener() {} };
    const copy = { value: '', focus() {}, select() {} };
    const document = { getElementById: id => id === 'paste' ? paste : copy,
        execCommand(command) {
            if (command === 'paste') pasteListener({ preventDefault() { prevented = true; }, clipboardData: { getData: () => 'Texte copié', items: [] } });
            return true;
        }
    };
    const scope = vm.createContext({ document, chrome: { runtime: { onMessage: { addListener() {} } } } });
    vm.runInContext(source('offscreen.js'), scope);
    const result = await vm.runInContext('readClipboard()', scope);
    assert.equal(result.text, 'Texte copié'); assert.equal(prevented, true);
    vm.runInContext('writeClipboard("Réponse")', scope);
    assert.equal(copy.value, '');
});
