function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Impossible de lire l’image copiée.'));
        reader.readAsDataURL(blob);
    });
}

async function readClipboard() {
    // execCommand is needed here because an offscreen document cannot gain focus
    // for navigator.clipboard.read(). Only use clipboardData, never pasted HTML.
    const target = document.getElementById('paste');
    let image = null;
    let text = '';
    let received = false;
    const onPaste = (event) => {
        event.preventDefault();
        received = true;
        text = event.clipboardData.getData('text/plain');
        const item = Array.from(event.clipboardData.items).find(item => item.type.startsWith('image/'));
        image = item?.getAsFile();
    };
    target.textContent = '';
    target.addEventListener('paste', onPaste);
    target.focus();
    try {
        document.execCommand('paste');
    } finally {
        target.removeEventListener('paste', onPaste);
        target.textContent = '';
    }
    if (!received) throw new Error('Lecture du presse-papiers refusée. Vérifiez les autorisations de l’extension.');
    if (image) {
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.type)) {
            throw new Error('Format d’image non pris en charge. Copiez une capture PNG ou une image JPEG/WebP/GIF.');
        }
        return { kind: 'image', dataUrl: await blobToDataUrl(image) };
    }
    return text.trim() ? { kind: 'text', text } : { kind: 'empty' };
}

function writeClipboard(text) {
    const target = document.getElementById('copy');
    target.value = text;
    target.focus();
    target.select();
    try {
        if (!document.execCommand('copy')) throw new Error('Copie refusée. La réponse reste disponible via le menu de l’extension.');
    } finally {
        target.value = '';
    }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || message.target !== 'offscreen') return;
    const run = async () => {
        if (message.action === 'read') return await readClipboard();
        if (message.action === 'write') return writeClipboard(message.text);
        if (message.action === 'generate') {
            // Messages keep the worker handling this operation alive while the
            // network request runs in this document (not in the service worker).
            const heartbeat = setInterval(() => {
                chrome.runtime.sendMessage({ target: 'background', action: 'heartbeat' }).catch(() => {});
            }, 20000);
            try {
                return await new OpenAIResponsesClient(message.settings.apiKey).generate(message.settings, message.clip);
            } finally {
                clearInterval(heartbeat);
            }
        }
        throw new Error('Opération inconnue.');
    };
    run().then(result => sendResponse({ ok: true, result }), error => sendResponse({ ok: false, error: error.message }));
    return true;
});
