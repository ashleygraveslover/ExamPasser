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
    if (message?.type === "get-capture-region") {
      const regionResult = findCaptureRegion();
      console.warn("ExamPasser: capture candidates", regionResult?.controls || 0, regionResult ? "region-found" : "no-region");
      sendResponse(regionResult);
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

  function findCaptureRegion() {
    const controls = getCaptureCandidates();

    if (controls.length < 2) return null;

    const groups = [];
    for (const item of controls.sort((a, b) => a.controlRect.top - b.controlRect.top)) {
      const previous = groups.at(-1);
      const previousBottom = previous ? Math.max(...previous.map(({ controlRect }) => controlRect.bottom)) : -Infinity;
      if (!previous || item.controlRect.top - previousBottom > 180) groups.push([item]);
      else previous.push(item);
    }

    const group = groups.sort((a, b) => b.length - a.length)[0];
    const rects = group.flatMap(({ controlRect, labelRect }) => [controlRect, labelRect].filter(Boolean));
    const left = Math.min(...rects.map((rect) => rect.left));
    const right = Math.max(...rects.map((rect) => rect.right));
    const top = Math.min(...rects.map((rect) => rect.top));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    const columnCount = countCoordinateClusters(group.map(({ controlRect }) => controlRect.left), 36);
    const isMatchingGrid = group.length >= 6 && columnCount >= 3;
    const topPadding = isMatchingGrid
      ? Math.min(520, Math.max(320, (bottom - top) * 3))
      : Math.min(220, Math.max(120, (bottom - top) * 0.8));
    const x = isMatchingGrid ? 0 : Math.max(0, left - 32);
    const y = Math.max(0, top - topPadding);
    const rightEdge = isMatchingGrid ? window.innerWidth : Math.min(window.innerWidth, right + 32);
    const bottomEdge = Math.min(window.innerHeight, bottom + 40);

    if (rightEdge - x < 120 || bottomEdge - y < 100) return null;
    return {
      x,
      y,
      width: rightEdge - x,
      height: bottomEdge - y,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      controls: group.length,
      layout: isMatchingGrid ? "matching-grid" : "control-group"
    };
  }

  function countCoordinateClusters(values, tolerance) {
    const sorted = [...values].sort((a, b) => a - b);
    let count = 0;
    let last = -Infinity;
    for (const value of sorted) {
      if (value - last > tolerance) {
        count += 1;
        last = value;
      }
    }
    return count;
  }

  function getCaptureCandidates() {
    const selector = [
      'input[type="radio"]',
      'input[type="checkbox"]',
      '[role="radio"]',
      '[role="checkbox"]',
      '[role="option"]',
      'button'
    ].join(",");
    const seen = new Set();
    const explicitCandidates = [...document.querySelectorAll(selector)].map((element) => {
      const controlRect = element.getBoundingClientRect();
      const label = element.labels?.[0] || element.closest("label");
      const labelRect = label && label !== element ? label.getBoundingClientRect() : null;
      const text = (label?.innerText || element.innerText || element.getAttribute("aria-label") || "")
        .replace(/\s+/g, " ")
        .trim();
      const key = `${Math.round(controlRect.left)}:${Math.round(controlRect.top)}:${Math.round(controlRect.width)}:${Math.round(controlRect.height)}:${text}`;
      const isButton = element.tagName === "BUTTON";
      const isOptionLike = !isButton || ["radio", "checkbox", "option"].includes(element.getAttribute("role"));
      if (!isOptionLike || !text || text.length > 500 || seen.has(key) || !isVisibleRect(controlRect)) return null;
      seen.add(key);
      return { controlRect, labelRect, text };
    }).filter(Boolean);
    if (explicitCandidates.length >= 2) return explicitCandidates;

    const heuristicCandidates = [...document.querySelectorAll("body *")].map((element) => {
      const rect = element.getBoundingClientRect();
      const text = (element.innerText || element.getAttribute("aria-label") || "")
        .replace(/\s+/g, " ")
        .trim();
      const classHint = `${element.className || ""} ${element.id || ""}`;
      const optionHint = /(option|answer|choice|variant|response|question)/i.test(classHint);
      const clickable = element.matches("[tabindex], [onclick], [data-option], [data-answer], [data-value]") ||
        getComputedStyle(element).cursor === "pointer";
      if (!text || text.length > 500 || rect.width < 120 || rect.height < 20 || rect.height > 180 ||
        rect.width > window.innerWidth * 0.98 || !isVisibleRect(rect) || (!optionHint && !clickable)) return null;
      return { controlRect: rect, labelRect: null, text, heuristic: true };
    }).filter(Boolean);
    const unique = new Map();
    for (const candidate of [...explicitCandidates, ...heuristicCandidates]) {
      const rect = candidate.controlRect;
      const key = `${Math.round(rect.left)}:${Math.round(rect.top)}:${Math.round(rect.width)}:${Math.round(rect.height)}:${candidate.text}`;
      if (!unique.has(key)) unique.set(key, candidate);
    }
    return [...unique.values()];
  }

  function isVisibleRect(rect) {
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
      rect.left < window.innerWidth && rect.top < window.innerHeight;
  }
})();
