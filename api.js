// Shared by the options page and the offscreen document.
class OpenAIResponsesClient {
    constructor(apiKey) {
        this.apiKey = apiKey;
    }

    async request(path, body, timeoutMs = 180000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(`https://api.openai.com/v1/${path}`, {
                method: body ? 'POST' : 'GET',
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: body ? JSON.stringify(body) : undefined,
                signal: controller.signal
            });
            const data = await response.json().catch(() => null);
            if (!response.ok) {
                const hints = {
                    401: 'Clé API invalide ou expirée.',
                    403: 'Accès refusé à ce modèle ou à ce projet.',
                    404: 'Modèle ou session introuvable. Vérifiez le modèle ou démarrez une nouvelle session.',
                    429: 'Quota, crédits ou limite de requêtes atteints.'
                };
                const detail = data?.error?.message || response.statusText;
                throw new Error(`OpenAI ${response.status} — ${hints[response.status] || 'Requête refusée.'} ${detail}`);
            }
            if (!data) throw new Error('Réponse OpenAI illisible.');
            return data;
        } catch (error) {
            if (error.name === 'AbortError') {
                throw new Error('Délai dépassé. La requête a été interrompue après 3 minutes.');
            }
            if (error instanceof TypeError) throw new Error('Connexion à OpenAI impossible. Vérifiez votre réseau.');
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    buildBody(settings, clip) {
        const model = settings.model?.trim() || 'gpt-4o-mini';
        const previousId = settings.sessionEnabled ? settings.sessionLastResponseId : null;
        const prompt = settings.prePrompt ?? settings.systemPrompt ?? 'Tu es un assistant concis.';
        const input = [];
        if (!previousId && prompt.trim()) input.push({ role: 'developer', content: prompt.trim() });
        const content = clip.kind === 'image'
            ? [{ type: 'input_image', image_url: clip.dataUrl }]
            : [{ type: 'input_text', text: clip.text }];
        input.push({ role: 'user', content });
        const body = { model, input, store: true };
        // Keep the old deterministic setting only for known compatible families.
        if (/^gpt-4(?:o|\.1)(?:-|$)/.test(model)) body.temperature = 0;
        if (previousId) body.previous_response_id = previousId;
        return body;
    }

    async generate(settings, clip) {
        if (!clip || clip.kind === 'empty') throw new Error('Le presse-papiers est vide. Copiez du texte ou une image.');
        const response = await this.request('responses', this.buildBody(settings, clip));
        if (response.error || (response.status && response.status !== 'completed')) {
            throw new Error(response.error?.message || `Réponse ${response.status} — ${response.incomplete_details?.reason || 'aucun résultat complet'}.`);
        }
        const parts = [];
        for (const output of response.output || []) {
            for (const item of output.content || []) {
                if (item.type === 'output_text' && item.text) parts.push(item.text);
                if (item.type === 'refusal' && item.refusal) parts.push(item.refusal);
            }
        }
        const answer = (response.output_text || parts.join('\n')).trim();
        if (!answer) throw new Error('Le modèle n’a renvoyé aucun texte. Choisissez un modèle compatible avec Responses.');
        return { answer, responseId: response.id || null };
    }
}
