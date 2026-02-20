const defaults = {
  apiKey: "",
  geminiApiKey: "",
  apiBaseUrl: "https://api.openai.com/v1/chat/completions",
  model: "gpt-5.1",
  temperature: 0.2,
  geminiThinkingLevel: "high",
  batchSize: 8,
  prefetchAhead: 8,
  smoothLines: 3,
  hideTranslationTimestamp: false,
  originalColorScheme: "dark",
  translationColorScheme: "dark",
};

const apiKeyInput = document.getElementById("apiKey");
const geminiApiKeyInput = document.getElementById("geminiApiKey");
const apiBaseInput = document.getElementById("apiBaseUrl");
const modelInput = document.getElementById("model");
const temperatureInput = document.getElementById("temperature");
const geminiThinkingLevelSelect = document.getElementById("geminiThinkingLevel");
const batchSizeInput = document.getElementById("batchSize");
const prefetchAheadInput = document.getElementById("prefetchAhead");
const smoothLinesInput = document.getElementById("smoothLines");
const hideTranslationTimestampInput = document.getElementById("hideTranslationTimestamp");
const originalColorSelect = document.getElementById("originalColorScheme");
const translationColorSelect = document.getElementById("translationColorScheme");
const statusEl = document.getElementById("status");
const modelNoteEl = document.getElementById("modelNote");
const saveBtn = document.getElementById("saveBtn");

const MODEL_PRICE = {
  "gpt-4.1-mini": "$0.4 / 1M",
  "gpt-4o-mini": "$0.15 / 1M",
  "gpt-4.1": "$2 / 1M",
  "gpt-5.2": "TBD",
  "gpt-5.1": "$1.25 / 1M",
  "gemini-3-flash-preview": "in: $0.50 / out: $3 per 1M",
};

init();

async function init() {
  const stored = await chrome.storage.local.get(defaults);
  apiKeyInput.value = stored.apiKey || "";
  geminiApiKeyInput.value = stored.geminiApiKey || "";
  apiBaseInput.value = stored.apiBaseUrl || defaults.apiBaseUrl;
  modelInput.value = stored.model || defaults.model;
  temperatureInput.value = stored.temperature ?? defaults.temperature;
  geminiThinkingLevelSelect.value = normalizeGeminiThinkingLevel(
    stored.geminiThinkingLevel,
    defaults.geminiThinkingLevel
  );
  syncTemperatureLock();
  syncGeminiThinkingLock();
  updateModelNote();
  const prefetch = stored.prefetchAhead ?? defaults.prefetchAhead;
  prefetchAheadInput.value = prefetch;
  batchSizeInput.value = prefetch;
  batchSizeInput.disabled = true;
  const smooth = stored.smoothLines ?? defaults.smoothLines;
  smoothLinesInput.value = smooth;
  hideTranslationTimestampInput.checked =
    !!(stored.hideTranslationTimestamp ?? defaults.hideTranslationTimestamp);
  originalColorSelect.value = stored.originalColorScheme || defaults.originalColorScheme;
  translationColorSelect.value =
    stored.translationColorScheme || defaults.translationColorScheme;
}

modelInput.addEventListener("change", () => {
  syncTemperatureLock();
  syncGeminiThinkingLock();
  updateModelNote();
});

saveBtn.addEventListener("click", async () => {
  const apiKey = apiKeyInput.value.trim();
  const geminiApiKey = geminiApiKeyInput.value.trim();
  const apiBaseUrl = apiBaseInput.value.trim() || defaults.apiBaseUrl;
  const model = modelInput.value.trim() || defaults.model;
  const temperature = clampFloat(temperatureInput.value, 0, 1, defaults.temperature);
  const finalTemperature = temperature;
  const geminiThinkingLevel = normalizeGeminiThinkingLevel(
    geminiThinkingLevelSelect.value,
    defaults.geminiThinkingLevel
  );
  const prefetchAhead = clampInt(prefetchAheadInput.value, 1, 20, defaults.prefetchAhead);
  const batchSize = prefetchAhead; // batch size follows segment size
  const smoothLines = clampInt(
    Math.min(prefetchAhead, smoothLinesInput.value),
    1,
    prefetchAhead,
    defaults.smoothLines
  );
  const hideTranslationTimestamp = !!hideTranslationTimestampInput.checked;
  const originalColorScheme = originalColorSelect.value === "green" ? "green" : "dark";
  const translationColorScheme =
    translationColorSelect.value === "green" ? "green" : "dark";

  await chrome.storage.local.set({
    apiKey,
    apiBaseUrl,
    model,
    geminiApiKey,
    temperature: finalTemperature,
    geminiThinkingLevel,
    batchSize,
    prefetchAhead,
    smoothLines,
    hideTranslationTimestamp,
    originalColorScheme,
    translationColorScheme,
  });
  statusEl.textContent =
    "已保存，返回播放页后字幕会自动刷新。";
  statusEl.style.color = "#0c713a";
  setTimeout(() => (statusEl.textContent = ""), 2500);
});

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampFloat(value, min, max, fallback) {
  const n = parseFloat(value);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function syncTemperatureLock() {
  temperatureInput.disabled = false;
}

function syncGeminiThinkingLock() {
  if (!geminiThinkingLevelSelect) return;
  const isGemini = isGeminiModel(modelInput.value);
  geminiThinkingLevelSelect.disabled = !isGemini;
}

function updateModelNote() {
  if (!modelNoteEl) return;
  const price = MODEL_PRICE[modelInput.value] || "";
  modelNoteEl.textContent = price ? `费用：${price}` : "";
}

function normalizeGeminiThinkingLevel(value, fallback) {
  const allowed = ["minimal", "low", "medium", "high"];
  const lower = (value || "").toLowerCase();
  return allowed.includes(lower) ? lower : fallback;
}

function isGeminiModel(model = "") {
  return (model || "").toLowerCase().includes("gemini");
}
