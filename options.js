const $ = id => document.getElementById(id);
const suggestions = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini'];

function populateModels(ids) {
    $('modelSuggestions').replaceChildren(...[...new Set(ids)].sort().map(id => new Option(id, id)));
}

async function load() {
    const data = await chrome.storage.local.get(['apiKey', 'model', 'prePrompt', 'systemPrompt', 'lastError']);
    $('apiKey').value = data.apiKey || '';
    $('model').value = data.model || 'gpt-4o-mini';
    $('prePrompt').value = data.prePrompt ?? data.systemPrompt ?? $('prePrompt').value;
    $('lastError').textContent = data.lastError || 'Aucune erreur.';
    populateModels(suggestions);
}

async function send(action, settings) {
    const response = await chrome.runtime.sendMessage({ target: 'background', action, settings });
    if (!response?.ok) throw new Error(response?.error || 'Extension indisponible. Rechargez-la.');
}

async function withStatus(button, action) {
    button.disabled = true;
    try {
        await action();
    } catch (error) {
        $('status').textContent = error.message;
    } finally {
        button.disabled = false;
    }
}

$('apiKey').addEventListener('input', () => {
    populateModels(suggestions);
    $('modelStatus').textContent = 'Actualisez la liste avec cette clé.';
});
$('refreshModels').addEventListener('click', async () => {
    const key = $('apiKey').value.trim();
    if (!key) { $('modelStatus').textContent = 'Renseignez une clé API pour charger les modèles.'; return; }
    $('refreshModels').disabled = true;
    $('modelStatus').textContent = 'Chargement…';
    try {
        const data = await new OpenAIResponsesClient(key).request('models', null, 20000);
        // Ignore a response for a key that the user has since changed.
        if (key !== $('apiKey').value.trim()) return;
        const ids = (data.data || []).map(item => item.id).filter(id =>
            typeof id === 'string' && /^(gpt-|o[1-9])/.test(id) &&
            !/audio|realtime|transcrib|tts|image|embedding|moderation|instruct/.test(id));
        populateModels(ids);
        $('modelStatus').textContent = `${ids.length} modèles candidats. Les modèles spécialisés audio et génération d’images sont filtrés. Enregistrez pour appliquer votre choix.`;
    } catch (error) {
        $('modelStatus').textContent = error.message;
    } finally {
        $('refreshModels').disabled = false;
    }
});
$('save').addEventListener('click', () => withStatus($('save'), async () => {
    await send('saveSettings', {
        apiKey: $('apiKey').value.trim(), model: $('model').value.trim() || 'gpt-4o-mini',
        prePrompt: $('prePrompt').value
    });
    $('status').textContent = 'Configuration enregistrée.';
}));
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.lastError) $('lastError').textContent = changes.lastError.newValue || 'Aucune erreur.';
});
load().catch(error => { $('status').textContent = error.message; });
