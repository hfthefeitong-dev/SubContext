const DEFAULT_MODEL = "gpt-5.1";
const DEFAULT_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const DEFAULT_CONTEXT_LINES = 8; // user-defined "segment" length (lines)
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_SMOOTH_LINES = 3;
const DEFAULT_GEMINI_THINKING_LEVEL = "high";

const recentSegments = [];
const recentTranslations = [];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "translate") {
    if (Array.isArray(message.segments)) {
      logTranslateBatch(message.segments);
      translateBatch(message.segments, message.context)
        .then((translation) => sendResponse({ ok: true, translation }))
        .catch((error) =>
          sendResponse({ ok: false, error: error?.message || String(error) })
        );
    } else {
      translateMessage(message.text, message.metadata)
        .then((translation) => sendResponse({ ok: true, translation }))
        .catch((error) =>
          sendResponse({ ok: false, error: error?.message || String(error) })
        );
    }
    return true; // async response
  }

  if (message?.type === "smoothTranslations") {
    smoothTranslations(
      message.prevLines,
      message.nextLines,
      message.prevOriginalLines,
      message.nextOriginalLines
    )
      .then((lines) => sendResponse({ ok: true, lines }))
      .catch((error) =>
        sendResponse({ ok: false, error: error?.message || String(error) })
      );
    return true;
  }

  if (message?.type === "openOptions") {
    chrome.runtime.openOptionsPage(() => {
      if (chrome.runtime.lastError) {
        sendResponse({
          ok: false,
          error: chrome.runtime.lastError.message,
        });
      } else {
        sendResponse({ ok: true });
      }
    });
    return true;
  }

  if (message?.type === "getConfig") {
    getConfig()
      .then((config) => sendResponse({ ok: true, config }))
      .catch((error) =>
        sendResponse({ ok: false, error: error?.message || String(error) })
      );
    return true;
  }
});

chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "reopenOverlay" }).catch(() => {});
});

function logTranslateBatch(segments) {
  try {
    const items = (segments || []).map((s, idx) => ({
      idx,
      ts: (s?.timestamp || "").slice(0, 16),
      text: (s?.text || "").slice(0, 80),
    }));
    console.info("[spt] translate batch", {
      count: items.length,
      items,
    });
  } catch (err) {
    console.warn("[spt] failed to log batch", err);
  }
}

async function getConfig() {
  const stored = await chrome.storage.local.get({
    apiKey: "",
    geminiApiKey: "",
    geminiThinkingLevel: DEFAULT_GEMINI_THINKING_LEVEL,
    apiBaseUrl: DEFAULT_ENDPOINT,
    model: DEFAULT_MODEL,
    prefetchAhead: DEFAULT_CONTEXT_LINES,
    temperature: DEFAULT_TEMPERATURE,
    smoothLines: DEFAULT_SMOOTH_LINES,
  });

  const contextLines = clampInt(stored.prefetchAhead, 0, 50, DEFAULT_CONTEXT_LINES);
  const smoothLines =
    contextLines <= 0
      ? 0
      : clampInt(
          Math.min(contextLines, stored.smoothLines),
          0,
          contextLines,
          Math.min(DEFAULT_SMOOTH_LINES, contextLines)
        );
  const geminiThinkingLevel = normalizeGeminiThinkingLevel(
    stored.geminiThinkingLevel,
    DEFAULT_GEMINI_THINKING_LEVEL
  );

  return {
    apiKey: stored.apiKey?.trim(),
    geminiApiKey: stored.geminiApiKey?.trim(),
    apiBaseUrl: normalizeEndpoint(stored.apiBaseUrl || DEFAULT_ENDPOINT),
    model: stored.model || DEFAULT_MODEL,
    temperature: clampFloat(stored.temperature, 0, 1, DEFAULT_TEMPERATURE),
    contextLines,
    smoothLines,
    geminiThinkingLevel,
  };
}

async function translateMessage(text, metadata = {}) {
  const config = await getConfig();
  if (!config.apiKey) {
    throw new Error("Missing API key. Set it in the extension options.");
  }

  const trimmedText = (text || "").trim();
  if (!trimmedText) throw new Error("Empty text to translate.");

  const cleanText = stripTimestamps(trimmedText);
  const contextMessages = buildContextMessages(config.contextLines);

  let translation = "";
  if (isGeminiModel(config.model)) {
    translation = await sendGeminiRequest({
      config,
      messages: [
        ...contextMessages,
        { role: "user", content: cleanText },
      ],
    });
  } else {
    const payload = {
      model: config.model || DEFAULT_MODEL,
      messages: [
        ...contextMessages,
        {
          role: "user",
          content: cleanText,
        },
      ],
      temperature: forceHighTemperature(config),
    };

    const response = await fetch(config.apiBaseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Translation request failed (${response.status}): ${errorText.slice(0, 200)}`
      );
    }

    const data = await response.json();
    translation =
      data?.choices?.[0]?.message?.content?.trim() ||
      data?.choices?.[0]?.text?.trim();

    if (!translation) {
      throw new Error("Translation missing in API response.");
    }
  }

  pushRecent(cleanText, config.contextLines);
  pushRecentTranslation(splitLines(translation), config.contextLines);
  return translation;
}

async function translateBatch(segments = [], context = {}) {
  const config = await getConfig();
  if (!config.apiKey) {
    throw new Error("Missing API key. Set it in the extension options.");
  }
  if (!Array.isArray(segments) || !segments.length) {
    throw new Error("No segments to translate.");
  }

  const normalized = segments
    .map((s) => ({
      text: (s?.text || "").trim(),
      timestamp: (s?.timestamp || "").trim(),
    }))
    .filter((s) => s.text);

  if (!normalized.length) throw new Error("Segments are empty.");

  const currentLines = normalized.map((s) => s.text);

  const contextMessages = buildContextMessages(config.contextLines, {
    prevOriginal: context?.prevOriginal,
    prevTranslation: context?.prevTranslation,
    prevTranslations: context?.prevTranslations,
  });

  let translation = "";

  if (isGeminiModel(config.model)) {
    translation = await sendGeminiRequest({
      config,
      messages: [
        ...contextMessages,
        {
          role: "user",
          content: [
            "Translate the following lines to natural Simplified Chinese.",
            "Return exactly one translated line for each input line.",
            "Echo the marker for each line using the same format: <<LINE N>> <translation>.",
            "Input lines:",
            currentLines
              .map((line, idx) => `<<LINE ${idx + 1}>> ${line}`)
              .join("\n"),
          ].join("\n"),
        },
      ],
    });
  } else {
    const payload = {
      model: config.model || DEFAULT_MODEL,
      messages: [
        ...contextMessages,
        {
          role: "user",
          content: [
            "Translate the following lines to natural Simplified Chinese.",
            "Return exactly one translated line for each input line.",
            "Echo the marker for each line using the same format: <<LINE N>> <translation>.",
            "Input lines:",
            currentLines
              .map((line, idx) => `<<LINE ${idx + 1}>> ${line}`)
              .join("\n"),
          ].join("\n"),
        },
      ],
      temperature: forceHighTemperature(config),
    };

    const response = await fetch(config.apiBaseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Translation request failed (${response.status}): ${errorText.slice(0, 200)}`
      );
    }

    const data = await response.json();
    translation =
      data?.choices?.[0]?.message?.content?.trim() ||
      data?.choices?.[0]?.text?.trim();
  }

  if (!translation) {
    throw new Error("Translation missing in API response.");
  }

  const parsed = parseDelimitedTranslation(translation, currentLines.length);
  pushRecentTranslation(parsed, config.contextLines);
  // keep originals for context in subsequent requests
  currentLines.forEach((line) => pushRecent(line, config.contextLines));
  return parsed.join("\n");
}

async function smoothTranslations(
  prevLines = [],
  nextLines = [],
  prevOriginalLines = [],
  nextOriginalLines = []
) {
  const config = await getConfig();
  if (!config.apiKey) {
    throw new Error("Missing API key. Set it in the extension options.");
  }

  const prev = (prevLines || []).map((l) => (l || "").trim()).filter(Boolean);
  const next = (nextLines || []).map((l) => (l || "").trim()).filter(Boolean);
  if (!prev.length && !next.length) {
    throw new Error("No lines to smooth.");
  }

  const overlap = Math.min(config.smoothLines, prev.length, next.length);
  console.info("[spt] smoothTranslations", {
    prevLines: prev.length,
    nextLines: next.length,
    overlap,
    smoothLines: config.smoothLines,
    model: config.model,
  });

  if (!overlap) {
    return [...prev, ...next];
  }

  const targetPrev = prev.slice(-overlap);
  const targetNext = next.slice(0, overlap);
  const total = overlap * 2;

  const systemPrompt = [
    "You are a subtitle coherence editor.",
    "",
    "Your job:",
    "- Improve the coherence of the provided Chinese translations ONLY.",
    "- You are only allowed to modify the single sentence that spans the boundary; other lines must remain exactly the same.",
    "- If the boundary-spanning sentence is mistranslated or broken because of truncation, re-translate that single sentence using the original text to restore correct meaning and fluency.",
    "- Do NOT change or re-translate any other lines from the source; they must stay exactly as provided.",
    "",
    "- The source text is ONLY for resolving pronouns, sentence continuation, and context.",
    "",
    "You are given ORIGINAL TEXT + CURRENT TRANSLATIONS for:",
    "- The last N lines of the previous segment",
    "- The first N lines of the next segment",
    "",
    "Constraints:",
    "1. Do NOT change line IDs (e.g., <<L0123>>).",
    "2. Do NOT add or remove lines.",
    "3. Maintain consistency of names, tone, and pronouns across the 2N lines.",
    "4. Do NOT output <<BOUNDARY>> or any markers other than <<Lxxxx>>.",
    "5. If ORIGINAL shows a sentence that spans across <<BOUNDARY>> and the provided translations are truncated/broken, rewrite to form one coherent sentence.",
    "",
    "Formatting Rule:",
    "- Each line MUST begin with its line ID (e.g., <<LINE 5>>) and MUST NOT have any other markers.",
    "- Line IDs MUST NOT appear inside sentences.",
    "- Do NOT merge or split lines; keep structure unchanged.",
  ].join("\n");

  const originalsCombined = [...prevOriginalLines, ...nextOriginalLines]
    .map((line, idx) => `<<SRC ${idx + 1}>> ${line || ""}`)
    .join("\n");
  const originalsWithBoundary = [
    ...prevOriginalLines.map((line, idx) => `<<SRC ${idx + 1}>> ${line || ""}`),
    "<<BOUNDARY>>", // 标记段落衔接处
    ...nextOriginalLines.map(
      (line, idx) => `<<SRC ${prevOriginalLines.length + idx + 1}>> ${line || ""}`
    ),
  ].join("\n");

  const translatedWithBoundary = [
    ...targetPrev.map((line, idx) => `<<LINE ${idx + 1}>> ${line}`),
    "<<BOUNDARY>>", // 标记段落衔接处
    ...targetNext.map(
      (line, idx) => `<<LINE ${targetPrev.length + idx + 1}>> ${line}`
    ),
  ].join("\n");

  const userPrompt = [
    "Adjust the lines so they read fluently across the boundary.",
    `Return exactly ${total} lines, each prefixed with its marker in the same order: <<LINE n>>.`,
    "Original lines (context only, boundary marked with <<BOUNDARY>>):",
    originalsWithBoundary || "<<SRC 1>>",
    "Translated lines (boundary marked with <<BOUNDARY>>):",
    translatedWithBoundary,
  ].join("\n");

  let translation = "";
  if (isGeminiModel(config.model)) {
    translation = await sendGeminiRequest({
      config,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });
  } else {
    const payload = {
      model: config.model || DEFAULT_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: Math.min(0.4, forceHighTemperature(config)),
    };

    const response = await fetch(config.apiBaseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Smoothing request failed (${response.status}): ${errorText.slice(0, 200)}`
      );
    }

    const data = await response.json();
    translation =
      data?.choices?.[0]?.message?.content?.trim() ||
      data?.choices?.[0]?.text?.trim();
  }

  const parsed = parseDelimitedTranslation(translation, total);
  return parsed;
}

function normalizeEndpoint(url) {
  if (!url) return DEFAULT_ENDPOINT;
  const trimmed = url.trim();
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  const stripped = trimmed.endsWith("/")
    ? trimmed.slice(0, trimmed.length - 1)
    : trimmed;
  if (stripped.endsWith("/v1")) {
    return `${stripped}/chat/completions`;
  }
  return stripped;
}

function buildContextMessages(contextLines, chunkContext = {}) {
  const messages = [
    {
      role: "system",
      content:
        [
          "You are a translation engine. Translate incoming subtitles or transcripts into concise, natural Simplified Chinese.",
          "Keep named entities accurate.",
          "Maintain terminology and tone consistent with previous translations and the surrounding context.",
          "Before translating, compare with the previous translation: if it already covers the start of this segment (e.g., it completed an unfinished sentence), skip the duplicated opening and translate from the first untranslated part to keep the flow natural.",
          "Avoid list-style or telegraphic fragments unless the source is explicitly a list; keep sentences flowing.",
          "Use every provided line marker (e.g., <<LINE N>>) and return one translation for each marker.",
          "If N markers are provided, you must return exactly N markers.",
        ].join(" "),
    },
  ];

  const prevOriginal = chunkContext?.prevOriginal || [];
  const prevTranslation = chunkContext?.prevTranslation;
  const prevTranslations = chunkContext?.prevTranslations || [];
  const hasChunkTranslation =
    typeof prevTranslation === "string" && prevTranslation.trim();
  const hasPrevTranslations =
    Array.isArray(prevTranslations) && prevTranslations.length > 0;
  const hasPrevSegment = Array.isArray(prevOriginal) && prevOriginal.length > 0;

  if (hasPrevSegment) {
    messages.push({
      role: "user",
      content: `Previous segment :\n${prevOriginal
        .map((line, idx) => `${idx + 1}. ${line}`)
        .join("\n")}`,
    });
    messages.push({
      role: "assistant",
      content:
        "Understood. I will keep style and terminology consistent with the previous segment.",
    });
  }

  // 翻译上下文：仅保留上一段的最后几行译文，避免重复提供整段译文
  if (!hasPrevTranslations && hasChunkTranslation) {
    messages.push({
      role: "user",
      content: `Previous segment translation:\n${prevTranslation.trim()}`,
    });
    messages.push({
      role: "assistant",
      content: "Understood. I will continue seamlessly from this line.",
    });
  }

  if (hasPrevTranslations) {
    messages.push({
      role: "user",
      content: `Previous translations :\n${prevTranslations
        .slice(-3)
        .map((line, idx) => `${idx + 1}. ${line}`)
        .join("\n")}`,
    });
  }

  if (!hasPrevSegment && recentSegments.length) {
    const history = recentSegments
      .slice(-contextLines)
      .map((line, idx) => `${idx + 1}. ${line}`)
      .join("\n");
    messages.push({
      role: "user",
      content: `Previous lines :\n${history}`,
    });
    messages.push({
      role: "assistant",
      content:
        "Understood. I will only translate the new line while keeping context consistency.",
    });
  }

  if (!hasChunkTranslation && recentTranslations.length) {
    const last = recentTranslations[recentTranslations.length - 1];
    messages.push({
      role: "user",
      content: `Previous translation :\n${last}`,
    });
  }

  return messages;
}

function pushRecent(text, contextLines) {
  recentSegments.push(text);
  const limit = Math.max(1, contextLines) * 3;
  if (recentSegments.length > limit) {
    recentSegments.splice(0, recentSegments.length - limit);
  }
}

function pushRecentTranslation(lines, contextLines) {
  const arr = Array.isArray(lines) ? lines : [lines];
  arr.forEach((line) => {
    const t = (line || "").trim();
    if (t) recentTranslations.push(t);
  });
  const limit = Math.max(1, contextLines) * 3;
  if (recentTranslations.length > limit) {
    recentTranslations.splice(0, recentTranslations.length - limit);
  }
}

function splitLines(text) {
  return (text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

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

function parseDelimitedTranslation(text, expected) {
  const result = Array(Math.max(1, expected)).fill("");
  if (!text) return result;
  const regex =
    /<<LINE\s*(\d+)\s*>>\s*([\s\S]*?)(?=<<LINE\s*\d+\s*>>|$)/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const idx = parseInt(match[1], 10) - 1;
    if (idx >= 0 && idx < result.length) {
      result[idx] = (match[2] || "").trim();
    }
  }

  // fallback: if some are empty, try naive newline split
  const fallbackLines = splitLines(text);
  for (let i = 0; i < result.length; i += 1) {
    if (!result[i]) {
      result[i] = fallbackLines[i] || fallbackLines[fallbackLines.length - 1] || "";
    }
  }

  return result;
}

function stripTimestamps(text) {
  if (!text) return "";
  // remove leading timestamp-like patterns and numbering
  return text
    .split(/\r?\n/)
    .map((line) =>
      line
        .trim()
        .replace(/^\d+\s*[\.\):\-]\s*/, "")
        .replace(/^(\d{1,2}:)?\d{1,2}:\d{2}\s*/, "")
    )
    .join("\n");
}

function forceHighTemperature(config) {
  const model = (config?.model || DEFAULT_MODEL || "").toLowerCase();
  if (model === "gpt-5-mini" || model === "gpt-5-nano") return 1;
  return config?.temperature ?? DEFAULT_TEMPERATURE;
}

function isGeminiModel(model = "") {
  return (model || "").toLowerCase().includes("gemini");
}

function normalizeGeminiThinkingLevel(level, fallback = "") {
  const allowed = ["minimal", "low", "medium", "high"];
  const normalized = (level || "").toLowerCase();
  if (allowed.includes(normalized)) return normalized;
  const fallbackNormalized = (fallback || "").toLowerCase();
  return allowed.includes(fallbackNormalized) ? fallbackNormalized : "";
}

async function sendGeminiRequest({ config, messages }) {
  const model = config.model || "gemini-3-flash-preview";
  const base = normalizeGeminiEndpoint(
    config.apiBaseUrl,
    model,
    config.geminiApiKey || config.apiKey
  );
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const payload = {
    contents,
  };

  const thinkingLevel = normalizeGeminiThinkingLevel(
    config.geminiThinkingLevel,
    DEFAULT_GEMINI_THINKING_LEVEL
  );
  if (thinkingLevel) {
    payload.generationConfig = {
      thinkingConfig: { thinkingLevel },
    };
  }

  const response = await fetch(base, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Translation request failed (${response.status}): ${errorText.slice(0, 200)}`
    );
  }

  const data = await response.json();
  const text =
    data?.candidates?.[0]?.content?.parts?.map((p) => p?.text).join("\n").trim();
  if (!text) {
    throw new Error("Translation missing in Gemini API response.");
  }
  return text;
}

function normalizeGeminiEndpoint(apiBaseUrl, model, apiKey) {
  // If user provided a full Gemini endpoint, use it; otherwise build from model and key.
  if (apiBaseUrl && apiBaseUrl.includes("generativelanguage.googleapis.com")) {
    return apiBaseUrl.includes("?key=")
      ? apiBaseUrl
      : `${apiBaseUrl}?key=${encodeURIComponent(apiKey || "")}`;
  }
  const safeModel = encodeURIComponent(model);
  const keyParam = apiKey ? `?key=${encodeURIComponent(apiKey)}` : "";
  return `https://generativelanguage.googleapis.com/v1beta/models/${safeModel}:generateContent${keyParam}`;
}
