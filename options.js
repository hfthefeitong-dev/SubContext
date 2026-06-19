const defaults = {
  apiKey: "",
  geminiApiKey: "",
  deepseekApiKey: "",
  apiBaseUrl: "https://api.openai.com/v1/chat/completions",
  model: "gpt-5.1",
  temperature: 0.2,
  geminiThinkingLevel: "minimal",
  batchSize: 8,
  prefetchAhead: 8,
  smoothLines: 3,
  enableSourceCorrections: false,
  hideTranslationTimestamp: false,
  limitDisplayLines: false,
  displayLineLimit: 1,
  originalColorScheme: "dark",
  translationColorScheme: "dark",
  theme: "auto",
};

const apiKeyInput = document.getElementById("apiKey");
const geminiApiKeyInput = document.getElementById("geminiApiKey");
const deepseekApiKeyInput = document.getElementById("deepseekApiKey");
const apiBaseInput = document.getElementById("apiBaseUrl");
const modelInput = document.getElementById("model");
const temperatureInput = document.getElementById("temperature");
const geminiThinkingLevelSelect = document.getElementById("geminiThinkingLevel");
const thinkingLevelLabel = document.getElementById("thinkingLevelLabel");
const thinkingLevelHelp = document.getElementById("thinkingLevelHelp");
const batchSizeInput = document.getElementById("batchSize");
const prefetchAheadInput = document.getElementById("prefetchAhead");
const smoothLinesInput = document.getElementById("smoothLines");
const enableSourceCorrectionsInput = document.getElementById("enableSourceCorrections");
const hideTranslationTimestampInput = document.getElementById("hideTranslationTimestamp");
const limitDisplayLinesInput = document.getElementById("limitDisplayLines");
const displayLineLimitInput = document.getElementById("displayLineLimit");
const originalColorSelect = document.getElementById("originalColorScheme");
const translationColorSelect = document.getElementById("translationColorScheme");
const statusEl = document.getElementById("status");
const modelNoteEl = document.getElementById("modelNote");
const saveBtn = document.getElementById("saveBtn");
const themeToggleBtn = document.getElementById("themeToggle");

const MODEL_PRICE = {
  "gpt-4.1-mini": "$0.4 / 1M",
  "gpt-4o-mini": "$0.15 / 1M",
  "gpt-4.1": "$2 / 1M",
  "gpt-5.2": "TBD",
  "gpt-5.1": "$1.25 / 1M",
  "gemini-3-flash-preview": "in: $0.50 / out: $3 per 1M",
  "deepseek-v4-flash": "in: $0.14 / out: $0.28 per 1M",
  "deepseek-v4-pro": "in: $0.435 / out: $0.87 per 1M",
};

const GEMINI_THINKING_OPTIONS = [
  ["minimal", "minimal - 最低延迟/成本 (默认)"],
  ["low", "low - 较低思考，快"],
  ["medium", "medium - 均衡"],
  ["high", "high - 深度"],
];

const DEEPSEEK_THINKING_OPTIONS = [
  ["disabled", "disabled - 关闭思考模式"],
  ["high", "high - 标准思考 (默认)"],
  ["max", "max - 最高思考强度"],
];

let currentTheme = "auto";

init();

async function init() {
  const stored = await chrome.storage.local.get(defaults);
  
  // Theme initialization
  applyTheme(stored.theme || "auto");

  apiKeyInput.value = stored.apiKey || "";
  geminiApiKeyInput.value = stored.geminiApiKey || "";
  deepseekApiKeyInput.value = stored.deepseekApiKey || "";
  apiBaseInput.value = stored.apiBaseUrl || defaults.apiBaseUrl;
  modelInput.value = stored.model || defaults.model;
  syncApiBaseUrlForModel();
  temperatureInput.value = stored.temperature ?? defaults.temperature;
  
  syncTemperatureLock();
  syncThinkingLevelControl(stored.geminiThinkingLevel);
  updateModelNote();
  
  const prefetch = stored.prefetchAhead ?? defaults.prefetchAhead;
  prefetchAheadInput.value = prefetch;
  
  const smooth = stored.smoothLines ?? defaults.smoothLines;
  smoothLinesInput.value = smooth;
  
  syncSegmentControls();
  
  enableSourceCorrectionsInput.checked =
    !!(stored.enableSourceCorrections ?? defaults.enableSourceCorrections);
  hideTranslationTimestampInput.checked =
    !!(stored.hideTranslationTimestamp ?? defaults.hideTranslationTimestamp);
  limitDisplayLinesInput.checked =
    !!(stored.limitDisplayLines ?? defaults.limitDisplayLines);
  
  displayLineLimitInput.value = clampInt(
    stored.displayLineLimit,
    1,
    3,
    defaults.displayLineLimit
  );
  
  syncDisplayLineLimitControl();
  originalColorSelect.value = stored.originalColorScheme || defaults.originalColorScheme;
  translationColorSelect.value =
    stored.translationColorScheme || defaults.translationColorScheme;

  // Initialize display badge for temperature
  const tempValEl = document.getElementById("temperatureVal");
  if (tempValEl) tempValEl.textContent = temperatureInput.value;

  // Setup UI tabs, passwords visibility, and sliders
  setupInteractiveUI();
}

// Set up UI navigation tabs, passwords visibility, and sliders listeners
function setupInteractiveUI() {
  // 1. Sidebar navigation tab switching
  const navItems = document.querySelectorAll(".nav-item");
  const tabPanes = document.querySelectorAll(".tab-pane");

  navItems.forEach(item => {
    item.addEventListener("click", () => {
      const targetTab = item.getAttribute("data-tab");
      
      navItems.forEach(nav => nav.classList.remove("active"));
      tabPanes.forEach(pane => pane.classList.remove("active"));

      item.classList.add("active");
      const targetEl = document.getElementById(targetTab);
      if (targetEl) targetEl.classList.add("active");
    });
  });

  // 2. Password visibility toggles
  document.querySelectorAll(".password-toggle").forEach(btn => {
    btn.addEventListener("click", () => {
      const targetId = btn.getAttribute("data-target");
      const input = document.getElementById(targetId);
      if (!input) return;
      if (input.type === "password") {
        input.type = "text";
        btn.textContent = "🙈";
      } else {
        input.type = "password";
        btn.textContent = "👁️";
      }
    });
  });

  // 3. Theme Toggle button listener
  if (themeToggleBtn) {
    themeToggleBtn.addEventListener("click", async () => {
      let nextTheme = "auto";
      if (currentTheme === "auto") {
        nextTheme = "light";
      } else if (currentTheme === "light") {
        nextTheme = "dark";
      } else {
        nextTheme = "auto";
      }
      applyTheme(nextTheme);
      await chrome.storage.local.set({ theme: nextTheme });
    });
  }
}

// Theme applier function
function applyTheme(theme) {
  currentTheme = theme;
  const root = document.documentElement;
  if (theme === "dark") {
    root.setAttribute("data-theme", "dark");
  } else if (theme === "light") {
    root.setAttribute("data-theme", "light");
  } else {
    root.removeAttribute("data-theme");
  }
  
  if (themeToggleBtn) {
    const textEl = themeToggleBtn.querySelector(".theme-text");
    const iconEl = themeToggleBtn.querySelector(".theme-icon");
    if (theme === "dark") {
      if (textEl) textEl.textContent = "深色外观";
      if (iconEl) iconEl.textContent = "🌙";
    } else if (theme === "light") {
      if (textEl) textEl.textContent = "浅色外观";
      if (iconEl) iconEl.textContent = "🌞";
    } else {
      if (textEl) textEl.textContent = "自动主题";
      if (iconEl) iconEl.textContent = "🌓";
    }
  }
}

modelInput.addEventListener("change", () => {
  syncApiBaseUrlForModel();
  syncTemperatureLock();
  syncThinkingLevelControl(geminiThinkingLevelSelect.value);
  updateModelNote();
});

temperatureInput.addEventListener("input", () => {
  const tempValEl = document.getElementById("temperatureVal");
  if (tempValEl) tempValEl.textContent = temperatureInput.value;
});

prefetchAheadInput.addEventListener("input", () => {
  syncSegmentControls();
});

smoothLinesInput.addEventListener("input", () => {
  syncSegmentControls();
});

limitDisplayLinesInput.addEventListener("change", () => {
  syncDisplayLineLimitControl();
});

displayLineLimitInput.addEventListener("input", () => {
  syncDisplayLineLimitControl();
});

saveBtn.addEventListener("click", async () => {
  const apiKey = apiKeyInput.value.trim();
  const geminiApiKey = geminiApiKeyInput.value.trim();
  const deepseekApiKey = deepseekApiKeyInput.value.trim();
  const apiBaseUrl = apiBaseInput.value.trim() || defaults.apiBaseUrl;
  const model = modelInput.value.trim() || defaults.model;
  const temperature = clampFloat(temperatureInput.value, 0, 1, defaults.temperature);
  const finalTemperature = temperature;
  const geminiThinkingLevel = normalizeThinkingLevelForModel(
    geminiThinkingLevelSelect.value,
    model,
    defaults.geminiThinkingLevel
  );
  const prefetchAhead = clampInt(prefetchAheadInput.value, 0, 20, defaults.prefetchAhead);
  const batchSize = prefetchAhead; // batch size follows segment size
  const smoothLines =
    prefetchAhead <= 0
      ? 0
      : clampInt(
          Math.min(prefetchAhead, smoothLinesInput.value),
          0,
          prefetchAhead,
          defaults.smoothLines
        );
  const enableSourceCorrections = !!enableSourceCorrectionsInput.checked;
  const hideTranslationTimestamp = !!hideTranslationTimestampInput.checked;
  const limitDisplayLines = !!limitDisplayLinesInput.checked;
  const displayLineLimit = clampInt(
    displayLineLimitInput.value,
    1,
    3,
    defaults.displayLineLimit
  );
  const originalColorScheme = originalColorSelect.value === "green" ? "green" : "dark";
  const translationColorScheme =
    translationColorSelect.value === "green" ? "green" : "dark";

  if (isGeminiModel(model) && !geminiApiKey) {
    statusEl.textContent = "⚠️ 使用 Gemini 模型时必须填写 Gemini API Key。";
    statusEl.style.color = "var(--danger)";
    return;
  }

  if (isDeepSeekModel(model) && !deepseekApiKey) {
    statusEl.textContent = "⚠️ 使用 DeepSeek 模型时必须填写 DeepSeek API Key。";
    statusEl.style.color = "var(--danger)";
    return;
  }

  await chrome.storage.local.set({
    apiKey,
    apiBaseUrl,
    model,
    geminiApiKey,
    deepseekApiKey,
    temperature: finalTemperature,
    geminiThinkingLevel,
    batchSize,
    prefetchAhead,
    smoothLines,
    enableSourceCorrections,
    hideTranslationTimestamp,
    limitDisplayLines,
    displayLineLimit,
    originalColorScheme,
    translationColorScheme,
  });
  statusEl.textContent =
    "✨ 已保存，返回播放页后字幕会自动刷新。";
  statusEl.style.color = "var(--success)";
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

function syncSegmentControls() {
  const prefetchAhead = clampInt(
    prefetchAheadInput.value,
    0,
    20,
    defaults.prefetchAhead
  );
  batchSizeInput.value = prefetchAhead;
  batchSizeInput.disabled = true;
  smoothLinesInput.max = String(Math.max(0, prefetchAhead));
  
  // Update badge values
  const prefetchValEl = document.getElementById("prefetchAheadVal");
  if (prefetchValEl) prefetchValEl.textContent = prefetchAhead;

  if (prefetchAhead <= 0) {
    smoothLinesInput.value = "0";
    smoothLinesInput.disabled = true;
    const smoothValEl = document.getElementById("smoothLinesVal");
    if (smoothValEl) smoothValEl.textContent = "0";
    return;
  }
  smoothLinesInput.disabled = false;
  smoothLinesInput.value = String(
    clampInt(smoothLinesInput.value, 0, prefetchAhead, defaults.smoothLines)
  );
  const smoothValEl = document.getElementById("smoothLinesVal");
  if (smoothValEl) smoothValEl.textContent = smoothLinesInput.value;
}

function syncDisplayLineLimitControl() {
  const isChecked = limitDisplayLinesInput.checked;
  displayLineLimitInput.disabled = !isChecked;
  
  const row = document.getElementById("displayLineLimitRow");
  if (row) {
    row.style.opacity = isChecked ? "1" : "0.5";
    row.style.pointerEvents = isChecked ? "auto" : "none";
  }
  
  displayLineLimitInput.value = String(
    clampInt(displayLineLimitInput.value, 1, 3, defaults.displayLineLimit)
  );
  const valEl = document.getElementById("displayLineLimitVal");
  if (valEl) valEl.textContent = displayLineLimitInput.value;
}

function syncTemperatureLock() {
  temperatureInput.disabled = false;
}

function syncThinkingLevelControl(preferredValue) {
  if (!geminiThinkingLevelSelect) return;
  const isGemini = isGeminiModel(modelInput.value);
  const isDeepSeek = isDeepSeekModel(modelInput.value);

  if (isGemini) {
    setThinkingOptions(GEMINI_THINKING_OPTIONS);
    geminiThinkingLevelSelect.value = normalizeGeminiThinkingLevel(
      preferredValue,
      defaults.geminiThinkingLevel
    );
    geminiThinkingLevelSelect.disabled = false;
    if (thinkingLevelLabel) {
      thinkingLevelLabel.textContent = "Gemini 思考深度 (Thinking Level)";
    }
    if (thinkingLevelHelp) {
      thinkingLevelHelp.textContent =
        "仅针对 gemini-3-flash-preview 开启思考模型，非 Gemini 模型时会自动禁用。";
    }
    return;
  }

  if (isDeepSeek) {
    setThinkingOptions(DEEPSEEK_THINKING_OPTIONS);
    geminiThinkingLevelSelect.value = normalizeDeepSeekThinkingLevel(
      preferredValue,
      "high"
    );
    geminiThinkingLevelSelect.disabled = false;
    if (thinkingLevelLabel) {
      thinkingLevelLabel.textContent = "DeepSeek 思考深度 (Thinking Mode)";
    }
    if (thinkingLevelHelp) {
      thinkingLevelHelp.textContent =
        "DeepSeek 默认开启思考模式；high 为标准强度，max 为最高强度，disabled 会关闭思考。";
    }
    return;
  }

  setThinkingOptions(GEMINI_THINKING_OPTIONS);
  geminiThinkingLevelSelect.value = defaults.geminiThinkingLevel;
  geminiThinkingLevelSelect.disabled = true;
  if (thinkingLevelLabel) {
    thinkingLevelLabel.textContent = "思考深度 (Thinking Level)";
  }
  if (thinkingLevelHelp) {
    thinkingLevelHelp.textContent =
      "仅 Gemini 与 DeepSeek 模型支持此设置，其他模型会自动禁用。";
  }
}

function setThinkingOptions(options) {
  const currentOptions = Array.from(geminiThinkingLevelSelect.options).map(
    (option) => `${option.value}:${option.textContent}`
  );
  const nextOptions = options.map(([value, label]) => `${value}:${label}`);
  if (currentOptions.join("|") === nextOptions.join("|")) return;
  geminiThinkingLevelSelect.replaceChildren(
    ...options.map(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      return option;
    })
  );
}

function updateModelNote() {
  if (!modelNoteEl) return;
  const price = MODEL_PRICE[modelInput.value] || "";
  modelNoteEl.textContent = price ? `费用：${price}` : "";
}

function syncApiBaseUrlForModel() {
  if (!apiBaseInput) return;
  const current = (apiBaseInput.value || "").trim();
  const nextDefault = isDeepSeekModel(modelInput.value)
    ? "https://api.deepseek.com/chat/completions"
    : defaults.apiBaseUrl;
  if (!current || isKnownProviderEndpoint(current)) {
    apiBaseInput.value = nextDefault;
  }
  apiBaseInput.placeholder = nextDefault;
}

function normalizeGeminiThinkingLevel(value, fallback) {
  const allowed = ["minimal", "low", "medium", "high"];
  const lower = (value || "").toLowerCase();
  return allowed.includes(lower) ? lower : fallback;
}

function normalizeDeepSeekThinkingLevel(value, fallback) {
  const aliases = {
    off: "disabled",
    none: "disabled",
    minimal: "high",
    low: "high",
    medium: "high",
    xhigh: "max",
  };
  const lower = (value || "").toLowerCase();
  const normalized = aliases[lower] || lower;
  return ["disabled", "high", "max"].includes(normalized)
    ? normalized
    : fallback;
}

function normalizeThinkingLevelForModel(value, model, fallback) {
  if (isDeepSeekModel(model)) {
    return normalizeDeepSeekThinkingLevel(value, "high");
  }
  return normalizeGeminiThinkingLevel(value, fallback);
}

function isGeminiModel(model = "") {
  return (model || "").toLowerCase().includes("gemini");
}

function isDeepSeekModel(model = "") {
  return (model || "").toLowerCase().includes("deepseek");
}

function isKnownProviderEndpoint(url = "") {
  const normalized = String(url || "").trim().replace(/\/+$/, "");
  return [
    "https://api.openai.com/v1/chat/completions",
    "https://api.deepseek.com/chat/completions",
    "https://api.deepseek.com/v1/chat/completions",
  ].includes(normalized);
}
