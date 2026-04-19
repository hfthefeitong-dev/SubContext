(() => {
  const SELECTORS = [
    '[data-testid="transcript-segment"]',
    '[data-testid="transcript-line"]',
    'section[aria-label*="Transcript"] p',
    'div[aria-label*="Transcript"] p',
    'section[aria-label*="transcript"] p',
    'article[data-testid*="transcript"] p',
    'div[data-testid="transcript"] p',
    'ytd-transcript-segment-renderer',
    'ytd-transcript-segment-renderer #segment-text',
  ];

  const __SPT_GUARD_KEY__ = "__spt_subtitle_context_translator__";
  try {
    if (typeof window !== "undefined") {
      if (window[__SPT_GUARD_KEY__]) return;
      window[__SPT_GUARD_KEY__] = { initedAt: Date.now() };
    }
  } catch (_) {
    // ignore guard failures
  }

  const seenSegments = new Set(); // for DOM transcript fallback
  const submittedIds = new Set(); // segments already sent for translation
  const renderedIds = new Set(); // segments already shown in UI
  const translationCache = new Map(); // id -> translated text
  const sourceCorrectionCache = new Map(); // id -> { originalText, correctedText }
  const retryAfterById = new Map(); // id -> next retry timestamp
  const translationQueue = [];
  const entryMap = new Map();
  const chunkBuffers = new Map(); // chunkId -> { expected, originals: [], translations: [], finalized: false }
  const GROUP_DOM = "dom-chunk";
  const youtubeTranscriptState = {
    mediaKey: "",
    tracksKey: "",
    loadingPromise: null,
    segments: [],
    anchorSeconds: null,
    panel: null,
  };
  let lastSegments = []; // cache of latest transcript segments (ordered)
  let lastChunkOriginal = []; // 上一段原文行
  let lastChunkTranslations = []; // 上一段译文行
  let lastChunkLastTranslation = ""; // 上一段最后一句译文
  let activeSessionKey = "";
  let sessionVersion = 0;
  let activeTranslations = 0;
  let lastPrefetchedChunkId = -1;
  const MAX_PARALLEL = 1; // 串行翻译，保证上下文按顺序传递
  const DEFAULT_BATCH_SIZE = 8;
  const DEFAULT_PREFETCH_AHEAD = 8;
  const DEFAULT_SMOOTH_LINES = 3;
  const DEFAULT_QUEUE_FLUSH_MS = 300;
  const DEFAULT_RETRY_DELAY_MS = 3000;
  const DEFAULT_CONFIG_RETRY_DELAY_MS = 15000;
  const PENDING_TRANSLATION_TEXT = "翻译中...";
  const MAX_TRANSCRIPT_TIME_DRIFT_SEC = 8;
  const SEEK_RESET_THRESHOLD_SEC = 1.5;
  const YOUTUBE_VISIBLE_LINES = 2;
  const DEFAULT_PANEL_HEIGHT_VH = 70;
  const DEFAULT_PANEL_WIDTH_VW = 32;
  const DEFAULT_FONT_ORIGINAL = 12;
  const DEFAULT_FONT_TRANSLATION = 13;
  const DEFAULT_ORIGINAL_COLOR_SCHEME = "dark";
  const DEFAULT_TRANSLATION_COLOR_SCHEME = "dark";
  const DEFAULT_HIDE_TRANSLATION_TIMESTAMP = false;
  const DEFAULT_ENABLE_SOURCE_CORRECTIONS = false;
  const COLOR_MAP = {
    dark: {
      original: "#0f172a",
      translation: "#1f2937",
    },
    green: {
      original: "#0c713a",
      translation: "#0c713a",
    },
  };
  let BATCH_SIZE = DEFAULT_BATCH_SIZE;
  let PREFETCH_AHEAD = DEFAULT_PREFETCH_AHEAD;
  let SMOOTH_LINES = DEFAULT_SMOOTH_LINES;
  let QUEUE_FLUSH_MS = DEFAULT_QUEUE_FLUSH_MS;
  let PANEL_HEIGHT_VH = DEFAULT_PANEL_HEIGHT_VH;
  let PANEL_WIDTH_VW = DEFAULT_PANEL_WIDTH_VW;
  let FONT_ORIGINAL = DEFAULT_FONT_ORIGINAL;
  let FONT_TRANSLATION = DEFAULT_FONT_TRANSLATION;
  let ORIGINAL_COLOR_SCHEME = DEFAULT_ORIGINAL_COLOR_SCHEME;
  let TRANSLATION_COLOR_SCHEME = DEFAULT_TRANSLATION_COLOR_SCHEME;
  let HIDE_TRANSLATION_TIMESTAMP = DEFAULT_HIDE_TRANSLATION_TIMESTAMP;
  let ENABLE_SOURCE_CORRECTIONS = DEFAULT_ENABLE_SOURCE_CORRECTIONS;
  const STORAGE_KEY_POSITION = "sptPosition";
  const hookedVideos = new WeakSet();
  const hookedTracks = new WeakSet();
  const hookedTimeVideos = new WeakSet();
  const lastVideoTimeByVideo = new WeakMap();
  const EXT_INACTIVE_ERROR = "Extension inactive";

  const isYouTubeSite = () =>
    typeof location !== "undefined" &&
    location.hostname.includes("youtube.com");

  const isSpotifySite = () =>
    typeof location !== "undefined" &&
    location.hostname.includes("open.spotify.com");

  function isExtensionAlive() {
    return typeof chrome !== "undefined" && !!chrome.runtime?.id;
  }

  function safeStorageGet(defaults, cb) {
    if (!isExtensionAlive()) return;
    try {
      chrome.storage.local.get(defaults, (res) => {
        if (!isExtensionAlive() || chrome.runtime.lastError) return;
        cb(res);
      });
    } catch (_) {
      // ignore when extension context is gone
    }
  }

  function safeStorageSet(obj) {
    if (!isExtensionAlive()) return;
    try {
      chrome.storage.local.set(obj, () => {});
    } catch (_) {
      // ignore when extension context is gone
    }
  }

  function safeSendMessage(message, fallback = null) {
    return new Promise((resolve) => {
      if (!isExtensionAlive()) {
        resolve(fallback ?? { ok: false, error: EXT_INACTIVE_ERROR });
        return;
      }
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (!isExtensionAlive() || chrome.runtime.lastError) {
            resolve(
              fallback ?? {
                ok: false,
                error: chrome.runtime.lastError?.message || EXT_INACTIVE_ERROR,
              }
            );
          } else {
            resolve(response ?? fallback ?? { ok: false, error: "No response" });
          }
        });
      } catch (err) {
        resolve(fallback ?? { ok: false, error: err.message });
      }
    });
  }

  function canSubmitSegment(id) {
    const retryAt = retryAfterById.get(id);
    if (!retryAt) return true;
    if (retryAt <= Date.now()) {
      retryAfterById.delete(id);
      return true;
    }
    return false;
  }

  function getRetryDelayMs(errorLike) {
    const message = String(errorLike?.message || errorLike || "");
    if (/Missing API key|Missing Gemini API key|401|403|404/i.test(message)) {
      return DEFAULT_CONFIG_RETRY_DELAY_MS;
    }
    return DEFAULT_RETRY_DELAY_MS;
  }

  function resetTranslationState({ clearUi = true } = {}) {
    submittedIds.clear();
    renderedIds.clear();
    translationCache.clear();
    sourceCorrectionCache.clear();
    retryAfterById.clear();
    translationQueue.length = 0;
    chunkBuffers.clear();
    lastSegments = [];
    lastChunkOriginal = [];
    lastChunkTranslations = [];
    lastChunkLastTranslation = "";
    lastPrefetchedChunkId = -1;
    sessionVersion += 1;
    safeSendMessage({ type: "resetContext" }, { ok: false });
    hideCorrectionPopup();
    if (clearUi) {
      entryMap.clear();
      if (listEl) listEl.innerHTML = "";
      setStatus("");
    }
  }

  function ensureSession(nextKey, options = {}) {
    const key = String(nextKey || "").trim();
    if (!key || key === activeSessionKey) return false;
    activeSessionKey = key;
    resetTranslationState(options);
    return true;
  }

  function buildMediaBaseKey(video = getPrimaryVideo()) {
    return [
      location.hostname || "",
      location.pathname || "",
      video?.currentSrc || video?.src || "",
    ].join("||");
  }

  function buildTrackSessionKey(track, video, cues = track?.cues || []) {
    const firstCue = cues?.[0];
    return [
      "track",
      buildMediaBaseKey(video),
      track?.kind || "",
      track?.label || "",
      track?.language || "",
      firstCue?.startTime ?? "",
      cleanText(firstCue?.text || "").slice(0, 80),
    ].join("||");
  }

  function buildTranscriptSessionKey(video, segments = []) {
    const first = segments[0];
    return [
      "transcript",
      buildMediaBaseKey(video),
      first?.id || "",
      first?.seconds ?? "",
    ].join("||");
  }

  function setStableChunkContext(originalLines = [], translatedLines = []) {
    lastChunkOriginal = (originalLines || []).filter(Boolean).slice(-3);
    lastChunkTranslations = (translatedLines || []).filter(Boolean).slice(-3);
    lastChunkLastTranslation =
      lastChunkTranslations[lastChunkTranslations.length - 1] || "";
  }

  function isAnyVideoPlaying() {
    const videos = document.querySelectorAll("video");
    if (!videos.length) return true; // if no video found, keep scanning
    for (let i = 0; i < videos.length; i += 1) {
      const v = videos[i];
      if (!v.paused && !v.ended) return true;
    }
    return false;
  }

  // Default: don't show / don't translate until enabled by user action
  // (popup/background sends { type: "reopenOverlay" }).
  let overlayEnabled = false;
  let overlayClosed = true;

  let overlay = null;
  let statusEl = null;
  let listEl = null;
  let openOptionsButton = null;
  let scrollLatestButton = null;
  let fontDecButton = null;
  let fontIncButton = null;
  let closeButton = null;
  let correctionPopup = null;
  let scanTimer = null;
  let observer = null;
  let storageListenerAttached = false;

  function ensureOverlay() {
    if (overlay) return;
    overlay = createOverlay();
    statusEl = overlay.querySelector(".spt-status");
    listEl = overlay.querySelector(".spt-items");
    openOptionsButton = overlay.querySelector(".spt-open-options");
    scrollLatestButton = overlay.querySelector(".spt-scroll-latest");
    fontDecButton = overlay.querySelector(".spt-font-dec");
    fontIncButton = overlay.querySelector(".spt-font-inc");
    closeButton = overlay.querySelector(".spt-close");

    openOptionsButton?.addEventListener("click", () => {
      safeSendMessage({ type: "openOptions" }).then((res) => {
        if (res && res.ok === false) {
          setStatus(`打开设置失败: ${res.error || "unknown"}`, true);
        }
      });
    });
    fontDecButton?.addEventListener("click", () => adjustFont(-1));
    fontIncButton?.addEventListener("click", () => adjustFont(1));
    scrollLatestButton?.addEventListener("click", () => {
      listEl?.scrollTo?.({ top: 0, behavior: "smooth" });
    });
    closeButton?.addEventListener("click", () => closeOverlay());

    loadPosition(overlay);
    loadRuntimeConfig();
    if (isExtensionAlive() && !storageListenerAttached) {
      chrome.storage.onChanged.addListener(handleStorageChange);
      storageListenerAttached = true;
    }
  }

  function startOverlayWork() {
    overlayEnabled = true;
    overlayClosed = false;
    ensureOverlay();
    if (overlay) overlay.style.display = "";

    if (!observer) {
      observer = new MutationObserver(scheduleScan);
      observer.observe(document.documentElement || document.body, {
        childList: true,
        subtree: true,
      });
    }

    scheduleScan();
    hookVideoTracks();
  }

  function stopOverlayWork() {
    overlayEnabled = false;
    overlayClosed = true;
    hideCorrectionPopup();

    if (scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
    if (scheduleQueueProcessing.timer) {
      clearTimeout(scheduleQueueProcessing.timer);
      scheduleQueueProcessing.timer = null;
    }
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (overlay) {
      overlay.style.display = "none";
    }
  }

  if (chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === "reopenOverlay") {
        reopenOverlay();
      }
    });
  }

  function getPrimaryVideo() {
    const videos = document.querySelectorAll("video");
    return videos.length ? videos[0] : null;
  }

  function extractLeadingTimestamp(rawText) {
    const normalized = cleanText(rawText);
    if (!normalized) return { timestamp: "", text: "" };
    const match = normalized.match(
      /^((?:\d{1,2}:)?\d{1,2}:\d{2})(?:\s+|\s*[-|]\s*)(.+)$/
    );
    if (!match) {
      return { timestamp: "", text: normalized };
    }
    return {
      timestamp: cleanText(match[1] || ""),
      text: cleanText(match[2] || ""),
    };
  }

  function getTranscriptTimestampNode(node) {
    if (!node?.querySelector) return null;
    return (
      node.querySelector('[id="segment-timestamp"]') ||
      node.querySelector("#start-offset") ||
      node.querySelector("time") ||
      node.querySelector(".segment-timestamp") ||
      node.querySelector('[class*="segment-timestamp"]') ||
      node.querySelector('[class*="timestamp"]') ||
      node.querySelector('[data-testid="timestamp"]')
    );
  }

  function getCurrentTranscriptTime() {
    // 尝试从当前高亮的转写行获取时间戳
    const active =
      document.querySelector(
        'ytd-transcript-segment-renderer[aria-selected="true"]'
      ) ||
      document.querySelector('ytd-transcript-segment-renderer[selected]') ||
      document.querySelector(
        'ytd-transcript-segment-renderer[focused] [id="segment-timestamp"]'
      );
    if (!active) return null;
    const tsNode = getTranscriptTimestampNode(active);
    const fallback = extractLeadingTimestamp(active.innerText || "");
    const ts = cleanText(tsNode?.textContent || fallback.timestamp || "");
    return parseTimestampToSeconds(ts);
  }

  function scheduleScan() {
    if (!overlayEnabled) return;
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      if (!overlayEnabled) return;
      if (isAnyVideoPlaying()) {
        void scanForSegments();
      }
      hookVideoTracks();
    }, 200); // 更高频率扫描，降低延迟与批量渲染
  }

  async function scanForSegments() {
    const video = getPrimaryVideo();
    const videoTime = video?.currentTime;

    // YouTube：按播放时间拿两段（每段若干行）翻译，当前段渲染，下一段预取，播放到对应时间戳再渲染
    if (isYouTubeSite()) {
      const segments = await collectYouTubeTranscriptSegments(video);
      const transcriptTime = getCurrentTranscriptTime();
      const hasTranscriptTime = isFinite(transcriptTime ?? NaN);
      const hasVideoTime = isFinite(videoTime ?? NaN);
      const panelAnchorTime =
        youtubeTranscriptState.tracksKey === "panel-text" &&
        isFinite(youtubeTranscriptState.anchorSeconds ?? NaN)
          ? youtubeTranscriptState.anchorSeconds
          : null;
      const currentTime =
        hasTranscriptTime &&
        (!hasVideoTime ||
          Math.abs((transcriptTime ?? 0) - (videoTime ?? 0)) <=
            MAX_TRANSCRIPT_TIME_DRIFT_SEC)
          ? transcriptTime
          : hasVideoTime
            ? videoTime
            : isFinite(panelAnchorTime ?? NaN)
              ? panelAnchorTime
              : null;
      ensureSession(buildTranscriptSessionKey(video, segments));
      lastSegments = segments;
      if (!segments.length) {
        setStatus(
          isYouTubeLiveContent()
            ? "未能从这个 YouTube 直播/回放页面解析到转写内容。请确认右侧“转写文稿”已展开；若仍无结果，可能是该视频当前不提供可抓取的字幕数据。"
            : "请打开 YouTube 的“转写”面板以获取字幕。"
        );
        return;
      }
      setStatus("");
      if (!isFinite(currentTime ?? NaN)) return;

      const chunkSize = Math.max(1, BATCH_SIZE); // 用户指定的若干行（为0时也按1处理当前行）
      let currentIdx = segments.findIndex(
        (s) => s.seconds != null && s.seconds >= (currentTime - 0.5)
      );
      if (currentIdx < 0) currentIdx = segments.length - 1;
      const currentChunkId = Math.floor(currentIdx / chunkSize);
      const currentChunkStart = currentChunkId * chunkSize;
      const currentChunkEnd = currentChunkStart + chunkSize;
      const currentVisibleCount = Math.max(1, YOUTUBE_VISIBLE_LINES);
      const currentOffset = Math.max(0, currentIdx - currentChunkStart);

      const currentChunk = segments.slice(
        currentChunkStart,
        currentChunkEnd
      );
      const currentVisibleChunk = segments.slice(
        currentIdx,
        Math.min(currentChunkEnd, currentIdx + currentVisibleCount)
      );
      const currentLeadingChunk = segments.slice(
        currentChunkStart,
        currentIdx
      );
      const currentTrailingChunk = segments.slice(
        Math.min(currentChunkEnd, currentIdx + currentVisibleCount),
        currentChunkEnd
      );
      const nextChunk = segments.slice(
        (currentChunkId + 1) * chunkSize,
        (currentChunkId + 2) * chunkSize
      );
      const nextNextChunk = segments.slice(
        (currentChunkId + 2) * chunkSize,
        (currentChunkId + 3) * chunkSize
      );

      // 当前仅立即显示 1-2 行；整段仍会预取翻译以保留上下文和顺滑度
      enqueueChunk(currentVisibleChunk, `${GROUP_DOM}-${currentChunkId}-visible`, true, {
        renderPlaceholder: true,
        chunkId: currentChunkId,
        startOrder: currentOffset,
      });
      enqueueChunk(currentLeadingChunk, `${GROUP_DOM}-${currentChunkId}-leading`, false, {
        chunkId: currentChunkId,
        startOrder: 0,
      });
      enqueueChunk(currentTrailingChunk, `${GROUP_DOM}-${currentChunkId}-trailing`, false, {
        chunkId: currentChunkId,
        startOrder: currentOffset + currentVisibleChunk.length,
      });
      if (PREFETCH_AHEAD > 0) {
        enqueueChunk(nextChunk, `${GROUP_DOM}-${currentChunkId + 1}`, false, {
          chunkId: currentChunkId + 1,
          startOrder: 0,
        });
        // 再预取下一段，保证有一段完整译文在未播放前就准备好
        enqueueChunk(nextNextChunk, `${GROUP_DOM}-${currentChunkId + 2}`, false, {
          chunkId: currentChunkId + 2,
          startOrder: 0,
        });
      }

      renderDueSegments(currentTime, segments); // 播放到时间戳再渲染缓存
      return;
    }

    // Spotify：禁用 DOM transcript 扫描，完全依赖 textTracks(cuechange) 以避免重复翻译
    if (isSpotifySite()) return;

    // 其他站点：按时间窗口过滤，逐行翻译
    const pastWindow = 2;
    const futureWindow = 6;
    const nodes = new Set();
    SELECTORS.forEach((selector) => {
      document.querySelectorAll(selector).forEach((node) => nodes.add(node));
    });

    nodes.forEach((node) => {
      const segment = extractSegment(node);
      if (!segment || !segment.text) return;
      if (typeof videoTime === "number" && segment.seconds != null) {
        if (segment.seconds < videoTime - pastWindow) return;
        if (segment.seconds > videoTime + futureWindow) return;
      }
      if (renderedIds.has(segment.id) || submittedIds.has(segment.id)) return;
      renderedIds.add(segment.id);
      ensureEntry(
        segment,
        translationCache.get(segment.id) || PENDING_TRANSLATION_TEXT
      );
      enqueueTranslation(segment, { prefetch: false, render: true });
    });
  }

  function extractSegment(node) {
    // Spotify transcript DOM: container node may include multiple line nodes; skip containers to avoid duplicates
    if (
      node?.matches?.('[data-testid="transcript-segment"]') &&
      node.querySelector?.('[data-testid="transcript-line"]')
    ) {
      return null;
    }
    const rawText = cleanText(node.innerText || "");
    if (!rawText) return null;
    const timeNode = getTranscriptTimestampNode(node);
    const fallback = extractLeadingTimestamp(rawText);
    const timestamp = cleanText(timeNode?.textContent || fallback.timestamp || "");
    // For YouTube transcript items, drop the leading timestamp from the text content
    const seconds = parseTimestampToSeconds(timestamp);
    const canonicalTimestamp = seconds != null ? formatTimestamp(seconds) : timestamp;
    const text = (() => {
      if (timestamp && rawText.startsWith(timestamp)) {
        return cleanText(rawText.slice(timestamp.length));
      }
      if (canonicalTimestamp && rawText.startsWith(canonicalTimestamp)) {
        return cleanText(rawText.slice(canonicalTimestamp.length));
      }
      if (fallback.timestamp && fallback.text) {
        return fallback.text;
      }
      return rawText;
    })();
    const id = `${canonicalTimestamp}|${text}`.slice(0, 240);
    return { id, text, timestamp: canonicalTimestamp, seconds };
  }

  function isNodeVisible(node) {
    if (!node || typeof node.getBoundingClientRect !== "function") return false;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const viewH = window.innerHeight || document.documentElement.clientHeight;
    return rect.bottom > 0 && rect.top < viewH;
  }

  function parseTimestampToSeconds(ts) {
    if (!ts) return null;
    const normalized = normalizeTimestampText(ts);
    const parts = normalized.split(":").map((p) => parseInt(p, 10));
    if (parts.some((n) => Number.isNaN(n))) return null;
    while (parts.length < 3) parts.unshift(0); // pad to [h,m,s]
    const [h, m, s] = parts;
    return h * 3600 + m * 60 + s;
  }

  function cleanText(str) {
    return (str || "").replace(/\s+/g, " ").trim();
  }

  function hookVideoTracks() {
    if (!overlayEnabled) return;
    const videos = document.querySelectorAll("video");
    videos.forEach((video) => {
      if (hookedVideos.has(video)) return;
      hookedVideos.add(video);
      lastVideoTimeByVideo.set(video, video?.currentTime);

      if (!hookedTimeVideos.has(video)) {
        hookedTimeVideos.add(video);
        video.addEventListener("timeupdate", () => {
          if (!overlayEnabled) return;
          const t = video?.currentTime;
          if (!isFinite(t)) return;
          lastVideoTimeByVideo.set(video, t);
          renderDueSegments(t, lastSegments);
        });
        video.addEventListener("seeking", () => {
          if (!overlayEnabled || !isYouTubeSite()) return;
          const t = video?.currentTime;
          const lastTime = lastVideoTimeByVideo.get(video);
          lastVideoTimeByVideo.set(video, t);
          if (
            isFinite(lastTime) &&
            isFinite(t) &&
            Math.abs(t - lastTime) < SEEK_RESET_THRESHOLD_SEC
          ) {
            return;
          }
          resetTranslationState();
          youtubeTranscriptState.anchorSeconds = null;
        });
      }

      const registerTrack = (track) => {
        if (!track || hookedTracks.has(track)) return;
        hookedTracks.add(track);
        track.mode = "hidden"; // allow JS access
        track.addEventListener("cuechange", () => handleCueChange(track, video));
      };

      const tracks = video.textTracks || [];
      for (let i = 0; i < tracks.length; i += 1) {
        registerTrack(tracks[i]);
      }
      video.addEventListener("loadedmetadata", () => {
        const updatedTracks = video.textTracks || [];
        for (let i = 0; i < updatedTracks.length; i += 1) {
          registerTrack(updatedTracks[i]);
        }
      });
      if (video.textTracks?.addEventListener) {
        video.textTracks.addEventListener("addtrack", (e) => {
          const track = e.track;
          registerTrack(track);
          if (track?.cues?.length) {
            handleCueChange(track, video); // immediately process if cues already loaded
          }
        });
      }
    });
  }

  function loadRuntimeConfig() {
    safeStorageGet(
      {
        batchSize: DEFAULT_BATCH_SIZE,
        prefetchAhead: DEFAULT_PREFETCH_AHEAD,
        smoothLines: 3,
        panelHeightVh: DEFAULT_PANEL_HEIGHT_VH,
        panelWidthVw: DEFAULT_PANEL_WIDTH_VW,
        fontOriginal: DEFAULT_FONT_ORIGINAL,
        fontTranslation: DEFAULT_FONT_TRANSLATION,
        enableSourceCorrections: DEFAULT_ENABLE_SOURCE_CORRECTIONS,
        hideTranslationTimestamp: DEFAULT_HIDE_TRANSLATION_TIMESTAMP,
        originalColorScheme: DEFAULT_ORIGINAL_COLOR_SCHEME,
        translationColorScheme: DEFAULT_TRANSLATION_COLOR_SCHEME,
      },
      (res) => {
        PREFETCH_AHEAD = clampInt(
          res.prefetchAhead,
          0,
          20,
          DEFAULT_PREFETCH_AHEAD
        );
        BATCH_SIZE = PREFETCH_AHEAD;
        if (PREFETCH_AHEAD <= 0) {
          SMOOTH_LINES = 0;
        } else {
          SMOOTH_LINES = clampInt(
            Math.min(PREFETCH_AHEAD, res.smoothLines),
            0,
            PREFETCH_AHEAD,
            Math.min(DEFAULT_SMOOTH_LINES, PREFETCH_AHEAD)
          );
        }
        PANEL_HEIGHT_VH = clampInt(
          res.panelHeightVh,
          30,
          95,
          DEFAULT_PANEL_HEIGHT_VH
        );
        PANEL_WIDTH_VW = clampInt(
          res.panelWidthVw,
          20,
          90,
          DEFAULT_PANEL_WIDTH_VW
        );
        FONT_ORIGINAL = clampInt(
          res.fontOriginal,
          10,
          22,
          DEFAULT_FONT_ORIGINAL
        );
        FONT_TRANSLATION = clampInt(
          res.fontTranslation,
          11,
          24,
          DEFAULT_FONT_TRANSLATION
        );
        ENABLE_SOURCE_CORRECTIONS = !!res.enableSourceCorrections;
        HIDE_TRANSLATION_TIMESTAMP = !!res.hideTranslationTimestamp;
        applyColorScheme(
          res.originalColorScheme || DEFAULT_ORIGINAL_COLOR_SCHEME,
          res.translationColorScheme || DEFAULT_TRANSLATION_COLOR_SCHEME
        );
        if (!overlay) return;
        overlay.style.maxHeight = `${PANEL_HEIGHT_VH}vh`;
        overlay.style.width = `${PANEL_WIDTH_VW}vw`;
        overlay.style.maxWidth = `${PANEL_WIDTH_VW}vw`;
        applyFontSizes();
      }
    );
  }

  function handleStorageChange(changes, area) {
    if (area !== "local") return;
    if (
      changes.apiKey ||
      changes.geminiApiKey ||
      changes.apiBaseUrl ||
      changes.model
    ) {
      retryAfterById.clear();
    }
    if (!overlay) return;
    if (changes.prefetchAhead) {
      PREFETCH_AHEAD = clampInt(
        changes.prefetchAhead.newValue,
        0,
        20,
        DEFAULT_PREFETCH_AHEAD
      );
      BATCH_SIZE = PREFETCH_AHEAD;
      if (PREFETCH_AHEAD <= 0) {
        SMOOTH_LINES = 0;
      } else {
        SMOOTH_LINES = clampInt(
          Math.min(PREFETCH_AHEAD, SMOOTH_LINES),
          0,
          PREFETCH_AHEAD,
          Math.min(DEFAULT_SMOOTH_LINES, PREFETCH_AHEAD)
        );
      }
    }
    if (changes.smoothLines) {
      if (PREFETCH_AHEAD <= 0) {
        SMOOTH_LINES = 0;
      } else {
        SMOOTH_LINES = clampInt(
          Math.min(PREFETCH_AHEAD, changes.smoothLines.newValue),
          0,
          PREFETCH_AHEAD,
          Math.min(DEFAULT_SMOOTH_LINES, PREFETCH_AHEAD)
        );
      }
    }
    if (changes.panelHeightVh) {
      PANEL_HEIGHT_VH = clampInt(
        changes.panelHeightVh.newValue,
        30,
        95,
        DEFAULT_PANEL_HEIGHT_VH
      );
      overlay.style.maxHeight = `${PANEL_HEIGHT_VH}vh`;
    }
    if (changes.panelWidthVw) {
      PANEL_WIDTH_VW = clampInt(
        changes.panelWidthVw.newValue,
        20,
        90,
        DEFAULT_PANEL_WIDTH_VW
      );
      overlay.style.width = `${PANEL_WIDTH_VW}vw`;
      overlay.style.maxWidth = `${PANEL_WIDTH_VW}vw`;
    }
    if (changes.fontOriginal) {
      FONT_ORIGINAL = clampInt(
        changes.fontOriginal.newValue,
        10,
        22,
        DEFAULT_FONT_ORIGINAL
      );
      applyFontSizes();
    }
    if (changes.fontTranslation) {
      FONT_TRANSLATION = clampInt(
        changes.fontTranslation.newValue,
        11,
        24,
        DEFAULT_FONT_TRANSLATION
      );
      applyFontSizes();
    }
    if (changes.enableSourceCorrections) {
      ENABLE_SOURCE_CORRECTIONS = !!changes.enableSourceCorrections.newValue;
      resetTranslationState({ clearUi: true });
      scheduleScan();
    }
    if (changes.hideTranslationTimestamp) {
      HIDE_TRANSLATION_TIMESTAMP = !!changes.hideTranslationTimestamp.newValue;
      // refresh existing cards
      entryMap.forEach((card, id) => {
        const translationEl = card?.querySelector?.(".spt-translation");
        if (!translationEl) return;
        if (translationEl.dataset.error === "1") return;
        const cached = translationCache.get(id) || translationEl.textContent || "";
        translationEl.textContent = formatTranslationForDisplay(cached, false);
      });
    }
    if (changes.originalColorScheme || changes.translationColorScheme) {
      const originalScheme =
        changes.originalColorScheme?.newValue || ORIGINAL_COLOR_SCHEME;
      const translationScheme =
        changes.translationColorScheme?.newValue || TRANSLATION_COLOR_SCHEME;
      applyColorScheme(originalScheme, translationScheme);
    }
  }

  function handleCueChange(track, videoRef = getPrimaryVideo()) {
    if (!overlayEnabled) return;
    const activeCues = track?.activeCues || [];
    const allCues = track?.cues || [];
    if (allCues.length) {
      ensureSession(buildTrackSessionKey(track, videoRef, allCues));
    }
    const activeIds = new Set();

    // translate active cues immediately
    for (let i = 0; i < activeCues.length; i += 1) {
      const seg = cueToSegment(activeCues[i]);
      if (seg?.id) activeIds.add(seg.id);
    }

    // prefetch next segment (user-defined number of lines) to keep exactly one segment cached
    if (allCues.length && activeCues.length) {
      const firstActive = activeCues[0];
      const idx = findCueIndex(allCues, firstActive);
      if (idx >= 0) {
        if (idx === 0) {
          lastPrefetchedChunkId = -1;
        }
        const chunkSize = Math.max(1, PREFETCH_AHEAD || 1);
        const currentChunkId = Math.floor(idx / chunkSize);
        const nextChunkId = currentChunkId + 1;

        // 补齐当前段（未激活行也一起批量翻译），但仅当前激活行会立即渲染
        const start = currentChunkId * chunkSize;
        const end = Math.min(allCues.length, start + chunkSize);
        ensureChunkBuffer(currentChunkId, end - start);
        for (let j = start; j < end; j += 1) {
          const seg = cueToSegment(allCues[j]);
          if (!seg) continue;
          const isActive = activeIds.has(seg.id);
          if (isActive) {
            renderedIds.add(seg.id);
            let cached = translationCache.get(seg.id);
            if (!cached) {
              const buf = chunkBuffers.get(currentChunkId);
              const buffered = buf?.translations?.[j - start];
              if (typeof buffered === "string" && buffered.trim()) {
                cached = mergeTimestamp(seg.timestamp, buffered);
                translationCache.set(seg.id, cached);
              }
            }
            ensureEntry(seg, cached || "");
            if (cached) {
              updateEntry(seg.id, cached, false, seg.text);
            }
          }
          if (submittedIds.has(seg.id)) continue;
          enqueueTranslation(
            { ...seg, chunkId: currentChunkId, chunkOrder: j - start },
            {
              prefetch: !isActive,
              render: isActive,
              groupId: `chunk-${currentChunkId}`,
              deferSchedule: true,
            }
          );
        }

        if (PREFETCH_AHEAD > 0 && nextChunkId > lastPrefetchedChunkId) {
          const start = nextChunkId * chunkSize;
          const end = Math.min(allCues.length, start + chunkSize);
          ensureChunkBuffer(nextChunkId, end - start);
          for (let j = start; j < end; j += 1) {
            const seg = cueToSegment(allCues[j]);
            if (!seg || submittedIds.has(seg.id)) continue;
            enqueueTranslation(
              { ...seg, chunkId: nextChunkId, chunkOrder: j - start },
              {
                prefetch: true,
                render: false,
                groupId: `chunk-${nextChunkId}`,
                deferSchedule: true,
              }
            );
          }
          lastPrefetchedChunkId = nextChunkId;
        }

        // 预取下下段，确保总有一段完整译文处于未播放状态
        const secondNextChunkId = nextChunkId + 1;
        if (PREFETCH_AHEAD > 0 && secondNextChunkId > lastPrefetchedChunkId) {
          const start = secondNextChunkId * chunkSize;
          const end = Math.min(allCues.length, start + chunkSize);
          ensureChunkBuffer(secondNextChunkId, end - start);
          for (let j = start; j < end; j += 1) {
            const seg = cueToSegment(allCues[j]);
            if (!seg || submittedIds.has(seg.id)) continue;
            enqueueTranslation(
              { ...seg, chunkId: secondNextChunkId, chunkOrder: j - start },
              {
                prefetch: true,
                render: false,
                groupId: `chunk-${secondNextChunkId}`,
                deferSchedule: true,
              }
            );
          }
          lastPrefetchedChunkId = secondNextChunkId;
        }
      }
    }
    scheduleQueueProcessing();
  }

  function enqueueCue(cue, { prefetch = false } = {}) {
    if (!cue) return;
    const text = cleanText(cue.text || "");
    if (!text) return;
    const timestamp = formatTimestamp(cue.startTime);
    const id = `${timestamp}|${text}`.slice(0, 240);
    const segment = { id, text, timestamp };
    if (prefetch) {
      if (submittedIds.has(id)) return;
      enqueueTranslation(segment, { prefetch: true, render: false });
      return;
    }
    if (renderedIds.has(id)) return;
    renderedIds.add(id);

    if (translationCache.has(id)) {
      ensureEntry(segment, translationCache.get(id));
      return;
    }

    ensureEntry(segment, "");
    enqueueTranslation(segment, { prefetch: false, render: true });
  }

  function cueToSegment(cue) {
    if (!cue) return null;
    const text = cleanText(cue.text || "");
    if (!text) return null;
    const timestamp = formatTimestamp(cue.startTime);
    const id = `${timestamp}|${text}`.slice(0, 240);
    return { id, text, timestamp, seconds: cue.startTime };
  }

  function findCueIndex(cues, cue) {
    for (let i = 0; i < cues.length; i += 1) {
      if (cues[i] === cue) return i;
    }
    return -1;
  }

  function formatTimestamp(seconds) {
    if (!isFinite(seconds)) return "";
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (v) => String(v).padStart(2, "0");
    return h > 0
      ? `${pad(h)}:${pad(m)}:${pad(sec)}`
      : `${pad(m)}:${pad(sec)}`;
  }

  function enqueueTranslation(
    segment,
    { prefetch = false, render = true, groupId, deferSchedule = false } = {}
  ) {
    if (submittedIds.has(segment.id) || !canSubmitSegment(segment.id)) return;
    submittedIds.add(segment.id);
    translationQueue.push({
      ...segment,
      prefetch,
      render,
      groupId,
      sessionVersion,
    });
    if (!deferSchedule) scheduleQueueProcessing();
  }

  function enqueueChunk(segments, groupId, renderNow, options = {}) {
    if (!segments?.length) return;
    const gid = groupId || `grp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const chunkId = Number.isFinite(options.chunkId) ? options.chunkId : null;
    const startOrder = Number.isInteger(options.startOrder) ? options.startOrder : 0;
    const placeholderText = options.renderPlaceholder
      ? options.placeholderText || PENDING_TRANSLATION_TEXT
      : "";
    if (chunkId !== null) {
      ensureChunkBuffer(chunkId, segments.length + startOrder);
    }
    segments.forEach((segment, idx) => {
      if (submittedIds.has(segment.id) || !canSubmitSegment(segment.id)) return;
      submittedIds.add(segment.id);
      if (renderNow) {
        renderedIds.add(segment.id);
        const cached = translationCache.get(segment.id);
        ensureEntry(segment, cached || placeholderText);
        if (cached) {
          updateEntry(segment.id, cached, false, segment.text);
        }
      }
      const payload = {
        ...segment,
        prefetch: !renderNow,
        render: renderNow,
        groupId: gid,
        sessionVersion,
      };
      if (chunkId !== null) {
        payload.chunkId = chunkId;
        payload.chunkOrder = startOrder + idx;
      }
      translationQueue.push(payload);
    });
    scheduleQueueProcessing();
  }

  function collectTranscriptSegments() {
    const nodes = new Set();
    SELECTORS.forEach((selector) => {
      document.querySelectorAll(selector).forEach((node) => nodes.add(node));
    });
    const segments = [];
    nodes.forEach((node) => {
      const seg = extractSegment(node);
      if (!seg || !seg.text || seg.seconds == null) return;
      segments.push(seg);
    });
    segments.sort((a, b) => (a.seconds ?? 0) - (b.seconds ?? 0));
    return segments;
  }

  async function collectYouTubeTranscriptSegments(video) {
    const panelResult = collectYouTubeTranscriptFromPanelText();
    youtubeTranscriptState.mediaKey = buildMediaBaseKey(video);
    youtubeTranscriptState.loadingPromise = null;
    youtubeTranscriptState.panel = panelResult.panel || null;
    if (panelResult.segments.length) {
      youtubeTranscriptState.tracksKey = "panel-text";
      youtubeTranscriptState.segments = panelResult.segments;
      youtubeTranscriptState.anchorSeconds =
        panelResult.anchorSeconds ?? panelResult.segments[0]?.seconds ?? null;
      return panelResult.segments;
    }
    youtubeTranscriptState.tracksKey = "panel-text";
    youtubeTranscriptState.segments = [];
    youtubeTranscriptState.anchorSeconds = null;
    youtubeTranscriptState.panel = null;
    return [];
  }

  function collectYouTubeTranscriptFromPanelText() {
    const panels = Array.from(
      document.querySelectorAll("ytd-engagement-panel-section-list-renderer")
    );
    const candidates = panels
      .map((panel) => {
        const rawText = panel.innerText || "";
        const text = cleanText(rawText);
        const segments = parseTranscriptSegmentsFromText(rawText);
        return {
          panel,
          text,
          segments,
          score: scoreYouTubePanel(panel, text, segments),
        };
      })
      .filter(({ text, segments, score }) => {
        return (
          /(?:\d{1,2}:)?\d{1,2}:\d{2}/.test(text) &&
          segments.length >= 3 &&
          score > -50
        );
      })
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.segments.length !== a.segments.length) {
          return b.segments.length - a.segments.length;
        }
        return (b.text.length || 0) - (a.text.length || 0);
      });

    for (const { panel, segments } of candidates) {
      if (segments.length >= 3) {
        return {
          panel,
          segments,
          anchorSeconds: getVisibleTranscriptAnchorSeconds(panel),
        };
      }
    }
    return { panel: null, segments: [], anchorSeconds: null };
  }

  function getVisibleTranscriptAnchorSeconds(panel) {
    if (!panel?.querySelectorAll) return null;
    const nodes = Array.from(panel.querySelectorAll("*"))
      .filter((node) => {
        const text = cleanText(node.textContent || "");
        return /^(\d{1,2}:)?\d{1,2}:\d{2}$/.test(text) && isNodeVisible(node);
      })
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return ar.top - br.top;
      });
    for (const node of nodes) {
      const seconds = parseTimestampToSeconds(cleanText(node.textContent || ""));
      if (seconds != null) return seconds;
    }
    return null;
  }

  function scoreYouTubePanel(panel, text, segments) {
    let score = segments.length * 2;
    const compact = String(text || "");

    if (/转写|Transcript|Transkript/i.test(compact)) score += 50;
    if (/搜索转写内容|Search transcript|Transcript search/i.test(compact)) {
      score += 80;
    }
    if (
      panel?.querySelector?.('input[placeholder*="转写"], input[placeholder*="transcript" i]')
    ) {
      score += 120;
    }
    if (
      panel?.querySelector?.(
        'button[aria-selected="true"], yt-chip-cloud-chip-renderer[aria-selected="true"]'
      )
    ) {
      const activeText = cleanText(
        panel.querySelector(
          'button[aria-selected="true"], yt-chip-cloud-chip-renderer[aria-selected="true"]'
        )?.innerText || ""
      );
      if (/转写|Transcript|Transkript/i.test(activeText)) score += 120;
      if (/章节|Chapter/i.test(activeText)) score -= 150;
    }
    if (/章节|Chapter|Intro/i.test(compact)) score -= 80;
    if (segments.length <= 5) score -= 40;

    return score;
  }

  function parseTranscriptSegmentsFromText(rawText) {
    const lines = String(rawText || "")
      .split(/\r?\n/)
      .map((line) => cleanText(line))
      .filter(Boolean);
    const segments = [];
    let current = null;

    const flush = () => {
      if (!current?.timestamp || !current.parts?.length) return;
      const text = cleanText(current.parts.join(" "));
      if (!text) return;
      const seconds = parseTimestampToSeconds(current.timestamp);
      if (seconds == null) return;
      segments.push({
        id: `${formatTimestamp(seconds)}|${text}`.slice(0, 240),
        text,
        timestamp: formatTimestamp(seconds),
        seconds,
      });
    };

    for (const line of lines) {
      const timestampOnly = line.match(/^((?:\d{1,2}:)?\d{1,2}:\d{2})$/);
      if (timestampOnly) {
        flush();
        current = {
          timestamp: timestampOnly[1],
          parts: [],
        };
        continue;
      }
      const matched = line.match(/^((?:\d{1,2}:)?\d{1,2}:\d{2})\s+(.+)$/);
      if (matched) {
        flush();
        current = {
          timestamp: matched[1],
          parts: [matched[2]],
        };
        continue;
      }
      if (current) {
        current.parts.push(line);
      }
    }
    flush();

    return segments.filter(
      (seg, idx, arr) => idx === 0 || seg.id !== arr[idx - 1]?.id
    );
  }

  function extractBalancedObjectLiteral(source, marker) {
    const raw = String(source || "");
    const markerIndex = raw.indexOf(marker);
    if (markerIndex < 0) return null;
    const braceStart = raw.indexOf("{", markerIndex + marker.length);
    if (braceStart < 0) return null;
    let depth = 0;
    let inString = false;
    let quote = "";
    let escaped = false;
    for (let i = braceStart; i < raw.length; i += 1) {
      const ch = raw[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === quote) {
          inString = false;
          quote = "";
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = true;
        quote = ch;
        continue;
      }
      if (ch === "{") depth += 1;
      if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          return raw.slice(braceStart, i + 1);
        }
      }
    }
    return null;
  }

  function getYouTubePlayerResponseFromInlineScripts() {
    const scripts = Array.from(document.scripts || []);
    for (const script of scripts) {
      const text = script?.textContent || "";
      if (!text || !text.includes("ytInitialPlayerResponse")) continue;
      const jsonText = extractBalancedObjectLiteral(
        text,
        "ytInitialPlayerResponse"
      );
      if (!jsonText) continue;
      try {
        return JSON.parse(jsonText);
      } catch (_) {
        // ignore malformed candidate
      }
    }
    return null;
  }

  function getYouTubePlayerResponse() {
    try {
      if (window?.ytInitialPlayerResponse) return window.ytInitialPlayerResponse;
    } catch (_) {
      // ignore
    }
    try {
      const raw = window?.ytplayer?.config?.args?.player_response;
      if (raw) return JSON.parse(raw);
    } catch (_) {
      // ignore
    }
    return getYouTubePlayerResponseFromInlineScripts();
  }

  function isYouTubeLiveContent() {
    const response = getYouTubePlayerResponse();
    return !!response?.videoDetails?.isLiveContent;
  }

  function renderDueSegments(currentTime, segments = lastSegments) {
    if (!overlayEnabled) return;
    if (!isFinite(currentTime ?? NaN)) return;
    if (!Array.isArray(segments) || !segments.length) return;
    const ready = segments
      .filter(
        (seg) =>
          seg.seconds != null &&
          seg.seconds <= currentTime + 0.05 &&
          !renderedIds.has(seg.id) &&
          translationCache.has(seg.id)
      )
      .sort((a, b) => (a.seconds ?? 0) - (b.seconds ?? 0));

    // 避免成段一起渲染，每次最多渲染 2 行
    ready.slice(0, 2).forEach((seg) => {
      renderedIds.add(seg.id);
      ensureEntry(seg, "");
      updateEntry(seg.id, translationCache.get(seg.id), false, seg.text);
    });
  }

  function scheduleQueueProcessing() {
    if (!overlayEnabled) return;
    if (activeTranslations >= MAX_PARALLEL) return;
    const effectiveBatch = Math.max(1, BATCH_SIZE);

    // group chunk takes priority: if queue head有groupId，立即处理
    if (translationQueue[0]?.groupId) {
      processQueue();
      return;
    }

    // if we already have enough items for a full batch, send immediately
    if (translationQueue.length >= effectiveBatch) {
      processQueue();
      return;
    }

    // otherwise debounce to allow a small window for batching
    if (scheduleQueueProcessing.timer) return;
    scheduleQueueProcessing.timer = setTimeout(() => {
      scheduleQueueProcessing.timer = null;
      processQueue();
    }, QUEUE_FLUSH_MS);
  }

  function processQueue() {
    if (!overlayEnabled) return;
    if (scheduleQueueProcessing.timer) {
      clearTimeout(scheduleQueueProcessing.timer);
      scheduleQueueProcessing.timer = null;
    }
    if (activeTranslations >= MAX_PARALLEL) return;
    const effectiveBatch = Math.max(1, BATCH_SIZE);
    let batch = [];
    if (translationQueue[0]?.groupId) {
      const gid = translationQueue[0].groupId;
      batch = translationQueue.filter((item) => item.groupId === gid);
      translationQueue.splice(
        0,
        translationQueue.length,
        ...translationQueue.filter((item) => item.groupId !== gid)
      );
    } else {
      batch = translationQueue.splice(0, effectiveBatch);
    }
    if (!batch.length) return;
    const batchSessionVersion = batch[0]?.sessionVersion ?? sessionVersion;
    activeTranslations += 1;
    translateBatch(batch)
      .catch((err) => {
        if (batchSessionVersion !== sessionVersion) return;
        const retryAt = Date.now() + getRetryDelayMs(err);
        batch.forEach((seg) => {
          submittedIds.delete(seg.id);
          retryAfterById.set(seg.id, retryAt);
          if (seg.render) {
            updateEntry(seg.id, `翻译失败: ${err.message || err}`, true);
          }
        });
      })
      .finally(() => {
        activeTranslations -= 1;
        processQueue();
      });
  }

  async function translateBatch(batch) {
    const batchSessionVersion = batch[0]?.sessionVersion ?? sessionVersion;
    const response = await sendTranslationRequest(batch);
    if (!response.ok) {
      throw new Error(response.error || "Translation failed");
    }
    if (batchSessionVersion !== sessionVersion) return;
    const lineResults = normalizeLineResults(response, batch);
    const cleanedLines = [];
    const touchedChunks = new Set();
    batch.forEach((segment, idx) => {
      const result = lineResults[idx] || {};
      const rawLine = result.translation || response.translation || "";
      const cleaned = cleanTranslatedLine(rawLine, segment.timestamp);
      const correction = normalizeCorrectionResult(result, segment.text);
      cleanedLines.push(cleaned);
      retryAfterById.delete(segment.id);
      sourceCorrectionCache.set(segment.id, correction);
      if (
        typeof segment.chunkId === "number" &&
        Number.isInteger(segment.chunkOrder)
      ) {
        ensureChunkBuffer(segment.chunkId, segment.chunkOrder + 1);
        touchedChunks.add(segment.chunkId);
        const buf = chunkBuffers.get(segment.chunkId);
        if (buf) {
          buf.segments[segment.chunkOrder] = segment;
          buf.originals[segment.chunkOrder] = segment.text;
          buf.translations[segment.chunkOrder] = cleaned;
        }
        if (segment.render || renderedIds.has(segment.id)) {
          const content = mergeTimestamp(segment.timestamp, cleaned);
          translationCache.set(segment.id, content);
          ensureEntry(segment, content);
          updateEntry(segment.id, content, false, segment.text);
        }
      } else {
        const content = mergeTimestamp(segment.timestamp, cleaned);
        translationCache.set(segment.id, content);
        if (segment.render || renderedIds.has(segment.id)) {
          ensureEntry(segment, translationCache.get(segment.id) || "");
          updateEntry(segment.id, content, false, segment.text);
        }
      }
    });

    if (touchedChunks.size) {
      for (const chunkId of touchedChunks) {
        await trySmoothWithPrevious(chunkId);
        publishChunkIfReady(chunkId, { keepBuffer: true });
      }
      finalizeTrailingChunksIfIdle();
    } else {
      setStableChunkContext(
        batch.map((s) => s.text),
        cleanedLines
      );
    }

    // If translations arrived while video is paused, render immediately using current time
    if (isYouTubeSite()) {
      const video = getPrimaryVideo();
      const t = video?.currentTime;
      if (isFinite(t)) {
        renderDueSegments(t, lastSegments);
      }
    }
  }

  function normalizeLineResults(response, batch) {
    if (Array.isArray(response?.lines) && response.lines.length) {
      return batch.map((segment, idx) => ({
        translation:
          response.lines[idx]?.translation ||
          response.lines[idx]?.text ||
          "",
        corrections:
          response.lines[idx]?.corrections ||
          (response.lines[idx]?.originalText || response.lines[idx]?.correctedText
            ? [
                {
                  originalText: response.lines[idx]?.originalText || "",
                  correctedText: response.lines[idx]?.correctedText || "",
                },
              ]
            : []),
      }));
    }

    const lines = normalizeTranslationLines(response?.translation, batch.length);
    return batch.map((segment, idx) => ({
      translation: lines[idx] || response?.translation || "",
      corrections: [],
    }));
  }

  function normalizeCorrectionResult(result, fallbackOriginalText) {
    const rawCorrections = Array.isArray(result?.corrections)
      ? result.corrections
      : result?.originalText || result?.correctedText
        ? [
            {
              originalText: result?.originalText || "",
              correctedText: result?.correctedText || "",
            },
          ]
        : [];
    const corrections = rawCorrections
      .map((entry) => {
        const originalText = String(entry?.originalText || "").trim();
        const correctedText = normalizeCorrectedLine(
          entry?.correctedText,
          originalText
        );
        return {
          originalText,
          correctedText,
        };
      })
      .filter((entry) => entry.originalText && entry.correctedText);
    return {
      corrections,
      originalLine: String(fallbackOriginalText || "").trim(),
    };
  }

  function sendTranslationRequest(batch) {
    return safeSendMessage({
      type: "translate",
      segments: batch.map((seg) => ({
        text: seg.text,
        timestamp: seg.timestamp,
      })),
      context: {
        prevOriginal: lastChunkOriginal,
        prevTranslation: lastChunkLastTranslation,
        prevTranslations: lastChunkTranslations,
      },
    });
  }

  async function trySmoothWithPrevious(chunkId) {
    const current = chunkBuffers.get(chunkId);
    if (!isChunkReady(current)) return;
    const idx = chunkIndex(chunkId);
    if (!Number.isFinite(idx) || idx <= 0) return;
    const prevId = idx - 1;
    const prev = chunkBuffers.get(prevId);
    if (!isChunkReady(prev) || prev.finalized) return;
    const overlap = Math.min(
      SMOOTH_LINES,
      prev.translations.length,
      current.translations.length
    );
    if (overlap <= 0) {
      prev.finalized = true;
      publishChunk(prevId);
      return;
    }
    const prevTail = prev.translations.slice(-overlap);
    const currHead = current.translations.slice(0, overlap);
    const prevTailOriginal = prev.originals.slice(-overlap);
    const currHeadOriginal = current.originals.slice(0, overlap);

    const smoothResp = await requestSmoothing(
      prevTail,
      currHead,
      prevTailOriginal,
      currHeadOriginal
    );
    if (smoothResp?.ok && Array.isArray(smoothResp.lines)) {
      const expected = overlap * 2;
      const merged =
        smoothResp.lines.length >= expected
          ? smoothResp.lines.slice(0, expected)
          : smoothResp.lines;
      if (merged.length >= expected) {
        prev.translations.splice(prev.translations.length - overlap, overlap, ...merged.slice(0, overlap));
        current.translations.splice(0, overlap, ...merged.slice(overlap, overlap * 2));
      }
    }
    prev.finalized = true;
    publishChunk(prevId);
  }

  function finalizeTrailingChunksIfIdle() {
    if (activeTranslations > 0 || translationQueue.length > 0) return;
    const ids = Array.from(chunkBuffers.keys()).sort((a, b) => chunkIndex(a) - chunkIndex(b));
    if (!ids.length) return;
    const lastId = ids[ids.length - 1];
    const lastBuf = chunkBuffers.get(lastId);
    // 发布最后一段以填充 UI，但保留缓冲，等待下一段到来时再做连贯化
    if (isChunkReady(lastBuf) && !lastBuf.finalized && !lastBuf.published) {
      publishChunk(lastId, { keepBuffer: true });
    }
  }

  function publishChunk(chunkId, { keepBuffer = false } = {}) {
    const buf = chunkBuffers.get(chunkId);
    if (!buf || !buf.segments) return;
    if (keepBuffer) {
      buf.published = true;
    }
    for (let i = 0; i < buf.segments.length; i += 1) {
      const seg = buf.segments[i];
      const t = buf.translations[i];
      if (!seg || !t) continue;
      const content = mergeTimestamp(seg.timestamp, t);
      translationCache.set(seg.id, content);
      if (entryMap.has(seg.id)) {
        updateEntry(seg.id, content, false, seg.text);
      }
    }
    setStableChunkContext(buf.originals, buf.translations);
    if (!keepBuffer && buf.finalized) {
      chunkBuffers.delete(chunkId);
    }

    // Render any ready lines even if playback is paused
    if (isYouTubeSite()) {
      const video = getPrimaryVideo();
      const t = video?.currentTime;
      if (isFinite(t)) {
        renderDueSegments(t, lastSegments);
      }
    }
  }

  function publishChunkIfReady(chunkId, { keepBuffer = false } = {}) {
    const buf = chunkBuffers.get(chunkId);
    if (!isChunkReady(buf)) return;
    buf.finalized = buf.finalized || !keepBuffer;
    publishChunk(chunkId, { keepBuffer });
  }

  function requestSmoothing(prevLines, nextLines, prevOriginalLines, nextOriginalLines) {
    return safeSendMessage({
      type: "smoothTranslations",
      prevLines,
      nextLines,
      prevOriginalLines,
      nextOriginalLines,
    });
  }

  function renderEntry(segment, statusText) {
    if (!overlayEnabled || !listEl) return;
    const card = document.createElement("div");
    card.className = "spt-item";
    card.dataset.segmentId = segment.id;
    card.dataset.originalText = segment.text || "";
    const orderValue = getSegmentOrderValue(segment);
    if (orderValue != null) {
      card.dataset.segmentOrder = String(orderValue);
    }
    card.innerHTML = `
      <div class="spt-original"></div>
      <div class="spt-translation">${escapeHtml(
        formatTranslationForDisplay(statusText, false)
      )}</div>
    `;
    syncCardCopyHint(card);
    renderOriginalText(card, segment.text);
    card.addEventListener("mouseover", (event) => {
      const correctionTrigger = event.target?.closest?.(".spt-corrected-token");
      if (!correctionTrigger || !card.contains(correctionTrigger)) return;
      setCardCopyHintSuppressed(card, true);
      showCorrectionPopup(correctionTrigger, card.dataset.segmentId);
    });
    card.addEventListener("mouseout", (event) => {
      const correctionTrigger = event.target?.closest?.(".spt-corrected-token");
      if (!correctionTrigger || !card.contains(correctionTrigger)) return;
      const related = event.relatedTarget;
      if (
        correctionTrigger.contains?.(related) ||
        correctionPopup?.contains?.(related) ||
        related?.closest?.(".spt-corrected-token")
      ) {
        return;
      }
      setCardCopyHintSuppressed(card, false);
      hideCorrectionPopup();
    });
    card.addEventListener("focusin", (event) => {
      const correctionTrigger = event.target?.closest?.(".spt-corrected-token");
      if (!correctionTrigger || !card.contains(correctionTrigger)) return;
      setCardCopyHintSuppressed(card, true);
      showCorrectionPopup(correctionTrigger, card.dataset.segmentId);
    });
    card.addEventListener("focusout", (event) => {
      const correctionTrigger = event.target?.closest?.(".spt-corrected-token");
      if (!correctionTrigger || !card.contains(correctionTrigger)) return;
      const related = event.relatedTarget;
      if (
        correctionPopup?.contains?.(related) ||
        related?.closest?.(".spt-corrected-token")
      ) {
        return;
      }
      setCardCopyHintSuppressed(card, false);
      hideCorrectionPopup();
    });
    card.addEventListener("click", (event) => {
      const correctionTrigger = event.target?.closest?.(".spt-corrected-token");
      if (correctionTrigger) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      void copyOriginalText(card);
    });
    insertEntryCard(card, segment);
    entryMap.set(segment.id, card);
    trimList();
  }

  function getSegmentOrderValue(segment) {
    if (!segment) return null;
    if (isFinite(segment.seconds)) return Number(segment.seconds);
    const parsed = parseTimestampToSeconds(segment.timestamp);
    return isFinite(parsed) ? parsed : null;
  }

  function getCardOrderValue(card) {
    if (!card) return null;
    const raw = card.dataset.segmentOrder;
    if (raw != null && raw !== "") {
      const numeric = Number(raw);
      if (isFinite(numeric)) return numeric;
    }
    const segmentId = card.dataset.segmentId || "";
    const timestamp = segmentId.split("|")[0] || "";
    const parsed = parseTimestampToSeconds(timestamp);
    return isFinite(parsed) ? parsed : null;
  }

  function insertEntryCard(card, segment) {
    if (!listEl) return;
    const orderValue = getSegmentOrderValue(segment);
    if (orderValue == null) {
      listEl.prepend(card);
      return;
    }
    const cards = Array.from(listEl.querySelectorAll(".spt-item"));
    const insertBeforeCard = cards.find((existing) => {
      const existingOrder = getCardOrderValue(existing);
      return existingOrder != null && existingOrder < orderValue;
    });
    if (insertBeforeCard) {
      listEl.insertBefore(card, insertBeforeCard);
      return;
    }
    listEl.appendChild(card);
  }

  function ensureEntry(segment, statusText = "") {
    if (!overlayEnabled || !listEl) return;
    if (entryMap.has(segment.id)) return;
    renderEntry(segment, statusText || "");
  }

  function updateEntry(id, translationText, isError = false, originalText) {
    if (!overlayEnabled || !listEl) return;
    const card = entryMap.get(id);
    if (!card) return;
    if (originalText) {
      card.dataset.originalText = originalText;
      renderOriginalText(card, originalText);
    }
    const translationEl = card.querySelector(".spt-translation");
    translationEl.textContent = formatTranslationForDisplay(translationText, isError);
    if (isError) {
      translationEl.style.color = "#d33";
      translationEl.dataset.error = "1";
    } else {
      translationEl.style.color = "var(--spt-translation-color, #1f2937)";
      delete translationEl.dataset.error;
    }
  }

  function renderOriginalText(card, originalText) {
    const originalEl = card?.querySelector?.(".spt-original");
    if (!originalEl) return;
    originalEl.innerHTML = buildOriginalLineHtml(card.dataset.segmentId, originalText);
  }

  function normalizeTranslationLines(text, expected) {
    if (!text) return [];
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return [];
    if (lines.length >= expected) return lines.slice(0, expected);
    // if fewer than expected, pad with last line
    const last = lines[lines.length - 1];
    while (lines.length < expected) lines.push(last);
    return lines;
  }

  async function copyOriginalText(card) {
    const raw = card?.dataset?.originalText || "";
    const text = stripLeadingTimestamp(formatOriginalForDisplay(raw)).trim();
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const input = document.createElement("textarea");
        input.value = text;
        input.setAttribute("readonly", "readonly");
        input.style.position = "fixed";
        input.style.opacity = "0";
        document.body.appendChild(input);
        input.select();
        document.execCommand("copy");
        input.remove();
      }
      flashCopiedState(card, "已复制原文");
    } catch (_) {
      flashCopiedState(card, "复制失败");
    }
  }

  function flashCopiedState(card, message) {
    if (!card) return;
    const previous = card.dataset.copyState || "";
    card.dataset.copyState = message || "已复制";
    syncCardCopyHint(card);
    clearTimeout(card.__sptCopyTimer);
    card.__sptCopyTimer = setTimeout(() => {
      card.dataset.copyState = previous;
      syncCardCopyHint(card);
    }, 1200);
  }

  function setCardCopyHintSuppressed(card, suppressed) {
    if (!card) return;
    if (suppressed) {
      card.dataset.copyHintSuppressed = "1";
    } else {
      delete card.dataset.copyHintSuppressed;
    }
    syncCardCopyHint(card);
  }

  function syncCardCopyHint(card) {
    if (!card) return;
    if (card.dataset.copyHintSuppressed === "1") {
      card.title = "";
      return;
    }
    card.title = card.dataset.copyState || "点击复制原文";
  }

  function trimList() {
    if (!listEl) return;
    const cards = listEl.querySelectorAll(".spt-item");
    const limit = 80;
    if (cards.length <= limit) return;
    for (let i = limit; i < cards.length; i += 1) {
      const card = cards[i];
      entryMap.delete(card.dataset.segmentId);
       sourceCorrectionCache.delete(card.dataset.segmentId);
      card.remove();
    }
  }

  function mergeTimestamp(timestamp, line) {
    if (!timestamp) return line;
    const ts = normalizeTimestampText(timestamp);
    if (!ts) return line;
    const combined = line.trim();
    const tsPattern = /^(\d{1,2}:)?\d{1,2}:\d{2}/;
    // if line already starts with a timestamp, don't double-prepend
    const normalizedCombined = normalizeTimestampText(combined);
    if (tsPattern.test(normalizedCombined)) {
      return normalizedCombined;
    }
    return `${ts} ${combined}`;
  }

  function stripLeadingTimestamp(text) {
    const s = normalizeTimestampText((text || "").trimStart());
    return s.replace(/^(\d{1,2}:)?\d{1,2}:\d{2}\s+/, "");
  }

  function formatTranslationForDisplay(text, isError) {
    if (isError) return text || "";
    const normalized = normalizeTimestampText(text || "");
    if (!HIDE_TRANSLATION_TIMESTAMP) return normalized;
    return stripLeadingTimestamp(normalized);
  }

  function formatOriginalForDisplay(text) {
    return normalizeTimestampText(text || "");
  }

  function normalizeCorrectedLine(correctedText, originalText) {
    const corrected = String(correctedText || "").trim();
    const original = String(originalText || "").trim();
    if (!corrected) return "";
    if (normalizeCompareText(corrected) === normalizeCompareText(original)) {
      return "";
    }
    return corrected;
  }

  function normalizeCompareText(text) {
    return String(text || "")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
  }

  function buildOriginalLineHtml(segmentId, originalText) {
    const displayedOriginal = formatOriginalForDisplay(originalText);
    const correction = sourceCorrectionCache.get(segmentId);
    const corrections = Array.isArray(correction?.corrections)
      ? correction.corrections
      : [];

    if (!ENABLE_SOURCE_CORRECTIONS || !corrections.length) {
      return escapeHtml(displayedOriginal);
    }

    const fragments = buildCorrectionFragments(displayedOriginal, corrections);
    if (!fragments.length || !fragments.some((fragment) => fragment.changed)) {
      return escapeHtml(displayedOriginal);
    }

    return fragments
      .map((fragment) =>
        fragment.changed
          ? `<span class="spt-corrected-token" tabindex="0" data-correction-index="${fragment.index}">${escapeHtml(
              fragment.text
            )}</span>`
          : escapeHtml(fragment.text)
      )
      .join("");
  }

  function buildCorrectionFragments(lineText, corrections = []) {
    const line = String(lineText || "");
    const fragments = [];
    let cursor = 0;
    let matched = false;

    corrections.forEach((entry, idx) => {
      const originalPhrase = String(entry?.originalText || "").trim();
      const correctedText = normalizeCorrectedLine(
        entry?.correctedText,
        originalPhrase
      );
      if (!originalPhrase || !correctedText) return;
      const phraseMatch = findPhraseRange(line, originalPhrase, cursor);
      if (!phraseMatch) return;
      if (phraseMatch.start > cursor) {
        fragments.push({
          text: line.slice(cursor, phraseMatch.start),
          changed: false,
        });
      }
      fragments.push({
        text: correctedText,
        changed: true,
        index: idx,
      });
      cursor = phraseMatch.end;
      matched = true;
    });

    if (cursor < line.length) {
      fragments.push({
        text: line.slice(cursor),
        changed: false,
      });
    }

    return matched ? fragments : [];
  }

  function findPhraseRange(lineText, phraseText, fromIndex = 0) {
    const line = String(lineText || "");
    const phrase = String(phraseText || "").trim();
    if (!line || !phrase) return null;

    let start = line.indexOf(phrase, Math.max(0, fromIndex));
    if (start >= 0) {
      return { start, end: start + phrase.length };
    }

    const lowerLine = line.toLowerCase();
    const lowerPhrase = phrase.toLowerCase();
    start = lowerLine.indexOf(lowerPhrase, Math.max(0, fromIndex));
    if (start >= 0) {
      return { start, end: start + phrase.length };
    }

    return null;
  }

  function showCorrectionPopup(anchorEl, segmentId) {
    const correction = sourceCorrectionCache.get(segmentId);
    const correctionIndex = parseInt(
      anchorEl?.dataset?.correctionIndex || "-1",
      10
    );
    const item = Array.isArray(correction?.corrections)
      ? correction.corrections[correctionIndex]
      : null;
    if (!item?.correctedText) return;
    ensureCorrectionPopup();
    if (!correctionPopup) return;
    correctionPopup.dataset.segmentId = segmentId || "";
    correctionPopup.innerHTML = `
      <div class="spt-correction-title">原文校正</div>
      <div class="spt-correction-label">原文片段</div>
      <div class="spt-correction-value">${escapeHtml(
        formatOriginalForDisplay(item.originalText || "")
      )}</div>
      <div class="spt-correction-label">校正后片段</div>
      <div class="spt-correction-value">${escapeHtml(
        formatOriginalForDisplay(item.correctedText)
      )}</div>
    `;
    correctionPopup.style.display = "block";
    positionCorrectionPopup(anchorEl);
  }

  function ensureCorrectionPopup() {
    if (correctionPopup) return;
    correctionPopup = document.createElement("div");
    correctionPopup.className = "spt-correction-popup";
    correctionPopup.style.display = "none";
    correctionPopup.addEventListener("mouseleave", () => {
      const segmentId = correctionPopup.dataset.segmentId || "";
      if (segmentId) {
        setCardCopyHintSuppressed(entryMap.get(segmentId), false);
      }
      hideCorrectionPopup();
    });
    document.documentElement.appendChild(correctionPopup);
    document.addEventListener("click", handleDocumentClickForCorrectionPopup);
    window.addEventListener("resize", hideCorrectionPopup);
    window.addEventListener("scroll", hideCorrectionPopup, true);
  }

  function handleDocumentClickForCorrectionPopup(event) {
    if (!correctionPopup || correctionPopup.style.display === "none") return;
    const target = event.target;
    if (correctionPopup.contains(target)) return;
    if (target?.closest?.(".spt-corrected-token")) return;
    hideCorrectionPopup();
  }

  function hideCorrectionPopup() {
    if (!correctionPopup) return;
    const segmentId = correctionPopup.dataset.segmentId || "";
    if (segmentId) {
      setCardCopyHintSuppressed(entryMap.get(segmentId), false);
    }
    correctionPopup.dataset.segmentId = "";
    correctionPopup.style.display = "none";
  }

  function positionCorrectionPopup(anchorEl) {
    if (!correctionPopup || !anchorEl) return;
    const rect = anchorEl.getBoundingClientRect();
    correctionPopup.style.visibility = "hidden";
    correctionPopup.style.left = "12px";
    correctionPopup.style.top = "12px";
    const popupWidth = correctionPopup.offsetWidth;
    const popupHeight = correctionPopup.offsetHeight;
    let left = Math.min(
      window.innerWidth - popupWidth - 12,
      Math.max(12, rect.left)
    );
    let top = rect.bottom + 10;
    if (top + popupHeight > window.innerHeight - 12) {
      top = Math.max(12, rect.top - popupHeight - 10);
    }
    correctionPopup.style.left = `${left}px`;
    correctionPopup.style.top = `${top}px`;
    correctionPopup.style.visibility = "visible";
  }

  function cleanTranslatedLine(line, originalTs) {
    let out = normalizeTimestampText((line || "").trim());
    // remove embedded line markers like <<LINE N>>
    out = out.replace(/<<\s*LINE\s*\d+\s*>>\s*/gi, "");
    // strip leading numbering like "1. " or "1) " or "1:" etc.
    out = out.replace(/^\d+\s*[\.\):\-](?:\s+|(?=[^\d]))/, "");
    // strip any leading timestamp-like pattern
    out = out.replace(/^(\d{1,2}:)?\d{1,2}:\d{2}\s*/, "");
    // if model echoed the original timestamp anywhere at the start, remove it
    const ts = normalizeTimestampText((originalTs || "").trim());
    if (ts && out.startsWith(ts)) {
      out = out.slice(ts.length).trim();
    }
    out = stripLocalizedTimestampPrefix(out, originalTs);
    // remove any duplicated timestamp prefix again
    out = out.replace(/^(\d{1,2}:)?\d{1,2}:\d{2}\s*/, "");
    return out;
  }

  function stripLocalizedTimestampPrefix(text, originalTs) {
    const out = String(text || "").trimStart();
    const totalSeconds = parseTimestampToSeconds(normalizeTimestampText(originalTs || ""));
    if (!out || totalSeconds == null) return out;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const variants = [];

    if (hours > 0) {
      variants.push(
        `${hours}小时${minutes}分${seconds}秒`,
        `${hours}小时${minutes}分钟${seconds}秒`,
        `${hours}小时${minutes}分`,
        `${hours}小时${minutes}分钟`
      );
      if (minutes === 0 && seconds === 0) {
        variants.push(`${hours}小时`);
      }
    } else if (minutes > 0) {
      variants.push(
        `${minutes}分${seconds}秒`,
        `${minutes}分钟${seconds}秒`,
        `${minutes}分`,
        `${minutes}分钟`
      );
    } else {
      variants.push(`${seconds}秒`, `${seconds}秒钟`);
    }

    for (const variant of variants) {
      if (!variant) continue;
      const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`^${escaped}(?=\\s|$|[\\p{P}\\p{S}])`, "u");
      if (pattern.test(out)) {
        return out.replace(pattern, "").trimStart();
      }
    }
    return out;
  }

  function normalizeTimestampText(text) {
    const raw = String(text || "").trim();
    if (!raw) return "";
    const normalizedColon = raw.replace(/：/g, ":");
    const parts = normalizedColon.match(
      /^(?:(\d{1,2})\s*小时\s*)?(?:(\d{1,2})\s*分(?:钟)?\s*)?(?:(\d{1,2})\s*秒(?:钟)?)?(.*)$/
    );
    if (parts && (parts[1] || parts[2] || parts[3])) {
      const hours = parts[1] ? parseInt(parts[1], 10) : 0;
      const minutes = parts[2] ? parseInt(parts[2], 10) : 0;
      const seconds = parts[3] ? parseInt(parts[3], 10) : 0;
      const suffix = parts[4] || "";
      return `${formatTimestamp(hours * 3600 + minutes * 60 + seconds)}${suffix}`;
    }
    return normalizedColon;
  }

  function ensureChunkBuffer(chunkId, expected) {
    const size = Math.max(1, expected || PREFETCH_AHEAD);
    const existing = chunkBuffers.get(chunkId);
    if (!existing) {
      chunkBuffers.set(chunkId, {
        expected: size,
        originals: Array(size).fill(""),
        translations: Array(size).fill(""),
        segments: Array(size).fill(null),
        finalized: false,
        published: false,
      });
      return;
    }
    if (size <= existing.expected) return;
    existing.expected = size;
    while (existing.originals.length < size) existing.originals.push("");
    while (existing.translations.length < size) existing.translations.push("");
    while (existing.segments.length < size) existing.segments.push(null);
  }

  function isChunkReady(buf) {
    if (!buf) return false;
    if (buf.finalized) return false;
    if (!buf.segments || !buf.translations) return false;
    if (buf.segments.length < buf.expected || buf.translations.length < buf.expected)
      return false;
    const filledSegments = buf.segments.every(Boolean);
    const filledTranslations = buf.translations.every(
      (t) => typeof t === "string" && t.trim().length > 0
    );
    return filledSegments && filledTranslations;
  }

  function chunkIndex(chunkId) {
    if (typeof chunkId === "number") return chunkId;
    const m = String(chunkId || "").match(/(\d+)/);
    return m ? parseInt(m[1], 10) : NaN;
  }

  function createOverlay() {
    const container = document.createElement("div");
    container.className = "spt-overlay";
    container.style.right = "20px";
    container.style.bottom = "20px";
    container.style.maxHeight = `${PANEL_HEIGHT_VH}vh`;
    container.style.width = `${PANEL_WIDTH_VW}vw`;
    container.innerHTML = `
      <div class="spt-header">
        <span class="spt-title">字幕上下文翻译</span>
        <div class="spt-actions">
          <button class="spt-font-dec" title="缩小字体">A-</button>
          <button class="spt-font-inc" title="放大字体">A+</button>
          <button class="spt-scroll-latest" title="回到最新字幕" aria-label="回到最新字幕">
            <span class="spt-icon">↓</span>
          </button>
          <button class="spt-open-options" title="设置" aria-label="设置">
            <span class="spt-icon">⚙</span>
          </button>
          <button class="spt-close" title="关闭悬浮窗">×</button>
        </div>
      </div>
      <div class="spt-status">等待捕获字幕… 请确保播放器打开了 Transcript.</div>
      <div class="spt-items"></div>
      <div class="spt-resize" title="拖动调整高度"></div>
      <div class="spt-resize-h" title="拖动调整宽度"></div>
    `;
    document.documentElement.appendChild(container);
    attachStyles();
    enableDrag(container);
    enableResize(container);
    enableResizeWidth(container);
    return container;
  }

  function setStatus(text, isError) {
    if (!statusEl) return;
    statusEl.textContent = text || "";
    statusEl.style.display = text ? "block" : "none";
    statusEl.style.color = isError ? "#d33" : "#222";
  }

  // 在 contentScript.js 中找到 attachStyles 函数
  function attachStyles() {
    if (document.getElementById("spt-style")) return;
    const style = document.createElement("style");
    style.id = "spt-style";
    style.textContent = `
      /* 容器：毛玻璃 + 圆润设计 */
      .spt-overlay {
        position: fixed;
        right: 20px;
        bottom: 20px;
        width: min(420px, 32vw);
        max-height: 70vh;
        /* 背景变淡，加模糊 */
        background: rgba(255, 255, 255, 0.75);
        backdrop-filter: blur(20px) saturate(180%);
        -webkit-backdrop-filter: blur(20px) saturate(180%);
        color: #1f2937;
        border: 1px solid rgba(255, 255, 255, 0.6);
        border-radius: 20px;
        /* 阴影更加弥散，高级感 */
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.1), 0 1px 2px rgba(0,0,0,0.05);
        z-index: 99999;
        display: flex;
        flex-direction: column;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        overflow: hidden;
        transition: opacity 0.2s, transform 0.2s;
      }

      /* 顶部标题栏：透明化，图标微调 */
      .spt-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        /* 只有淡淡的分隔线 */
        border-bottom: 1px solid rgba(0, 0, 0, 0.05);
        background: rgba(255, 255, 255, 0.4);
        font-weight: 600;
        font-size: 14px;
        color: #374151;
        cursor: move;
        user-select: none;
        font-family: inherit;
      }

      .spt-actions {
        display: flex;
        align-items: center;
        gap: 4px;
      }

      /* 按钮：去边框，加悬停效果 */
      .spt-actions button {
        border: none;
        background: transparent;
        border-radius: 8px;
        cursor: pointer;
        padding: 6px;
        color: #6b7280;
        transition: all 0.2s ease;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .spt-actions button:hover {
        background: rgba(0, 0, 0, 0.06);
        color: #111;
        transform: scale(1.05);
      }
      
      .spt-icon { font-size: 16px; line-height: 1; }
      .spt-scroll-latest .spt-icon { transform: translateY(-1px); }

      /* 状态栏 */
      .spt-status {
        padding: 8px 16px;
        font-size: 12px;
        color: #ef4444; /* 错误时显眼一点 */
        background: rgba(255,255,255,0.5);
        display: none;
        font-family: inherit;
      }

      /* 列表区域：隐藏滚动条但可滚动 */
      .spt-items {
        overflow-y: auto;
        padding: 10px 16px 16px 16px;
        gap: 16px; /* 增加间距 */
        display: flex;
        flex-direction: column-reverse;
        flex: 1;
        scrollbar-width: thin;
        scrollbar-color: rgba(0,0,0,0.1) transparent;
      }

      /* 美化滚动条 (Chrome/Safari) */
      .spt-items::-webkit-scrollbar {
        width: 4px;
      }
      .spt-items::-webkit-scrollbar-track {
        background: transparent;
      }
      .spt-items::-webkit-scrollbar-thumb {
        background-color: rgba(0, 0, 0, 0.1);
        border-radius: 4px;
      }

      /* 单条字幕：去掉边框，纯净风格 */
      .spt-item {
        border: none;
        background: transparent;
        padding: 0;
        /* 加一个左侧装饰线，提升层次感 */
        border-left: 3px solid transparent; 
        padding-left: 10px;
        transition: border-color 0.3s, background-color 0.2s ease, transform 0.15s ease;
        font-family: inherit;
        cursor: pointer;
        position: relative;
      }
      
      /* 鼠标悬停时显示一点点高亮 */
      .spt-item:hover {
        border-left-color: #6366f1; 
        background: rgba(99, 102, 241, 0.05);
      }

      .spt-item:active {
        transform: scale(0.995);
      }

      .spt-item[data-copy-state]:not([data-copy-state=""])::after {
        content: attr(data-copy-state);
        position: absolute;
        top: 2px;
        right: 4px;
        font-size: 11px;
        font-weight: 600;
        color: #059669;
        background: #d1fae5;
        padding: 4px 8px;
        border-radius: 6px;
        box-shadow: 0 2px 8px rgba(5, 150, 105, 0.15);
        z-index: 10;
        pointer-events: none;
        animation: 
          sptCopyBadgeIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) forwards,
          sptCopyBadgeOut 0.3s 0.9s ease-in forwards;
      }

      @keyframes sptCopyBadgeIn {
        0% { opacity: 0; transform: scale(0.9) translateY(4px); }
        100% { opacity: 1; transform: scale(1) translateY(0); }
      }

      @keyframes sptCopyBadgeOut {
        0% { opacity: 1; transform: scale(1) translateY(0); }
        100% { opacity: 0; transform: scale(0.9) translateY(-4px); }
      }

      /* 原文：调淡一点，作为辅助信息 */
      .spt-original {
        font-size: var(--spt-original-size, 12px);
        color: var(--spt-original-color, #0f172a); /* 可通过设置选择深色/绿色 */
        margin-bottom: 4px;
        line-height: 1.4;
        letter-spacing: 0.02em;
      }

      .spt-corrected-token {
        color: #2563eb;
        cursor: pointer;
        font-weight: 600;
        border-radius: 4px;
      }

      .spt-corrected-token:hover,
      .spt-corrected-token:focus {
        background: rgba(37, 99, 235, 0.12);
        outline: none;
      }

      /* 译文：深色，强调，加粗 */
      .spt-translation {
        font-size: var(--spt-translation-size, 14px);
        font-weight: 600;
        color: var(--spt-translation-color, #1f2937); /* 可通过设置选择深色/绿色 */
        line-height: 1.5;
        text-shadow: 0 1px 0 rgba(255,255,255,0.5); /* 增加一点立体感 */
      }

      /* 调整手柄 */
      .spt-resize {
        position: absolute; left: 0; right: 0; bottom: 0; height: 12px;
        cursor: ns-resize;
        background: linear-gradient(to top, rgba(0,0,0,0.03), transparent);
        z-index: 10;
      }
      .spt-resize-h {
        position: absolute; top: 0; bottom: 0; right: 0; width: 12px;
        cursor: ew-resize;
        background: linear-gradient(to left, rgba(0,0,0,0.03), transparent);
        z-index: 10;
      }

      .spt-correction-popup {
        position: fixed;
        z-index: 100000;
        max-width: min(360px, calc(100vw - 24px));
        padding: 12px;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.96);
        border: 1px solid rgba(37, 99, 235, 0.18);
        box-shadow: 0 10px 30px rgba(15, 23, 42, 0.16);
        color: #0f172a;
        font-size: 12px;
        line-height: 1.5;
      }

      .spt-correction-title {
        font-size: 13px;
        font-weight: 700;
        margin-bottom: 8px;
      }

      .spt-correction-label {
        font-size: 11px;
        font-weight: 700;
        color: #475569;
        margin-top: 8px;
      }

      .spt-correction-value {
        white-space: pre-wrap;
        word-break: break-word;
      }

      /* 移动端适配 */
      @media (max-width: 720px) {
        .spt-overlay {
          width: calc(100vw - 32px);
          right: 16px;
          bottom: 16px;
          border-radius: 16px;
        }
      }
    `;
    document.documentElement.appendChild(style);
  }

  function escapeHtml(str) {
    return (str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function enableDrag(container) {
    const header = container.querySelector(".spt-header");
    if (!header) return;

    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    header.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      isDragging = true;
      const rect = container.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      container.style.transition = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      e.preventDefault();
    });

    function onMove(e) {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const left = startLeft + dx;
      const top = startTop + dy;
      container.style.left = `${left}px`;
      container.style.top = `${top}px`;
      container.style.right = "";
      container.style.bottom = "";
      container.style.position = "fixed";
    }

    function onUp() {
      if (!isDragging) return;
      isDragging = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      savePosition(container);
    }
  }

  function enableResize(container) {
    const handle = container.querySelector(".spt-resize");
    if (!handle) return;
    let isResizing = false;
    let startY = 0;
    let startHeight = 0;

    handle.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      isResizing = true;
      startY = e.clientY;
      startHeight = container.getBoundingClientRect().height;
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      e.preventDefault();
    });

    function onMove(e) {
      if (!isResizing) return;
      const dy = e.clientY - startY;
      const newHeightPx = Math.max(200, startHeight + dy);
      const newVh = Math.min(
        95,
        Math.max(30, (newHeightPx / window.innerHeight) * 100)
      );
      PANEL_HEIGHT_VH = newVh;
      container.style.maxHeight = `${newVh}vh`;
      container.style.height = `${newHeightPx}px`;
    }

    function onUp() {
      if (!isResizing) return;
      isResizing = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      safeStorageSet({ panelHeightVh: Math.round(PANEL_HEIGHT_VH) });
    }
  }

  function enableResizeWidth(container) {
    const handle = container.querySelector(".spt-resize-h");
    if (!handle) return;
    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    handle.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      isResizing = true;
      startX = e.clientX;
      startWidth = container.getBoundingClientRect().width;
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      e.preventDefault();
    });

    function onMove(e) {
      if (!isResizing) return;
      const dx = e.clientX - startX;
      const newWidthPx = Math.max(220, startWidth + dx);
      const newVw = Math.min(
        90,
        Math.max(20, (newWidthPx / window.innerWidth) * 100)
      );
      PANEL_WIDTH_VW = newVw;
      container.style.width = `${newVw}vw`;
      container.style.maxWidth = `${newVw}vw`;
    }

    function onUp() {
      if (!isResizing) return;
      isResizing = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      safeStorageSet({ panelWidthVw: Math.round(PANEL_WIDTH_VW) });
    }
  }

  function savePosition(container) {
    const rect = container.getBoundingClientRect();
    const pos = { top: rect.top, left: rect.left };
    safeStorageSet({ [STORAGE_KEY_POSITION]: pos });
  }

  function loadPosition(container) {
    safeStorageGet({ [STORAGE_KEY_POSITION]: null }, (res) => {
      const pos = res?.[STORAGE_KEY_POSITION];
      if (!pos || typeof pos.top !== "number" || typeof pos.left !== "number")
        return;
      container.style.left = `${pos.left}px`;
      container.style.top = `${pos.top}px`;
      container.style.right = "";
      container.style.bottom = "";
      container.style.position = "fixed";
    });
  }

  function clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function applyFontSizes() {
    if (!overlay) return;
    overlay.style.setProperty("--spt-original-size", `${FONT_ORIGINAL}px`);
    overlay.style.setProperty("--spt-translation-size", `${FONT_TRANSLATION}px`);
  }

  function applyColorScheme(originalScheme, translationScheme) {
    if (!overlay) return;
    const orig = COLOR_MAP[originalScheme] || COLOR_MAP[DEFAULT_ORIGINAL_COLOR_SCHEME];
    const trans =
      COLOR_MAP[translationScheme] || COLOR_MAP[DEFAULT_TRANSLATION_COLOR_SCHEME];
    ORIGINAL_COLOR_SCHEME = originalScheme || DEFAULT_ORIGINAL_COLOR_SCHEME;
    TRANSLATION_COLOR_SCHEME = translationScheme || DEFAULT_TRANSLATION_COLOR_SCHEME;
    overlay.style.setProperty("--spt-original-color", orig.original);
    overlay.style.setProperty("--spt-translation-color", trans.translation);
    refreshEntryColors();
  }

  function refreshEntryColors() {
    if (!listEl) return;
    const items = listEl.querySelectorAll(".spt-translation");
    items.forEach((el) => {
      if (el.dataset.error === "1") return;
      el.style.color = "var(--spt-translation-color, #1f2937)";
    });
  }

  function adjustFont(delta) {
    FONT_ORIGINAL = clampInt(
      FONT_ORIGINAL + delta,
      10,
      22,
      DEFAULT_FONT_ORIGINAL
    );
    FONT_TRANSLATION = clampInt(
      FONT_TRANSLATION + delta,
      11,
      24,
      DEFAULT_FONT_TRANSLATION
    );
    applyFontSizes();
    safeStorageSet({
      fontOriginal: FONT_ORIGINAL,
      fontTranslation: FONT_TRANSLATION,
    });
  }

  function closeOverlay() {
    stopOverlayWork();
  }

  function reopenOverlay() {
    startOverlayWork();
  }
})();
