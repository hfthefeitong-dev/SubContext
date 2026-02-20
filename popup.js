document.getElementById("openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

// 点击扩展图标打开弹窗时，自动请求当前标签页重新显示浮窗
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tabId = tabs?.[0]?.id;
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { type: "reopenOverlay" }, () => {
    // 忽略因没有注入 content script 或权限导致的错误
    void chrome.runtime.lastError;
  });
});
