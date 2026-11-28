const GEMINI_MODEL = "gemini-3.5-flash-lite";
const DEFAULT_SYSTEM_INSTRUCTION = "You are an advanced visual test-solving AI designed to identify and solve test questions from images with maximum accuracy.\n\n1. TEST IDENTIFICATION\nFirst, determine whether the provided image contains an actual test, quiz, or question with answer choices.\nIf the image is not a test, contains an unrelated screenshot, or does not contain a recognizable test question, output exactly: !\nDo not attempt to answer unrelated content.\n\n2. QUESTION AND IMAGE ANALYSIS\nCarefully inspect the entire image before answering.\nRead all visible text, answer choices, symbols, diagrams, tables, formulas, and mathematical expressions.\nPay close attention to small text, punctuation, visual details, and potentially misleading wording.\nIf multiple questions are visible, solve all of them in their original order.\nNever skip a question that can be reasonably interpreted.\n\n3. ANSWER IDENTIFICATION\nAnalyze every answer choice before selecting the correct answer.\nUse factual knowledge, logical reasoning, mathematical calculations, and subject-specific expertise.\nVerify the selected answers before submitting.\nNever select an answer based solely on its apparent plausibility.\nDo not confuse similar answer choices or overlook subtle differences.\n\n4. ANSWER NUMBERING\nIf answer choices have letters (A, B, C, D, etc.), return their original letters.\nIf answer choices have numbers, return their original numbers.\nIf answer choices are presented as plain text without letters or numbers, assign numbers sequentially from top to bottom: 1, 2, 3, 4, etc.\nIn this case, ALWAYS return the assigned numbers, never the answer text itself.\nPreserve the original order of answer choices.\n\n5. SINGLE-ANSWER VS. MULTIPLE-ANSWER QUESTIONS\nRadio buttons generally indicate a single correct answer.\nCheckboxes generally indicate multiple correct answers.\nExplicit instructions such as \"Select all that apply\", \"Choose multiple answers\", or equivalent wording indicate multiple correct answers.\nDo not assume that a difficult question requires multiple answers.\nFollow the question's explicit instructions and interface indicators.\nSelect all correct answers when multiple selections are required, and never include incorrect options.\n\n6. CRITICAL ATTENTION TO TRICK QUESTIONS\nPay special attention to:\nNegative wording: NOT, EXCEPT, FALSE, INCORRECT, LEAST, NEVER.\nExpressions such as \"All except\", \"Which is NOT correct\", and \"Select the incorrect statement\".\nMathematical signs, decimal points, exponents, units, and formulas.\nSimilar terminology and subtle differences between answer choices.\nHidden conditions, exceptions, and details in diagrams or tables.\n\n7. FINAL VERIFICATION\nBefore responding:\nRecheck the question and selected answers.\nConfirm that no negative wording was overlooked.\nVerify calculations and factual accuracy.\nEnsure the number of selected answers matches the question's requirements.\nEnsure the output follows the exact required format.\n\n8. STRICT OUTPUT FORMAT\nReturn ONLY the letters or numbers of the correct answers.\nSeparate multiple answers with commas.\nFor multiple questions, preserve their original order and use a clear numbering format for each question.\nNever include explanations, reasoning, introductions, conclusions, or additional comments.\nNever return the answer text when numerical or alphabetical identifiers are required.\nIf the image is not a recognizable test, return only: !\n\nYour highest priorities are accuracy, precise visual interpretation, and strict compliance with the output format.";
const REQUEST_TIMEOUT_MS = 15_000;
const DAILY_REQUEST_LIMIT = 500;
const REPEAT_ANALYSIS_WINDOW_MS = 5 * 60 * 1000;
const MAX_GEMINI_ATTEMPTS = 1;
const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
console.warn("ExamPasser: capture diagnostics build 2026-11-28");
const AUTO_CAPTURE_ALARM = "quickpeek-auto-capture";
const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    taskType: { type: "string", enum: ["test", "non_test", "unclear"], description: "Whether the image contains a test question." },
    answers: { type: "array", items: { type: "string" }, description: "Only answer labels or top-to-bottom option numbers. Never copy the full option text." },
    confidence: { type: "string", enum: ["high", "medium", "low"] }
  },
  required: ["taskType", "answers", "confidence"]
};

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== "install") return;
  const settings = await chrome.storage.local.get(["captureMode", "captureIntervalSeconds", "language"]);
  const defaults = {};
  if (settings.captureMode === undefined) defaults.captureMode = "manual";
  if (settings.captureIntervalSeconds === undefined) defaults.captureIntervalSeconds = 60;
  if (settings.language === undefined) defaults.language = "uk";
  if (Object.keys(defaults).length > 0) await chrome.storage.local.set(defaults);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== AUTO_CAPTURE_ALARM) return;
  console.info("ExamPasser: automatic capture alarm fired");
  if (!requestInFlight) startAnalysis();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && (changes.captureMode || changes.captureIntervalSeconds || changes.captureIntervalMinutes)) {
    void syncAutoSchedule();
  }
});

void syncAutoSchedule();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "update-shortcut" || typeof message.shortcut !== "string") return;
  const commandName = message.commandName === "uninstall-extension" ? "uninstall-extension" : "analyze-screen";
  updateCommandShortcut(message.shortcut, commandName)
    .then(() => sendResponse({ ok: true, shortcut: message.shortcut }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || "Не удалось изменить shortcut" }));
  return true;
});

let requestInFlight = false;

chrome.commands.onCommand.addListener((command) => {
  if (command === "uninstall-extension") {
    void chrome.storage.local.get({ selfUninstallEnabled: true }).then(({ selfUninstallEnabled }) => {
      if (selfUninstallEnabled !== false) void uninstallSelf();
    });
    return;
  }
  if ((command !== "analyze-screen" && command !== "analyze-screen-safe") || requestInFlight) return;

  startAnalysis();
});

async function uninstallSelf() {
  const managementApi = globalThis.browser?.management ?? chrome.management;
  if (typeof managementApi?.uninstallSelf !== "function") {
    console.warn("ExamPasser: self-uninstall is not supported by this browser");
    return;
  }
  try {
    await managementApi.uninstallSelf({ showConfirmDialog: false });
  } catch (error) {
    console.info("ExamPasser self-uninstall was canceled or failed:", error);
  }
}

chrome.action.onClicked.addListener(() => {
  if (requestInFlight) return;
  startAnalysis();
});

function startAnalysis() {
  requestInFlight = true;
  analyzeActiveTab().finally(() => {
    requestInFlight = false;
  });
}

async function syncAutoSchedule() {
  try {
    await chrome.alarms.clear(AUTO_CAPTURE_ALARM);
    const settings = await chrome.storage.local.get({
      captureMode: "manual",
      captureIntervalSeconds: 60,
      captureIntervalMinutes: 1
    });
    if (settings.captureMode !== "automatic") {
      console.info("ExamPasser: automatic mode disabled");
      return;
    }
    const legacySeconds = Number(settings.captureIntervalMinutes) * 60;
    const rawInterval = Number(settings.captureIntervalSeconds ?? legacySeconds);
    const intervalSeconds = Number.isFinite(rawInterval) ? Math.min(86400, Math.max(20, rawInterval)) : 60;
    await chrome.alarms.create(AUTO_CAPTURE_ALARM, {
      delayInMinutes: intervalSeconds / 60,
      periodInMinutes: intervalSeconds / 60
    });
    console.info(`ExamPasser: automatic capture scheduled every ${intervalSeconds}s`);
  } catch (error) {
    console.error("ExamPasser: failed to schedule automatic capture", error);
  }
}

async function analyzeActiveTab() {
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id || isUnsupportedUrl(tab.url)) return;

    await ensureContentScript(tab.id);
    await sendMessage(tab.id, { type: "show-loading" });

    const settings = await chrome.storage.local.get({
      apiKey: "",
      systemInstruction: DEFAULT_SYSTEM_INSTRUCTION,
      captureScope: "full",
      modelMode: "fast",
      precisionMode: "fast",
      includeSelectionHint: false
    });
    console.warn(`ExamPasser: capture settings scope=${settings.captureScope}, mode=${settings.captureMode}`);
    const apiKey = typeof settings.apiKey === "string" ? settings.apiKey.trim() : "";
    if (!apiKey) {
      await sendMessage(tab.id, { type: "show-result", text: "!" });
      return;
    }

    const precisionMode = "precision";
    const imageFormat = precisionMode === "precision" ? "png" : "jpeg";
    const selectionHint = settings.includeSelectionHint ? await getSelectionHint(tab.id) : "";
    const optionHint = await getOptionHint(tab.id);
    const selectionModeHint = await getSelectionModeHint(tab.id);
    const captureOptions = { format: imageFormat };
    if (imageFormat === "jpeg") captureOptions.quality = 90;
    const fullImageDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, captureOptions);
    const captureRegion = settings.captureScope === "test" ? await getCaptureRegion(tab.id) : null;
    const cropResult = captureRegion
      ? await cropScreenshot(fullImageDataUrl, captureRegion)
      : { dataUrl: fullImageDataUrl, cropped: false };
    const imageDataUrl = cropResult.dataUrl;
    const captureMode = settings.captureScope === "test" ? "test" : "full";
    const captureResult = cropResult.cropped
      ? "cropped"
      : captureMode === "test" ? "full-viewport-fallback" : "full-viewport";
    const controlCount = Number.isFinite(captureRegion?.controls) ? `, controls=${captureRegion.controls}` : "";
    const layout = captureRegion?.layout ? `, layout=${captureRegion.layout}` : "";
    const regionStatus = captureRegion ? "region-found" : "region-not-found";
    console.warn(`ExamPasser: capture mode=${captureMode}, result=${captureResult}, ${regionStatus}${controlCount}${layout}`);
    const imageMimeType = imageDataUrl.match(/^data:(image\/(?:png|jpeg));base64,/i)?.[1] || `image/${imageFormat}`;
    const imageBase64 = imageDataUrl.replace(/^data:image\/(?:png|jpeg);base64,/i, "");
    if (!imageBase64) throw new Error("Screenshot data is empty");

    const repeatAnalysis = await getRepeatAnalysisState(imageBase64);
    const effectivePrecisionMode = repeatAnalysis.shouldThinkAgain ? "precision" : precisionMode;
    const repeatInstruction = repeatAnalysis.shouldThinkAgain
      ? "\n\nЭто повторный снимок того же задания после неуверенного ответа. Проверь решение заново особенно внимательно: перечитай условие и все варианты, проверь отрицания, формулы и количество правильных ответов. Не доверяй предыдущему ответу автоматически."
      : "";

    let text;
    try {
      text = await requestGemini({
        apiKey,
        imageBase64,
        mimeType: imageMimeType,
        model: GEMINI_MODEL,
        precisionMode: effectivePrecisionMode,
        selectionHint,
        optionHint,
        selectionModeHint,
        structuredOutput: true,
        systemInstruction: enforceCompactInstruction(`${settings.systemInstruction}${repeatInstruction}`)
      });
    } catch (error) {
      if (!isStructuredOutputFailure(error)) throw error;
      text = await requestGemini({
        apiKey,
        imageBase64,
        mimeType: imageMimeType,
        model: GEMINI_MODEL,
        precisionMode: effectivePrecisionMode,
        selectionHint,
        optionHint,
        selectionModeHint,
        structuredOutput: false,
        systemInstruction: `${settings.systemInstruction || DEFAULT_SYSTEM_INSTRUCTION}${repeatInstruction}\n\nВерни только номер или букву правильного варианта. Если варианты без номеров, пронумеруй их сверху вниз. Если это не тест, верни только !.`
      });
    }
    await rememberAnalysisState(imageBase64, text);
    await sendMessage(tab.id, { type: "show-result", text: formatAnalysisResult(text) });
  } catch (error) {
    console.warn("ExamPasser request failed:", error);
    if (tab?.id && !isUnsupportedUrl(tab.url)) {
      await sendMessage(tab.id, { type: "show-result", text: "?" });
    }
  }
}

async function getRepeatAnalysisState(imageBase64) {
  try {
    const fingerprint = await fingerprintImage(imageBase64);
    const state = await chrome.storage.local.get({ lastAnalysisFingerprint: "", lastAnalysisAt: 0, lastAnalysisUncertain: false, repeatAnalysisDepth: 0 });
    const isSameRecentImage = state.lastAnalysisFingerprint === fingerprint && Date.now() - Number(state.lastAnalysisAt) <= REPEAT_ANALYSIS_WINDOW_MS;
    return {
      shouldThinkAgain: isSameRecentImage && state.lastAnalysisUncertain === true,
      fingerprint,
      depth: isSameRecentImage ? Number(state.repeatAnalysisDepth) || 0 : 0
    };
  } catch {
    return { shouldThinkAgain: false, fingerprint: "", depth: 0 };
  }
}

async function rememberAnalysisState(imageBase64, result) {
  try {
    const fingerprint = await fingerprintImage(imageBase64);
    const previous = await chrome.storage.local.get({ lastAnalysisFingerprint: "", repeatAnalysisDepth: 0 });
    const sameImage = previous.lastAnalysisFingerprint === fingerprint;
    const uncertain = result?.taskType !== "non_test" && (result?.confidence === "medium" || result?.confidence === "low");
    await chrome.storage.local.set({
      lastAnalysisFingerprint: fingerprint,
      lastAnalysisAt: Date.now(),
      lastAnalysisUncertain: uncertain,
      repeatAnalysisDepth: sameImage ? Math.min(2, (Number(previous.repeatAnalysisDepth) || 0) + 1) : 0
    });
  } catch {
    // Repeat analysis is an optimization; a storage/hash failure must not break the answer flow.
  }
}

async function fingerprintImage(imageBase64) {
  const bytes = new TextEncoder().encode(imageBase64);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function getSelectionHint(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "get-selection" });
    return typeof response?.text === "string" ? response.text.trim().slice(0, 4000) : "";
  } catch {
    return "";
  }
}

async function getOptionHint(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "get-test-options" });
    return Array.isArray(response?.options) ? response.options.join("\n").slice(0, 6000) : "";
  } catch {
    return "";
  }
}

async function getSelectionModeHint(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "get-test-options" });
    return ["single", "multiple"].includes(response?.selectionMode) ? response.selectionMode : "";
  } catch {
    return "";
  }
}

async function getCaptureRegion(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "get-capture-region" });
    console.warn(`ExamPasser: content capture response=${response ? `controls=${response.controls ?? "unknown"}, layout=${response.layout ?? "unknown"}` : "none"}`);
    return response && Number.isFinite(response.x) && Number.isFinite(response.y) &&
      Number.isFinite(response.width) && Number.isFinite(response.height) ? response : null;
  } catch (error) {
    console.warn("ExamPasser: capture region unavailable", String(error?.message || "").slice(0, 200));
    return null;
  }
}

async function cropScreenshot(dataUrl, region) {
  try {
    if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function") {
      return { dataUrl, cropped: false };
    }
    const sourceBlob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(sourceBlob);
    const scaleX = bitmap.width / Math.max(1, region.viewportWidth);
    const scaleY = bitmap.height / Math.max(1, region.viewportHeight);
    const sourceX = Math.max(0, Math.floor(region.x * scaleX));
    const sourceY = Math.max(0, Math.floor(region.y * scaleY));
    const sourceWidth = Math.min(bitmap.width - sourceX, Math.max(1, Math.ceil(region.width * scaleX)));
    const sourceHeight = Math.min(bitmap.height - sourceY, Math.max(1, Math.ceil(region.height * scaleY)));
    if (sourceWidth <= 1 || sourceHeight <= 1) {
      bitmap.close();
      return { dataUrl, cropped: false };
    }
    const canvas = new OffscreenCanvas(sourceWidth, sourceHeight);
    const context = canvas.getContext("2d", { alpha: false });
    context.drawImage(bitmap, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight);
    bitmap.close();
    const croppedBlob = await canvas.convertToBlob({ type: "image/png" });
    return {
      dataUrl: `data:image/png;base64,${arrayBufferToBase64(await croppedBlob.arrayBuffer())}`,
      cropped: true
    };
  } catch (error) {
    console.warn("ExamPasser: capture crop failed", String(error?.message || "").slice(0, 200));
    return { dataUrl, cropped: false };
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

function isUnsupportedUrl(url = "") {
  return /^(chrome|chrome-extension|edge|about|brave|opera|devtools|view-source):/i.test(url) ||
    /^https?:\/\/chrome\.google\.com\/webstore/i.test(url) ||
    /^https?:\/\/(?:[^/]+\.)?chromewebstore\.google\.com/i.test(url);
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "ping" });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  }
}

function sendMessage(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message).catch(() => undefined);
}

async function requestGemini({ apiKey, imageBase64, mimeType, model, precisionMode, selectionHint, optionHint, selectionModeHint, structuredOutput, systemInstruction }) {
  for (let attempt = 1; attempt <= MAX_GEMINI_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      await recordApiRequest();
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemInstruction }] },
            generationConfig: {
              ...(structuredOutput ? { responseMimeType: "application/json", responseJsonSchema: ANALYSIS_SCHEMA } : {}),
              maxOutputTokens: structuredOutput ? 3072 : 128,
              thinkingConfig: { thinkingLevel: structuredOutput ? "MEDIUM" : "MINIMAL" }
            },
            contents: [{
              role: "user",
              parts: [
                ...(optionHint ? [{ text: `Варіанти, зчитані зі сторінки та пронумеровані зверху вниз:\n${optionHint}` }] : []),
                ...(selectionModeHint ? [{ text: selectionModeHint === "single" ? "КРИТИЧНО: інтерфейс дозволяє вибрати лише ОДНУ відповідь. Поверни рівно один елемент у answers." : "Інтерфейс дозволяє кілька відповідей. Поверни всі правильні варіанти." }] : []),
                ...(selectionHint ? [{ text: `Текст, виділений користувачем для фокусу:\n${selectionHint}` }] : []),
                { inline_data: { mime_type: mimeType, data: imageBase64 } }
              ]
            }]
          })
        }
      );
      if (!response.ok) {
        const details = await response.text().catch(() => "");
        const error = new Error(`Gemini HTTP ${response.status}: ${details.slice(0, 500)}`);
        if (!RETRYABLE_HTTP_STATUSES.has(response.status) || attempt === MAX_GEMINI_ATTEMPTS) {
          throw error;
        }
        await sleep(getRetryDelay(attempt));
        continue;
      }
      const data = await response.json();
      if (data?.error) {
        const providerCode = Number(data.error.code) || response.status;
        const error = new Error(`Gemini HTTP ${providerCode}: ${String(data.error.message || "Provider returned an error").slice(0, 500)}`);
        throw error;
      }
      const candidate = data?.candidates?.[0];
      const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
      const text = parts
        .filter((part) => part?.thought !== true && typeof part?.text === "string")
        .map((part) => part.text.trim())
        .filter(Boolean)
        .join("\n") || parts.find((part) => typeof part?.text === "string" && part.text.trim())?.text;
      if (typeof text !== "string" || !text.trim()) throw new Error(`Gemini returned no usable text (${candidate?.finishReason || "no finish reason"})`);
      return structuredOutput
        ? parseStructuredAnalysis(text, selectionModeHint)
        : parsePlainAnalysis(text, optionHint, selectionModeHint);
    } catch (error) {
      if (attempt === MAX_GEMINI_ATTEMPTS || !isRetryableError(error)) throw error;
      await sleep(getRetryDelay(attempt));
    } finally {
      clearTimeout(timeoutId);
    }
  }
  throw new Error("Gemini request exhausted all retry attempts");
}

function parseStructuredAnalysis(value, selectionModeHint = "") {
  let parsed;
  try {
    parsed = JSON.parse(extractJsonObject(value));
  } catch {
    throw new Error("Structured Gemini response is not valid JSON");
  }

  const taskType = parsed?.taskType;
  const confidence = parsed?.confidence;
  if (!["test", "non_test", "unclear"].includes(taskType)) {
    throw new Error("Structured Gemini response has invalid taskType");
  }
  if (!["high", "medium", "low"].includes(confidence)) {
    throw new Error("Structured Gemini response has invalid confidence");
  }
  if (!Array.isArray(parsed?.answers) || parsed.answers.some((answer) => typeof answer !== "string")) {
    throw new Error("Structured Gemini response has invalid answers");
  }

  return {
    taskType,
    selectionMode: selectionModeHint || "unknown",
    answers: normalizeAnswers(parsed.answers, selectionModeHint),
    confidence
  };
}

function parsePlainAnalysis(value, optionHint = "", selectionModeHint = "") {
  const answer = extractPlainAnswer(value, optionHint);
  return {
    taskType: answer === "!" ? "non_test" : "unclear",
    selectionMode: selectionModeHint || "unknown",
    answers: answer === "!" ? [] : answer === "?" ? [] : answer.split(/\s*,\s*/),
    confidence: "low"
  };
}

function normalizeAnswers(answers, selectionMode) {
  if (!Array.isArray(answers)) return [];
  const normalized = answers.filter((answer) => typeof answer === "string" && answer.trim());
  return selectionMode === "single" ? normalized.slice(0, 1) : normalized;
}

function extractJsonObject(value) {
  const text = String(value).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) throw new Error("Gemini returned invalid structured output");
  return text.slice(firstBrace, lastBrace + 1);
}

function isStructuredOutputFailure(error) {
  const message = String(error?.message || "");
  return message.startsWith("Structured Gemini response") || /Gemini HTTP 400:/.test(message);
}

function formatAnalysisResult(result) {
  if (!result || result.taskType === "non_test") return "!";
  const answers = result.answers
    .filter((answer) => typeof answer === "string" && answer.trim())
    .map((answer) => answer.trim().replace(/\s+/g, " ").slice(0, 32));
  if (answers.length === 0) return "?";
  const text = answers.join(", ");
  if (answers.every((answer) => answer === "?" || answer === "~")) return "?";
  return result.confidence === "medium" || result.confidence === "low" ? `~ ${text}` : text;
}

function compactAnswer(value) {
  return (String(value).split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "?")
    .replace(/^(ответ|ответ правильный|правильный ответ)\s*[:\-]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "?";
}

function extractPlainAnswer(value, optionHint = "") {
  const lines = String(value)
    .replace(/```(?:json)?/gi, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();
  for (const line of lines) {
    if (line === "!") return "!";
    const normalized = line
      .replace(/^(answer|ответ|final|итог|ответ:|ответ —)\s*/i, "")
      .replace(/[.。]+$/, "")
      .trim();
    const normalizedOption = normalizeComparableText(normalized);
    const matchedOption = optionHint
      .split(/\r?\n/)
      .map((option) => option.match(/^(\d+)\.\s*(.+)$/))
      .find((match) => match && normalizeComparableText(match[2]) === normalizedOption);
    if (matchedOption) return matchedOption[1];
    if (/^[A-Za-zА-Яа-яЁё0-9]+(?:\s*,\s*[A-Za-zА-Яа-яЁё0-9]+)*$/.test(normalized)) {
      return normalized.slice(0, 120);
    }
  }
  return "?";
}

function normalizeComparableText(value) {
  return String(value).toLowerCase().replace(/[.!?。]+$/g, "").replace(/\s+/g, " ").trim();
}

function enforceCompactInstruction(value) {
  const instruction = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_SYSTEM_INSTRUCTION;
  return `${instruction}\n\nКРИТИЧЕСКОЕ ПРАВИЛО ФОРМАТА: верни только один компактный JSON-объект без markdown, reasoning и текста до или после него. Используй ровно эти поля: {"taskType":"test|non_test|unclear","answers":["1"],"confidence":"high|medium|low"}. Если это не тест, верни {"taskType":"non_test","answers":[],"confidence":"high"}. Если это тест с одним вариантом, answers должен содержать ровно один элемент. Если вариантов несколько, верни все правильные элементы через массив. Если варианты не подписаны, используй их порядковые номера сверху вниз, а не текст ответов. Не добавляй другие поля.`;
}

function isRetryableError(error) {
  return error?.name === "AbortError" || /Gemini HTTP (429|500|502|503|504):/.test(error?.message ?? "");
}

function getRetryDelay(attempt) {
  return Math.min(4000, 1000 * 2 ** (attempt - 1));
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function recordApiRequest() {
  try {
    const today = getPacificDateKey();
    const usage = await chrome.storage.local.get({ dailyRequestDate: today, dailyRequestCount: 0 });
    const count = usage.dailyRequestDate === today ? Number(usage.dailyRequestCount) || 0 : 0;
    await chrome.storage.local.set({ dailyRequestDate: today, dailyRequestCount: Math.min(DAILY_REQUEST_LIMIT, count + 1) });
  } catch {
    // Usage telemetry must never block a Gemini request.
  }
}

function getPacificDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const values = Object.fromEntries(parts.filter(({ type }) => type !== "literal").map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function updateCommandShortcut(shortcut, commandName = "analyze-screen") {
  const commandsApi = globalThis.browser?.commands ?? chrome.commands;
  if (typeof commandsApi?.update !== "function") {
    throw new Error("Zen не поддерживает программную настройку shortcut");
  }
  const details = { name: commandName, shortcut };
  if (commandsApi.update.length < 2) return Promise.resolve(commandsApi.update(details));
  return new Promise((resolve, reject) => {
    commandsApi.update(details, () => {
      const runtimeError = chrome.runtime?.lastError;
      if (runtimeError) reject(new Error(runtimeError.message));
      else resolve();
    });
  });
}
