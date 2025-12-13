const $ = (id) => document.getElementById(id);

async function load() {
    const data = await chrome.storage.local.get([
        "apiKey",
        "model",
        "prePrompt"
    ]);

    $("apiKey").value = data.apiKey || "";
    $("model").value = data.model || "gpt-4o-mini";
    $("prePrompt").value = data.prePrompt || $("prePrompt").value;
}

async function save() {
    const apiKey = $("apiKey").value.trim();
    const model = $("model").value.trim() || "gpt-4o-mini";
    const prePrompt = $("prePrompt").value || "";

    await chrome.storage.local.set({
        apiKey,
        model,
        prePrompt
    });

    $("status").textContent = "Enregistré";
    setTimeout(() => ($("status").textContent = ""), 1200);
}

$("save").addEventListener("click", save);
load();
