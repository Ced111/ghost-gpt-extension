const $ = (id) => document.getElementById(id);

async function load() {
    const data = await chrome.storage.local.get([
        "apiKey",
        "model",
        "systemPrompt",
        "imagePrompt",
        "textPrompt"
    ]);

    $("apiKey").value = data.apiKey || "";
    $("model").value = data.model || "gpt-4o-mini";
    $("systemPrompt").value = data.systemPrompt || $("systemPrompt").value;
    $("imagePrompt").value = data.imagePrompt || $("imagePrompt").value;
    $("textPrompt").value = data.textPrompt || $("textPrompt").value;
}

async function save() {
    const apiKey = $("apiKey").value.trim();
    const model = $("model").value.trim() || "gpt-4o-mini";

    await chrome.storage.local.set({
        apiKey,
        model,
        systemPrompt: $("systemPrompt").value,
        imagePrompt: $("imagePrompt").value,
        textPrompt: $("textPrompt").value
    });

    $("status").textContent = "✅ Enregistré";
    setTimeout(() => ($("status").textContent = ""), 1200);
}

$("save").addEventListener("click", save);
load();
