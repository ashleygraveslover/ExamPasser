(() => {
  const singletonKey = "__quickPeekAIContentLoaded";
  if (globalThis[singletonKey]) return;
  globalThis[singletonKey] = true;

  let host = null;
  let shadow = null;
  let label = null;
  let hideTimer = null;
  let renderVersion = 0;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "ping") {
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "get-selection") {
      sendResponse({ text: window.getSelection()?.toString() || "" });
      return;
    }
    if (message?.type === "get-test-options") {
      sendResponse({ options: collectTestOptions(), selectionMode: detectSelectionMode() });
      return;
    }
    if (message?.type === "show-loading") showLoading();
    if (message?.type === "show-result") showResult(message.text);
  });

  function ensureOverlay() {
    clearTimeout(hideTimer);
    if (host?.isConnected && label) {
      host.style.opacity = "1";
      return;
    }
    host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "position:fixed;bottom:8px;right:10px;z-index:2147483647;pointer-events:none;user-select:none;transition:opacity 220ms ease;opacity:1;";
    shadow = host.attachShadow({ mode: "closed" });
    label = document.createElement("span");
    label.style.cssText = "display:block;font:11px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace;color:#777;white-space:pre-wrap;max-width:50vw;overflow-wrap:anywhere;";
    shadow.append(label);
    (document.documentElement || document.body)?.append(host);
  }

  async function showLoading() {
    const version = ++renderVersion;
    ensureOverlay();
    label.textContent = "";
    label.style.width = "4px";
    label.style.height = "4px";
    label.style.borderRadius = "50%";
    label.style.background = "#777";
    label.style.opacity = "0.4";
    try {
      const settings = await chrome.storage.local.get({ opacity: 0.45 });
      if (version !== renderVersion || !label) return;
      const opacity = Number(settings.opacity);
      label.style.opacity = String(Number.isFinite(opacity) ? Math.min(1, Math.max(0.1, opacity)) : 0.45);
    } catch {
      // Keep the fallback loading-dot opacity when storage is unavailable.
    }
  }

  async function showResult(value) {
    const version = ++renderVersion;
    ensureOverlay();
    const settings = await chrome.storage.local.get({ opacity: 0.45 });
    if (version !== renderVersion || !label) return;
    const opacity = Number(settings.opacity);
    label.textContent = typeof value === "string" ? value : "?";
    label.style.width = "auto";
    label.style.height = "auto";
    label.style.borderRadius = "0";
    label.style.background = "transparent";
    label.style.opacity = String(Number.isFinite(opacity) ? Math.min(1, Math.max(0.1, opacity)) : 0.45);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!host) return;
      host.style.opacity = "0";
      hideTimer = setTimeout(() => {
        if (version !== renderVersion) return;
        host?.remove();
        host = null;
        shadow = null;
        label = null;
      }, 240);
    }, 5000);
  }

  function collectTestOptions() {
    const elements = [...document.querySelectorAll(
      'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]'
    )].filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const options = [];
    const seen = new Set();
    for (const element of elements) {
      const label = element.labels?.[0] || element.closest("label");
      const text = (label?.innerText || element.parentElement?.innerText || "")
        .replace(/\s+/g, " ")
        .trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      options.push(`${options.length + 1}. ${text.slice(0, 500)}`);
      if (options.length >= 20) break;
    }
    return options;
  }

  function detectSelectionMode() {
    const checkboxes = document.querySelectorAll('input[type="checkbox"], [role="checkbox"]');
    if (checkboxes.length > 0) return "multiple";
    const radios = document.querySelectorAll('input[type="radio"], [role="radio"]');
    if (radios.length > 0) return "single";
    return "unknown";
  }
})();
