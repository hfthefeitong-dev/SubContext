(() => {
  const MAX_TEXT_LENGTH = 500000;
  const INTERESTING_URL_RE =
    /zdf|cellular|ptmd|caption|subtitle|untertitel|webvtt|\.vtt|\.ttml|\.dfxp|\.srt|\.m3u8|\.mpd|document|content|player|mediathek|api/i;
  const INTERESTING_TEXT_RE =
    /"captions"|caption|subtitle|untertitel|ptmd|WEBVTT|<tt[\s>]|<MPD[\s>]|#EXTM3U/i;

  function postHint(url, contentType, text) {
    const rawText = String(text || "");
    if (!INTERESTING_URL_RE.test(url || "") && !INTERESTING_TEXT_RE.test(rawText)) {
      return;
    }
    window.postMessage(
      {
        source: "spt-zdf-hook",
        url: String(url || ""),
        contentType: String(contentType || ""),
        text: rawText.slice(0, MAX_TEXT_LENGTH),
      },
      "*"
    );
  }

  function shouldRead(url, contentType) {
    return (
      INTERESTING_URL_RE.test(String(url || "")) ||
      /json|xml|text|vtt|dash|mpegurl/i.test(String(contentType || ""))
    );
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = async function (...args) {
      const response = await originalFetch.apply(this, args);
      try {
        const url = response?.url || String(args?.[0]?.url || args?.[0] || "");
        const contentType = response?.headers?.get?.("content-type") || "";
        if (shouldRead(url, contentType)) {
          response
            .clone()
            .text()
            .then((text) => postHint(url, contentType, text))
            .catch(() => {});
        }
      } catch (_) {
        // keep page fetch behavior untouched
      }
      return response;
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__sptZdfUrl = String(url || "");
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", () => {
      try {
        const url = this.responseURL || this.__sptZdfUrl || "";
        const contentType = this.getResponseHeader("content-type") || "";
        if (!shouldRead(url, contentType)) return;
        if (typeof this.responseText === "string") {
          postHint(url, contentType, this.responseText);
        }
      } catch (_) {
        // reading responseText can throw for binary responses
      }
    });
    return originalSend.apply(this, args);
  };
})();
