let getContextFn = null;
let eventTypesCache = null;
async function initSTEnvironment() {
  const globalCtx = globalThis.getContext;
  if (typeof globalCtx === "function") {
    getContextFn = globalCtx;
    return true;
  }
  try {
    const modulePath = "../../../extensions.js";
    const extensionsModule = await import(
      /* @vite-ignore */
      modulePath
    );
    if (typeof extensionsModule.getContext === "function") {
      getContextFn = extensionsModule.getContext;
      return true;
    }
  } catch {
    console.warn("[ST-Story-Illustrator] 无法加载 SillyTavern extensions.js，扩展将在降级模式下运行。");
  }
  return false;
}
function getContext() {
  if (getContextFn) {
    try {
      return getContextFn();
    } catch {
    }
  }
  return {
    chat: [],
    chatId: void 0,
    eventSource: void 0,
    eventTypes: {},
    extensionSettings: {}
  };
}
function getCurrentChatId() {
  const ctx = getContext();
  if (typeof ctx.getCurrentChatId === "function") {
    try {
      return ctx.getCurrentChatId() ?? "";
    } catch {
    }
  }
  return ctx.chatId ?? "";
}
function getChat() {
  return getContext().chat ?? [];
}
function getMessage(floor) {
  const chat = getChat();
  if (floor < 0 || floor >= chat.length) return void 0;
  return chat[floor];
}
function getEventTypes() {
  if (eventTypesCache) return eventTypesCache;
  const ctx = getContext();
  const fromST = ctx.eventTypes ?? {};
  eventTypesCache = {
    // 从 ST 获取
    ...fromST,
    // 硬编码兜底（确保关键事件存在）
    MESSAGE_RECEIVED: fromST.MESSAGE_RECEIVED ?? "message_received",
    MESSAGE_SENT: fromST.MESSAGE_SENT ?? "message_sent",
    GENERATION_ENDED: fromST.GENERATION_ENDED ?? "generation_ended",
    CHARACTER_MESSAGE_RENDERED: fromST.CHARACTER_MESSAGE_RENDERED ?? "character_message_rendered",
    USER_MESSAGE_RENDERED: fromST.USER_MESSAGE_RENDERED ?? "user_message_rendered",
    MESSAGE_SWIPED: fromST.MESSAGE_SWIPED ?? "message_swiped",
    MESSAGE_UPDATED: fromST.MESSAGE_UPDATED ?? "message_updated",
    MESSAGE_DELETED: fromST.MESSAGE_DELETED ?? "message_deleted",
    MESSAGE_EDITED: fromST.MESSAGE_EDITED ?? "message_edited",
    CHAT_CHANGED: fromST.CHAT_CHANGED ?? "chat_id_changed",
    CHAT_DELETED: fromST.CHAT_DELETED ?? "chat_deleted",
    APP_READY: fromST.APP_READY ?? "app_ready",
    EXTENSION_SETTINGS_LOADED: fromST.EXTENSION_SETTINGS_LOADED ?? "extension_settings_loaded"
  };
  return eventTypesCache;
}
function on(eventName, callback) {
  const ctx = getContext();
  const source = ctx.eventSource;
  if (!source || typeof source.on !== "function") {
    console.warn(`[ST-Story-Illustrator] eventSource 不可用，无法监听 ${eventName}`);
    return () => {
    };
  }
  source.on(eventName, callback);
  return () => {
    var _a;
    try {
      (_a = source.off) == null ? void 0 : _a.call(source, eventName, callback);
    } catch {
    }
  };
}
const SETTINGS_KEY = "STStoryIllustrator";
function getSettings(defaults) {
  const ctx = getContext();
  const settings2 = ctx.extensionSettings ?? {};
  const stored = settings2[SETTINGS_KEY];
  if (!stored || typeof stored !== "object") {
    return { ...defaults };
  }
  return { ...defaults, ...stored };
}
function saveSettings(settings2) {
  const ctx = getContext();
  if (!ctx.extensionSettings) {
    ctx.extensionSettings = {};
  }
  ctx.extensionSettings[SETTINGS_KEY] = settings2;
  if (typeof ctx.saveSettingsDebounced === "function") {
    ctx.saveSettingsDebounced();
  }
}
function getChatMetadata(key, defaults) {
  const ctx = getContext();
  const meta = ctx.chatMetadata ?? {};
  const stored = meta[key];
  if (stored === void 0) return defaults;
  return stored;
}
function saveChatMetadata(key, value) {
  const ctx = getContext();
  if (!ctx.chatMetadata) {
    ctx.chatMetadata = {};
  }
  ctx.chatMetadata[key] = value;
  if (typeof ctx.saveMetadataDebounced === "function") {
    ctx.saveMetadataDebounced();
  }
}
async function generateQuietPrompt(prompt, options) {
  const ctx = getContext();
  if (typeof ctx.generateQuietPrompt !== "function") {
    throw new Error("SillyTavern generateQuietPrompt 不可用");
  }
  return await ctx.generateQuietPrompt(prompt, options);
}
function getSendDate(floor) {
  const msg = getMessage(floor);
  const d = msg == null ? void 0 : msg.send_date;
  return typeof d === "string" ? d.trim() : "";
}
function getSwipeId(floor) {
  const msg = getMessage(floor);
  return typeof (msg == null ? void 0 : msg.swipe_id) === "number" ? msg.swipe_id : 0;
}
function stillCurrent(chatId, floor, swipe, sendDate) {
  if (getCurrentChatId() !== chatId) return false;
  const msg = getMessage(floor);
  if (!msg) return false;
  if (sendDate) {
    const actual = typeof msg.send_date === "string" ? msg.send_date.trim() : "";
    if (actual && actual !== sendDate) return false;
  }
  const currentSwipe = typeof msg.swipe_id === "number" ? msg.swipe_id : 0;
  if (currentSwipe !== swipe) return false;
  return true;
}
const MIN_API_VERSION = "1";
const MAX_WAIT_ATTEMPTS = 20;
const WAIT_INTERVAL_MS = 500;
let cachedApi = null;
let cachedAvailability = null;
function compareVersions(a, b) {
  const parseVersion = (v) => {
    return v.split(".").map((part) => {
      const num = parseInt(part, 10);
      return isNaN(num) ? 0 : num;
    });
  };
  const partsA = parseVersion(a);
  const partsB = parseVersion(b);
  const maxLen = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < maxLen; i++) {
    const va = partsA[i] ?? 0;
    const vb = partsB[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}
function checkAvailability() {
  if (cachedApi && typeof globalThis !== "undefined") {
    const current = globalThis.STBaiBaiImage;
    if (current === cachedApi) {
      return cachedAvailability;
    }
  }
  if (typeof globalThis === "undefined") {
    cachedAvailability = { status: "error", message: "globalThis not available" };
    return cachedAvailability;
  }
  const raw = globalThis.STBaiBaiImage;
  if (!raw || typeof raw !== "object") {
    cachedApi = null;
    cachedAvailability = { status: "not_installed" };
    return cachedAvailability;
  }
  const api = raw;
  if (typeof api.apiVersion !== "number" && typeof api.apiVersion !== "string") {
    cachedApi = null;
    cachedAvailability = { status: "version_mismatch", apiVersion: "unknown" };
    return cachedAvailability;
  }
  const versionStr = String(api.apiVersion);
  if (compareVersions(versionStr, MIN_API_VERSION) < 0) {
    cachedApi = null;
    cachedAvailability = { status: "version_mismatch", apiVersion: versionStr };
    return cachedAvailability;
  }
  cachedApi = api;
  cachedAvailability = { status: "available", api };
  return cachedAvailability;
}
async function waitForApi(maxAttempts = MAX_WAIT_ATTEMPTS) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = checkAvailability();
    if (result.status === "available") {
      return result;
    }
    if (result.status === "version_mismatch" || result.status === "error") {
      return result;
    }
    await sleep(WAIT_INTERVAL_MS);
  }
  return { status: "not_installed" };
}
function getApi() {
  const result = checkAvailability();
  if (result.status === "available") {
    return result.api;
  }
  throw new BaiBaiApiError(result);
}
function isAvailable() {
  return checkAvailability().status === "available";
}
async function getCharacters(floor) {
  if (!isAvailable()) {
    return { apiVersion: 1, pluginVersion: "", revision: 0, floor: null, characters: [] };
  }
  try {
    const api = getApi();
    return await api.getCharacters(floor !== void 0 ? { floor } : {});
  } catch {
    return { apiVersion: 1, pluginVersion: "", revision: 0, floor: null, characters: [] };
  }
}
async function generateImage(request, options) {
  const api = getApi();
  return await api.generate(request, options);
}
class BaiBaiApiError extends Error {
  constructor(availability) {
    let message;
    switch (availability.status) {
      case "not_installed":
        message = "柏宝绘未安装或未加载。请先安装并启用柏宝绘扩展。";
        break;
      case "version_mismatch":
        message = `柏宝绘 API 版本不兼容（当前 ${availability.apiVersion}，需要 >= ${MIN_API_VERSION}）。`;
        break;
      case "error":
        message = availability.message;
        break;
      default:
        message = "柏宝绘 API 不可用。";
    }
    super(message);
    this.name = "BaiBaiApiError";
    this.availability = availability;
  }
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
const MES_SELECTOR = ".mes";
const MIN_SELECTION_LENGTH = 2;
function isSelectionInMesText(selection) {
  var _a;
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  if (range.collapsed) return false;
  const text = selection.toString().trim();
  if (text.length < MIN_SELECTION_LENGTH) return false;
  let container = range.commonAncestorContainer;
  if (container && container.nodeType === Node.TEXT_NODE) {
    container = container.parentNode;
  }
  while (container && container !== document.body) {
    if (container instanceof HTMLElement) {
      if ((_a = container.classList) == null ? void 0 : _a.contains("mes_text")) {
        const mes = container.closest(MES_SELECTOR);
        if (mes) return true;
      }
    }
    container = container.parentNode;
  }
  return false;
}
function getMesTextFromSelection(selection) {
  var _a;
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  let container = range.commonAncestorContainer;
  if (container && container.nodeType === Node.TEXT_NODE) {
    container = container.parentNode;
  }
  while (container && container !== document.body) {
    if (container instanceof HTMLElement && ((_a = container.classList) == null ? void 0 : _a.contains("mes_text"))) {
      return container;
    }
    container = container.parentNode;
  }
  return null;
}
function getMesFromSelection(selection) {
  const mesText = getMesTextFromSelection(selection);
  if (!mesText) return null;
  return mesText.closest(MES_SELECTOR);
}
function getSelectionText(selection) {
  return selection.toString().trim();
}
let documentListener = null;
function startSelectionListener(callback) {
  stopSelectionListener();
  const handler = () => {
    const selection = window.getSelection();
    if (!selection) {
      callback(false, null);
      return;
    }
    const valid = isSelectionInMesText(selection);
    callback(valid, valid ? selection : null);
  };
  document.addEventListener("selectionchange", handler);
  document.addEventListener("mouseup", handler);
  documentListener = () => {
    document.removeEventListener("selectionchange", handler);
    document.removeEventListener("mouseup", handler);
  };
}
function stopSelectionListener() {
  if (documentListener) {
    documentListener();
    documentListener = null;
  }
}
const MESID_ATTR = "mesid";
function resolveFloorFromSelection(selection) {
  const mes = getMesFromSelection(selection);
  if (!mes) return null;
  return resolveFloorFromMesElement(mes);
}
function resolveFloorFromMesElement(mes) {
  const mesidAttr = mes.getAttribute(MESID_ATTR);
  if (mesidAttr === null) return null;
  const mesId = parseInt(mesidAttr, 10);
  if (!Number.isFinite(mesId) || mesId < 0) return null;
  const chatId = getCurrentChatId();
  if (!chatId) return null;
  const swipeId = getSwipeId(mesId);
  return {
    chatId,
    mesId,
    swipeId,
    mesElement: mes
  };
}
const ANCHOR_LENGTH = 60;
const MAX_SELECTED_TEXT = 2e3;
function buildAnchor(selectedText, floorText, paragraphIndex) {
  const cleanSelected = selectedText.slice(0, MAX_SELECTED_TEXT);
  const selectionStart = floorText.indexOf(cleanSelected);
  let beforeAnchor = "";
  let afterAnchor = "";
  let startOffset;
  let endOffset;
  if (selectionStart >= 0) {
    startOffset = selectionStart;
    endOffset = selectionStart + cleanSelected.length;
    beforeAnchor = floorText.slice(Math.max(0, selectionStart - ANCHOR_LENGTH), selectionStart);
    afterAnchor = floorText.slice(endOffset, Math.min(floorText.length, endOffset + ANCHOR_LENGTH));
  } else {
    const fuzzyKey = cleanSelected.slice(0, 30);
    const fuzzyStart = floorText.indexOf(fuzzyKey);
    if (fuzzyStart >= 0) {
      startOffset = fuzzyStart;
      endOffset = fuzzyStart + cleanSelected.length;
      beforeAnchor = floorText.slice(Math.max(0, fuzzyStart - ANCHOR_LENGTH), fuzzyStart);
      afterAnchor = floorText.slice(endOffset, Math.min(floorText.length, endOffset + ANCHOR_LENGTH));
    }
  }
  return {
    selectedText: cleanSelected,
    beforeAnchor,
    afterAnchor,
    paragraphIndex,
    startOffset,
    endOffset
  };
}
function extractPlainText(mesText) {
  const clone = mesText.cloneNode(true);
  clone.querySelectorAll("bbi_image").forEach((el) => el.remove());
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}
const TOOLBAR_ID = "sti-selection-toolbar";
const TOOLBAR_CLASS = "sti-selection-toolbar";
const TOOLBAR_BUTTON_CLASS = "sti-toolbar-btn";
let toolbarElement = null;
let onGenerateCallback = null;
function ensureToolbar() {
  if (toolbarElement && document.body.contains(toolbarElement)) {
    return toolbarElement;
  }
  const toolbar = document.createElement("div");
  toolbar.id = TOOLBAR_ID;
  toolbar.className = TOOLBAR_CLASS;
  toolbar.style.display = "none";
  const button = document.createElement("button");
  button.className = TOOLBAR_BUTTON_CLASS;
  button.type = "button";
  button.textContent = "生成配图";
  button.addEventListener("mousedown", (e) => {
    e.preventDefault();
  });
  button.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (onGenerateCallback) {
      onGenerateCallback();
    }
  });
  toolbar.appendChild(button);
  document.body.appendChild(toolbar);
  toolbarElement = toolbar;
  return toolbar;
}
function showToolbar(selection) {
  const toolbar = ensureToolbar();
  if (selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  const top = rect.top + window.scrollY - 40;
  const left = rect.left + window.scrollX + rect.width / 2;
  toolbar.style.display = "flex";
  toolbar.style.top = `${Math.max(0, top)}px`;
  toolbar.style.left = `${left}px`;
}
function hideToolbar() {
  if (toolbarElement) {
    toolbarElement.style.display = "none";
  }
}
function setOnGenerate(callback) {
  onGenerateCallback = callback;
}
function destroyToolbar() {
  if (toolbarElement) {
    toolbarElement.remove();
    toolbarElement = null;
  }
  onGenerateCallback = null;
}
function defaultMountMode(mode) {
  switch (mode) {
    case "illustration":
    case "comic":
      return "inline";
    case "chibi-status":
    case "chibi-bonus":
    case "bw-manga":
      return "trailing";
    default:
      return "trailing";
  }
}
function defaultModeSettings(mode) {
  const base = {
    enabled: false,
    autoTrigger: false,
    profileId: "",
    shots: 1
  };
  switch (mode) {
    case "illustration":
      return { ...base, enabled: true, illustrationMultiImage: false };
    case "comic":
      return {
        ...base,
        comicLayout: "regular",
        comicPageType: "auto",
        comicMaxPages: 1,
        comicDialoguePolicy: "auto",
        comicBubbleStyle: "classic",
        comicBubbleFont: "sans",
        comicShowComposite: true
      };
    case "chibi-status":
      return { ...base, chibiStyle: "card" };
    case "chibi-bonus":
      return { ...base, chibiBonusChance: 25 };
    case "bw-manga":
      return { ...base, bwMangaSafeMode: true, bwMangaArtistId: "" };
    default:
      return base;
  }
}
const DEFAULT_SETTINGS = {
  enabled: false,
  contextRange: 1,
  includeChinese: true,
  includeNl: false,
  syncBaiBaiExcludes: true,
  preferContentTag: true,
  llmSource: "auto",
  // 默认不指定，走 llmSource('auto' → 柏宝绘 tagGen 渠道)；用户在弹窗里可为每个模式分别指派
  modeChannels: {},
  modes: {
    "illustration": defaultModeSettings("illustration"),
    "comic": defaultModeSettings("comic"),
    "chibi-status": defaultModeSettings("chibi-status"),
    "chibi-bonus": defaultModeSettings("chibi-bonus"),
    "bw-manga": defaultModeSettings("bw-manga")
  },
  profiles: [],
  // 遗留字段
  chibiMode: false,
  chibiStatusBar: false,
  chibiStatusShots: 1,
  chibiStatusStyle: "card",
  chibiBonusEnabled: false,
  chibiBonusChance: 25,
  chibiBonusShots: 1,
  mangaEnabled: false,
  mangaShots: 1,
  mangaSafe: true,
  mangaArtistId: "",
  panelMode: false,
  panelLayout: "regular",
  panelPageType: "auto",
  dialogueEnabled: false,
  dialoguePolicy: "auto",
  bubbleStyle: "classic",
  bubbleFont: "sans"
};
const CHANNELS_KEY = "baibai_api_channels";
const IMAGE_SETTINGS_KEY = "baibai_image";
const CHAT_COMPLETIONS_URL = "/api/backends/chat-completions/generate";
function normalizeChannel(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const c = raw;
  const id = typeof c.id === "string" ? c.id.trim() : "";
  const url = typeof c.url === "string" ? c.url.trim() : "";
  if (!id || !url) return null;
  return {
    id,
    name: typeof c.name === "string" && c.name.trim() ? c.name.trim() : id,
    url,
    key: typeof c.key === "string" ? c.key : "",
    model: typeof c.model === "string" ? c.model.trim() : "",
    temperature: typeof c.temperature === "number" && Number.isFinite(c.temperature) ? c.temperature : 1,
    maxTokens: typeof c.maxTokens === "number" && c.maxTokens > 0 ? Math.floor(c.maxTokens) : 65535,
    timeoutSec: typeof c.timeoutSec === "number" && c.timeoutSec > 0 ? Math.floor(c.timeoutSec) : 180,
    stream: typeof c.stream === "boolean" ? c.stream : false,
    excludeParams: Array.isArray(c.excludeParams) ? c.excludeParams.filter((x) => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()) : [],
    reasoningEffort: typeof c.reasoningEffort === "string" ? c.reasoningEffort.trim() : ""
  };
}
function parseSharedChannels(raw) {
  if (!raw || typeof raw !== "object") return [];
  const store = raw;
  const arr = Array.isArray(store.channels) ? store.channels : Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of arr) {
    const ch = normalizeChannel(item);
    if (!ch || seen.has(ch.id)) continue;
    seen.add(ch.id);
    out.push(ch);
  }
  return out;
}
function listSharedChannels() {
  var _a;
  const ctx = getContext();
  return parseSharedChannels((_a = ctx.extensionSettings) == null ? void 0 : _a[CHANNELS_KEY]);
}
function listSharedChannelInfos() {
  return listSharedChannels().map((c) => ({
    id: c.id,
    name: c.name || c.id,
    model: c.model,
    url: c.url
  }));
}
function readTagGenChannelId() {
  var _a;
  const ctx = getContext();
  const raw = (_a = ctx.extensionSettings) == null ? void 0 : _a[IMAGE_SETTINGS_KEY];
  if (!raw || typeof raw !== "object") return "";
  const settings2 = raw;
  const assignments = settings2.assignments;
  const id = assignments == null ? void 0 : assignments.tagGen;
  return typeof id === "string" ? id.trim() : "";
}
function resolveChannelId(mode, modeChannels, llmSource) {
  const explicit = modeChannels == null ? void 0 : modeChannels[mode];
  if (explicit) return explicit;
  return llmSource === "main" ? "main" : "tagGen";
}
function buildChannelRequestBody(channel, messages, stream = false) {
  const effort = (channel.reasoningEffort ?? "").trim();
  const common = {
    model: channel.model,
    messages,
    temperature: channel.temperature ?? 1,
    max_tokens: channel.maxTokens ?? 65535,
    stream,
    tool_choice: "none",
    presence_penalty: 0,
    frequency_penalty: 0
  };
  const body = effort ? {
    chat_completion_source: "custom",
    custom_url: channel.url,
    custom_include_headers: JSON.stringify({ Authorization: `Bearer ${channel.key || ""}` }),
    custom_include_body: JSON.stringify({ reasoning_effort: effort }),
    ...common
  } : {
    chat_completion_source: "openai",
    reverse_proxy: channel.url,
    proxy_password: channel.key || "",
    ...common
  };
  for (const p of channel.excludeParams ?? []) {
    const key = p.trim();
    if (key) delete body[key];
  }
  return body;
}
function extractCompletionText(data) {
  if (!data || typeof data !== "object") return null;
  const d = data;
  if (typeof d.error === "object" && d.error !== null) {
    const msg = d.error.message;
    console.warn("[ST-Story-Illustrator] 副 API 返回错误：", typeof msg === "string" ? msg : "未知错误");
    return null;
  }
  const choices = Array.isArray(d.choices) ? d.choices : [];
  for (const choice of choices) {
    if (!choice || typeof choice !== "object") continue;
    const c = choice;
    const message = c.message;
    const parts = [message == null ? void 0 : message.content, c.text, d.content];
    for (const part of parts) {
      const text = textFromContent(part);
      if (text) return text;
    }
  }
  return textFromContent(d.content);
}
function textFromContent(value) {
  if (typeof value === "string") return value.trim() ? value.trim() : null;
  if (Array.isArray(value)) {
    const texts = [];
    for (const part of value) {
      if (!part || typeof part !== "object") continue;
      const p = part;
      if (typeof p.text === "string") texts.push(p.text);
    }
    return texts.join("").trim() || null;
  }
  return null;
}
async function generateViaChannelId(channelId, system, user, signal) {
  const id = (channelId || "").trim();
  if (!id || id === "main") return null;
  const ctx = getContext();
  const all = listSharedChannels();
  const targetId = id === "tagGen" ? readTagGenChannelId() : id;
  if (!targetId) return null;
  const channel = all.find((c) => c.id === targetId);
  if (!channel) return null;
  if (!channel.model) {
    console.warn(`[ST-Story-Illustrator] 渠道「${channel.name}」未填模型，跳过。`);
    return null;
  }
  const headers = typeof ctx.getRequestHeaders === "function" ? ctx.getRequestHeaders() : {};
  const controller = new AbortController();
  const timeoutMs = Math.max(5, channel.timeoutSec) * 1e3;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(buildChannelRequestBody(channel, [
        { role: "system", content: system },
        { role: "user", content: user }
      ])),
      signal: controller.signal
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      console.warn(`[ST-Story-Illustrator] 渠道「${channel.name}」请求失败 (${resp.status})：${detail.slice(0, 200)}`);
      return null;
    }
    const data = await resp.json().catch(() => null);
    return extractCompletionText(data);
  } catch (err) {
    {
      console.warn(`[ST-Story-Illustrator] 渠道「${channel.name}」不可用：`, err instanceof Error ? err.message : String(err));
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}
async function generateViaSecondary(system, user, signal) {
  return await generateViaChannelId("tagGen", system, user);
}
const SHARED_EXCLUDES_KEY = "baibai_exclude_settings";
const DEFAULT_STRIP_TAGS = ["\\[mvu[\\s\\S]*?\\]"];
function getBaiBaiCustomStripTags() {
  var _a;
  const ctx = getRuntimeContext();
  if (!ctx) return [];
  const ext = ctx.extensionSettings;
  if (!ext) return [];
  const raw = ext[SHARED_EXCLUDES_KEY];
  if (!raw || typeof raw !== "object") return [];
  const store = raw;
  const direct = store.customStripTags;
  const mirrored = (_a = store.excludes) == null ? void 0 : _a.customStripTags;
  const source = Array.isArray(direct) ? direct : Array.isArray(mirrored) ? mirrored : null;
  if (!source) return [];
  const tags = source.filter((t) => typeof t === "string" && t.length > 0);
  return tags.length ? tags : [];
}
function getSyncedStripTags() {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const tag of [...DEFAULT_STRIP_TAGS, ...getBaiBaiCustomStripTags()]) {
    if (!seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}
function getRuntimeContext() {
  const g = globalThis;
  const fn = g.getContext;
  if (typeof fn !== "function") return null;
  try {
    const ctx = fn();
    return ctx && typeof ctx === "object" ? ctx : null;
  } catch {
    return null;
  }
}
const RE_THINK_BLOCK = /<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi;
const RE_HTML_COMMENT = /<!--[\s\S]+?-->/g;
const RE_HORAE = /<horae[\s\S]*?>[\s\S]*?<\/horae[\s\S]*?>/gi;
const BBI_IMAGE_TAG_RE = /<bbi_image\b[^>]*>[\s\S]*?<\/bbi_image>/gi;
const RE_CONTENT_BLOCK = /<content\b[^>]*>([\s\S]*?)<\/content>/gi;
const HTML_ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
  "&#x27;": "'"
};
function blockStripRegexes(tag) {
  return [
    new RegExp(`<${tag}(?=[\\s/>])[^>]*>[\\s\\S]*?</${tag}>`, "gi"),
    new RegExp(`<\\/?${tag}(?=[\\s/>])[^>]*\\/?>`, "gi")
  ];
}
function stripTagsByNames(s, tags) {
  let out = s;
  for (const tag of tags) {
    if (!tag) continue;
    for (const re of blockStripRegexes(tag)) out = out.replace(re, "");
  }
  return out;
}
function stripManagedBlock(s, tag) {
  const openRe = new RegExp(`^[ \\t]*<${tag}\\b[^>]*>[ \\t]*$`, "m");
  const closeRe = new RegExp(`^[ \\t]*</${tag}>[ \\t]*$`, "m");
  let out = s;
  let open;
  let guard = 0;
  while ((open = out.match(openRe)) && guard++ < 100) {
    const start = open.index ?? 0;
    const rest = out.slice(start + open[0].length);
    const close = rest.match(closeRe);
    if (!close) {
      out = out.slice(0, start) + out.slice(start + open[0].length);
      continue;
    }
    const end = start + open[0].length + (close.index ?? 0) + close[0].length;
    out = out.slice(0, start) + out.slice(end);
  }
  return out;
}
function cleanMessageText(mes, options = {}) {
  if (!mes || typeof mes !== "string") return "";
  const { syncBaiBai = true, preferContent = false, extraStripTags = [] } = options;
  let text = mes;
  if (preferContent) {
    const blocks = [];
    text = text.replace(RE_CONTENT_BLOCK, (_m, inner) => {
      blocks.push(inner);
      return "\n";
    });
    if (blocks.length > 0) {
      text = blocks.join("\n\n");
    }
  }
  text = text.replace(BBI_IMAGE_TAG_RE, "");
  text = text.replace(RE_THINK_BLOCK, "");
  text = text.replace(RE_HTML_COMMENT, "");
  text = text.replace(RE_HORAE, "");
  const tags = [
    ...syncBaiBai ? getSyncedStripTags() : [],
    "bbs_items",
    "bbs_vars",
    "bbs_start",
    "bbs_end",
    ...extraStripTags
  ];
  text = stripTagsByNames(text, tags);
  text = stripManagedBlock(text, "bbs_items");
  text = stripManagedBlock(text, "bbs_vars");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/p\s*>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = decodeHtmlEntities(text);
  text = text.replace(/[ \t]+\n/g, "\n");
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();
  return text;
}
function decodeHtmlEntities(text) {
  text = text.replace(/&#(\d+);/g, (_, code) => {
    const num = parseInt(code, 10);
    if (num > 0 && num <= 1114111) {
      try {
        return String.fromCodePoint(num);
      } catch {
        return "";
      }
    }
    return "";
  });
  text = text.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
    const num = parseInt(hex, 16);
    if (num > 0 && num <= 1114111) {
      try {
        return String.fromCodePoint(num);
      } catch {
        return "";
      }
    }
    return "";
  });
  for (const [entity, char] of Object.entries(HTML_ENTITIES)) {
    text = text.split(entity).join(char);
  }
  return text;
}
function isSystemMessage(msg) {
  var _a;
  if (msg.is_system === true) return true;
  const name = (msg.name ?? "").toLowerCase().trim();
  if (name === "system" || name === "narrator") return true;
  const extraType = (_a = msg.extra) == null ? void 0 : _a.type;
  if (typeof extraType === "string" && (extraType === "system" || extraType === "narrator")) {
    return true;
  }
  return false;
}
const MAX_MESSAGES_IN_SEGMENT = 50;
const MAX_MESSAGE_TEXT = 4e3;
let cleanOptions = { syncBaiBai: true, preferContent: true };
function setSegmentCleanOptions(options) {
  cleanOptions = { ...cleanOptions, ...options };
}
function cleanMes(mes) {
  return cleanMessageText(mes, cleanOptions);
}
function extractMessage(floor, chatId) {
  const chat = getChat();
  if (floor < 0 || floor >= chat.length) return null;
  const msg = chat[floor];
  if (!msg) return null;
  if (!stillCurrent(chatId, floor, getSwipeId(floor), getSendDate(floor) || void 0)) {
    return null;
  }
  const text = cleanMes(msg.mes).slice(0, MAX_MESSAGE_TEXT);
  if (!text) return null;
  return {
    floor,
    speaker: String(msg.name ?? (msg.is_user ? "User" : "Unknown")),
    isUser: msg.is_user === true,
    sendDate: typeof msg.send_date === "string" ? msg.send_date.trim() : void 0,
    swipeId: typeof msg.swipe_id === "number" ? msg.swipe_id : 0,
    text
  };
}
function buildSingleSegment(floor) {
  const chatId = getCurrentChatId();
  if (!chatId) return null;
  const msg = extractMessage(floor, chatId);
  if (!msg) return null;
  return {
    chatId,
    sourceKind: "single",
    floorIds: [floor],
    text: msg.text,
    messages: [msg],
    createdAt: Date.now()
  };
}
function buildRangeSegment(startFloor, endFloor, excludeFloors = []) {
  const chatId = getCurrentChatId();
  if (!chatId) return null;
  const lo = Math.min(startFloor, endFloor);
  const hi = Math.max(startFloor, endFloor);
  const excludeSet = new Set(excludeFloors);
  const messages = [];
  const floorIds = [];
  for (let floor = lo; floor <= hi; floor++) {
    if (excludeSet.has(floor)) continue;
    if (messages.length >= MAX_MESSAGES_IN_SEGMENT) break;
    const msg = extractMessage(floor, chatId);
    if (!msg) continue;
    const chat = getChat();
    const raw = chat[floor];
    if (raw && isSystemMessage(raw)) continue;
    messages.push(msg);
    floorIds.push(floor);
  }
  if (messages.length === 0) return null;
  const text = messages.map((m) => m.text).join("\n\n");
  return {
    chatId,
    sourceKind: "range",
    floorIds,
    startFloor: lo,
    endFloor: hi,
    text,
    messages,
    createdAt: Date.now()
  };
}
function buildPickedSegment(floorIds) {
  const chatId = getCurrentChatId();
  if (!chatId || floorIds.length === 0) return null;
  const messages = [];
  const validFloorIds = [];
  for (const floor of floorIds) {
    if (messages.length >= MAX_MESSAGES_IN_SEGMENT) break;
    const msg = extractMessage(floor, chatId);
    if (!msg) continue;
    const chat = getChat();
    const raw = chat[floor];
    if (raw && isSystemMessage(raw)) continue;
    messages.push(msg);
    validFloorIds.push(floor);
  }
  if (messages.length === 0) return null;
  const text = messages.map((m) => m.text).join("\n\n");
  return {
    chatId,
    sourceKind: "picked",
    floorIds: validFloorIds,
    text,
    messages,
    createdAt: Date.now()
  };
}
function buildManualSegment(text, floorIds = []) {
  const chatId = getCurrentChatId();
  const cleanText = text.trim();
  if (!cleanText) return null;
  const messages = [];
  if (floorIds.length > 0 && chatId) {
    for (const floor of floorIds.slice(0, MAX_MESSAGES_IN_SEGMENT)) {
      const msg = extractMessage(floor, chatId);
      if (msg) messages.push(msg);
    }
  }
  return {
    chatId: chatId || "manual",
    sourceKind: "manual",
    floorIds,
    text: cleanText,
    messages,
    createdAt: Date.now()
  };
}
function validateSegment(segment) {
  if (segment.sourceKind === "manual") {
    return true;
  }
  const currentChatId = getCurrentChatId();
  if (currentChatId !== segment.chatId) return false;
  for (const msg of segment.messages) {
    if (!stillCurrent(segment.chatId, msg.floor, msg.swipeId, msg.sendDate)) {
      return false;
    }
  }
  return true;
}
function getAnchorFloor(segment) {
  if (segment.sourceKind === "manual") {
    return segment.floorIds.length > 0 ? segment.floorIds[segment.floorIds.length - 1] : null;
  }
  if (segment.floorIds.length === 0) return null;
  return segment.floorIds[segment.floorIds.length - 1];
}
function getSurroundingContext(segment, range = 1) {
  if (segment.sourceKind === "manual" || segment.floorIds.length === 0) {
    return {};
  }
  const chatId = segment.chatId;
  if (getCurrentChatId() !== chatId) return {};
  const firstFloor = Math.min(...segment.floorIds);
  const lastFloor = Math.max(...segment.floorIds);
  const previousMessages = [];
  for (let f = firstFloor - 1; f >= Math.max(0, firstFloor - range); f--) {
    const msg = extractMessage(f, chatId);
    if (msg) {
      const chat2 = getChat();
      const raw = chat2[f];
      if (raw && isSystemMessage(raw)) continue;
      previousMessages.unshift(msg.text);
    }
  }
  const nextMessages = [];
  const chat = getChat();
  for (let f = lastFloor + 1; f <= Math.min(chat.length - 1, lastFloor + range); f++) {
    const msg = extractMessage(f, chatId);
    if (msg) {
      const raw = chat[f];
      if (raw && isSystemMessage(raw)) continue;
      nextMessages.push(msg.text);
    }
  }
  return {
    previousText: previousMessages.length > 0 ? previousMessages.join("\n\n") : void 0,
    nextText: nextMessages.length > 0 ? nextMessages.join("\n\n") : void 0
  };
}
function defaultFloor() {
  const chat = getChat();
  for (let i = chat.length - 1; i >= 0; i--) {
    const msg = chat[i];
    if (!msg) continue;
    if (isSystemMessage(msg)) continue;
    if (msg.is_user === true) continue;
    const text = cleanMes(msg.mes);
    if (text.length > 0) return i;
  }
  for (let i = chat.length - 1; i >= 0; i--) {
    const msg = chat[i];
    if (!msg) continue;
    if (isSystemMessage(msg)) continue;
    const text = cleanMes(msg.mes);
    if (text.length > 0) return i;
  }
  return -1;
}
function getAvailableFloors() {
  const chat = getChat();
  getCurrentChatId();
  const result = [];
  for (let i = 0; i < chat.length; i++) {
    const msg = chat[i];
    if (!msg) continue;
    if (isSystemMessage(msg)) continue;
    const text = cleanMes(msg.mes);
    if (!text) continue;
    result.push({
      floor: i,
      speaker: String(msg.name ?? (msg.is_user ? "User" : "Unknown")),
      isUser: msg.is_user === true,
      preview: text.slice(0, 80)
    });
  }
  return result;
}
const PANEL_ID = "sti-selection-panel";
const PANEL_OVERLAY_ID = "sti-selection-panel-overlay";
const METHOD_ORDER = ["local", "single", "range", "picked"];
const MODE_LABELS$1 = {
  "illustration": "正文插画",
  "comic": "正文漫画分镜",
  "chibi-status": "QQ 人状态栏",
  "chibi-bonus": "QQ 人彩蛋",
  "bw-manga": "黑白漫小剧场"
};
const MODE_DESCRIPTIONS = {
  "illustration": "提取一个瞬间或按设置拆分镜头，生成单图/多图",
  "comic": "提炼连续事件中的不同瞬间，排成漫画页",
  "chibi-status": "提取真实发生的瞬间，Q 版比例",
  "chibi-bonus": "选段用于识别角色和性格，另构思平行宇宙彩蛋",
  "bw-manga": "选取真实发生的瞬间，正常比例、黑白漫画风"
};
let panelElement = null;
let overlayElement = null;
let currentSegment = null;
let selectedModes = /* @__PURE__ */ new Set(["illustration"]);
let onConfirmCallback = null;
let currentMethod = "local";
let selectedSingleFloor = -1;
let rangeStart = -1;
let rangeEnd = -1;
let excludedFloors = /* @__PURE__ */ new Set();
let pickedFloors = [];
let selectedTextSeed = "";
let selectedFloorSeed = -1;
function showSelectionPanel(initialFloorOrOptions, onConfirm) {
  const opts = typeof initialFloorOrOptions === "number" ? { initialFloor: initialFloorOrOptions } : initialFloorOrOptions ?? {};
  const seedFloor = opts.initialFloor ?? defaultFloor();
  selectedSingleFloor = seedFloor;
  rangeStart = seedFloor;
  rangeEnd = seedFloor;
  currentMethod = opts.startAtLocal !== false ? "local" : "single";
  excludedFloors = /* @__PURE__ */ new Set();
  pickedFloors = seedFloor >= 0 ? [seedFloor] : [];
  selectedTextSeed = (opts.selectedText ?? "").trim();
  selectedFloorSeed = seedFloor;
  localText = selectedTextSeed;
  onConfirmCallback = onConfirm ?? null;
  ensurePanel();
  renderPanel();
}
function hideSelectionPanel() {
  if (overlayElement) overlayElement.style.display = "none";
  if (panelElement) panelElement.style.display = "none";
}
function ensurePanel() {
  if (!overlayElement) {
    overlayElement = document.createElement("div");
    overlayElement.id = PANEL_OVERLAY_ID;
    overlayElement.className = "sti-panel-overlay";
    overlayElement.addEventListener("click", (e) => {
      if (e.target === overlayElement) hideSelectionPanel();
    });
    document.body.appendChild(overlayElement);
  }
  if (!panelElement) {
    panelElement = document.createElement("div");
    panelElement.id = PANEL_ID;
    panelElement.className = "sti-selection-panel";
    document.body.appendChild(panelElement);
  }
  overlayElement.style.display = "block";
  panelElement.style.display = "block";
}
function renderPanel() {
  if (!panelElement) return;
  const floors = getAvailableFloors();
  panelElement.innerHTML = "";
  const title = document.createElement("div");
  title.className = "sti-panel-title";
  title.textContent = "剧情选段";
  panelElement.appendChild(title);
  const methodTabs = document.createElement("div");
  methodTabs.className = "sti-method-tabs";
  for (const method of METHOD_ORDER) {
    const tab = document.createElement("button");
    tab.className = `sti-method-tab ${currentMethod === method ? "active" : ""}`;
    tab.textContent = methodLabel(method);
    tab.addEventListener("click", () => {
      currentMethod = method;
      renderPanel();
    });
    methodTabs.appendChild(tab);
  }
  panelElement.appendChild(methodTabs);
  const content = document.createElement("div");
  content.className = "sti-panel-content";
  switch (currentMethod) {
    case "local":
    case "manual":
      content.appendChild(renderLocalEditor());
      break;
    case "single":
      content.appendChild(renderSingleSelector(floors));
      break;
    case "range":
      content.appendChild(renderRangeSelector(floors));
      break;
    case "picked":
      content.appendChild(renderPickedSelector(floors));
      break;
  }
  panelElement.appendChild(content);
  panelElement.appendChild(renderModeSelector());
  panelElement.appendChild(renderApiChannelSelector());
  panelElement.appendChild(renderPreview());
  panelElement.appendChild(renderActions());
}
function methodLabel(method) {
  switch (method) {
    case "local":
      return "局部";
    case "single":
      return "单楼";
    case "range":
      return "范围";
    case "picked":
      return "勾选";
    case "manual":
      return "局部";
  }
}
function renderSingleSelector(floors) {
  const container = document.createElement("div");
  container.className = "sti-selector-container";
  const label = document.createElement("div");
  label.className = "sti-selector-label";
  label.textContent = "选择楼层：";
  container.appendChild(label);
  const select = document.createElement("select");
  select.className = "sti-floor-select";
  for (const f of floors) {
    const opt = document.createElement("option");
    opt.value = String(f.floor);
    opt.textContent = `[${f.floor}] ${f.speaker}: ${f.preview.slice(0, 40)}...`;
    if (f.floor === selectedSingleFloor) opt.selected = true;
    select.appendChild(opt);
  }
  if (selectedSingleFloor >= 0) select.value = String(selectedSingleFloor);
  select.addEventListener("change", () => {
    selectedSingleFloor = parseInt(select.value, 10);
    rebuildSegment();
    renderPreviewOnly();
  });
  container.appendChild(select);
  return container;
}
function renderRangeSelector(floors) {
  const container = document.createElement("div");
  container.className = "sti-selector-container";
  const rangeRow = document.createElement("div");
  rangeRow.className = "sti-range-row";
  const startLabel = document.createElement("span");
  startLabel.textContent = "从";
  rangeRow.appendChild(startLabel);
  const startSelect = createFloorSelect(floors, rangeStart, (val) => {
    rangeStart = val;
    rebuildSegment();
    renderPreviewOnly();
  });
  rangeRow.appendChild(startSelect);
  const dash = document.createElement("span");
  dash.textContent = "到";
  rangeRow.appendChild(dash);
  const endSelect = createFloorSelect(floors, rangeEnd, (val) => {
    rangeEnd = val;
    rebuildSegment();
    renderPreviewOnly();
  });
  rangeRow.appendChild(endSelect);
  container.appendChild(rangeRow);
  if (rangeStart >= 0 && rangeEnd >= 0) {
    const lo = Math.min(rangeStart, rangeEnd);
    const hi = Math.max(rangeStart, rangeEnd);
    const rangeFloors = floors.filter((f) => f.floor >= lo && f.floor <= hi);
    if (rangeFloors.length > 0) {
      const excludeLabel = document.createElement("div");
      excludeLabel.className = "sti-selector-label";
      excludeLabel.textContent = "排除楼层（勾选不想要的）：";
      container.appendChild(excludeLabel);
      const excludeList = document.createElement("div");
      excludeList.className = "sti-exclude-list";
      for (const f of rangeFloors) {
        const item = document.createElement("label");
        item.className = "sti-exclude-item";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = excludedFloors.has(f.floor);
        cb.addEventListener("change", () => {
          if (cb.checked) excludedFloors.add(f.floor);
          else excludedFloors.delete(f.floor);
          rebuildSegment();
          renderPreviewOnly();
        });
        item.appendChild(cb);
        item.appendChild(document.createTextNode(` [${f.floor}] ${f.speaker}: ${f.preview.slice(0, 50)}...`));
        excludeList.appendChild(item);
      }
      container.appendChild(excludeList);
    }
  }
  return container;
}
function renderPickedSelector(floors) {
  const container = document.createElement("div");
  container.className = "sti-selector-container";
  const label = document.createElement("div");
  label.className = "sti-selector-label";
  label.textContent = "勾选要纳入的楼层（按勾选顺序）：";
  container.appendChild(label);
  const list = document.createElement("div");
  list.className = "sti-picked-list";
  for (const f of floors) {
    const item = document.createElement("label");
    item.className = "sti-picked-item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = pickedFloors.includes(f.floor);
    cb.addEventListener("change", () => {
      if (cb.checked) {
        if (!pickedFloors.includes(f.floor)) pickedFloors.push(f.floor);
      } else {
        pickedFloors = pickedFloors.filter((id) => id !== f.floor);
      }
      rebuildSegment();
      renderPreviewOnly();
    });
    item.appendChild(cb);
    item.appendChild(document.createTextNode(` [${f.floor}] ${f.speaker}: ${f.preview.slice(0, 50)}...`));
    list.appendChild(item);
  }
  container.appendChild(list);
  return container;
}
function renderLocalEditor() {
  const container = document.createElement("div");
  container.className = "sti-selector-container";
  const label = document.createElement("div");
  label.className = "sti-selector-label";
  label.textContent = "划线文本（可编辑，直接作为剧情内容）：";
  container.appendChild(label);
  const textarea = document.createElement("textarea");
  textarea.className = "sti-manual-textarea";
  textarea.rows = 10;
  textarea.placeholder = "在此编辑剧情文本...";
  textarea.value = localText;
  textarea.addEventListener("input", () => {
    localText = textarea.value;
    rebuildSegment();
    renderPreviewOnly();
  });
  container.appendChild(textarea);
  const note = document.createElement("div");
  note.className = "sti-manual-note";
  const floorHint = selectedFloorSeed >= 0 ? `结果将挂载在第 ${selectedFloorSeed} 楼下方。` : "结果将放入插件作品历史。";
  note.textContent = `已锚定你划线的楼层。${floorHint}`;
  container.appendChild(note);
  return container;
}
let localText = "";
function renderModeSelector() {
  const container = document.createElement("div");
  container.className = "sti-mode-selector";
  const label = document.createElement("div");
  label.className = "sti-selector-label";
  label.textContent = "创作模式（可多选，每个模式各生成一份）：";
  container.appendChild(label);
  const modeList = document.createElement("div");
  modeList.className = "sti-mode-list";
  for (const mode of Object.keys(MODE_LABELS$1)) {
    const item = document.createElement("label");
    item.className = `sti-mode-item ${selectedModes.has(mode) ? "active" : ""}`;
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.name = "sti-mode";
    cb.value = mode;
    cb.checked = selectedModes.has(mode);
    cb.addEventListener("change", () => {
      if (cb.checked) selectedModes.add(mode);
      else selectedModes.delete(mode);
      if (selectedModes.size === 0) {
        selectedModes.add("illustration");
        cb.checked = false;
      }
      item.classList.toggle("active", selectedModes.has(mode));
      updateConfirmButton();
    });
    item.appendChild(cb);
    const text = document.createElement("div");
    text.className = "sti-mode-text";
    const name = document.createElement("div");
    name.className = "sti-mode-name";
    name.textContent = MODE_LABELS$1[mode];
    const desc = document.createElement("div");
    desc.className = "sti-mode-desc";
    desc.textContent = MODE_DESCRIPTIONS[mode];
    text.appendChild(name);
    text.appendChild(desc);
    item.appendChild(text);
    modeList.appendChild(item);
  }
  container.appendChild(modeList);
  return container;
}
function renderApiChannelSelector() {
  const container = document.createElement("div");
  container.className = "sti-api-channel-selector";
  const label = document.createElement("div");
  label.className = "sti-selector-label";
  label.textContent = "LLM API 渠道（各模式分开指派；渠道自动同步自柏宝绘）：";
  container.appendChild(label);
  const channels = listSharedChannelInfos();
  const tagGenId = readTagGenChannelId();
  const settings2 = getSettings(DEFAULT_SETTINGS);
  const modeChannels = settings2.modeChannels ?? {};
  if (channels.length === 0) {
    const hint = document.createElement("div");
    hint.className = "sti-api-hint";
    hint.textContent = "柏宝绘还没有副 API 渠道。在柏宝绘设置里添加渠道后，这里会自动出现，不用重启。";
    container.appendChild(hint);
  }
  const list = document.createElement("div");
  list.className = "sti-api-channel-list";
  for (const mode of Object.keys(MODE_LABELS$1)) {
    const row = document.createElement("label");
    row.className = "sti-api-channel-row";
    const name = document.createElement("span");
    name.className = "sti-api-mode-name";
    name.textContent = MODE_LABELS$1[mode];
    row.appendChild(name);
    const select = document.createElement("select");
    select.className = "sti-api-channel-select";
    const tagGenOpt = document.createElement("option");
    tagGenOpt.value = "tagGen";
    const tagGenChannel = channels.find((c) => c.id === tagGenId);
    tagGenOpt.textContent = tagGenId ? `跟随柏宝绘 tagGen（${(tagGenChannel == null ? void 0 : tagGenChannel.name) ?? tagGenId}）` : "跟随柏宝绘 tagGen（未指派 → 回退主 API）";
    select.appendChild(tagGenOpt);
    const mainOpt = document.createElement("option");
    mainOpt.value = "main";
    mainOpt.textContent = "酒馆主 API";
    select.appendChild(mainOpt);
    for (const ch of channels) {
      const opt = document.createElement("option");
      opt.value = ch.id;
      opt.textContent = `${ch.name}${ch.model ? ` · ${ch.model}` : ""}`;
      select.appendChild(opt);
    }
    const current = modeChannels[mode] ?? "tagGen";
    if (current !== "tagGen" && current !== "main" && !channels.some((c) => c.id === current)) {
      const stale = document.createElement("option");
      stale.value = current;
      stale.textContent = `已失效渠道（${current.slice(0, 10)}…）`;
      select.appendChild(stale);
    }
    select.value = current;
    select.addEventListener("change", () => {
      const next = getSettings(DEFAULT_SETTINGS);
      next.modeChannels = { ...next.modeChannels ?? {}, [mode]: select.value };
      saveSettings(next);
      window.dispatchEvent(new CustomEvent("sti-settings-changed"));
    });
    row.appendChild(select);
    list.appendChild(row);
  }
  container.appendChild(list);
  return container;
}
function renderPreview() {
  const container = document.createElement("div");
  container.className = "sti-preview-container";
  container.id = "sti-preview-container";
  rebuildSegment();
  if (!currentSegment) {
    const empty = document.createElement("div");
    empty.className = "sti-preview-empty";
    empty.textContent = "请选择楼层或输入文本";
    container.appendChild(empty);
    return container;
  }
  const info = document.createElement("div");
  info.className = "sti-preview-info";
  const floorInfo = currentSegment.floorIds.length > 0 ? `楼层 ${currentSegment.floorIds.join(", ")}` : "手动文本";
  info.textContent = `${floorInfo} | ${currentSegment.messages.length} 条消息 | ${currentSegment.text.length} 字`;
  container.appendChild(info);
  if (currentSegment.messages.length > 0) {
    const msgList = document.createElement("div");
    msgList.className = "sti-preview-messages";
    for (const msg of currentSegment.messages) {
      const item = document.createElement("div");
      item.className = `sti-preview-message ${msg.isUser ? "is-user" : ""}`;
      const speaker = document.createElement("span");
      speaker.className = "sti-preview-speaker";
      speaker.textContent = `[${msg.floor}] ${msg.speaker}:`;
      const text = document.createElement("span");
      text.className = "sti-preview-text";
      text.textContent = msg.text.slice(0, 200) + (msg.text.length > 200 ? "..." : "");
      item.appendChild(speaker);
      item.appendChild(text);
      msgList.appendChild(item);
    }
    container.appendChild(msgList);
  }
  const textLabel = document.createElement("div");
  textLabel.className = "sti-selector-label";
  textLabel.textContent = "最终剧情文本（可编辑）：";
  container.appendChild(textLabel);
  const textarea = document.createElement("textarea");
  textarea.className = "sti-preview-textarea";
  textarea.rows = 6;
  textarea.value = currentSegment.text;
  textarea.addEventListener("input", () => {
    if (currentSegment) currentSegment = { ...currentSegment, text: textarea.value };
  });
  container.appendChild(textarea);
  return container;
}
function renderPreviewOnly() {
  const container = document.getElementById("sti-preview-container");
  if (!container || !panelElement) return;
  const preview = renderPreview();
  container.replaceWith(preview);
}
function renderActions() {
  const container = document.createElement("div");
  container.className = "sti-panel-actions";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "sti-btn sti-btn-cancel";
  cancelBtn.textContent = "取消";
  cancelBtn.addEventListener("click", () => hideSelectionPanel());
  container.appendChild(cancelBtn);
  const confirmBtn = document.createElement("button");
  confirmBtn.className = "sti-btn sti-btn-confirm";
  confirmBtn.id = "sti-confirm-btn";
  confirmBtn.textContent = `确认选段 · 生成 ${selectedModes.size} 份`;
  confirmBtn.disabled = !currentSegment;
  confirmBtn.addEventListener("click", () => {
    if (currentSegment && onConfirmCallback) {
      if (!validateSegment(currentSegment)) {
        const warning = document.createElement("div");
        warning.className = "sti-preview-warning";
        warning.textContent = "选段已失效（聊天切换或消息删除），请重新选择。";
        panelElement == null ? void 0 : panelElement.appendChild(warning);
        return;
      }
      onConfirmCallback(currentSegment, Array.from(selectedModes));
      hideSelectionPanel();
    }
  });
  container.appendChild(confirmBtn);
  return container;
}
function updateConfirmButton() {
  const btn = document.getElementById("sti-confirm-btn");
  if (btn) btn.textContent = `确认选段 · 生成 ${selectedModes.size} 份`;
}
function createFloorSelect(floors, currentValue, onChange) {
  const select = document.createElement("select");
  select.className = "sti-floor-select";
  for (const f of floors) {
    const opt = document.createElement("option");
    opt.value = String(f.floor);
    opt.textContent = `[${f.floor}] ${f.speaker}`;
    if (f.floor === currentValue) opt.selected = true;
    select.appendChild(opt);
  }
  if (currentValue >= 0) select.value = String(currentValue);
  select.addEventListener("change", () => onChange(parseInt(select.value, 10)));
  return select;
}
function rebuildSegment() {
  switch (currentMethod) {
    case "local":
    case "manual":
      currentSegment = localText.trim() ? buildManualSegment(localText, selectedFloorSeed >= 0 ? [selectedFloorSeed] : []) : null;
      break;
    case "single":
      currentSegment = selectedSingleFloor >= 0 ? buildSingleSegment(selectedSingleFloor) : null;
      break;
    case "range":
      currentSegment = rangeStart >= 0 && rangeEnd >= 0 ? buildRangeSegment(rangeStart, rangeEnd, Array.from(excludedFloors)) : null;
      break;
    case "picked":
      currentSegment = pickedFloors.length > 0 ? buildPickedSegment(pickedFloors) : null;
      break;
  }
}
function destroySelectionPanel() {
  if (panelElement) {
    panelElement.remove();
    panelElement = null;
  }
  if (overlayElement) {
    overlayElement.remove();
    overlayElement = null;
  }
  onConfirmCallback = null;
  currentSegment = null;
}
let overlay = null;
function openLightbox(imageUrl, caption) {
  ensureOverlay();
  if (!overlay) return;
  overlay.innerHTML = "";
  const img = document.createElement("img");
  img.className = "sti-lightbox-img";
  img.src = imageUrl;
  img.alt = caption ?? "图片";
  overlay.appendChild(img);
  if (caption) {
    const cap = document.createElement("div");
    cap.className = "sti-lightbox-caption";
    cap.textContent = caption;
    overlay.appendChild(cap);
  }
  const close = document.createElement("button");
  close.className = "sti-lightbox-close";
  close.textContent = "×";
  close.setAttribute("aria-label", "关闭");
  close.addEventListener("click", closeLightbox);
  overlay.appendChild(close);
  overlay.style.display = "flex";
  overlay.onclick = (e) => {
    if (e.target === overlay) closeLightbox();
  };
}
function closeLightbox() {
  if (overlay) overlay.style.display = "none";
}
function ensureOverlay() {
  if (overlay) return;
  overlay = document.createElement("div");
  overlay.id = "sti-lightbox";
  overlay.className = "sti-lightbox";
  overlay.style.display = "none";
  document.body.appendChild(overlay);
}
function destroyLightbox() {
  if (overlay) {
    overlay.remove();
    overlay = null;
  }
}
const ARTIFACTS_KEY = "sti_artifacts";
const CHAT_META_KEY = "STStoryIllustrator";
const SCHEMA_VERSION = 1;
function readStore$1(raw) {
  if (!raw || typeof raw !== "object") return { version: SCHEMA_VERSION, artifacts: [] };
  const store = raw;
  const version = typeof store.version === "number" ? store.version : 0;
  const artifacts = Array.isArray(store.artifacts) ? store.artifacts.filter((a) => !!a && typeof a === "object") : [];
  return migrate({ version, artifacts });
}
function migrate(store) {
  if (store.version >= SCHEMA_VERSION) return store;
  const artifacts = store.artifacts.map((a) => ({
    ...a,
    mountMode: a.mountMode ?? "trailing",
    metadata: a.metadata ?? {},
    sourceFloors: a.sourceFloors ?? [],
    createdAt: a.createdAt ?? 0
  }));
  return { version: SCHEMA_VERSION, artifacts };
}
function getArtifacts(floor) {
  const msg = getMessage(floor);
  if (!msg) return [];
  const extra = msg.extra ?? {};
  return readStore$1(extra[ARTIFACTS_KEY]).artifacts;
}
function appendArtifact(floor, artifact) {
  const msg = getMessage(floor);
  if (!msg) return false;
  if (!msg.extra) msg.extra = {};
  const extra = msg.extra;
  const store = readStore$1(extra[ARTIFACTS_KEY]);
  store.artifacts.push(artifact);
  store.version = SCHEMA_VERSION;
  extra[ARTIFACTS_KEY] = store;
  touchChatIndex();
  return true;
}
function touchChatIndex() {
  const index2 = getChatMetadata(CHAT_META_KEY, { version: SCHEMA_VERSION, updatedAt: 0, count: 0 });
  saveChatMetadata(CHAT_META_KEY, {
    version: SCHEMA_VERSION,
    updatedAt: Date.now(),
    count: (index2.count ?? 0) + 1
  });
}
let seq = 0;
function createArtifactId() {
  seq += 1;
  return `sti-${Date.now().toString(36)}-${seq.toString(36)}`;
}
const INLINE_CLASS = "sti-inline-card";
const TRAILING_AREA_CLASS = "sti-trailing-area";
const TRAILING_AREA_ID = "sti-trailing-area-";
const MOUNTED_ATTR$1 = "data-sti-mounted";
const MODE_LABELS = {
  "illustration": "插画",
  "comic": "漫画分镜",
  "chibi-status": "QQ人状态",
  "chibi-bonus": "QQ人彩蛋",
  "bw-manga": "黑白漫"
};
function mountFloor(floor) {
  const mes = document.querySelector(`.mes[mesid="${floor}"]`);
  if (!mes) return;
  unmountFloor(floor);
  const artifacts = getArtifacts(floor);
  const visible = artifacts.filter((a) => {
    var _a;
    return ((_a = a.metadata) == null ? void 0 : _a.embeddedInBody) !== true;
  });
  const inline = visible.filter((a) => a.mountMode === "inline");
  const trailing = visible.filter((a) => a.mountMode !== "inline");
  for (const artifact of inline) mountInline(mes, floor, artifact);
  if (trailing.length > 0) mountTrailing(mes, floor, trailing);
}
function unmountFloor(floor) {
  const mes = document.querySelector(`.mes[mesid="${floor}"]`);
  if (!mes) return;
  const cards = mes.querySelectorAll(`[${MOUNTED_ATTR$1}="${floor}"]`);
  for (const card of Array.from(cards)) card.remove();
}
function remountAll() {
  const nodes = document.querySelectorAll(".mes[mesid]");
  for (const node of Array.from(nodes)) {
    const floor = parseInt(node.getAttribute("mesid") ?? "", 10);
    if (Number.isFinite(floor)) mountFloor(floor);
  }
}
function mountInline(mes, floor, artifact) {
  var _a;
  const mesText = mes.querySelector(".mes_text");
  if (!mesText) return;
  const card = buildCard(artifact, floor, true);
  let inserted = false;
  if (artifact.textAnchor) {
    const anchor = artifact.textAnchor;
    const target = findTextNodeAfter(mesText, anchor.selectedText);
    if (target) {
      (_a = target.parentNode) == null ? void 0 : _a.insertBefore(card, target.nextSibling);
      inserted = true;
    }
  }
  if (!inserted) mesText.appendChild(card);
}
function findTextNodeAfter(root, selectedText) {
  if (!selectedText) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while (node = walker.nextNode()) {
    if ((node.textContent ?? "").includes(selectedText)) return node;
  }
  return null;
}
function mountTrailing(mes, floor, artifacts) {
  const mesBlock = mes.querySelector(".mes_block") ?? mes;
  let area = mesBlock.querySelector(`#${TRAILING_AREA_ID}${floor}`);
  if (!area) {
    area = document.createElement("div");
    area.id = `${TRAILING_AREA_ID}${floor}`;
    area.className = TRAILING_AREA_CLASS;
    area.setAttribute(MOUNTED_ATTR$1, String(floor));
    const header = document.createElement("div");
    header.className = "sti-trailing-header";
    header.textContent = "ST 创作";
    area.appendChild(header);
    mesBlock.appendChild(area);
  }
  for (const artifact of artifacts) {
    area.appendChild(buildCard(artifact, floor, false));
  }
}
function buildCard(artifact, floor, inline) {
  const card = document.createElement("div");
  card.className = inline ? INLINE_CLASS : "sti-floor-card";
  card.setAttribute(MOUNTED_ATTR$1, String(floor));
  card.setAttribute("data-sti-artifact-id", artifact.id);
  const img = document.createElement("img");
  img.className = "sti-card-image";
  img.src = artifact.imagePath;
  img.alt = `${MODE_LABELS[artifact.mode] || artifact.mode} 作品`;
  img.loading = "lazy";
  img.addEventListener("click", () => openLightbox(artifact.imagePath, img.alt));
  card.appendChild(img);
  const caption = document.createElement("div");
  caption.className = "sti-card-caption";
  caption.appendChild(document.createTextNode(artifact.nl ? artifact.nl.slice(0, 80) : ""));
  if (caption.textContent) card.appendChild(caption);
  return card;
}
const THEATER_KEY = "sti_theater";
function emptyStore() {
  return { version: 1, buckets: { status: [], bonus: [], manga: [] } };
}
function readStore(raw) {
  const store = emptyStore();
  if (!raw || typeof raw !== "object") return store;
  const o = raw;
  const buckets = o.buckets ?? {};
  for (const b of ["status", "bonus", "manga"]) {
    if (Array.isArray(buckets[b])) {
      store.buckets[b] = buckets[b].filter(
        (x) => !!x && typeof x === "object"
      );
    }
  }
  return store;
}
function writeStore(floor, store) {
  const msg = getMessage(floor);
  if (!msg) return false;
  if (!msg.extra) msg.extra = {};
  msg.extra[THEATER_KEY] = store;
  return true;
}
function getStories(floor, bucket) {
  const msg = getMessage(floor);
  if (!msg) return [];
  const extra = msg.extra;
  return readStore(extra == null ? void 0 : extra[THEATER_KEY]).buckets[bucket];
}
function saveStory(floor, bucket, story) {
  const msg = getMessage(floor);
  if (!msg) return false;
  if (!msg.extra) msg.extra = {};
  const extra = msg.extra;
  const store = readStore(extra[THEATER_KEY]);
  const clean = {
    ...story,
    ...story.lines && story.lines.length ? { lines: story.lines } : { lines: void 0 }
  };
  store.buckets[bucket].push(clean);
  return writeStore(floor, store);
}
function removeStory(floor, bucket, storyId) {
  const msg = getMessage(floor);
  if (!(msg == null ? void 0 : msg.extra)) return false;
  const extra = msg.extra;
  const store = readStore(extra[THEATER_KEY]);
  const before = store.buckets[bucket].length;
  store.buckets[bucket] = store.buckets[bucket].filter((s) => s.storyId !== storyId);
  if (store.buckets[bucket].length === before) return false;
  return writeStore(floor, store);
}
const AREA_ID = "sti-theater-area-";
const AREA_CLASS = "sti-cs-bar";
const MOUNTED_ATTR = "data-sti-theater-mounted";
const BUCKET_LABELS = {
  status: "QQ人小剧场",
  bonus: "彩蛋",
  manga: "黑白漫"
};
function mountTheater(floor) {
  const mes = document.querySelector(`.mes[mesid="${floor}"]`);
  if (!mes) return;
  unmountTheater(floor);
  const all = [];
  for (const bucket of ["status", "bonus", "manga"]) {
    for (const story of getStories(floor, bucket)) all.push({ bucket, story });
  }
  if (all.length === 0) return;
  const mesBlock = mes.querySelector(".mes_block") ?? mes;
  const area = document.createElement("div");
  area.id = `${AREA_ID}${floor}`;
  area.className = AREA_CLASS;
  area.setAttribute(MOUNTED_ATTR, String(floor));
  for (const { bucket, story } of all) {
    area.appendChild(buildTheaterCard(floor, bucket, story));
  }
  mesBlock.appendChild(area);
}
function unmountTheater(floor) {
  const mes = document.querySelector(`.mes[mesid="${floor}"]`);
  if (!mes) return;
  const areas = mes.querySelectorAll(`[${MOUNTED_ATTR}="${floor}"]`);
  for (const area of Array.from(areas)) area.remove();
}
function buildTheaterCard(floor, bucket, story) {
  const card = document.createElement("details");
  card.className = "sti-cs-card";
  const summary = document.createElement("summary");
  summary.className = "sti-cs-headline";
  const kicker = document.createElement("span");
  kicker.className = "sti-cs-kicker";
  kicker.textContent = BUCKET_LABELS[bucket];
  summary.appendChild(kicker);
  summary.appendChild(document.createTextNode(" " + (story.title || `第 ${story.index + 1} 格`)));
  card.appendChild(summary);
  const body = document.createElement("div");
  body.className = "sti-cs-body";
  if (story.imagePath) {
    const figure = document.createElement("div");
    figure.className = "sti-cs-figure";
    const img = document.createElement("img");
    img.className = "sti-cs-photo";
    img.src = story.imagePath;
    img.alt = story.title ?? "小剧场";
    img.loading = "lazy";
    img.addEventListener("click", () => openLightbox(story.imagePath, story.title));
    figure.appendChild(img);
    body.appendChild(figure);
  }
  if (story.lines && story.lines.length) {
    const lines = document.createElement("div");
    lines.className = "sti-cs-lines";
    for (const line of story.lines) {
      const row = document.createElement("div");
      row.className = "sti-cs-line";
      if (line.speaker) {
        const b = document.createElement("b");
        b.textContent = line.speaker;
        row.appendChild(b);
      }
      row.appendChild(document.createTextNode(line.text));
      lines.appendChild(row);
    }
    body.appendChild(lines);
  }
  const actions = document.createElement("div");
  actions.className = "sti-cs-actions";
  const del = document.createElement("button");
  del.className = "sti-cs-regen";
  del.textContent = "删除";
  del.addEventListener("click", (e) => {
    e.preventDefault();
    removeStory(floor, bucket, story.storyId);
    mountTheater(floor);
  });
  actions.appendChild(del);
  body.appendChild(actions);
  card.appendChild(body);
  return card;
}
class TaskQueue {
  constructor(runner, options = {}) {
    this.pending = [];
    this.current = null;
    this.running = false;
    this.runner = runner;
    this.options = options;
    this.timeoutMs = options.taskTimeoutMs ?? 5 * 60 * 1e3;
  }
  /** 入队。重复 task.id 会被去重（忽略后入的）。 */
  enqueue(task) {
    var _a;
    if (this.pending.some((t) => t.id === task.id)) return;
    if (((_a = this.current) == null ? void 0 : _a.task.id) === task.id) return;
    this.pending.push(task);
    this.setStatus(task, "queued");
    void this.drain();
  }
  /** 取消指定任务：排队中的直接移除；运行中的发出 abort。 */
  cancel(taskId) {
    var _a;
    const idx = this.pending.findIndex((t) => t.id === taskId);
    if (idx >= 0) {
      const [task] = this.pending.splice(idx, 1);
      this.setStatus(task, "cancelled");
      return;
    }
    if (((_a = this.current) == null ? void 0 : _a.task.id) === taskId) {
      this.current.controller.abort();
    }
  }
  /** 取消全部（排队中 + 运行中）。 */
  cancelAll() {
    for (const task of this.pending.splice(0)) this.setStatus(task, "cancelled");
    if (this.current) this.current.controller.abort();
  }
  /** 等待当前队列排空（测试用）。 */
  async idle() {
    while (this.running || this.pending.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  get size() {
    return this.pending.length + (this.current ? 1 : 0);
  }
  // ----------------------------------------------------------
  // 内部调度
  // ----------------------------------------------------------
  async drain() {
    var _a, _b, _c, _d;
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length > 0) {
        const task = this.pending.shift();
        const controller = new AbortController();
        const entry = { task, controller, timer: null };
        this.current = entry;
        if (this.timeoutMs > 0) {
          entry.timer = setTimeout(() => controller.abort(), this.timeoutMs);
        }
        const ctx = {
          signal: controller.signal,
          report: (progress) => {
            task.progress = progress;
            task.updatedAt = Date.now();
          },
          setStatus: (status) => this.setStatus(task, status)
        };
        try {
          if (controller.signal.aborted) throw new DOMException("任务已取消", "AbortError");
          this.setStatus(task, "reading");
          await this.runner(task, ctx);
          if (controller.signal.aborted) throw new DOMException("任务已取消", "AbortError");
          this.setStatus(task, "completed");
          (_b = (_a = this.options).onComplete) == null ? void 0 : _b.call(_a, task);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          const cancelled = error.name === "AbortError" || controller.signal.aborted;
          this.setStatus(task, cancelled ? "cancelled" : "failed");
          if (!cancelled) {
            task.error = error.message;
            (_d = (_c = this.options).onError) == null ? void 0 : _d.call(_c, task, error);
          }
        } finally {
          if (entry.timer) clearTimeout(entry.timer);
          this.current = null;
        }
      }
    } finally {
      this.running = false;
    }
  }
  setStatus(task, status) {
    var _a, _b;
    task.status = status;
    task.updatedAt = Date.now();
    (_b = (_a = this.options).onStatusChange) == null ? void 0 : _b.call(_a, task, status);
  }
}
function toBaiBaiRequest(input, character) {
  const size = input.size === "landscape" ? "landscape" : "portrait";
  return {
    prompt: input.prompt,
    ...input.nl ? { nl: input.nl } : {},
    ...input.negative ? { negative: input.negative } : {},
    ...input.characters && input.characters.length ? { characters: input.characters } : {},
    size,
    ...typeof input.seed === "number" ? { seed: input.seed } : {},
    save: input.save !== false,
    ...character ? { character } : {}
  };
}
const baiBaiAdapter = {
  id: "baibai-public-v1",
  capabilities: {
    supportsWeightedTags: true,
    supportsNl: true,
    supportsCharacters: true,
    supportsSeed: true,
    supportsAbort: true
  },
  async generate(input, profile) {
    const result = await generateImage(toBaiBaiRequest(input, profile.generationProfileId));
    return {
      ...result.path ? { path: result.path } : {},
      ...result.dataUrl ? { dataUrl: result.dataUrl } : {},
      seed: result.seed,
      meta: {
        backend: result.backend,
        format: result.format,
        charactersApplied: result.charactersApplied
      }
    };
  }
};
const PANEL_BUBBLE_AREAS = [
  "tl",
  "tc",
  "tr",
  "ml",
  "mr",
  "bl",
  "bc",
  "br"
];
const PANEL_DIALOGUE_MAX = 4;
const PANEL_DIALOGUE_TEXT_MAX = 60;
const PANEL_DIALOGUE_SPEAKER_MAX = 16;
const PANEL_TAGS_BY_LAYOUT = {
  regular: ["1.4::multiple views::", "1.4::2koma::", "1.5::split screen::"],
  irregular: ["1.4::multiple views::", "1.5::split screen::"],
  inset: ["1.5::multiple views::", "1.4::white background::"],
  unframed: [
    "3格漫画",
    "三场景漫画构图",
    "3::非对称漫画页面布局::",
    "2::开放分镜漫画构图::",
    "2::无边框中央插画::",
    "3::第二场景周围没有长方形画框::",
    "2::主场景周围没有长方形包围::",
    "2::人物自然融入白色空间::",
    "1.4::white background::"
  ]
};
const PANEL_FORBIDDEN_CLAUSE = "8. 不要写 speech bubble、text、english text、dialogue、caption —— 这些词会让画面出现气泡或对白条，而生成的字全是乱码，比留白难看得多。分镜靠画面说话。";
const PANEL_SELF_CHECK = "【输出前自检，逐条核对后再输出】\n- tag 里是否原样包含了本档要求的构图词（含权重写法）？漏了必须补上。\n- nl 的第一句是否说清了版面？只描述画面内容而不提版面，等于没写。\n- 景别 tag 是否只有一个？\n- 这是漫画分镜图，不是一张普通插画。任何一条不满足，就重写再输出。";
const PANEL_NO_POS_CLAUSE = "分格图不需要 pos：NAI 的坐标是整张图的坐标系，一格里的角色会被拉到整图某个位置、也就是被拉出格子。这个字段整个省略。";
function compositionTags(layout) {
  return PANEL_TAGS_BY_LAYOUT[layout].join(", ");
}
function normalizePanelLayout(v) {
  return v === "irregular" || v === "inset" || v === "unframed" ? v : "regular";
}
function normalizePanelPageType(v) {
  return v === "a" || v === "b" || v === "c" || v === "d" ? v : "auto";
}
function normalizeDialoguePolicy(v) {
  return v === "always" || v === "eager" ? v : "auto";
}
function clamp01(v) {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(Math.min(1, Math.max(0, v)) * 1e4) / 1e4 : void 0;
}
function normalizeDialogueItems(value) {
  if (!Array.isArray(value)) return [];
  const items = [];
  for (const raw of value) {
    if (items.length >= PANEL_DIALOGUE_MAX) break;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw;
    const text = typeof item.text === "string" ? item.text.trim().replace(/[\r\n]+/g, " ").slice(0, PANEL_DIALOGUE_TEXT_MAX) : "";
    if (!text) continue;
    const speaker = typeof item.speaker === "string" ? item.speaker.trim().replace(/[\r\n]+/g, " ").slice(0, PANEL_DIALOGUE_SPEAKER_MAX) : "";
    const areaRaw = typeof item.area === "string" ? item.area.trim().toLowerCase() : "";
    const area = PANEL_BUBBLE_AREAS.includes(areaRaw) ? areaRaw : void 0;
    const x = clamp01(item.x);
    const y = clamp01(item.y);
    const dirRaw = typeof item.dir === "string" ? item.dir.trim().toLowerCase() : "";
    const dir = dirRaw === "v" || dirRaw === "h" ? dirRaw : void 0;
    const moodRaw = typeof item.mood === "string" ? item.mood.trim().toLowerCase() : "";
    const mood = moodRaw === "shout" || moodRaw === "whisper" || moodRaw === "calm" ? moodRaw : void 0;
    items.push({
      ...speaker ? { speaker } : {},
      ...area ? { area } : {},
      ...x !== void 0 ? { x } : {},
      ...y !== void 0 ? { y } : {},
      ...dir ? { dir } : {},
      ...mood ? { mood } : {},
      text
    });
  }
  return items;
}
const UNFRAMED_NL_PORTRAIT = "An asymmetric three-scene manga page on a white background: the top 20% of the page is a narrow horizontal panel with a thin black border showing a simple close-up of one face, below the top strip, the main illustration fills the rest of the page with no border and no frame — the characters are drawn large, filling most of the illustration area with only narrow white margins around them, directly on the white page, blending into the white space, with one arm extending past the page edge — and the bottom right area has a floating panel with a thin black border, about 65% of the page width and 27% of the page height, showing a close-up detail of the same moment. Only the top and bottom-right scenes have panel borders, and no rectangular border surrounds the characters.";
const PANEL_NL_SENTENCE = {
  regular: {
    portrait: "The canvas is divided into two equal panels, one above the other, separated by a thin black gutter.",
    landscape: "The canvas is split into two panels side by side, separated by a thin black gutter."
  },
  irregular: {
    portrait: "The canvas is divided into panels of unequal size — one large main panel with smaller panels below it — separated by thin black gutters.",
    landscape: "The canvas is divided into panels of unequal size — one large main panel with narrower panels beside it — separated by thin black gutters."
  },
  inset: {
    portrait: "A manga page on a white background: an unframed character illustration occupies the center with generous white space around it, and small panels framed by thin black borders — one across the top, one in the bottom right corner — show close-up details of the same moment.",
    landscape: "A manga page on a white background: an unframed character illustration occupies the center with generous white space around it, and small panels framed by thin black borders — one across the top, one along the right edge — show close-up details of the same moment."
  },
  unframed: {
    portrait: UNFRAMED_NL_PORTRAIT,
    landscape: UNFRAMED_NL_PORTRAIT
  }
};
const UNFRAMED_PAGE_SPECS = {
  a: {
    nlHeadline: "An asymmetric three-scene manga page on a white background: a narrow bordered panel across the top 20% shows a simple close-up of one face, the main illustration fills the rest of the page, and a floating bordered panel sits in the bottom right area.",
    areas: ["top 20% strip", "main illustration", "bottom-right floating panel"],
    framed: ["top strip", "bottom-right panel"],
    overlapMax: 0.25
  },
  b: {
    nlHeadline: "A two-part manga page on a white background: a narrow bordered panel across the top 20% shows a simple close-up of one face, and the main illustration fills the remaining 80% of the page.",
    areas: ["top 20% strip", "main illustration"],
    framed: ["top strip"],
    overlapMax: 0.25
  },
  c: {
    nlHeadline: "A two-part manga page on a white background: a tall narrow bordered panel runs along the right edge (about 30% of the page width), and the main illustration fills the remaining area.",
    areas: ["right-edge vertical strip", "main illustration"],
    framed: ["right-edge strip"],
    overlapMax: 0.25
  },
  d: {
    nlHeadline: "A manga page on a white background where the main illustration fills the whole page, and a small bordered panel sits in the bottom right corner (about 30% of the page width).",
    areas: ["main illustration", "bottom-right floating panel"],
    framed: ["bottom-right panel"],
    overlapMax: 0.25
  }
};
function unframedNlSentence(pageType) {
  if (pageType === "auto") return PANEL_NL_SENTENCE.unframed.portrait;
  const spec = UNFRAMED_PAGE_SPECS[pageType];
  return `${spec.nlHeadline} The characters are drawn large, filling most of the illustration area, directly on the white page, blending into the white space, with one arm extending past the page edge. Only the inset panel(s) have thin black borders, and no rectangular border surrounds the characters.`;
}
const DIALOGUE_POLICY_TEXT = {
  auto: "只挑最关键的话；没有值得说的就整个字段省略，不要硬凑",
  always: "每张图必须至少写 1 条：安静镜头用拟声词顶上（「咚！」「……」都算），不许省略",
  eager: "有对话、呼喊、惊讶时必须写；只有独处、风景镜头才允许省略"
};
function panelDialogueClause(mode, policy = "auto") {
  const format = mode === "json" ? 'images 数组对应元素加 `dialogue` 字段，形如 `[{"text":"放学一起走吗？","area":"tl"}]`' : '在该条生图标签里写子标签 `<dialogue>[{"text":"放学一起走吗？","area":"tl"}]</dialogue>`';
  return `【对白气泡】这一张是漫画页，剧情里「谁说了什么」值得画进图时，${format}。
   - text：简短中文口语，一条不超过 20 个字；最多 4 条，${DIALOGUE_POLICY_TEXT[policy]}；
   - area：气泡锚点（tl/tc/tr/ml/mr/bl/bc/br），按说话人位置挑，可省略；
   - dir：排版方向——「v」竖排（独白、呢喃），缺省横排，可省略；
   - mood：语气——calm 缺省 / shout 喊叫 / whisper 轻声呢喃（带小爱心），可省略；
   - 想竖排轻声效果写成 {"text":"……","dir":"v","mood":"whisper"}，dir 与 mood 都带；
   - 台词出自本楼剧情、符合人物口吻，不写旁白；气泡里只画台词本身，不要写说话人名字。
   气泡由插件在出图后用系统字体合成（不会乱码），画面里照旧不许出现任何文字或气泡。`;
}
function regularRule(nlOn) {
  const ninth = nlOn ? '9. nl 必须按格写，这是唯一能分区描述两格的通道：先用一句总述场景，再用 "In the upper panel, ..." 和 "The lower panel shows ..." 各写一句。不要用 Panel 1 / Panel 2 编号，也不要写对白。' : "9. 本次没有 nl 通道，两格内容只能靠 tag 表达：让人物动作在两格之间发生变化。不要试图用第二个景别 tag 拉开两格。";
  return [
    "[漫画分镜｜一张画布切两格]",
    "",
    "这一张是双格漫画，不是普通插画：同一张画布被一道边框分成两格，读者从上往下读。两格讲同一件事的两层，不是两件不相干的事。",
    "",
    `1. 构图 tag 必须写全这三个，原样照抄（含权重写法），一个都不能少，紧跟人数 tag、排在外貌之前：${compositionTags("regular")}。 不要写 panel layout、comic panel、manga（0 帖空 tag）；也不要写 comic（整本漫画语义，会拉成黑白网点）。`,
    "2. 两格讲同一件事的两层，二选一，一张图里不许混用：**递进**（上格动作前、下格结果）或 **拆解**（同瞬间，上格全身空间、下格推近脸或接触点；两格人物停在同一动作）。",
    "3. 两格之间至少要有两个肉眼可辨的差异（人在做的事、画面里的东西、远近）；只有一个差异会被当噪声抹平。",
    "4. 景别 tag 仍然只写一个，用 cowboy shot 或 full body；两格各自的远近写在 nl 里。",
    "5. 两格里出现的人必须一致，同一个人在两格保持同一套外观词。",
    "6. 画幅写 portrait：上下两格各占一半高度，从上到下读。不要写 landscape。",
    "7. focus tag 属于整张图、不分格，全图最多 1~2 个。",
    PANEL_FORBIDDEN_CLAUSE,
    ninth
  ].join("\n");
}
function irregularRule(nlOn) {
  const ninth = nlOn ? '9. nl 必须按格写，并先说清版面：先用一句总述场景与画布怎么分（例："An irregular comic page: one large panel filling the upper two-thirds, and two narrow panels side by side along the bottom, separated by thin black gutters."），再逐格写。' : "9. 本次没有 nl 通道，不规则分格全靠 tag：让人物动作在大小不同的格里发生变化，不要写 Panel 1 / Panel 2 编号。";
  return [
    "[漫画分镜｜不规则分格]",
    "",
    "这一张是不规则分格的单张漫画，不是等分双格：画布被边框切成大小不等的几格，从上往下、从左往右读。所有格讲同一件事的不同层。",
    "",
    `1. 构图 tag 必须写全这两个，原样照抄（含权重写法）：${compositionTags("irregular")}。 不要写 2koma（钉成等分两格，与本模式打架）、4koma、panel layout、comic panel、manga、comic。`,
    "2. 2～4 格，大小必须不等：至少一格面积是另一格的两倍以上，或有一格细长条。禁止上下各一半 / 左右各一半等分。三种形态择一：大格+下方两条小格 / 左侧竖长条+右侧大格 / 上方宽格+下方一大一小。",
    "3. 所有格讲同一件事的不同层，相邻两格至少两个肉眼可辨的差异；同一批人出现在每一格。",
    "4. 读法必须顺：从上到下、从左到右。",
    "4a. 排版要满、白边要窄：格间只留细黑 gutter（约页宽 3%），人物画大撑到格边；所有格合计覆盖页面九成以上。",
    "5. 景别 tag 仍然只写一个；各格远近写在 nl 里。",
    "6. 画幅写 portrait：上方一大格占约三分之二高度，下方一到两条窄格；或左侧竖长条+右侧主格。不要上下各一半。",
    "7. focus tag 全图最多 1~2 个。",
    PANEL_FORBIDDEN_CLAUSE,
    ninth
  ].join("\n");
}
function insetRule(nlOn) {
  const ninth = nlOn ? '9. nl 第一句固定交代版面（例："A manga page on a white background: an unframed character illustration occupies the center with generous white space around it; a narrow wide panel with a thin black border across the top shows a close-up of their faces, and a small framed panel in the bottom right corner shows their intertwined hands."），再写人物动作、表情、姿态——不要写房间、家具、窗、街景。' : "9. 本次没有 nl 通道：白底人物为主，特写格内容只能靠 tag 表达，且不要写任何场景 tag。";
  return [
    "[漫画分镜｜人物漫画页（白底 + 特写框）]",
    "",
    "这一张是以人物为主的漫画页：白底为主，一张不加边框的人物插画放在页面中央、四周大量留白；只有特写小格才带细黑边框、浮在白边上。",
    "",
    `1. 构图 tag 写这两个，原样照抄：${compositionTags("inset")}。 不要写任何场景 tag（indoors、bed、classroom、window、street 一类全不要）；不要写 split screen、2koma/3koma/4koma、panel layout、comic panel、manga、comic。`,
    "2. 版面：白底为主、以人物为主。绝不允许把画布均分成上下或左右两三块。",
    "3. 画面里只有人物，几乎没有场景：环境最多一两件小道具。tag 与 nl 都只写人物。",
    "4. 特写小格 1～2 个，带细黑边框浮在白边上：顶部横条（宽约全宽、高约 15~20%）装脸部特写；贴边小格（右侧或右下角、宽约三分之一）装手/接触点。小格来自主画面同一瞬间、同一套外观词。",
    "5. 景别 tag 仍然只写一个（cowboy shot 或 full body）；小格特写写在 nl 里。",
    "6. 画幅写 portrait：白底竖页，人物居中占主要位置；顶部横条贴上边缘，贴边小格在右下角。",
    "7. focus tag 全图最多 1~2 个。",
    PANEL_FORBIDDEN_CLAUSE,
    ninth,
    "额外自检：tag 里是否还有任何场景词？nl 里是否描述了房间、家具、窗、街景？有就删掉。"
  ].join("\n");
}
function unframedRule(nlOn, pageType) {
  const pt = normalizePanelPageType(pageType);
  const specLine = pt === "auto" ? "2. 版面从 A（顶条+主画+右下格）/ B（顶条+主画）/ C（右缘竖格+主画）/ D（主画+右下浮格）四种页型里按剧情挑一种；默认 A，只需一处特写用 B 或 D，竖构图特写用 C，相邻两次出图尽量换型。不许自创第五种。" : `2. 版面钉死为 ${pt.toUpperCase()} 型：${UNFRAMED_PAGE_SPECS[pt].areas.join("、")}。不许自创其它版式。`;
  const ninth = nlOn ? `9. nl 第一句按页型照抄对应句式（${pt === "auto" ? "见四种页型首句" : UNFRAMED_PAGE_SPECS[pt].nlHeadline}），之后逐区写；最后必须收一句："The layout covers almost the whole page with only narrow white margins; only the inset panel(s) have thin black borders, and the main illustration has absolutely no panel border, with no rectangular border around the characters."` : "9. 本次没有 nl 通道：白底无框主画靠 tag 表达，特写格只做安静的放大镜。";
  return [
    "[漫画分镜｜无框漫画页（白底 + 大幅无框主画 + 带框特写格）]",
    "",
    "这一张是以人物为主的漫画页：白底为主，主插画无边框、铺到页底，特写格才带细黑边框。",
    "",
    `1. 构图 tag 必须原样照抄：${compositionTags("unframed")}。`,
    specLine,
    "铁律：主插画周围绝对没有长方形画框；带细黑边框的只有特写格；人物自然融入白色空间，周围不许出现任何圈住它的线。",
    "3. 场景词最多两个，只用来定室内外：一个 indoors 或 outdoors 锚点（必须有）+ 最多一个具体地点；家具、物件、光照、时段词一个都不要。",
    '4. 所有格讲同一个瞬间的三个层：主插画管"发生了什么"，顶部条管"脸上的表情"，右下格管"放大哪一处细节"；人物在所有格同一套外观词。',
    "5. 特写格防崩：顶部条优先一个人的脸，右下格只装一个局部；格内构图简单到一句话说完；复杂动作全放主插画。",
    "5a. 人物主体句式：tag 里写 `2::大型电影式<这一楼的人物动作>构图::`，再写 `富有表现力的肢体语言`。",
    "6. 画幅写 portrait：白底竖页，按所选页型排；人物身体或手臂至少一处延伸到页面边缘之外。",
    "7. focus tag 全图最多 1~2 个。",
    PANEL_FORBIDDEN_CLAUSE,
    ninth,
    '额外自检：场景词是否最多两个？nl 是否逐区写了页面百分比？主插画人物是否写大（占面积八成以上）？nl 结尾是否有"只有特写格有边框"的收束句？页面是否太空？'
  ].join("\n");
}
function buildPanelRule(enabled, options) {
  if (!enabled) return "";
  const layout = normalizePanelLayout(options.layout);
  const nlOn = options.nl !== false;
  const pageType = normalizePanelPageType(options.pageType);
  let body;
  switch (layout) {
    case "irregular":
      body = irregularRule(nlOn);
      break;
    case "inset":
      body = insetRule(nlOn);
      break;
    case "unframed":
      body = unframedRule(nlOn, pageType);
      break;
    case "regular":
    default:
      body = regularRule(nlOn);
      break;
  }
  const parts = [body, PANEL_SELF_CHECK];
  if (options.backend === "nai" && options.charPrompts === true) {
    parts.push(PANEL_NO_POS_CLAUSE);
  }
  if (options.dialogue === true) {
    parts.push(panelDialogueClause(options.dialogueMode ?? "json", normalizeDialoguePolicy(options.dialoguePolicy)));
  }
  return parts.join("\n\n");
}
function normalizeCharacters(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const c of raw.slice(0, 12)) {
    if (!c || typeof c !== "object" || Array.isArray(c)) continue;
    const o = c;
    const name = typeof o.name === "string" ? o.name.trim().slice(0, 32) : "";
    const act = typeof o.act === "string" ? o.act.trim().slice(0, 80) : "";
    if (name) out.push({ name, act });
  }
  return out;
}
function normalizePanel(raw, index2) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw;
  const tags = typeof o.tags === "string" ? o.tags.trim().slice(0, 2e3) : "";
  if (!tags && !Array.isArray(o.dialogue)) return null;
  return {
    index: typeof o.index === "number" && Number.isFinite(o.index) ? Math.max(0, Math.floor(o.index)) : index2,
    title: typeof o.title === "string" ? o.title.trim().slice(0, 120) : `第 ${index2 + 1} 格`,
    characters: normalizeCharacters(o.characters),
    mood: typeof o.mood === "string" ? o.mood.trim().slice(0, 120) : "",
    tags,
    ...typeof o.nl === "string" && o.nl.trim() ? { nl: o.nl.trim().slice(0, 2e3) } : {},
    ...(() => {
      const dialogue = normalizeDialogueItems(o.dialogue);
      return dialogue.length ? { dialogue } : {};
    })()
  };
}
function normalizePage(raw, pageIndex, warnings) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(`第 ${pageIndex + 1} 页不是对象，已跳过`);
    return null;
  }
  const o = raw;
  if (!Array.isArray(o.panels) || o.panels.length === 0) {
    warnings.push(`第 ${pageIndex + 1} 页无 panels 数组，已跳过`);
    return null;
  }
  const panels = [];
  for (let i = 0; i < Math.min(o.panels.length, 12); i += 1) {
    const panel = normalizePanel(o.panels[i], i);
    if (panel) panels.push(panel);
    else warnings.push(`第 ${pageIndex + 1} 页第 ${i + 1} 格数据无效，已跳过`);
  }
  if (panels.length === 0) {
    warnings.push(`第 ${pageIndex + 1} 页没有有效分格，已跳过`);
    return null;
  }
  return {
    pageIndex: typeof o.pageIndex === "number" && Number.isFinite(o.pageIndex) ? Math.max(0, Math.floor(o.pageIndex)) : pageIndex,
    title: typeof o.title === "string" ? o.title.trim().slice(0, 120) : `第 ${pageIndex + 1} 页`,
    layout: normalizePanelLayout(o.layout),
    panels
  };
}
function parseComicPagePlan(input) {
  const warnings = [];
  let data = input;
  if (typeof data === "string") {
    const trimmed = data.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1].trim() : trimmed;
    try {
      data = JSON.parse(candidate);
    } catch {
      return { pages: [], warnings: ["JSON 解析失败，台词/分镜数据已丢弃"] };
    }
  }
  let rawPages = [];
  if (Array.isArray(data)) {
    rawPages = data;
  } else if (data && typeof data === "object") {
    const o = data;
    if (Array.isArray(o.pages)) rawPages = o.pages;
    else if (Array.isArray(o.panels)) rawPages = [data];
    else if (o.comic && typeof o.comic === "object") {
      const inner = o.comic;
      if (Array.isArray(inner.pages)) rawPages = inner.pages;
    }
  }
  if (rawPages.length === 0) {
    return { pages: [], warnings: [...warnings, "未找到 pages / panels 数组"] };
  }
  const pages = [];
  for (let i = 0; i < Math.min(rawPages.length, 8); i += 1) {
    const page = normalizePage(rawPages[i], i, warnings);
    if (page) pages.push(page);
  }
  return { pages, warnings };
}
function extractJson(text) {
  const raw = String(text ?? "");
  if (!raw.trim()) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const inner = fenced[1].trim();
    if (inner) return inner;
  }
  const start = raw.search(/[\[{]/);
  if (start < 0) return null;
  const open = raw[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1).trim();
    }
  }
  return null;
}
function safeParseJson(text) {
  const json = extractJson(text);
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
const ILLUSTRATION_SYSTEM = `你是一位专业的图像提示词（tag）编辑。你的任务是根据给定剧情，输出结构化的英文生图标签。
严格遵守：
1. 只输出一个 JSON 对象，不要输出任何解释文字、不要使用 Markdown 代码围栏。
2. 结构：{"segments":[{"id":"...","source":"character|scene|global","characterName":"角色名(仅character段)","english":["英文tag",...],"chinese":["中文辅助翻译",...],"order":数字}],"nl":"可选英文自然语言描述","negative":"可选英文负面词","size":"portrait|landscape"}。
3. english / nl / negative 必须是纯英文，绝不能出现中文——中文只放在 chinese 字段作辅助阅读。
4. character 段只写角色固定外貌（来自提供的角色快照，原样保留其 tag，不得改写）；scene 段写本次画面新增的动作、场景、构图、光线、情绪 tag。
5. 一次只策划一个明确的瞬间，不要描述整段剧情的时间跨度。
6. 场景与动作必须以给定剧情和上下文为依据，不得凭空添加关键剧情事实。
7. segment 按 order 从小到大排列；无需的字段直接省略，不要填空字符串或空数组。
8. 若剧情里的名场面适合漫画分镜，仍按单幅插画输出（漫画由专门的模式处理）。`;
function buildIllustrationSystemPrompt(options) {
  const flags = [];
  if (!options.includeChinese) flags.push("不要生成 chinese 字段（用户已关闭中文辅助）。");
  if (!options.includeNl) flags.push("不要生成 nl 字段（当前后端不使用自然语言通道）。");
  if (!options.includeNegative) flags.push("不要生成 negative 字段。");
  if (options.size) flags.push(`画幅倾向：${options.size}。`);
  return flags.length ? `${ILLUSTRATION_SYSTEM}

补充约束：
${flags.join("\n")}` : ILLUSTRATION_SYSTEM;
}
function buildIllustrationUserPrompt(scene, characters) {
  const parts = [];
  parts.push("【本次画面主体（选段，必须以此为准）】\n" + scene.selectedText);
  if (scene.floorText) parts.push("【所在楼层全文（情境参考）】\n" + scene.floorText);
  if (scene.previousText) parts.push("【前文（仅补充，勿当成本画面正在发生的动作）】\n" + scene.previousText);
  if (scene.nextText) parts.push("【后文（仅补充）】\n" + scene.nextText);
  if (characters.length > 0) {
    const lines = characters.map((c) => `- ${c.name}: ${c.tag ?? ""}${c.nl ? ` (${c.nl})` : ""}`);
    parts.push("【角色固定外貌（character 段须原样保留其 tag）】\n" + lines.join("\n"));
  }
  parts.push("请只输出一个 JSON 对象。");
  return parts.join("\n\n");
}
function normalizePromptSegment(raw, index2) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw;
  const source = o.source === "character" || o.source === "global" ? o.source : "scene";
  const english = Array.isArray(o.english) ? o.english.filter((t) => typeof t === "string").map((t) => t.trim()).filter(Boolean).slice(0, 60) : [];
  if (english.length === 0) return null;
  const chinese = Array.isArray(o.chinese) ? o.chinese.filter((t) => typeof t === "string").map((t) => t.trim()).filter(Boolean).slice(0, 60) : [];
  return {
    id: typeof o.id === "string" && o.id.trim() ? o.id.trim().slice(0, 80) : `${source}-${index2}`,
    source,
    ...source === "character" && typeof o.characterName === "string" ? { characterName: o.characterName.trim().slice(0, 32) } : {},
    english,
    chinese,
    enabled: o.enabled !== false,
    order: typeof o.order === "number" && Number.isFinite(o.order) ? Math.floor(o.order) : index2
  };
}
function parseIllustrationResponse(text) {
  const data = safeParseJson(text);
  if (!data || typeof data !== "object") return null;
  const rawSegments = Array.isArray(data.segments) ? data.segments : [];
  const segments = [];
  for (let i = 0; i < Math.min(rawSegments.length, 40); i += 1) {
    const seg = normalizePromptSegment(rawSegments[i], i);
    if (seg) segments.push(seg);
  }
  if (segments.length === 0) return null;
  const result = { segments };
  if (typeof data.nl === "string" && data.nl.trim()) result.nl = data.nl.trim().slice(0, 2e3);
  if (typeof data.negative === "string" && data.negative.trim()) result.negative = data.negative.trim().slice(0, 2e3);
  if (typeof data.size === "string" && data.size.trim()) result.size = data.size.trim().slice(0, 40);
  return result;
}
const COMIC_SYSTEM_HEAD = `你是一位专业的漫画分镜编辑。根据给定剧情，把它排成漫画页，并以 JSON 输出分镜计划。
只输出一个 JSON 对象，不要解释文字、不要 Markdown 代码围栏。
结构：{"pages":[{"pageIndex":0,"title":"页标题","layout":"regular|irregular|inset|unframed","panels":[{"index":0,"title":"格标题","characters":[{"name":"角色","act":"动作"}],"mood":"氛围","tags":"英文构图与画面tag(逗号分隔)","nl":"英文分区描述","dialogue":[{"text":"简短中文台词","area":"tl|tc|tr|ml|mr|bl|bc|br","dir":"v(可选,竖排)","mood":"whisper(可选)"}]}]}]}。
要求：
- tags 必须是英文生图 tag（逗号分隔），可带权重；不要写任何中文进 tags/nl。
- nl 是英文自然语言描述，按格写；台词是对白气泡用中文口语。
- 一次只讲清楚每个格的一个瞬间；同一批角色在各格保持一致的着装与外貌。
- 分格数量与版面严格遵循下面的【分镜规则】。`;
function buildComicSystemPrompt(options) {
  const ruleOptions = {
    backend: options.backend,
    charPrompts: options.charPrompts,
    nl: options.nl,
    lockedSize: options.lockedSize,
    layout: normalizePanelLayout(options.panelLayout),
    pageType: normalizePanelPageType(options.pageType),
    dialogue: options.dialogue,
    dialogueMode: options.dialogueMode,
    dialoguePolicy: normalizeDialoguePolicy(options.dialoguePolicy)
  };
  const rule = buildPanelRule(options.panelMode, ruleOptions);
  const parts = [COMIC_SYSTEM_HEAD];
  if (rule) parts.push("【分镜规则（必须遵守）】\n" + rule);
  parts.push(`【输出约束】最多 ${Math.max(1, Math.min(8, options.maxPages))} 页；${options.dialogue ? "台词字段按规则写，可省略。" : "本次不要输出 dialogue 字段。"}`);
  if (!options.includeChinese) parts.push("除台词外的辅助中文一律不要输出。");
  return parts.join("\n\n");
}
function buildComicUserPrompt(scene, characters) {
  const parts = [];
  parts.push("【剧情（据此排分镜）】\n" + scene.selectedText);
  if (scene.floorText) parts.push("【所在楼层全文】\n" + scene.floorText);
  if (scene.previousText) parts.push("【前文（仅补充）】\n" + scene.previousText);
  if (scene.nextText) parts.push("【后文（仅补充）】\n" + scene.nextText);
  if (characters.length > 0) {
    const lines = characters.map((c) => `- ${c.name}: ${c.tag ?? ""}${c.nl ? ` (${c.nl})` : ""}`);
    parts.push("【在场角色（保持外貌一致）】\n" + lines.join("\n"));
  }
  parts.push("请只输出一个 JSON 对象（pages 数组）。");
  return parts.join("\n\n");
}
const mainApiLlmCaller = async (system, user) => {
  const prompt = `${system}

---

${user}`;
  return await generateQuietPrompt(prompt);
};
const defaultLlmCaller = async (system, user) => {
  const viaSecondary = await generateViaSecondary(system, user);
  if (viaSecondary !== null) return viaSecondary;
  return await mainApiLlmCaller(system, user);
};
function makeModeLlmCaller(settings2, mode) {
  const channelId = resolveChannelId(mode, settings2.modeChannels, settings2.llmSource);
  if (channelId === "main") return mainApiLlmCaller;
  return async (system, user) => {
    const viaChannel = await generateViaChannelId(channelId, system, user);
    if (viaChannel !== null) return viaChannel;
    return await mainApiLlmCaller(system, user);
  };
}
async function generateIllustrationPlan(input) {
  const caller = input.caller ?? defaultLlmCaller;
  const system = buildIllustrationSystemPrompt(input.options);
  const user = buildIllustrationUserPrompt(input.scene, input.characters ?? []);
  try {
    const raw = await caller(system, user);
    const parsed = parseIllustrationResponse(raw);
    if (!parsed) {
      return { ok: false, error: "LLM 未返回可解析的结构化 Tag（JSON 解析失败或无有效片段）。" };
    }
    return { ok: true, data: parsed };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
async function generateComicPlan(input) {
  const caller = input.caller ?? defaultLlmCaller;
  const system = buildComicSystemPrompt(input.options);
  const user = buildComicUserPrompt(input.scene, input.characters ?? []);
  try {
    const raw = await caller(system, user);
    const parsed = parseComicPagePlan(raw);
    if (parsed.pages.length === 0) {
      return {
        ok: false,
        error: "LLM 未返回可解析的分镜计划。",
        warnings: parsed.warnings
      };
    }
    return { ok: true, data: parsed.pages, warnings: parsed.warnings };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
function composeEnglishPrompt(segments) {
  const enabled = segments.filter((s) => s.enabled);
  const sorted = [...enabled].sort((a, b) => a.order - b.order);
  const allTags = [];
  const seenBareTags = /* @__PURE__ */ new Set();
  for (const segment of sorted) {
    for (const tag of segment.english) {
      const trimmed = tag.trim();
      if (!trimmed) continue;
      const bare = bareTagOf$1(trimmed);
      if (bare && seenBareTags.has(bare) && !trimmed.includes("::")) {
        continue;
      }
      if (bare) seenBareTags.add(bare);
      allTags.push(trimmed);
    }
  }
  return allTags.join(", ");
}
function bareTagOf$1(tag) {
  let text = tag.trim();
  text = text.replace(/^\s*[\d.]+\s*::/, "");
  text = text.replace(/^\s*::/, "");
  text = text.replace(/::\s*$/, "");
  return text.trim().toLowerCase();
}
function bareTagOf(segment) {
  return segment.replace(/^\s*[\d.]+::/, "").replace(/^\s*::/, "").replace(/::\s*$/, "").trim().toLowerCase();
}
function isPlainSegment(segment) {
  const text = segment.trim();
  if (!text) return false;
  if (!text.includes("::")) return true;
  return /^[\d.]+\s*::.*::\s*$/.test(text);
}
const PANEL_FAMILY = [
  "multiple views",
  "2koma",
  "3koma",
  "4koma",
  "split screen",
  "3格漫画",
  "三场景漫画构图",
  "非对称漫画页面布局",
  "开放分镜漫画构图",
  "无边框中央插画",
  "第二场景周围没有长方形画框",
  "主场景周围没有长方形包围",
  "人物自然融入白色空间"
];
const PANEL_FORBIDDEN_BY_LAYOUT = {
  regular: ["3koma", "4koma"],
  irregular: ["2koma", "3koma", "4koma"],
  inset: ["2koma", "3koma", "4koma", "split screen"],
  unframed: ["multiple views", "2koma", "3koma", "4koma", "split screen"]
};
const SCENE_ANCHOR_TAGS = ["indoors", "outdoors", "interior", "exterior"];
const SCENE_LOCATION_TAGS = [
  "dorm room",
  "bedroom",
  "classroom",
  "street",
  "city",
  "bathroom",
  "kitchen",
  "office",
  "living room",
  "study",
  "corridor",
  "rooftop"
];
const INSET_SCENE_TAGS = [
  "indoors",
  "outdoors",
  "dorm room",
  "bedroom",
  "classroom",
  "street",
  "city",
  "scenery",
  "bed",
  "single bed",
  "bedsheets",
  "rumpled bedsheets",
  "blanket",
  "pillow",
  "desk",
  "wooden desk",
  "table",
  "bookshelf",
  "shelf",
  "window",
  "curtain",
  "glass jar",
  "paper cranes",
  "wooden floor",
  "floor",
  "sunlight from window",
  "side lighting",
  "warm colors",
  "backlighting",
  "afternoon",
  "morning",
  "evening",
  "night",
  "sunset",
  "sunrise",
  "depth of field",
  "shallow depth of field"
];
function enforcePanelPrompt(prompt, layout) {
  const kind = normalizePanelLayout(layout);
  const source = String(prompt ?? "").trim();
  if (!source) return { prompt: source, removed: [], added: [] };
  const forbidden = new Set(PANEL_FORBIDDEN_BY_LAYOUT[kind]);
  const stripScene = kind === "inset" || kind === "unframed";
  const sceneLimit = kind === "unframed";
  let locationKept = 0;
  const kept = [];
  const removed = [];
  const present = /* @__PURE__ */ new Set();
  for (const segment of source.split(",")) {
    const text = segment.trim();
    if (!text) continue;
    const bare = bareTagOf(text);
    present.add(bare);
    if (!PANEL_FAMILY.includes(bare)) {
      if (sceneLimit && isPlainSegment(text)) {
        if (SCENE_ANCHOR_TAGS.includes(bare)) {
          kept.push(text);
          continue;
        }
        if (SCENE_LOCATION_TAGS.includes(bare)) {
          if (locationKept < 2) {
            locationKept += 1;
            kept.push(text);
            continue;
          }
          removed.push(text);
          continue;
        }
        if (INSET_SCENE_TAGS.includes(bare)) {
          removed.push(text);
          continue;
        }
        kept.push(text);
        continue;
      }
      if (stripScene && isPlainSegment(text) && INSET_SCENE_TAGS.includes(bare)) {
        removed.push(text);
        continue;
      }
      kept.push(text);
      continue;
    }
    if (isPlainSegment(text) && forbidden.has(bare)) {
      removed.push(text);
      continue;
    }
    kept.push(text);
  }
  const missing = PANEL_TAGS_BY_LAYOUT[kind].filter((tag) => !present.has(bareTagOf(tag)));
  return { prompt: [...missing, ...kept].join(", "), removed, added: missing };
}
function decidePanelInjection(input) {
  const layout = input.chibiOn ? "regular" : normalizePanelLayout(input.panelLayout);
  return { enabled: true, layout };
}
function isMostlyChinese(text) {
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  if (!cjk) return false;
  return cjk > (text.match(/[a-zA-Z]/g) ?? []).length;
}
const PANEL_NL_MARK = /\b(?:panels?|gutters?|inset|main image|main illustration|split screen|two-panel|comic page)\b/i;
function applyPanelToNl(nl, layout, orientation = "portrait", pageType = "auto") {
  const kind = normalizePanelLayout(layout);
  const text = String(nl ?? "").trim();
  if (!text) return text;
  if (isMostlyChinese(text) || PANEL_NL_MARK.test(text)) return nl;
  const sentence = kind === "unframed" ? unframedNlSentence(normalizePanelPageType(pageType)) : PANEL_NL_SENTENCE[kind][orientation === "landscape" ? "landscape" : "portrait"];
  return `${sentence} ${text}`;
}
function enforceForGeneration(input) {
  const decision = decidePanelInjection({
    panelLayout: input.panelLayout,
    chibiOn: input.chibiOn
  });
  const enforced = enforcePanelPrompt(input.prompt, decision.layout);
  return {
    prompt: enforced.prompt,
    nl: applyPanelToNl(input.nl, decision.layout, input.orientation, input.pageType),
    applied: true,
    layout: decision.layout,
    removed: enforced.removed,
    added: enforced.added
  };
}
function buildImageSnippet(imagePath, alt = "配图") {
  const safeAlt = alt.replace(/[\]\n\r]/g, " ").trim() || "配图";
  return `

![](${imagePath})`.replace("[]", `[${safeAlt}]`) + "\n";
}
async function insertImageIntoBody(input) {
  const { floor, chatId, swipeId, sendDate, imagePath, anchorText } = input;
  if (!imagePath) return { ok: false, reason: "no-image" };
  const ctx = getContext();
  if (!ctx || !Array.isArray(ctx.chat) || typeof ctx.saveChat !== "function") {
    return { ok: false, reason: "no-context" };
  }
  if (getCurrentChatId() !== chatId) return { ok: false, reason: "chat-changed" };
  const msg = ctx.chat[floor];
  if (!msg || typeof msg.mes !== "string") return { ok: false, reason: "floor-changed" };
  if (sendDate) {
    const actual = typeof msg.send_date === "string" ? msg.send_date.trim() : "";
    if (actual && actual !== sendDate) return { ok: false, reason: "floor-changed" };
  }
  const curSwipe = typeof msg.swipe_id === "number" ? msg.swipe_id : 0;
  if (curSwipe !== swipeId) return { ok: false, reason: "swipe-changed" };
  const snippet = buildImageSnippet(imagePath, input.alt);
  const currentText = msg.mes;
  let nextText;
  let position;
  if (anchorText && anchorText.length >= 2 && currentText.includes(anchorText)) {
    const at = currentText.indexOf(anchorText) + anchorText.length;
    nextText = currentText.slice(0, at) + snippet + currentText.slice(at);
    position = "after-anchor";
  } else {
    nextText = `${currentText.trimEnd()}${snippet}`;
    position = "appended";
  }
  if (currentText.includes(imagePath)) {
    return { ok: true, position };
  }
  msg.mes = nextText;
  if (Array.isArray(msg.swipes) && swipeId >= 0 && swipeId < msg.swipes.length) {
    msg.swipes[swipeId] = nextText;
  }
  try {
    await ctx.saveChat();
  } catch {
    msg.mes = currentText;
    if (Array.isArray(msg.swipes) && swipeId >= 0 && swipeId < msg.swipes.length) {
      msg.swipes[swipeId] = currentText;
    }
    return { ok: false, reason: "save-failed" };
  }
  await refreshMessage(ctx, floor, msg);
  return { ok: true, position };
}
async function refreshMessage(ctx, floor, msg, _unused) {
  var _a;
  try {
    const api = ctx;
    if (typeof api.updateMessageBlock === "function") {
      await api.updateMessageBlock(floor, msg);
      return;
    }
  } catch {
  }
  try {
    const types = getEventTypes();
    const evt = types.MESSAGE_EDITED ?? "message_edited";
    (_a = ctx.eventSource) == null ? void 0 : _a.emit(evt, floor);
  } catch {
    try {
      const api = ctx;
      if (typeof api.reloadCurrentChat === "function") await api.reloadCurrentChat();
    } catch {
    }
  }
}
const STATUS_MAX_CHARACTERS = 2;
const STATUS_MAX_PANELS = 4;
const STATUS_MAX_LINES = 4;
const STYLE_BLOCKLIST = [
  "masterpiece",
  "best quality",
  "high quality",
  "highly detailed",
  "ultra detailed",
  "absurdres",
  "8k",
  "4k",
  "photorealistic",
  "realistic",
  "photo",
  "cinematic",
  "depth of field",
  "chibi",
  "anime style",
  "illustration",
  "lineart",
  "flat color",
  "cel shading",
  "full body",
  "cowboy shot",
  "wide shot",
  "from below",
  "foreshortening"
];
const HAS_CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
const MAX_TAGS = 14;
function sanitizeStatusTags(raw) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const piece of String(raw ?? "").split(/[,，、\n]/)) {
    let tag = piece.trim().toLowerCase();
    if (!tag) continue;
    tag = tag.replace(/^\(?\s*[\d.]+::/, "").replace(/::$/, "").replace(/^\(|\)$/g, "");
    tag = tag.replace(/:\s*[\d.]+$/, "").trim();
    if (!tag || HAS_CJK.test(tag)) continue;
    if (STYLE_BLOCKLIST.some((word) => tag === word || tag.includes(word))) continue;
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}
function emptyFrame() {
  return { title: "", characters: [], roles: [], mood: "", tags: "", nl: "" };
}
function parseStatusReply(raw) {
  const empty = { ...emptyFrame(), panels: [] };
  const text = String(raw ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return empty;
  const body = text.slice(start, end + 1);
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    try {
      parsed = JSON.parse(body.replace(/'/g, '"'));
    } catch {
      return empty;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
  const record = parsed;
  const pick = (v) => typeof v === "string" ? v.trim() : "";
  const parseFrame = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return emptyFrame();
    const frame = value;
    const roles = [];
    const push = (item) => {
      if (roles.length >= STATUS_MAX_CHARACTERS) return;
      if (typeof item === "string") {
        const name = item.trim();
        if (name && !roles.some((r) => r.name === name)) roles.push({ name, act: "" });
        return;
      }
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const rec = item;
        const name = typeof rec.name === "string" ? rec.name.trim() : "";
        const act = typeof rec.act === "string" ? rec.act.replace(/\s+/g, " ").trim().slice(0, 200) : "";
        if (name && !roles.some((r) => r.name === name)) roles.push({ name, act });
      }
    };
    if (Array.isArray(frame.characters)) frame.characters.forEach(push);
    else push(frame.characters);
    push(frame.character);
    const tagsRaw = Array.isArray(frame.tags) ? frame.tags.join(", ") : pick(frame.tags);
    const tags = sanitizeStatusTags(tagsRaw);
    const lines = [];
    if (Array.isArray(frame.lines)) {
      for (const lineRaw of frame.lines) {
        if (lines.length >= STATUS_MAX_LINES) break;
        if (typeof lineRaw === "string") {
          const t = lineRaw.trim().slice(0, 60);
          if (t) lines.push({ speaker: "", text: t });
          continue;
        }
        if (lineRaw && typeof lineRaw === "object" && !Array.isArray(lineRaw)) {
          const rec = lineRaw;
          const speaker = typeof rec.speaker === "string" ? rec.speaker.trim().slice(0, 16) : "";
          const text2 = typeof rec.text === "string" ? rec.text.trim().slice(0, 60) : "";
          if (text2) lines.push({ speaker, text: text2 });
        }
      }
    }
    const nlRaw = pick(frame.nl).replace(/\s+/g, " ").slice(0, 300);
    const nl = nlRaw && !HAS_CJK.test(nlRaw) ? nlRaw : "";
    return {
      title: pick(frame.title).slice(0, 40),
      characters: roles.map((r) => r.name),
      roles,
      mood: pick(frame.mood).slice(0, 24),
      tags: tags.join(", "),
      nl,
      ...lines.length ? { lines } : {}
    };
  };
  const panels = [];
  const seen = /* @__PURE__ */ new Set();
  if (Array.isArray(record.panels)) {
    for (const panelRaw of record.panels) {
      if (panels.length >= STATUS_MAX_PANELS) break;
      const frame = parseFrame(panelRaw);
      if (!frame.tags) continue;
      const key = frame.tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean).sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      panels.push(frame);
    }
  }
  const top = parseFrame(record);
  if (!panels.length && top.tags) panels.push(top);
  if (!panels.length) return empty;
  const head = panels[0];
  return { ...head, title: (pick(record.title) || head.title).slice(0, 40), panels };
}
function clampMangaShots(raw) {
  const value = Math.round(Number(raw) || 1);
  return Math.min(Math.max(value, 1), STATUS_MAX_PANELS);
}
const BODY_LIMIT = 2400;
const BODY_LIMIT_STORY = 3600;
const FRAMING_RE = /\b(?:upper body|cowboy shot|close[- ]?up|portrait|headshot)\b/i;
function clampBody(body, many) {
  const text = String(body ?? "");
  const limit = many ? BODY_LIMIT_STORY : BODY_LIMIT;
  return text.length > limit ? text.slice(-limit) : text;
}
const JSON_FIELDS = '{"title":"中文，14 字以内，这一楼发生了什么","characters":[{"name":"出场角色名（照抄正文里的叫法）","act":"English danbooru phrases: what THIS character is doing this frame"}],"mood":"中文，6 字以内","tags":"10-16 个英文 danbooru 短 tag，逗号分隔","nl":"English, 1-2 sentences describing this frame"}';
const COMMON_RULES = [
  "画面必须是正文里真的发生的那件事，不要编造没写过的动作，也不要画成「站着摆姿势」。",
  "characters 最多 2 项；每一项的 act 用英文写这个角色自己在做什么。两人互动时主动方和被动方 act 必须分开写。",
  "nl 里写两个人时必须用正文里的角色名当主语，禁止用 he/she/the man 泛指。",
  "tags 只写四类：① 人数与互动；② 表情；③ 动作或姿态；④ 手里/身上的道具、与场景的互动。",
  "nl 用英文自然语言写同一件事，不要分点、不要换行。",
  "禁止写：画风、画质、镜头景别、光照颜色、服装细节、角色外貌——这些另有固定来源。",
  "不要解释，不要 markdown 代码块，不要多余文字。"
];
function statusSingleSystem() {
  return [
    "读一段角色扮演正文，把「这一楼最要紧的那一个画面」翻成一张插画，只输出一个 JSON 对象。",
    `格式：${JSON_FIELDS}`,
    "tags 里写互动词（couple / kiss / hug）与人数（1boy, 1girl 等）。",
    ...COMMON_RULES,
    '没有角色出场时输出 {"title":"","characters":[],"mood":"","tags":"","nl":""}。'
  ].join("\n");
}
function statusManySystem(count) {
  return [
    `读一段角色扮演正文，把这一楼发生的事挑成 ${count} 个先后画面，像一条小分镜，只输出一个 JSON 对象。`,
    `格式：{"title":"中文，14 字以内，这一楼讲了一件什么事","panels":[${JSON_FIELDS}]}`,
    "panels 按正文的时间顺序排列：第一格是这一楼的开头，最后一格是落点。",
    "每一格必须是不同的瞬间：换动作、换位置、换张力。不许重复或拆格凑数；没那么多就少给几格（至少 1 格）。",
    ...COMMON_RULES,
    '没有角色出场时输出 {"title":"","panels":[]}。'
  ].join("\n");
}
function bonusSystem(count) {
  const linesSchema = '"lines":[{"speaker":"说话角色名（照抄正文里的叫法）；旁白写「旁白」","text":"中文，20 字以内"}]';
  const many = count > 1;
  const panelsSchema = many ? `,"panels":[{"title":"中文，14 字以内，这一格发生了什么","characters":[{"name":"出场角色名","act":"English danbooru phrases: what THIS character is doing"}],"mood":"中文，6 字以内","tags":"10-16 个英文 danbooru 短 tag","nl":"English, 1-2 sentences","lines":[{"speaker":"说话角色名；旁白写「旁白」","text":"中文，20 字以内"}]}]` : "";
  return [
    "读一段角色扮演正文，忘掉它的剧情，只为其中的角色设计一个「平行宇宙彩蛋」：一段与正文剧情无关的架空小片段，只输出一个 JSON 对象。",
    `格式：{"title":"中文，14 字以内，以「彩蛋：」开头","characters":[{"name":"出场角色名","act":"English danbooru phrases: what THIS character is doing"}],"mood":"中文，6 字以内","tags":"10-16 个英文 danbooru 短 tag","nl":"English, 1-2 sentences",${linesSchema}${panelsSchema}}`,
    "题材、场景、基调完全自由发挥：温馨日常、热血战斗、悬疑惊悚、虐心催泪、史诗冒险、荒诞搞笑都可以。唯一硬要求：角色必须是正文里的那几位，性格照旧。",
    "每次都换花样：别落在咖啡店、甜品店这类用滥的套路里。",
    `每格给 2~4 条 lines（对话/旁白），短句符合口吻；旁白 speaker 写「旁白」。${many ? `把彩蛋拆成最多 ${count} 个先后画面（panels），按时间顺序，每格不同瞬间。` : "只画一个画面。"}`,
    "彩蛋不是正文的延续：不要接着正文里刚发生的事画。",
    ...COMMON_RULES
  ].join("\n");
}
function mangaSingleSystem(safe) {
  const rules = [
    "读一段角色扮演正文，把「这一楼最有画面的那一个瞬间」画成一格黑白漫画，只输出一个 JSON 对象。",
    `格式：${JSON_FIELDS}`,
    ...COMMON_RULES,
    "tags 里必须有一个景别，从这几类挑最合适的：extreme close-up / close-up / upper body / cowboy shot / full body / wide shot / medium shot / from above / from below / from side / dutch angle。按内容挑，多格时相邻两格景别不同。",
    "禁止写：黑白、网点、screentone、画风、角色外貌；也禁止 big head / chibi / super deformed 比例词（正常比例）。",
    "禁止写 speech bubble / text / dialogue / caption / comic panel border —— 画面里不许出现任何文字、气泡或分格线。"
  ];
  if (safe) {
    rules.push("这一格必须能公开发布：衣着完整，不画裸露、性行为、内衣特写、走光。挑能放到台面上的瞬间，用表情、留白、构图表达张力。tags 与 act 里不许出现 nude / nipples / underwear / sex 这类词。");
  }
  rules.push('没有角色出场时输出 {"title":"","characters":[],"mood":"","tags":"","nl":""}。');
  return rules.join("\n");
}
function mangaManySystem(count, safe) {
  const rules = [
    `读一段角色扮演正文，把这一楼发生的事挑成最多 ${count} 个先后画面，像一页黑白漫画的分格，只输出一个 JSON 对象。`,
    `格式：{"title":"中文，14 字以内","panels":[${JSON_FIELDS}]}`,
    "panels 按时间顺序排列；每一格必须是不同的瞬间（换动作、位置、张力），不许重复或拆格凑数，没那么多就少给几格。",
    ...COMMON_RULES,
    "tags 里必须有一个景别：extreme close-up / close-up / upper body / cowboy shot / full body / wide shot 等；相邻两格景别不同。",
    "禁止写：黑白、网点、screentone、画风、角色外貌、chibi 比例词；禁止 speech bubble / text / dialogue / caption / comic panel border。"
  ];
  if (safe) rules.push("每格必须能公开发布：衣着完整，不画裸露、性行为、内衣特写；用表情、留白、构图表达张力，tags 与 act 里不许出现 NSFW 词。");
  rules.push('没有角色出场时输出 {"title":"","panels":[]}。');
  return rules.join("\n");
}
function buildTheaterPrompt(input) {
  const count = Math.min(Math.max(Math.round(Number(input.shots) || 1), 1), STATUS_MAX_PANELS);
  const many = count > 1;
  const body = clampBody(input.body, many || input.kind === "bonus");
  const name = input.characterName || "（未命名）";
  let system;
  let bodyLabel = "正文：";
  switch (input.kind) {
    case "bonus":
      system = bonusSystem(count);
      bodyLabel = "正文（只用来认人，不用来取材）：";
      break;
    case "manga":
      system = many ? mangaManySystem(count, input.mangaSafe !== false) : mangaSingleSystem(input.mangaSafe !== false);
      break;
    case "status":
    default:
      system = many ? statusManySystem(count) : statusSingleSystem();
      break;
  }
  return {
    system,
    user: `角色：${name}
${bodyLabel}
${body}`
  };
}
const CHIBI_STYLE_STRONG = "2.3::super deformed, big head, small body::, 2.2::oversized eyes, round face, simplified facial features::, 2.0::tiny hands, short limbs::, 1.9::soft rounded shading, pastel highlights::, 1.8::glossy eyes, sparkles, bokeh background, warm rim light::, 1.7::exaggerated head-to-body ratio, rounded silhouette, simplified anatomy, stylized proportions, simple background::";
const MANGA_FRAMING = [
  "extreme close-up",
  "close-up",
  "upper body",
  "cowboy shot",
  "full body",
  "wide shot",
  "medium shot",
  "from above",
  "from below",
  "from side",
  "dutch angle"
];
const MANGA_FRAMING_RE = new RegExp(
  `\\b(?:${MANGA_FRAMING.map((w) => w.replace(/-/g, "[- ]?")).join("|")})\\b`,
  "i"
);
function buildStatusPrompt(appearances, tags, chibi = true) {
  const looks = appearances.map((t) => t.trim()).filter(Boolean).join(", ");
  const body = tags.trim();
  const framing = body && !FRAMING_RE.test(body) ? "upper body" : "";
  return [chibi ? CHIBI_STYLE_STRONG : "", looks, body, framing].filter(Boolean).join(", ");
}
function buildMangaPrompt(appearances, tags) {
  const looks = appearances.map((t) => t.trim()).filter(Boolean).join(", ");
  const body = tags.trim();
  const framing = body && !MANGA_FRAMING_RE.test(body) ? "cowboy shot" : "";
  return [looks, body, framing].filter(Boolean).join(", ");
}
function buildTheaterImagePrompt(kind, appearances, tags, chibi) {
  return kind === "manga" ? buildMangaPrompt(appearances, tags) : buildStatusPrompt(appearances, tags, chibi);
}
const MANGA_SAFE_NEGATIVE = "nsfw, nude, naked, completely nude, topless, bottomless, nipples, areolae, underwear, panties, lingerie, braless, see-through, cleavage, underboob, sideboob, pussy, penis, genitals, anus, buttocks, sex, intercourse, fellatio, cunnilingus, paizuri, handjob, masturbation, cum, semen, creampie, ahegao, spread legs";
const UNSAFE_RE = new RegExp(
  `\\b(?:${[
    "nsfw",
    "nudes?",
    "naked",
    "topless",
    "bottomless",
    "nipples?",
    "areolae?",
    "underwear",
    "panties?",
    "lingerie",
    "braless",
    "see[ -]through",
    "cleavage",
    "underboob",
    "sideboob",
    "downblouse",
    "upskirt",
    "pussy",
    "penis",
    "genitals?",
    "anus",
    "buttocks?",
    "ass",
    "groin",
    "breasts?",
    "sex",
    "sexual",
    "intercourse",
    "fellatio",
    "cunnilingus",
    "paizuri",
    "handjob",
    "masturbation",
    "orgasm",
    "ejaculat\\w*",
    "cum",
    "semen",
    "creampie",
    "ahegao",
    "spread legs",
    "exposed breasts?"
  ].join("|")})\\b`,
  "i"
);
function stripMangaUnsafeTags(tags) {
  const hits = [];
  const kept = String(tags ?? "").split(/[,，]/).map((p) => p.trim()).filter(Boolean).filter((part) => {
    if (!UNSAFE_RE.test(part)) return true;
    hits.push(part);
    return false;
  });
  return { tags: kept.join(", "), hits };
}
function scrubMangaReading(reading) {
  const hits = [];
  const scrubFrame = (frame) => {
    const tags = stripMangaUnsafeTags(frame.tags);
    hits.push(...tags.hits);
    const roles = frame.roles.map((role) => {
      if (!role.act || !UNSAFE_RE.test(role.act)) return role;
      hits.push(`${role.name} 的动作描写`);
      return { ...role, act: "" };
    });
    let nl = frame.nl;
    if (nl && UNSAFE_RE.test(nl)) {
      hits.push(`${frame.title || "一格"} 的自然语言描述`);
      nl = "";
    }
    return { ...frame, tags: tags.tags, roles, nl };
  };
  const panels = reading.panels.map(scrubFrame).filter((f) => !!f.tags);
  const head = panels[0];
  if (!head) {
    return { reading: { ...reading, panels, tags: "", roles: [], characters: [], nl: "" }, hits };
  }
  return { reading: { ...reading, ...head, title: reading.title, panels }, hits };
}
function statusSeedFor(name) {
  const text = (Array.isArray(name) ? name : [name]).map((s) => String(s ?? "").trim()).filter(Boolean).join("|");
  if (!text) return 0;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash % 4294967294 + 1;
}
function rerollSeed(backend, previous = 0) {
  const pick = backend === "nai" ? () => Math.floor(Math.random() * 4294967294) + 1 : () => Math.floor(Math.random() * Number.MAX_SAFE_INTEGER) + 1;
  for (let i = 0; i < 8; i += 1) {
    const seed = pick();
    if (seed > 0 && seed !== previous) return seed;
  }
  return previous > 0 ? previous + 1 : 1;
}
function decideSeed(backend, override, fixedSeed = 0) {
  if (backend === "nai") return fixedSeed > 0 ? fixedSeed : rerollSeed("nai");
  return rerollSeed(backend);
}
async function readTheater(input) {
  const { system, user } = buildTheaterPrompt({
    kind: input.kind,
    characterName: input.characterName,
    body: input.body,
    shots: clampMangaShots(input.shots),
    mangaSafe: input.mangaSafe
  });
  const raw = await input.llm(`${system}

---

${user}`);
  let reading = parseStatusReply(raw);
  const hits = [];
  if (input.kind === "manga" && input.mangaSafe) {
    const scrubbed = scrubMangaReading(reading);
    reading = scrubbed.reading;
    hits.push(...scrubbed.hits);
  }
  return { reading, hits };
}
async function runTheaterOne(input) {
  try {
    const { reading, hits } = await readTheater(input);
    if (reading.panels.length === 0) {
      return { ok: false, stories: [], error: "读剧情未返回可解析的分镜。", hits };
    }
    const names = /* @__PURE__ */ new Set();
    for (const panel of reading.panels) {
      for (const n of panel.characters) if (n) names.add(n);
      for (const l of panel.lines ?? []) if (l.speaker && l.speaker !== "旁白") names.add(l.speaker);
    }
    const looks = input.readLooks([...names]);
    const appearances = looks.map((l) => l.tag).filter(Boolean);
    const fixedSeed = statusSeedFor([...names]);
    const stories = [];
    for (let i = 0; i < reading.panels.length; i += 1) {
      const panel = reading.panels[i];
      const prompt = buildTheaterImagePrompt(
        input.kind,
        appearances,
        panel.tags,
        input.chibi
      );
      const negative = input.kind === "manga" && input.mangaSafe ? MANGA_SAFE_NEGATIVE : void 0;
      const seed = decideSeed(input.backend, void 0, fixedSeed);
      const result = await input.generate(
        {
          prompt,
          ...negative ? { negative } : {},
          seed,
          size: "portrait"
        },
        input.profile
      );
      const path = result.path ?? result.dataUrl ?? "";
      if (!path) continue;
      stories.push({
        storyId: `s${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 5)}`,
        index: i,
        storyAt: Date.now(),
        title: panel.title || reading.title,
        story: panel.nl || void 0,
        mood: panel.mood || void 0,
        cast: panel.characters.length ? panel.characters : void 0,
        lines: panel.lines,
        imagePath: path,
        bonus: input.kind === "bonus",
        manga: input.kind === "manga"
      });
    }
    if (stories.length === 0) {
      return { ok: false, stories, error: "所有分格出图均失败。", hits };
    }
    return { ok: true, stories, hits };
  } catch (err) {
    return {
      ok: false,
      stories: [],
      error: err instanceof Error ? err.message : String(err),
      hits: []
    };
  }
}
function pickProfile(profiles, mode) {
  return profiles.find((p) => p.mode === mode);
}
function sceneFromSegment(segment) {
  const context = getSurroundingContext(segment, 1);
  return {
    selectedText: segment.text,
    ...context.previousText ? { previousText: context.previousText } : {},
    ...context.nextText ? { nextText: context.nextText } : {}
  };
}
function toNormalizedInput(prompt, nl, negative, profile) {
  return {
    prompt,
    ...nl ? { nl } : {},
    ...negative ? { negative } : {},
    save: true
  };
}
async function runIllustration(task, ctx, deps) {
  var _a, _b;
  const segment = task.source;
  const floor = getAnchorFloor(segment);
  if (floor === null) throw new Error("无法确定挂载楼层。");
  ctx.report({ stage: "reading" });
  const characters = await getCharacters(floor);
  const plan = await generateIllustrationPlan({
    scene: sceneFromSegment(segment),
    characters: characters.characters,
    options: {
      includeChinese: deps.fullSettings.includeChinese,
      includeNl: deps.fullSettings.includeNl,
      includeNegative: true
    },
    caller: makeModeLlmCaller(deps.fullSettings, "illustration")
  });
  if (!plan.ok || !plan.data) throw new Error(plan.error ?? "Tag 计划生成失败。");
  ctx.report({ stage: "review" });
  const tagSegments = plan.data.segments.map((seg) => ({
    ...seg,
    chinese: seg.chinese ?? []
  }));
  const prompt = composeEnglishPrompt(tagSegments);
  if (!prompt.trim()) throw new Error("组装后的英文 prompt 为空。");
  const profile = pickProfile(deps.settings, "illustration");
  ctx.report({ stage: "generating" });
  const result = await baiBaiAdapter.generate(
    toNormalizedInput(prompt, plan.data.nl, plan.data.negative),
    profile ?? fallbackProfile("illustration")
  );
  const imagePath = result.path ?? result.dataUrl;
  if (!imagePath) throw new Error("出图未返回图片地址。");
  const anchorText = segment.text.slice(0, 120);
  const inserted = await insertImageIntoBody({
    floor,
    chatId: task.chatId,
    swipeId: ((_a = segment.messages[0]) == null ? void 0 : _a.swipeId) ?? 0,
    sendDate: (_b = segment.messages[0]) == null ? void 0 : _b.sendDate,
    imagePath,
    anchorText,
    alt: plan.data.nl ? plan.data.nl.slice(0, 60) : "配图"
  });
  console.log("[ST-Story-Illustrator] 正文插图写入:", inserted);
  const mesTextEl = document.querySelector(`.mes[mesid="${floor}"] .mes_text`);
  const anchor = mesTextEl ? buildAnchor(segment.text, extractPlainText(mesTextEl), 0) : void 0;
  const artifact = {
    id: createArtifactId(),
    taskId: task.id,
    mode: "illustration",
    chatId: task.chatId,
    sourceFloors: segment.floorIds,
    anchorFloor: floor,
    // 正文已嵌入图片时不再注入 DOM 卡片（避免重复显示）；写入失败才降级为 DOM 卡片
    mountMode: inserted.ok ? "trailing" : defaultMountMode("illustration"),
    ...anchor ? { textAnchor: anchor } : {},
    imagePath,
    prompt,
    ...plan.data.nl ? { nl: plan.data.nl } : {},
    ...plan.data.negative ? { negative: plan.data.negative } : {},
    ...result.seed !== void 0 ? { seed: result.seed } : {},
    metadata: { embeddedInBody: inserted.ok },
    createdAt: Date.now()
  };
  appendArtifact(floor, artifact);
  mountFloor(floor);
  ctx.report({ stage: "completed" });
}
function fallbackProfile(mode) {
  return {
    id: `default-${mode}`,
    name: "默认",
    mode,
    backend: "nai",
    promptTemplateId: "default",
    options: {}
  };
}
async function runComic(task, ctx, deps) {
  const segment = task.source;
  const floor = getAnchorFloor(segment);
  if (floor === null) throw new Error("无法确定挂载楼层。");
  const modeSettings = deps.fullSettings.modes["comic"];
  ctx.report({ stage: "reading" });
  const characters = await getCharacters(floor);
  const backendInfo = await baiBaiAdapter.id ? "nai" : "nai";
  const plan = await generateComicPlan({
    scene: sceneFromSegment(segment),
    characters: characters.characters,
    options: {
      panelMode: true,
      panelLayout: modeSettings.comicLayout ?? "regular",
      pageType: modeSettings.comicPageType ?? "auto",
      dialogue: deps.fullSettings.dialogueEnabled,
      dialoguePolicy: deps.fullSettings.dialoguePolicy,
      dialogueMode: "tag",
      nl: deps.fullSettings.includeNl,
      backend: backendInfo,
      charPrompts: false,
      includeChinese: deps.fullSettings.includeChinese,
      maxPages: modeSettings.comicMaxPages ?? 1
    },
    caller: makeModeLlmCaller(deps.fullSettings, "comic")
  });
  if (!plan.ok || !plan.data) throw new Error(plan.error ?? "分镜计划生成失败。");
  const profile = pickProfile(deps.settings, "comic");
  const totalPanels = plan.data.reduce((sum, page) => sum + page.panels.length, 0);
  let done = 0;
  for (const page of plan.data) {
    for (const panel of page.panels) {
      if (ctx.signal.aborted) return;
      ctx.report({ stage: "generating", page: page.pageIndex + 1, panel: panel.index + 1, totalPages: plan.data.length, totalPanels });
      const enforced = enforceForGeneration({
        prompt: panel.tags,
        nl: panel.nl ?? "",
        panelLayout: page.layout,
        chibiOn: false
      });
      const result = await baiBaiAdapter.generate(
        toNormalizedInput(enforced.prompt, enforced.nl || void 0, void 0),
        profile ?? fallbackProfile("comic")
      );
      const imagePath = result.path ?? result.dataUrl;
      if (!imagePath) continue;
      const artifact = {
        id: createArtifactId(),
        taskId: task.id,
        mode: "comic",
        chatId: task.chatId,
        sourceFloors: segment.floorIds,
        anchorFloor: floor,
        mountMode: defaultMountMode("comic"),
        pageIndex: page.pageIndex,
        panelIndex: panel.index,
        imagePath,
        prompt: enforced.prompt,
        ...panel.nl ? { nl: panel.nl } : {},
        ...panel.dialogue ? { dialogue: panel.dialogue } : {},
        ...result.seed !== void 0 ? { seed: result.seed } : {},
        metadata: { pageTitle: page.title, panelTitle: panel.title, layout: page.layout },
        createdAt: Date.now()
      };
      appendArtifact(floor, artifact);
      done += 1;
    }
  }
  if (done === 0) throw new Error("所有分格出图均失败。");
  mountFloor(floor);
  ctx.report({ stage: "completed" });
}
async function runTheaterMode(task, ctx, deps) {
  var _a, _b;
  const segment = task.source;
  const mode = task.mode;
  const floor = getAnchorFloor(segment);
  if (floor === null) throw new Error("无法确定挂载楼层。");
  const kind = mode === "chibi-status" ? "status" : mode === "chibi-bonus" ? "bonus" : "manga";
  const modeSettings = deps.fullSettings.modes[mode];
  const characters = await getCharacters(floor);
  ctx.report({ stage: "reading" });
  const result = await runTheaterOne({
    kind,
    chatId: task.chatId,
    floor,
    swipe: ((_a = segment.messages[0]) == null ? void 0 : _a.swipeId) ?? 0,
    characterName: ((_b = segment.messages.find((m) => !m.isUser)) == null ? void 0 : _b.speaker) ?? "",
    body: segment.text,
    shots: modeSettings.shots,
    chibi: kind !== "manga" && modeSettings.chibiStyle !== "thumb",
    mangaSafe: modeSettings.bwMangaSafeMode ?? true,
    backend: "nai",
    profile: pickProfile(deps.settings, mode),
    llm: async (prompt) => {
      const caller = makeModeLlmCaller(deps.fullSettings, mode);
      try {
        return await caller("", prompt);
      } catch {
        return await generateQuietPrompt(prompt);
      }
    },
    generate: async (input, profile) => {
      const r = await baiBaiAdapter.generate({
        prompt: input.prompt,
        ...input.negative ? { negative: input.negative } : {},
        seed: input.seed,
        size: input.size,
        save: true
      }, profile ?? fallbackProfile(mode));
      return { path: r.path, dataUrl: r.dataUrl, seed: r.seed };
    },
    readLooks: (names) => {
      const lookup = new Map(characters.characters.map((c) => [c.name, c]));
      return names.map((name) => {
        const c = lookup.get(name);
        return c ? { name, tag: c.tag, ...c.nl ? { nl: c.nl } : {} } : { name, tag: "" };
      });
    }
  });
  if (!result.ok) throw new Error(result.error ?? "小剧场生成失败。");
  for (const story of result.stories) {
    saveStory(floor, kind, story);
  }
  mountTheater(floor);
  ctx.report({ stage: "completed" });
}
function createTaskRunner(deps) {
  return async (task, ctx) => {
    switch (task.mode) {
      case "illustration":
        return runIllustration(task, ctx, deps);
      case "comic":
        return runComic(task, ctx, deps);
      case "chibi-status":
      case "chibi-bonus":
      case "bw-manga":
        return runTheaterMode(task, ctx, deps);
      default:
        throw new Error(`未知创作模式: ${task.mode}`);
    }
  };
}
function createVisualTask(segment, mode) {
  const now = Date.now();
  return {
    id: `task-${now}-${Math.random().toString(36).slice(2, 6)}`,
    chatId: segment.chatId,
    source: segment,
    mode,
    status: "queued",
    createdAt: now,
    updatedAt: now
  };
}
let initialized = false;
let settings = { ...DEFAULT_SETTINGS };
const cleanupFunctions = [];
let queue = null;
async function onActivate() {
  if (initialized) return;
  console.log("[ST-Story-Illustrator] 开始初始化...");
  try {
    const stReady = await initSTEnvironment();
    if (!stReady) {
      console.warn("[ST-Story-Illustrator] SillyTavern 环境未就绪，扩展将以降级模式运行。");
    }
    settings = getSettings(DEFAULT_SETTINGS);
    applySettings();
    registerEvents();
    setupSelectionListener();
    initQueue();
    remountAllSafe();
    void waitForApi(10).then((result) => {
      if (result.status === "available") {
        console.log("[ST-Story-Illustrator] 柏宝绘 API 已就绪:", result.api.apiVersion);
      } else if (result.status === "not_installed") {
        console.info("[ST-Story-Illustrator] 柏宝绘未安装。配图不可用，选段功能正常。");
      } else if (result.status === "version_mismatch") {
        console.warn("[ST-Story-Illustrator] 柏宝绘 API 版本不兼容:", result.apiVersion);
      }
    });
    initialized = true;
    console.log("[ST-Story-Illustrator] 初始化完成。");
  } catch (err) {
    console.error("[ST-Story-Illustrator] 初始化失败:", err);
  }
}
function initQueue() {
  const runner = createTaskRunner({
    settings: settings.profiles ?? [],
    fullSettings: settings
  });
  queue = new TaskQueue(runner, {
    taskTimeoutMs: 5 * 60 * 1e3,
    onStatusChange: (task, status) => {
      console.log(`[ST-Story-Illustrator] 任务 ${task.id} → ${status}`);
    },
    onError: (task, error) => {
      console.error(`[ST-Story-Illustrator] 任务 ${task.id} 失败:`, error);
      showToast(`生成失败：${error.message}`, "error");
    }
  });
}
function remountAllSafe() {
  try {
    remountAll();
  } catch (e) {
    console.warn("[ST-Story-Illustrator] 挂载历史作品失败:", e);
  }
}
function applySettings() {
  setSegmentCleanOptions({
    syncBaiBai: settings.syncBaiBaiExcludes ?? true,
    preferContent: settings.preferContentTag ?? true
  });
}
function registerEvents() {
  const events = getEventTypes();
  const offSettings = on(events.EXTENSION_SETTINGS_LOADED, () => {
    settings = getSettings(DEFAULT_SETTINGS);
    applySettings();
    queue = null;
    initQueue();
  });
  cleanupFunctions.push(offSettings);
  const onModeChannelsChanged = () => {
    settings = getSettings(DEFAULT_SETTINGS);
    applySettings();
    queue = null;
    initQueue();
  };
  window.addEventListener("sti-settings-changed", onModeChannelsChanged);
  cleanupFunctions.push(() => window.removeEventListener("sti-settings-changed", onModeChannelsChanged));
  const offReady = on(events.APP_READY, () => {
    const result = checkAvailability();
    if (result.status === "available") {
      console.log("[ST-Story-Illustrator] 应用就绪，柏宝绘可用。");
    }
  });
  cleanupFunctions.push(offReady);
  const offChatChanged = on(events.CHAT_CHANGED, () => {
    hideToolbar();
    hideSelectionPanel();
    queue == null ? void 0 : queue.cancelAll();
  });
  cleanupFunctions.push(offChatChanged);
  const offDeleted = on(events.MESSAGE_DELETED, () => {
    hideToolbar();
    hideSelectionPanel();
  });
  cleanupFunctions.push(offDeleted);
  const reMount = (...args) => {
    const floor = extractFloorFromEventArg(args[0]);
    if (floor >= 0) {
      try {
        mountFloor(floor);
        mountTheater(floor);
      } catch {
      }
    }
  };
  cleanupFunctions.push(on(events.CHARACTER_MESSAGE_RENDERED, reMount));
  cleanupFunctions.push(on(events.MESSAGE_SWIPED, reMount));
}
function extractFloorFromEventArg(arg) {
  if (typeof arg === "number") return arg;
  if (arg && typeof arg === "object") {
    const o = arg;
    const v = o.mesid ?? o.messageId ?? o.floor;
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const n = parseInt(v, 10);
      if (Number.isFinite(n)) return n;
    }
  }
  return -1;
}
function setupSelectionListener() {
  setOnGenerate(handleGenerateFromSelection);
  startSelectionListener((valid, selection) => {
    if (!settings.enabled && !isAvailable()) {
      hideToolbar();
      return;
    }
    if (valid && selection) showToolbar(selection);
    else hideToolbar();
  });
}
function handleGenerateFromSelection() {
  const selection = window.getSelection();
  if (!selection || !isSelectionInMesText(selection)) {
    console.warn("[ST-Story-Illustrator] 无有效选区。");
    return;
  }
  const selectedText = getSelectionText(selection);
  if (!selectedText) {
    console.warn("[ST-Story-Illustrator] 选区文本为空。");
    return;
  }
  const floor = resolveFloorFromSelection(selection);
  if (!floor) {
    showToast("无法定位选区所属楼层，请重新选择。", "warn");
    return;
  }
  const mesTextEl = document.querySelector(`.mes[mesid="${floor.mesId}"] .mes_text`);
  const floorText = mesTextEl ? extractPlainText(mesTextEl) : "";
  const anchor = buildAnchor(selectedText, floorText, 0);
  console.log("[ST-Story-Illustrator] 选区已捕获:", { floor: floor.mesId, textLength: selectedText.length, anchor });
  const availability = checkAvailability();
  if (availability.status !== "available") {
    const msg = availability.status === "not_installed" ? "柏宝绘未安装。选段已捕获，但配图功能不可用。" : `柏宝绘 API 不可用（${availability.status}）。选段已捕获，但配图不可用。`;
    showToast(msg, "warn");
  }
  showSelectionPanel(
    { initialFloor: floor.mesId, selectedText, startAtLocal: true },
    handleSegmentConfirmed
  );
  hideToolbar();
}
function handleSegmentConfirmed(segment, modes) {
  console.log("[ST-Story-Illustrator] 选段已确认:", {
    modes,
    sourceKind: segment.sourceKind,
    floorIds: segment.floorIds,
    textLength: segment.text.length,
    messageCount: segment.messages.length
  });
  if (!isAvailable()) {
    showToast("柏宝绘不可用，无法生成。请确认柏宝绘已安装且版本兼容。", "warn");
    return;
  }
  if (!queue) initQueue();
  for (const mode of modes) {
    const task = createVisualTask(segment, mode);
    queue == null ? void 0 : queue.enqueue(task);
  }
  showToast(`已加入 ${modes.length} 个生成任务，开始处理。`, "info");
}
function showToast(message, level = "info") {
  var _a, _b, _c;
  const toastr = window.toastr;
  if (toastr) {
    if (level === "error") (_a = toastr.error) == null ? void 0 : _a.call(toastr, message);
    else if (level === "warn") (_b = toastr.warning) == null ? void 0 : _b.call(toastr, message);
    else (_c = toastr.info) == null ? void 0 : _c.call(toastr, message);
  } else {
    if (level === "error") console.error(message);
    else if (level === "warn") console.warn(message);
    else console.info(message);
  }
}
function onDisable() {
  console.log("[ST-Story-Illustrator] 卸载中...");
  queue == null ? void 0 : queue.cancelAll();
  stopSelectionListener();
  destroyToolbar();
  destroySelectionPanel();
  destroyLightbox();
  for (const cleanup of cleanupFunctions) {
    try {
      cleanup();
    } catch {
    }
  }
  cleanupFunctions.length = 0;
  initialized = false;
  console.log("[ST-Story-Illustrator] 卸载完成。");
}
const index = {
  onActivate,
  onDisable
};
export {
  index as default,
  onActivate,
  onDisable
};
