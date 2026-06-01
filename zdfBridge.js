(() => {
  const KEY = "__spt_zdf_resource_hints__";
  window[KEY] = window[KEY] || [];

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.source !== "spt-zdf-hook") return;
    const item = {
      url: String(message.url || ""),
      contentType: String(message.contentType || ""),
      text: String(message.text || ""),
      createdAt: Date.now(),
    };
    if (!item.url && !item.text) return;
    window[KEY].push(item);
    if (window[KEY].length > 80) {
      window[KEY].splice(0, window[KEY].length - 80);
    }
  });
})();
