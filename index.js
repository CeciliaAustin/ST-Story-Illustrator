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
function readPersonaName() {
  try {
    const ctx = getContext();
    return typeof ctx.name1 === "string" ? ctx.name1.trim() : "";
  } catch {
    return "";
  }
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
let saveDraining = false;
let saveWaiters = [];
function saveChatSafe() {
  return new Promise((resolve) => {
    saveWaiters.push(resolve);
    if (!saveDraining) {
      saveDraining = true;
      void drainSaveQueue();
    }
  });
}
const SAVE_COALESCE_MS = 1500;
const SAVE_RETRY_MS = 2500;
function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
async function drainSaveQueue() {
  try {
    while (saveWaiters.length > 0) {
      await delay(SAVE_COALESCE_MS);
      const waiters = saveWaiters;
      saveWaiters = [];
      const ok = await saveOnceWithRetry();
      for (const waiter of waiters) waiter(ok);
      if (saveWaiters.length > 0) await delay(SAVE_COALESCE_MS);
    }
  } finally {
    saveDraining = false;
  }
}
async function saveOnceWithRetry() {
  const ctx = getContext();
  const save = ctx.saveChat;
  if (typeof save !== "function") return false;
  try {
    await save.call(ctx);
    return true;
  } catch {
    await delay(SAVE_RETRY_MS);
    try {
      await save.call(ctx);
      return true;
    } catch {
      return false;
    }
  }
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
const SETTINGS_KEY$1 = "STStoryIllustrator";
function getSettings(defaults) {
  const ctx = getContext();
  const settings2 = ctx.extensionSettings ?? {};
  const stored = settings2[SETTINGS_KEY$1];
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
  ctx.extensionSettings[SETTINGS_KEY$1] = settings2;
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
function touchChatMetadata(key, value) {
  const ctx = getContext();
  if (!ctx.chatMetadata) {
    ctx.chatMetadata = {};
  }
  ctx.chatMetadata[key] = value;
}
async function generateQuietPrompt(prompt, options) {
  const ctx = getContext();
  if (typeof ctx.generateQuietPrompt !== "function") {
    throw new Error("SillyTavern generateQuietPrompt 不可用");
  }
  return await ctx.generateQuietPrompt(prompt, options);
}
function isAiStoryMessage(message) {
  var _a;
  if (!message || typeof message.mes !== "string" || !message.mes.trim()) {
    return false;
  }
  return !message.is_user && !(message.is_system && typeof ((_a = message.extra) == null ? void 0 : _a.type) === "string");
}
function lastAssistantFloor() {
  const chat = getChat();
  for (let i = chat.length - 1; i >= 0; i--) {
    if (isAiStoryMessage(chat[i])) {
      return i;
    }
  }
  return -1;
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
    await sleep$3(WAIT_INTERVAL_MS);
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
function unconfiguredBackendStatus() {
  return {
    apiVersion: 1,
    pluginVersion: "",
    backend: "nai",
    configured: false,
    model: "",
    supportsCharacters: false,
    reason: "柏宝绘 API 不可用"
  };
}
async function getBackendStatus() {
  if (!isAvailable()) {
    return unconfiguredBackendStatus();
  }
  try {
    const api = getApi();
    return await api.getBackendStatus();
  } catch {
    return unconfiguredBackendStatus();
  }
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
function sleep$3(ms) {
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
  clone.querySelectorAll("bbi_image").forEach((el2) => el2.remove());
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}
const ZERO_WIDTH = /[\u200b-\u200f\u202a-\u202e\ufeff]/;
const MARK_CHARS = /[*_~`]/;
const QUOTE_MAP = {
  "“": '"',
  "”": '"',
  "„": '"',
  "«": '"',
  "»": '"',
  "‘": "'",
  "’": "'",
  "‚": "'",
  "‹": "'",
  "›": "'",
  "—": "-",
  "–": "-"
};
function skeleton(text) {
  const src = String(text ?? "");
  const chars = [];
  const map = [];
  let lastSpace = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ZERO_WIDTH.test(ch) || MARK_CHARS.test(ch)) continue;
    if (/\s/.test(ch)) {
      if (!chars.length || lastSpace) continue;
      chars.push(" ");
      map.push(i);
      lastSpace = true;
      continue;
    }
    lastSpace = false;
    const replaced = QUOTE_MAP[ch] ?? ch;
    const normalized = replaced.normalize("NFKC").toLowerCase();
    for (const c of normalized) {
      chars.push(c);
      map.push(i);
    }
  }
  while (chars.length && chars[chars.length - 1] === " ") {
    chars.pop();
    map.pop();
  }
  return { s: chars.join(""), map };
}
function findAnchorRange(haystack, needle) {
  const hay = skeleton(haystack);
  const pin = skeleton(needle);
  if (!hay.s || !pin.s) return null;
  const probes = [pin.s, pin.s.slice(0, 60), pin.s.slice(0, 40), pin.s.slice(0, 24)];
  for (let len = 22; len >= 8; len -= 2) probes.push(pin.s.slice(0, len));
  for (const probe2 of probes) {
    if (!probe2.trim()) continue;
    const at = hay.s.indexOf(probe2);
    if (at < 0) continue;
    const start = hay.map[at];
    const end = hay.map[at + probe2.length - 1] + 1;
    return { start, end };
  }
  return null;
}
function lineEndAfter(text, index2) {
  const nl = String(text ?? "").indexOf("\n", Math.max(0, index2));
  return nl < 0 ? String(text ?? "").length : nl;
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
        comicLayout: "auto",
        comicPageType: "auto",
        comicMaxPages: 1,
        comicPanelsPerPage: 0,
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
      return {
        ...base,
        bwMangaSafeMode: true,
        bwMangaMono: true,
        bwMangaArtistId: "",
        bwMangaDialogue: true,
        bwMangaBubbleStyle: "classic"
      };
    default:
      return base;
  }
}
const MODE_LABEL$1 = {
  illustration: "正文插画",
  comic: "正文漫画分镜",
  "chibi-status": "QQ 人状态栏",
  "chibi-bonus": "QQ 人彩蛋",
  "bw-manga": "黑白漫小剧场"
};
function resolveModeSettings(settings2, mode) {
  var _a;
  const defaults = defaultModeSettings(mode);
  const stored = (_a = settings2 == null ? void 0 : settings2.modes) == null ? void 0 : _a[mode];
  return stored ? { ...defaults, ...stored } : defaults;
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
  // 默认不指定，跟随柏宝绘当前出图方案；用户在弹窗里可为每个模式分别指派
  modeOutPlans: {},
  restorePlanAfterTask: true,
  showFloatingBall: true,
  showSelectionToolbar: true,
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
  bubbleFont: "sans",
  promptOverrides: {}
};
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
    const close2 = rest.match(closeRe);
    if (!close2) {
      out = out.slice(0, start) + out.slice(start + open[0].length);
      continue;
    }
    const end = start + open[0].length + (close2.index ?? 0) + close2[0].length;
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
function extractMessage(floor, chatId, options = {}) {
  const chat = getChat();
  if (floor < 0 || floor >= chat.length) return null;
  const msg = chat[floor];
  if (!msg) return null;
  if (!options.includeHidden && isSystemMessage(msg)) return null;
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
function buildSingleSegment(floor, options = {}) {
  const chatId = getCurrentChatId();
  if (!chatId) return null;
  const msg = extractMessage(floor, chatId, options);
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
function buildRangeSegment(startFloor, endFloor, excludeFloors = [], options = {}) {
  const chatId = getCurrentChatId();
  if (!chatId) return null;
  const chat = getChat();
  const lo = Math.max(0, Math.min(startFloor, endFloor));
  const hi = Math.min(chat.length - 1, Math.max(startFloor, endFloor));
  const excludeSet = new Set(excludeFloors);
  const messages = [];
  const floorIds = [];
  for (let floor = lo; floor <= hi; floor++) {
    if (excludeSet.has(floor)) continue;
    if (messages.length >= MAX_MESSAGES_IN_SEGMENT) break;
    const msg = extractMessage(floor, chatId, options);
    if (!msg) continue;
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
function buildPickedSegment(floorIds, options = {}) {
  const chatId = getCurrentChatId();
  if (!chatId || floorIds.length === 0) return null;
  const messages = [];
  const validFloorIds = [];
  for (const floor of floorIds) {
    if (messages.length >= MAX_MESSAGES_IN_SEGMENT) break;
    const msg = extractMessage(floor, chatId, options);
    if (!msg) continue;
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
function getAvailableFloors(options = {}) {
  const chat = getChat();
  const result = [];
  for (let i = 0; i < chat.length; i++) {
    const msg = chat[i];
    if (!msg) continue;
    const hidden = isSystemMessage(msg);
    if (hidden && !options.includeHidden) continue;
    const text = cleanMes(msg.mes);
    if (!text) continue;
    result.push({
      floor: i,
      speaker: String(msg.name ?? (msg.is_user ? "User" : "Unknown")),
      isUser: msg.is_user === true,
      preview: text.slice(0, 80),
      hidden
    });
  }
  return result;
}
function getChatFloorCount() {
  return getChat().length;
}
const CHANNELS_KEY = "baibai_api_channels";
const IMAGE_SETTINGS_KEY$1 = "baibai_image";
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
  const raw = (_a = ctx.extensionSettings) == null ? void 0 : _a[IMAGE_SETTINGS_KEY$1];
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
async function generateViaChannelStrict(channelId, system, user, signal) {
  const id = (channelId || "").trim();
  if (!id || id === "main") {
    throw new Error("这个模式没有指派副 API 渠道。请在「配图设置」里指派，或把来源切成主 API。");
  }
  const ctx = getContext();
  const all = listSharedChannels();
  const targetId = id === "tagGen" ? readTagGenChannelId() : id;
  if (!targetId) {
    throw new Error("柏宝绘里没有指派 tagGen 渠道。请在柏宝绘设置里指派一个，或改用主 API。");
  }
  const channel = all.find((c) => c.id === targetId);
  if (!channel) {
    throw new Error(`副 API 渠道已不存在（${targetId.slice(0, 8)}…）。请重新指派或改用主 API。`);
  }
  if (!channel.model) {
    throw new Error(`副 API 渠道「${channel.name}」没有填模型名。`);
  }
  const headers = typeof ctx.getRequestHeaders === "function" ? ctx.getRequestHeaders() : {};
  const controller = new AbortController();
  const timeoutMs = Math.max(5, channel.timeoutSec) * 1e3;
  const timer2 = setTimeout(() => controller.abort(), timeoutMs);
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
      throw new Error(`副 API「${channel.name}」请求失败 (${resp.status})：${detail.slice(0, 300)}`);
    }
    const data = await resp.json().catch(() => null);
    const text = extractCompletionText(data);
    if (!text || !text.trim()) {
      throw new Error(`副 API「${channel.name}」返回了空内容。`);
    }
    return text;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("副 API")) throw err;
    throw new Error(`副 API「${channel.name}」不可用：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer2);
  }
}
const IMAGE_SETTINGS_KEY = "baibai_image";
const PAGE_LAYOUT_WORDS = [
  "multiple views",
  "split screen",
  "2koma",
  "3koma",
  "4koma",
  "comic page",
  "manga page",
  "paneled",
  "panels",
  "panel layout"
];
function layoutWordsIn(text) {
  const lower = String(text ?? "").toLowerCase();
  if (!lower) return [];
  return PAGE_LAYOUT_WORDS.filter((word) => lower.includes(word));
}
function asRecord(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : null;
}
function str$1(v, fallback = "") {
  return typeof v === "string" ? v : fallback;
}
function detectModelFamily(model) {
  const m = model.toLowerCase();
  if (/4[._-]?5|v4\.5|nai45|diffusion-4-5|diffusion-4\.5/.test(m)) return "4.5";
  if (/nai.?5|diffusion-5|v5\b|-5-full|-5$/.test(m)) return "5";
  if (/4\b|diffusion-4|v4/.test(m)) return "4";
  return "unknown";
}
function parseEndpoints(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const e = asRecord(item);
    if (!e) continue;
    const id = str$1(e.id).trim();
    if (!id) continue;
    const url = str$1(e.url).trim();
    out.push({
      id,
      name: str$1(e.name).trim() || id,
      url,
      hasKey: str$1(e.key).trim().length > 0
    });
  }
  return out;
}
function parseArtists(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const a = asRecord(item);
    if (!a) continue;
    const id = str$1(a.id).trim();
    if (!id) continue;
    out.push({
      id,
      name: str$1(a.name).trim() || id,
      prompt: str$1(a.prompt).trim(),
      quality: str$1(a.quality).trim()
    });
  }
  return out;
}
function parsePlans(raw, endpoints, artists = []) {
  var _a;
  if (!Array.isArray(raw)) return [];
  const byId = new Map(endpoints.map((e) => [e.id, e]));
  const artistById = new Map(artists.map((a) => [a.id, a]));
  const out = [];
  for (const item of raw) {
    const p = asRecord(item);
    if (!p) continue;
    const id = str$1(p.id).trim();
    if (!id) continue;
    const endpointId = str$1(p.endpointId).trim();
    const artistId = str$1(p.artistId).trim();
    const artist = artistById.get(artistId);
    out.push({
      id,
      name: str$1(p.name).trim() || "未命名方案",
      model: str$1(p.model).trim(),
      endpointId,
      endpointName: ((_a = byId.get(endpointId)) == null ? void 0 : _a.name) ?? (endpointId || "(未指定)"),
      // 柏宝绘里尺寸直接存成形如 "832×1216" 的字符串
      portraitSize: str$1(p.portraitSize).trim(),
      landscapeSize: str$1(p.landscapeSize).trim(),
      modelFamily: detectModelFamily(str$1(p.model)),
      naturalLanguage: p.naturalLanguage === true,
      artistId,
      artistName: (artist == null ? void 0 : artist.name) ?? "",
      layoutWords: artist ? layoutWordsIn(`${artist.prompt}, ${artist.quality}`) : []
    });
  }
  return out;
}
function parseOutConfig(raw) {
  const settings2 = asRecord(raw) ?? {};
  const nai = asRecord(settings2.nai) ?? {};
  const endpoints = parseEndpoints(nai.endpoints);
  const artists = parseArtists(nai.artistPresets);
  const plans = parsePlans(nai.plans, endpoints, artists);
  const activePlanId = str$1(nai.activePlanId).trim();
  const active = plans.find((p) => p.id === activePlanId) ?? plans[0];
  const activeEndpoint = endpoints.find((e) => e.id === (active == null ? void 0 : active.endpointId));
  return {
    backend: str$1(settings2.defaultBackend, "nai"),
    endpoints,
    plans,
    activePlanId: (active == null ? void 0 : active.id) ?? "",
    activePlanName: (active == null ? void 0 : active.name) ?? "",
    activeEndpointConfigured: !!activeEndpoint && activeEndpoint.url.length > 0
  };
}
function readOutConfig() {
  var _a;
  const ctx = getContext();
  return parseOutConfig((_a = ctx.extensionSettings) == null ? void 0 : _a[IMAGE_SETTINGS_KEY]);
}
function activePlanOf(snap) {
  return snap.plans.find((p) => p.id === snap.activePlanId);
}
function planNlEnabled(plan) {
  if (!plan) return false;
  if (plan.modelFamily !== "5" && plan.modelFamily !== "4.5") return false;
  return plan.naturalLanguage === true;
}
function planForMode(snap, mode, assigned) {
  if (mode !== "illustration") {
    const id = assigned == null ? void 0 : assigned[mode];
    if (id) {
      const hit = snap.plans.find((p) => p.id === id);
      if (hit) return hit;
    }
  }
  return activePlanOf(snap);
}
function nlOfMode(snap, mode, assigned) {
  return planNlEnabled(planForMode(snap, mode, assigned));
}
function nlForMode(settings2, mode) {
  return nlOfMode(readOutConfig(), mode, settings2 == null ? void 0 : settings2.modeOutPlans);
}
function activePlanModel() {
  var _a;
  return ((_a = activePlanOf(readOutConfig())) == null ? void 0 : _a.model) ?? "";
}
function moneySavingHint(snap) {
  const active = snap.plans.find((p) => p.id === snap.activePlanId);
  if (!active) return "";
  if (active.modelFamily === "5" && snap.plans.some((p) => p.modelFamily === "4.5" || p.modelFamily === "4")) {
    return "当前用的是 NAI5（较贵）。柏宝绘里已有更便宜的方案，可在柏宝绘里切到 NAI4.5 省钱。";
  }
  return "";
}
let handlers = null;
function registerStudio(next) {
  handlers = next;
}
function openStudio(tab, options) {
  if (!handlers) {
    console.warn("[ST-Story-Illustrator] 面板尚未就绪。");
    return;
  }
  if (tab === "settings") handlers.settings();
  else if (tab === "prompts") handlers.prompts();
  else if (tab === "log") handlers.log();
  else handlers.generate(options);
}
const TAB_LABELS = [
  { tab: "generate", label: "生成配图", icon: "fa-wand-magic-sparkles" },
  { tab: "settings", label: "配图设置", icon: "fa-sliders" },
  { tab: "prompts", label: "提示词", icon: "fa-pen-to-square" },
  { tab: "log", label: "出图日志", icon: "fa-list-ul" }
];
function buildStudioTabs(active) {
  const bar = document.createElement("div");
  bar.className = "sti-studio-tabs";
  for (const { tab, label, icon } of TAB_LABELS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `sti-studio-tab${tab === active ? " active" : ""}`;
    btn.dataset.tab = tab;
    const i = document.createElement("i");
    i.className = `fa-solid ${icon}`;
    btn.appendChild(i);
    btn.appendChild(document.createTextNode(" " + label));
    btn.addEventListener("click", () => {
      if (tab === active) return;
      openStudio(tab);
    });
    bar.appendChild(btn);
  }
  return bar;
}
const PANEL_ID$1 = "sti-selection-panel";
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
let includeHiddenFloors = false;
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
  ensurePanel$1();
  renderPanel();
}
function hideSelectionPanel() {
  if (overlayElement) overlayElement.style.display = "none";
  if (panelElement) panelElement.style.display = "none";
}
function ensurePanel$1() {
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
    panelElement.id = PANEL_ID$1;
    panelElement.className = "sti-selection-panel";
    document.body.appendChild(panelElement);
  }
  overlayElement.style.display = "block";
  panelElement.style.display = "block";
}
function renderPanel() {
  if (!panelElement) return;
  const floors = getAvailableFloors({ includeHidden: includeHiddenFloors });
  panelElement.innerHTML = "";
  const title = document.createElement("div");
  title.className = "sti-panel-title";
  title.textContent = "生成配图";
  panelElement.appendChild(title);
  panelElement.appendChild(buildStudioTabs("generate"));
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
  if (currentMethod !== "local" && currentMethod !== "manual") {
    content.appendChild(renderHiddenToggle());
  }
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
  panelElement.appendChild(renderLlmChannelSelector());
  panelElement.appendChild(renderOutPlanSelector());
  panelElement.appendChild(renderPreview());
  panelElement.appendChild(renderActions());
}
function renderHiddenToggle() {
  const wrap = document.createElement("label");
  wrap.className = "sti-hidden-toggle";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = includeHiddenFloors;
  cb.addEventListener("change", () => {
    includeHiddenFloors = cb.checked;
    renderPanel();
  });
  wrap.appendChild(cb);
  const text = document.createElement("span");
  text.textContent = "查看所有楼层（含已隐藏的楼层）";
  wrap.appendChild(text);
  return wrap;
}
function floorOptionText(f, previewLen = 40) {
  const mark = f.hidden ? "（隐藏）" : "";
  return `[${f.floor}]${mark} ${f.speaker}: ${f.preview.slice(0, previewLen)}...`;
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
  label.textContent = `选择楼层（共 ${floors.length} 层可选）：`;
  container.appendChild(label);
  const select = document.createElement("select");
  select.className = "sti-floor-select";
  for (const f of floors) {
    const opt = document.createElement("option");
    opt.value = String(f.floor);
    opt.textContent = floorOptionText(f);
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
  const total = getChatFloorCount();
  const hint = document.createElement("div");
  hint.className = "sti-selector-label";
  hint.textContent = `填写楼层区间（当前共 ${total} 层，楼层号 0–${Math.max(0, total - 1)}）：`;
  container.appendChild(hint);
  const rangeRow = document.createElement("div");
  rangeRow.className = "sti-range-row";
  const startLabel = document.createElement("span");
  startLabel.textContent = "从";
  rangeRow.appendChild(startLabel);
  const startInput = createFloorNumberInput(rangeStart, total, (val) => {
    rangeStart = val;
    rebuildSegment();
    renderPanel();
  });
  rangeRow.appendChild(startInput);
  const dash = document.createElement("span");
  dash.textContent = "到";
  rangeRow.appendChild(dash);
  const endInput = createFloorNumberInput(rangeEnd, total, (val) => {
    rangeEnd = val;
    rebuildSegment();
    renderPanel();
  });
  rangeRow.appendChild(endInput);
  const unit = document.createElement("span");
  unit.textContent = "楼";
  rangeRow.appendChild(unit);
  container.appendChild(rangeRow);
  if (rangeStart >= 0 && rangeEnd >= 0 && floors.length > 0) {
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
        item.className = `sti-exclude-item ${f.hidden ? "is-hidden-floor" : ""}`;
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
        item.appendChild(document.createTextNode(` ${floorOptionText(f, 50)}`));
        excludeList.appendChild(item);
      }
      container.appendChild(excludeList);
    }
  }
  if (rangeStart >= 0 && rangeEnd >= 0 && Math.abs(rangeEnd - rangeStart) + 1 > 50) {
    const warn = document.createElement("div");
    warn.className = "sti-manual-note";
    warn.textContent = "区间超过 50 层，只会取前 50 条消息。";
    container.appendChild(warn);
  }
  if (!includeHiddenFloors && rangeStart >= 0 && rangeEnd >= 0) {
    const lo = Math.min(rangeStart, rangeEnd);
    const hi = Math.max(rangeStart, rangeEnd);
    const hiddenCount = getAvailableFloors({ includeHidden: true }).filter((f) => f.hidden && f.floor >= lo && f.floor <= hi).length;
    if (hiddenCount > 0) {
      const warn = document.createElement("div");
      warn.className = "sti-manual-note";
      warn.textContent = `该区间有 ${hiddenCount} 层是隐藏楼层，当前会被跳过。需要的话勾选上方「查看所有楼层」。`;
      container.appendChild(warn);
    }
  }
  return container;
}
function createFloorNumberInput(currentValue, total, onChange) {
  const input = document.createElement("input");
  input.type = "number";
  input.className = "sti-floor-number";
  input.min = "0";
  input.max = String(Math.max(0, total - 1));
  input.value = currentValue >= 0 ? String(currentValue) : "";
  input.placeholder = "0";
  const commit = () => {
    const raw = input.value.trim();
    if (raw === "") return;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return;
    onChange(Math.max(0, Math.min(total - 1, n)));
  };
  input.addEventListener("change", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    }
  });
  return input;
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
    item.className = `sti-picked-item ${f.hidden ? "is-hidden-floor" : ""}`;
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
    item.appendChild(document.createTextNode(` ${floorOptionText(f, 50)}`));
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
      item.classList.toggle("active", selectedModes.has(mode));
      cb.blur();
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
  const hint = document.createElement("div");
  hint.className = "sti-mode-hint";
  hint.id = "sti-mode-hint";
  hint.textContent = "至少选一个创作模式才能生成。";
  hint.style.display = selectedModes.size === 0 ? "" : "none";
  container.appendChild(hint);
  return container;
}
function renderLlmChannelSelector() {
  const container = document.createElement("div");
  container.className = "sti-api-channel-selector";
  const label = document.createElement("div");
  label.className = "sti-selector-label";
  label.textContent = "LLM 渠道（读剧情 / 写 Tag；各模式分开指派，渠道同步自柏宝绘）：";
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
function renderOutPlanSelector() {
  const container = document.createElement("div");
  container.className = "sti-api-channel-selector";
  const label = document.createElement("div");
  label.className = "sti-selector-label";
  label.textContent = "出图方案（各模式分开指派，方案同步自柏宝绘）：";
  container.appendChild(label);
  const snap = readOutConfig();
  const settings2 = getSettings(DEFAULT_SETTINGS);
  const modePlans = settings2.modeOutPlans ?? {};
  if (snap.plans.length === 0) {
    const hint2 = document.createElement("div");
    hint2.className = "sti-api-hint";
    hint2.textContent = "柏宝绘里还没有出图方案。先去柏宝绘新建一套方案（例如 NAI4.5 省钱方案），这里会自动出现。";
    container.appendChild(hint2);
    return container;
  }
  const list = document.createElement("div");
  list.className = "sti-api-channel-list";
  const note = document.createElement("div");
  note.className = "sti-api-hint";
  note.textContent = "正文插画固定用柏宝绘当前方案，这里不参与切换；下面几套出完图会自动切回原方案。";
  list.appendChild(note);
  for (const mode of Object.keys(MODE_LABELS$1)) {
    if (mode === "illustration") continue;
    const row = document.createElement("label");
    row.className = "sti-api-channel-row";
    const name = document.createElement("span");
    name.className = "sti-api-mode-name";
    name.textContent = MODE_LABELS$1[mode];
    row.appendChild(name);
    const select = document.createElement("select");
    select.className = "sti-api-channel-select";
    const followOpt = document.createElement("option");
    followOpt.value = "current";
    followOpt.textContent = `跟随当前方案（${snap.activePlanName || "未设置"}）`;
    select.appendChild(followOpt);
    for (const plan of snap.plans) {
      const opt = document.createElement("option");
      opt.value = plan.id;
      const family = plan.modelFamily !== "unknown" ? ` · NAI${plan.modelFamily}` : "";
      opt.textContent = `${plan.name}${family} · ${plan.endpointName}` + (plan.layoutWords.length ? " · ⚠整页" : "");
      select.appendChild(opt);
    }
    const current = modePlans[mode] ?? "current";
    if (current !== "current" && !snap.plans.some((p) => p.id === current)) {
      const stale = document.createElement("option");
      stale.value = current;
      stale.textContent = `已失效方案（${current.slice(0, 8)}…）`;
      select.appendChild(stale);
    }
    select.value = current;
    select.addEventListener("change", () => {
      const next = getSettings(DEFAULT_SETTINGS);
      const map = { ...next.modeOutPlans ?? {} };
      if (select.value === "current") delete map[mode];
      else map[mode] = select.value;
      next.modeOutPlans = map;
      saveSettings(next);
      window.dispatchEvent(new CustomEvent("sti-settings-changed"));
    });
    row.appendChild(select);
    list.appendChild(row);
  }
  container.appendChild(list);
  const hint = document.createElement("div");
  hint.className = "sti-api-hint";
  hint.textContent = "指了方案的模式，出图前会先把柏宝绘切成该方案（可能短暂弹出柏宝绘面板）。柏宝绘的「当前方案」是全局的，所以切换对所有用柏宝绘出图的地方都生效。";
  container.appendChild(hint);
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
  if (btn) {
    btn.textContent = selectedModes.size > 0 ? `确认选段 · 生成 ${selectedModes.size} 份` : "请至少选一个创作模式";
    btn.disabled = !currentSegment || selectedModes.size === 0;
  }
  const hint = document.getElementById("sti-mode-hint");
  if (hint) hint.style.display = selectedModes.size === 0 ? "" : "none";
}
function rebuildSegment() {
  const options = { includeHidden: includeHiddenFloors };
  switch (currentMethod) {
    case "local":
    case "manual":
      currentSegment = localText.trim() ? buildManualSegment(localText, selectedFloorSeed >= 0 ? [selectedFloorSeed] : []) : null;
      break;
    case "single":
      currentSegment = selectedSingleFloor >= 0 ? buildSingleSegment(selectedSingleFloor, options) : null;
      break;
    case "range":
      currentSegment = rangeStart >= 0 && rangeEnd >= 0 ? buildRangeSegment(rangeStart, rangeEnd, Array.from(excludedFloors), options) : null;
      break;
    case "picked":
      currentSegment = pickedFloors.length > 0 ? buildPickedSegment(pickedFloors, options) : null;
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
const ALL_BUBBLE_STYLES = [
  "classic",
  "bubble-vertical",
  "bubble-glow",
  "bubble-ink",
  "bubble-subtitle",
  "blend",
  "blend-vertical",
  "blend-glow",
  "blend-ink",
  "blend-subtitle"
];
function normalizeBubbleStyle(v) {
  return ALL_BUBBLE_STYLES.includes(v) ? v : "classic";
}
function bubbleShellOf(s) {
  return String(s).startsWith("blend") ? "blend" : "bubble";
}
function isBlendStyle(s) {
  return bubbleShellOf(s) === "blend";
}
function bubbleVariantOf(s) {
  const n = normalizeBubbleStyle(s);
  if (n === "classic" || n === "blend") return "normal";
  return n.slice(n.indexOf("-") + 1);
}
function normalizeBubbleFont(v) {
  return v === "serif" || v === "kai" || v === "round" ? v : "sans";
}
const BUBBLE_FONT_STACKS = {
  sans: "sans-serif",
  serif: '"Noto Serif SC", "SimSun", "Songti SC", "MS Song", serif',
  kai: '"KaiTi", "STKaiti", "Kaiti SC", "DFKai-SB", serif',
  round: '"Yuanti SC", "HYQiHei", "Microsoft YaHei", "PingFang SC", sans-serif'
};
const GAP = 0.024;
function panelSlots(layout, count, pageType = "auto") {
  const n = Math.min(4, Math.max(0, Math.round(Number(count) || 0)));
  if (layout === "regular") {
    if (n <= 1) return [{ x: 0, y: 0, width: 1, height: 1 }];
    if (n === 2) {
      const h2 = (1 - GAP) / 2;
      return [
        { x: 0, y: 0, width: 1, height: h2 },
        { x: 0, y: h2 + GAP, width: 1, height: h2 }
      ];
    }
    if (n === 3) {
      const top = 0.378;
      const botY = top + GAP;
      const botH = 1 - botY;
      const w2 = (1 - GAP) / 2;
      return [
        { x: 0, y: 0, width: 1, height: top },
        { x: 0, y: botY, width: w2, height: botH },
        { x: w2 + GAP, y: botY, width: w2, height: botH }
      ];
    }
    const w = (1 - GAP) / 2;
    const h = (1 - GAP) / 2;
    return [
      { x: 0, y: 0, width: w, height: h },
      { x: w + GAP, y: 0, width: w, height: h },
      { x: 0, y: h + GAP, width: w, height: h },
      { x: w + GAP, y: h + GAP, width: w, height: h }
    ];
  }
  if (layout === "irregular") return [];
  if (layout === "inset") {
    return [{ x: 0.02, y: 0.19, width: 0.96, height: 0.78 }];
  }
  switch (pageType) {
    case "c":
      return [{ x: 0.02, y: 0.02, width: 0.65, height: 0.96 }];
    case "d":
      return [{ x: 0.02, y: 0.02, width: 0.96, height: 0.96 }];
    case "a":
    case "b":
    default:
      return [{ x: 0.02, y: 0.21, width: 0.96, height: 0.77 }];
  }
}
function layoutNoGoZones(layout, pageType = "auto") {
  if (layout === "inset") {
    return [
      { x: 0, y: 0, width: 1, height: 0.19, weight: 3 },
      { x: 0.6, y: 0.66, width: 0.4, height: 0.34, weight: 3 }
    ];
  }
  if (layout === "unframed") {
    if (pageType === "d") {
      return [{ x: 0.66, y: 0.74, width: 0.34, height: 0.26, weight: 3 }];
    }
    if (pageType === "c") {
      return [{ x: 0.66, y: 0, width: 0.34, height: 1, weight: 3 }];
    }
    return [{ x: 0.33, y: 0.71, width: 0.65, height: 0.27, weight: 3 }];
  }
  return [];
}
function slotIndexAt(slots, px, py) {
  if (!slots.length) return 0;
  let inside = -1;
  slots.forEach((s, i) => {
    if (px >= s.x && px <= s.x + s.width && py >= s.y && py <= s.y + s.height) inside = i;
  });
  if (inside >= 0) return inside;
  let best = 0;
  let bestDist = Infinity;
  slots.forEach((s, i) => {
    const dx = s.x + s.width / 2 - px;
    const dy = s.y + s.height / 2 - py;
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  });
  return best;
}
const BUSY_COLS = 20;
const BUSY_ROWS = 28;
function clamp01$2(v) {
  return v <= 0 ? 0 : v >= 1 ? 1 : v;
}
function buildBusyGrid(data, width, height, cols = BUSY_COLS, rows = BUSY_ROWS) {
  const c = Math.max(1, Math.round(cols));
  const r = Math.max(1, Math.round(rows));
  const sum = new Array(c * r).fill(0);
  const sumSq = new Array(c * r).fill(0);
  const count = new Array(c * r).fill(0);
  if (!width || !height || data.length < 4) {
    return { cols: c, rows: r, cells: new Array(c * r).fill(0), mean: 0 };
  }
  const stepX = Math.max(1, Math.floor(width / (c * 4)));
  const stepY = Math.max(1, Math.floor(height / (r * 4)));
  for (let y = 0; y < height; y += stepY) {
    const gy = Math.min(r - 1, Math.floor(y * r / height));
    for (let x = 0; x < width; x += stepX) {
      const gx = Math.min(c - 1, Math.floor(x * c / width));
      const i = (y * width + x) * 4;
      const alpha = data[i + 3];
      if (alpha !== void 0 && alpha < 8) continue;
      const lum = (0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0)) / 255;
      const k = gy * c + gx;
      sum[k] += lum;
      sumSq[k] += lum * lum;
      count[k] += 1;
    }
  }
  const cells = [];
  let total = 0;
  for (let k = 0; k < c * r; k += 1) {
    const n = count[k];
    if (!n) {
      cells.push(0);
      continue;
    }
    const mean = sum[k] / n;
    const variance = Math.max(0, sumSq[k] / n - mean * mean);
    const std = Math.sqrt(variance);
    const density = clamp01$2((std - 0.04) * 2.8);
    const darkness = clamp01$2((0.52 - mean) * 1.6);
    const busy = clamp01$2(0.75 * density + 0.45 * darkness);
    cells.push(Math.round(busy * 1e3) / 1e3);
    total += busy;
  }
  return {
    cols: c,
    rows: r,
    cells,
    mean: Math.round(total / Math.max(1, c * r) * 1e3) / 1e3
  };
}
function busyInRect(grid, rect) {
  if (!grid || !grid.cells.length) return 0;
  const x0 = clamp01$2(Math.min(rect.x, rect.x + rect.width));
  const y0 = clamp01$2(Math.min(rect.y, rect.y + rect.height));
  const x1 = clamp01$2(Math.max(rect.x, rect.x + rect.width));
  const y1 = clamp01$2(Math.max(rect.y, rect.y + rect.height));
  if (x1 <= x0 || y1 <= y0) return 0;
  const cw = 1 / grid.cols;
  const ch = 1 / grid.rows;
  let weighted = 0;
  let area = 0;
  for (let gy = 0; gy < grid.rows; gy += 1) {
    const cy0 = gy * ch;
    const cy1 = cy0 + ch;
    const oy = Math.min(y1, cy1) - Math.max(y0, cy0);
    if (oy <= 0) continue;
    for (let gx = 0; gx < grid.cols; gx += 1) {
      const cx0 = gx * cw;
      const cx1 = cx0 + cw;
      const ox = Math.min(x1, cx1) - Math.max(x0, cx0);
      if (ox <= 0) continue;
      const w = ox * oy;
      weighted += (grid.cells[gy * grid.cols + gx] ?? 0) * w;
      area += w;
    }
  }
  return area > 0 ? weighted / area : 0;
}
function readBusyGrid(image, cols = BUSY_COLS, rows = BUSY_ROWS) {
  try {
    const w = Number(image.naturalWidth ?? image.width ?? 0);
    const h = Number(image.naturalHeight ?? image.height ?? 0);
    if (!w || !h) return null;
    const small = document.createElement("canvas");
    small.width = cols;
    small.height = rows;
    const ctx = small.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, cols, rows);
    const { data } = ctx.getImageData(0, 0, cols, rows);
    return buildBusyGrid(data, cols, rows, cols, rows);
  } catch {
    return null;
  }
}
const PANEL_DIALOGUE_MAX$1 = 4;
const BUBBLE_ANCHORS = {
  tl: { x: 0.24, y: 0.15 },
  tc: { x: 0.5, y: 0.13 },
  tr: { x: 0.76, y: 0.15 },
  ml: { x: 0.17, y: 0.44 },
  mr: { x: 0.83, y: 0.44 },
  bl: { x: 0.24, y: 0.79 },
  bc: { x: 0.5, y: 0.84 },
  br: { x: 0.76, y: 0.79 }
};
const SLOT_X = [0.16, 0.5, 0.84];
const SLOT_Y = [0.1, 0.3, 0.62, 0.84];
const FACE_AVOID_ZONES = [
  { x: 0.33, y: 0.14, width: 0.34, height: 0.4, weight: 4 },
  { x: 0.28, y: 0.42, width: 0.44, height: 0.38, weight: 1.2 }
];
function wrapText(text, maxWidth, measure) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  if (measure(clean) <= maxWidth) return [clean];
  const lines = [];
  let current = "";
  for (const char of clean) {
    const candidate = current + char;
    if (current && measure(candidate) > maxWidth) {
      lines.push(current);
      current = char === " " ? "" : char;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines;
}
function bubbleFontSize(page) {
  return Math.max(15, Math.min(44, Math.round(Math.min(page.width, page.height) * 0.034)));
}
function blendFontSize(page) {
  return Math.max(13, Math.min(36, Math.round(Math.min(page.width, page.height) * 0.028)));
}
function blendSpacing(fontSize) {
  return fontSize * 0.26;
}
function layoutBlendH(text, maxWidth, fontSize, measure) {
  const spacing = blendSpacing(fontSize);
  const widthOf = (s) => [...s].reduce((sum, ch) => sum + measure(ch), 0) + spacing * Math.max(0, [...s].length - 1);
  const lines = wrapText(text, maxWidth, widthOf);
  return {
    lines,
    width: Math.ceil(Math.max(0, ...lines.map(widthOf))),
    height: Math.ceil(lines.length * fontSize * 1.35)
  };
}
function layoutBlendV(text, maxHeight, fontSize) {
  var _a;
  const spacing = blendSpacing(fontSize);
  const step = fontSize * 1.15;
  const perCol = Math.max(4, Math.floor(maxHeight / step));
  const chars = [...text];
  const cols = [];
  for (let i = 0; i < chars.length; i += perCol) cols.push(chars.slice(i, i + perCol).join(""));
  return {
    cols,
    width: Math.ceil(cols.length * fontSize + (cols.length - 1) * spacing),
    height: Math.ceil(Math.min(perCol, ((_a = cols[0]) == null ? void 0 : _a.length) ?? 0) * step)
  };
}
function deriveTextColor(avg) {
  const lin = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const L = lum(avg);
  const text = L > 0.42 ? { r: Math.round(avg.r * 0.3), g: Math.round(avg.g * 0.28), b: Math.round(avg.b * 0.28) } : { r: Math.round(avg.r + (255 - avg.r) * 0.82), g: Math.round(avg.g + (255 - avg.g) * 0.82), b: Math.round(avg.b + (255 - avg.b) * 0.82) };
  const contrast = (Math.max(lum(text), L) + 0.05) / (Math.min(lum(text), L) + 0.05);
  const halo = L > 0.35 && L < 0.55 || contrast < 2.2 ? L > 0.42 ? "rgba(255,255,255,0.85)" : "rgba(0,0,0,0.5)" : null;
  return { color: `rgb(${text.r},${text.g},${text.b})`, halo };
}
function blendInkFor(style, avg) {
  if (style === "blend-glow") return { color: "#fffaf2", halo: "rgba(0,0,0,0.38)", glow: "rgba(255,246,228,0.85)", band: null };
  if (style === "blend-ink") return { color: "#2a2320", halo: "rgba(255,255,255,0.92)", glow: null, band: null };
  if (style === "blend-subtitle") return { color: "#f7f4ef", halo: "rgba(0,0,0,0.45)", glow: null, band: "rgba(18,16,15,0.55)" };
  const { color, halo } = deriveTextColor(avg);
  return { color, halo, glow: null, band: null };
}
function boxInkFor(style) {
  const variant = bubbleVariantOf(style);
  if (variant === "glow") return { color: "#fffaf2", glow: "rgba(255,244,214,0.9)" };
  if (variant === "ink") return { color: "#2a2320", glow: null };
  return { color: "#111111", glow: null };
}
function overlapArea(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
function atCenter(rect, cx, cy, page, margin) {
  return {
    x: Math.min(Math.max(margin, cx - rect.width / 2), Math.max(margin, page.width - rect.width - margin)),
    y: Math.min(Math.max(margin, cy - rect.height / 2), Math.max(margin, page.height - rect.height - margin))
  };
}
function candidatesFor(rect, item, page, margin) {
  const out = [];
  for (const ay of SLOT_Y) {
    for (const ax of SLOT_X) out.push(atCenter(rect, ax * page.width, ay * page.height, page, margin));
  }
  if (item.area && BUBBLE_ANCHORS[item.area]) {
    const a = BUBBLE_ANCHORS[item.area];
    out.push(atCenter(rect, a.x * page.width, a.y * page.height, page, margin));
  }
  return out;
}
const THUMB = 1;
const W_PLACED = 240;
const W_FACE = 130;
const W_CROSS = 14;
const W_EDGE = 26;
const W_BUSY = 150;
const BUSY_FLOOR = 0.12;
function normRect(rect, page) {
  return {
    x: rect.x / Math.max(1, page.width),
    y: rect.y / Math.max(1, page.height),
    width: rect.width / Math.max(1, page.width),
    height: rect.height / Math.max(1, page.height)
  };
}
function busyPenalty(busy, rect, page) {
  if (!busy) return 0;
  const ratio = busyInRect(busy, normRect(rect, page));
  return Math.max(0, ratio - BUSY_FLOOR) * W_BUSY;
}
function scoreAt(rect, point, item, page, placed, zones, busy) {
  const probe2 = { ...rect, x: point.x, y: point.y };
  const area = Math.max(THUMB, rect.width * rect.height);
  let score = 0;
  score += busyPenalty(busy, probe2, page);
  for (const zone of zones) {
    const box = {
      x: zone.x * page.width,
      y: zone.y * page.height,
      width: zone.width * page.width,
      height: zone.height * page.height
    };
    const ratio = overlapArea(probe2, box) / area;
    if (ratio <= 0) continue;
    score += ratio * W_FACE * (zone.weight ?? 1);
  }
  for (const other of placed) {
    const ratio = overlapArea(probe2, other) / area;
    if (ratio > 0) score += ratio * W_PLACED;
  }
  const mid = page.width * 0.5;
  if (probe2.x < mid && probe2.x + probe2.width > mid) score += W_CROSS;
  const edge = Math.min(
    probe2.x,
    probe2.y,
    page.width - probe2.x - probe2.width,
    page.height - probe2.y - probe2.height
  );
  score += Math.max(0, edge) / Math.max(1, page.width) * W_EDGE;
  if (item.area && BUBBLE_ANCHORS[item.area]) {
    const a = BUBBLE_ANCHORS[item.area];
    const ax = a.x * page.width;
    const ay = a.y * page.height;
    const dist = Math.hypot(probe2.x + probe2.width / 2 - ax, probe2.y + probe2.height / 2 - ay);
    score += dist / Math.max(1, page.width) * 6;
  }
  return score;
}
function bestPoint(rect, item, page, margin, placed, zones, busy) {
  let best = null;
  for (const point of candidatesFor(rect, item, page, margin)) {
    const score = scoreAt(rect, point, item, page, placed, zones, busy);
    if (!best || score < best.score) best = { point, score };
  }
  return best ?? { point: { x: margin, y: margin }, score: 0 };
}
function faceCoverRatio(rect, page, zones = FACE_AVOID_ZONES) {
  const face = zones[0];
  if (!face) return 0;
  const box = {
    x: face.x * page.width,
    y: face.y * page.height,
    width: face.width * page.width,
    height: face.height * page.height
  };
  const area = Math.max(1, rect.width * rect.height);
  return overlapArea(rect, box) / area;
}
function placeRect(rect, item, index2, page, margin, zones, placed, withTail, busy) {
  if (typeof item.x === "number" && typeof item.y === "number") {
    rect.x = Math.min(Math.max(margin, item.x * page.width - rect.width / 2), page.width - rect.width - margin);
    rect.y = Math.min(Math.max(margin, item.y * page.height - rect.height / 2), page.height - rect.height - margin);
    placed.push(rect);
    return;
  }
  const { point } = bestPoint(rect, item, page, margin, placed, zones, busy);
  rect.x = point.x;
  rect.y = point.y;
  placed.push(rect);
}
function pageBox(zone, page) {
  return {
    x: zone.x * page.width,
    y: zone.y * page.height,
    width: zone.width * page.width,
    height: zone.height * page.height
  };
}
function innerOf(slot, page, pad) {
  return {
    x: slot.x * page.width + pad,
    y: slot.y * page.height + pad,
    width: Math.max(24, slot.width * page.width - pad * 2),
    height: Math.max(24, slot.height * page.height - pad * 2)
  };
}
function faceZoneInSlot(slot, page) {
  return {
    x: (slot.x + slot.width * 0.3) * page.width,
    y: (slot.y + slot.height * 0.14) * page.height,
    width: slot.width * 0.4 * page.width,
    height: slot.height * 0.32 * page.height
  };
}
function outsideRatio(rect, inner) {
  const area = Math.max(1, rect.width * rect.height);
  const inside = overlapArea(rect, inner);
  return Math.max(0, area - inside) / area;
}
function candidatesInSlot(rect, inner, placed) {
  const freeW = Math.max(0, inner.width - rect.width);
  const freeH = Math.max(0, inner.height - rect.height);
  const out = [];
  for (const fy of [0, 0.18, 0.42, 0.68, 0.94]) {
    for (const fx of [0, 0.5, 1]) {
      out.push({ x: inner.x + fx * freeW, y: inner.y + fy * freeH });
    }
  }
  for (const p of placed) {
    const gap = Math.max(4, rect.height * 0.14);
    const below = p.y + p.height + gap;
    const above = p.y - rect.height - gap;
    for (const x of [p.x, inner.x, inner.x + freeW]) {
      if (below <= inner.y + freeH) out.push({ x, y: below });
      if (above >= inner.y) out.push({ x, y: above });
    }
  }
  return out;
}
function scoreInSlot(rect, point, inner, slot, item, page, placed, noGo, busy) {
  const probe2 = { ...rect, x: point.x, y: point.y };
  const area = Math.max(1, rect.width * rect.height);
  let score = 0;
  score += busyPenalty(busy, probe2, page);
  for (const other of placed) {
    score += overlapArea(probe2, other) / area * 400;
    if (probe2.y + probe2.height <= other.y + 1) score += 34;
  }
  score += overlapArea(probe2, faceZoneInSlot(slot, page)) / area * 95;
  for (const zone of noGo) {
    score += overlapArea(probe2, pageBox(zone, page)) / area * 120 * (zone.weight ?? 1);
  }
  score += (probe2.y - inner.y) / Math.max(1, inner.height) * 7;
  score += outsideRatio(probe2, inner) * 300;
  if (item.area) {
    const left = item.area.endsWith("l");
    const right = item.area.endsWith("r");
    const centerX = probe2.x + probe2.width / 2;
    const slotMid = (slot.x + slot.width / 2) * page.width;
    if (left && centerX > slotMid) score += 5;
    if (right && centerX < slotMid) score += 5;
  }
  return score;
}
function nameKey$1(v) {
  return String(v ?? "").replace(/[\s（）()「」『』【】·.,，。:：!！?？~～\-—_]/g, "").toLowerCase();
}
function slotBySpeaker(item, casts) {
  const speaker = nameKey$1(item.speaker ?? "");
  if (!speaker || !(casts == null ? void 0 : casts.length)) return -1;
  const hits = [];
  casts.forEach((names, i) => {
    if ((names ?? []).some((name) => {
      const key = nameKey$1(name);
      return key.length > 0 && (key === speaker || key.includes(speaker) || speaker.includes(key));
    })) hits.push(i);
  });
  return hits.length === 1 ? hits[0] : -1;
}
function assignDialogueToSlots(items, slots, casts) {
  const n = slots.length;
  if (!n) return items.map(() => 0);
  const zeroBased = items.some((item) => Number(item.panel) === 0);
  const explicit = (item) => {
    const raw = Number(item.panel);
    if (!Number.isFinite(raw)) return -1;
    const p = Math.round(zeroBased ? raw + 1 : raw);
    return p >= 1 && p <= n ? p - 1 : -1;
  };
  const hasHint = items.some((item) => explicit(item) >= 0 || !!item.area || slotBySpeaker(item, casts) >= 0);
  if (!hasHint) {
    return items.map((_, i) => Math.min(n - 1, Math.floor(i * n / Math.max(1, items.length))));
  }
  let prev = 0;
  return items.map((item) => {
    const p = explicit(item);
    const bySpeaker = slotBySpeaker(item, casts);
    if (p >= 0) {
      const chosen = bySpeaker >= 0 && bySpeaker !== p ? bySpeaker : p;
      prev = chosen;
      return chosen;
    }
    if (bySpeaker >= 0) {
      prev = bySpeaker;
      return bySpeaker;
    }
    if (item.area && BUBBLE_ANCHORS[item.area]) {
      const a = BUBBLE_ANCHORS[item.area];
      prev = slotIndexAt(slots, a.x, a.y);
      return prev;
    }
    return prev;
  });
}
function setTailInSlot(rect, slot, page) {
  const midY = (slot.y + slot.height / 2) * page.height;
  const midX = (slot.x + slot.width / 2) * page.width;
  rect.tail = rect.y + rect.height / 2 < midY ? "down" : "up";
  rect.tailX = rect.x + rect.width / 2 < midX ? rect.x + rect.width * 0.74 : rect.x + rect.width * 0.26;
}
function planBubbles(items, page, measure, opts = {}) {
  if (!page.width || !page.height) return [];
  const style = normalizeBubbleStyle(opts.style);
  const slots = opts.panels && opts.panels.length ? opts.panels : [];
  const zones = opts.avoidFace === false ? [] : opts.avoid ?? (slots.length ? [] : FACE_AVOID_ZONES);
  if (isBlendStyle(style)) {
    return planBlend(items, page, measure, style, zones, slots, opts.panelPadding, opts.panelCast, opts.busy);
  }
  return planBubbleBox(items, page, measure, style, zones, slots, opts.panelPadding, opts.panelCast, opts.busy);
}
const MAX_BUBBLE_RATIO = 0.34;
function measureBox(item, page, measure, fontSize, variant, maxWidth, maxHeight) {
  var _a;
  const padX = fontSize * 0.7;
  const padY = fontSize * 0.55;
  if (variant === "vertical") {
    const step = fontSize * 1.15;
    const perCol = Math.max(3, Math.floor((maxHeight ?? page.height * 0.5) / step));
    const chars = [...item.text];
    const cols = [];
    for (let i = 0; i < chars.length; i += perCol) cols.push(chars.slice(i, i + perCol).join(""));
    return {
      lines: cols,
      width: Math.ceil(cols.length * fontSize + (cols.length - 1) * fontSize * 0.26 + padX * 2),
      height: Math.ceil(Math.min(perCol, ((_a = cols[0]) == null ? void 0 : _a.length) ?? 0) * step + padY * 2),
      vertical: true
    };
  }
  const wrapWidth = Math.max(fontSize * 2, (maxWidth ?? page.width * MAX_BUBBLE_RATIO) - padX * 2);
  const lines = wrapText(item.text, wrapWidth, measure);
  if (!lines.length) return null;
  return {
    lines,
    width: Math.ceil(Math.max(...lines.map(measure)) + padX * 2),
    height: Math.ceil(lines.length * fontSize * 1.4 + padY * 2),
    vertical: false
  };
}
const PANEL_TEXT_RATIO = 0.88;
function planBubbleBoxPanel(items, page, measure, variant, slots, noGo, paddingRatio, casts, busy) {
  const baseFont = bubbleFontSize(page);
  const pad = Math.max(3, Math.round(page.width * (paddingRatio ?? 0.012)));
  const capped = items.slice(0, PANEL_DIALOGUE_MAX$1).filter((item) => item.text.trim());
  const groups = assignDialogueToSlots(capped, slots, casts);
  const out = capped.map(() => null);
  const placedAll = [];
  slots.forEach((slot, si) => {
    const inner = innerOf(slot, page, pad);
    const placedHere = [];
    const fontCap = Math.max(12, Math.round(Math.min(inner.width, inner.height) * 0.13));
    const startFont = Math.min(baseFont, fontCap);
    capped.forEach((item, idx) => {
      if (groups[idx] !== si) return;
      let best = null;
      for (const scale of [1, 0.88, 0.76, 0.64]) {
        const fontSize = Math.max(11, Math.round(startFont * scale));
        const metrics = measureBox(
          item,
          page,
          measure,
          fontSize,
          variant,
          inner.width * PANEL_TEXT_RATIO,
          inner.height * 0.8
        );
        if (!metrics) continue;
        if (metrics.width > inner.width || metrics.height > inner.height * 0.85) continue;
        const rect = {
          x: 0,
          y: 0,
          width: metrics.width,
          height: metrics.height,
          lines: metrics.lines,
          ...metrics.vertical ? { vertical: true } : {}
        };
        let point = { x: inner.x, y: inner.y };
        let score = Infinity;
        for (const candidate of candidatesInSlot(rect, inner, placedHere)) {
          const s = scoreInSlot(rect, candidate, inner, slot, item, page, placedHere, noGo, busy);
          if (s < score) {
            score = s;
            point = candidate;
          }
        }
        const total = score + (1 - scale) * 5;
        if (!best || total < best.score) {
          best = { rect: { ...rect, x: point.x, y: point.y, fontSize }, score: total };
        }
      }
      if (!best) return;
      setTailInSlot(best.rect, slot, page);
      best.rect.itemIndex = idx;
      placedHere.push(best.rect);
      placedAll.push(best.rect);
      out[idx] = best.rect;
    });
  });
  return out.filter((r) => !!r);
}
function planBubbleBox(items, page, measure, style, zones, slots = [], panelPadding, panelCasts, busy) {
  const variant = bubbleVariantOf(style);
  const baseFont = bubbleFontSize(page);
  const margin = Math.round(page.width * 0.02);
  const placed = [];
  const capped = items.slice(0, PANEL_DIALOGUE_MAX$1).filter((item) => item.text.trim());
  if (slots.length && variant !== "subtitle") {
    const casts = panelCasts;
    const pinned = capped.filter((item) => typeof item.x === "number" && typeof item.y === "number");
    const flowed = capped.filter((item) => !(typeof item.x === "number" && typeof item.y === "number"));
    const byPanel = planBubbleBoxPanel(flowed, page, measure, variant, slots, zones, panelPadding, casts, busy);
    const manual = [];
    for (const item of pinned) {
      const metrics = measureBox(item, page, measure, baseFont, variant);
      if (!metrics) continue;
      const rect = { x: 0, y: 0, width: metrics.width, height: metrics.height, lines: metrics.lines, ...metrics.vertical ? { vertical: true } : {} };
      rect.x = Math.min(Math.max(margin, item.x * page.width - rect.width / 2), page.width - rect.width - margin);
      rect.y = Math.min(Math.max(margin, item.y * page.height - rect.height / 2), page.height - rect.height - margin);
      rect.tail = item.y < 0.5 ? "down" : "up";
      rect.itemIndex = capped.indexOf(item);
      manual.push(rect);
    }
    const merged = capped.map(() => null);
    let i = 0;
    let j = 0;
    capped.forEach((item, idx) => {
      const isPinned = typeof item.x === "number" && typeof item.y === "number";
      merged[idx] = isPinned ? manual[j++] ?? null : byPanel[i++] ?? null;
    });
    return merged.filter((r) => !!r);
  }
  capped.forEach((item) => {
    if (typeof item.x === "number" && typeof item.y === "number") {
      const metrics = measureBox(item, page, measure, baseFont, variant === "subtitle" ? "normal" : variant);
      if (!metrics) return;
      const rect = {
        x: 0,
        y: 0,
        width: metrics.width,
        height: metrics.height,
        lines: metrics.lines,
        ...metrics.vertical ? { vertical: true } : {}
      };
      rect.x = Math.min(Math.max(margin, item.x * page.width - rect.width / 2), page.width - rect.width - margin);
      rect.y = Math.min(Math.max(margin, item.y * page.height - rect.height / 2), page.height - rect.height - margin);
      rect.tail = item.y < 0.5 ? "down" : "up";
      placed.push(rect);
      return;
    }
    if (variant === "subtitle") {
      const fontSize = baseFont;
      const metrics = measureBox(item, page, measure, fontSize, "normal");
      if (!metrics) return;
      const rect = { x: 0, y: 0, width: metrics.width, height: metrics.height, lines: metrics.lines };
      rect.x = Math.min(Math.max(margin, page.width * 0.5 - rect.width / 2), page.width - rect.width - margin);
      rect.y = page.height - rect.height - Math.max(margin, Math.round(page.height * 0.04));
      for (let guard = 0; guard < 8; guard += 1) {
        const hit = placed.find((o) => overlapArea(rect, o) > 0);
        if (!hit) break;
        rect.y = Math.max(margin, hit.y - rect.height - fontSize * 0.3);
      }
      placed.push(rect);
      return;
    }
    let chosen = null;
    for (const scale of [1, 0.86, 0.74]) {
      const fontSize = Math.max(12, Math.round(baseFont * scale));
      const metrics = measureBox(item, page, measure, fontSize, variant);
      if (!metrics) continue;
      const rect = { x: 0, y: 0, width: metrics.width, height: metrics.height, lines: metrics.lines, ...metrics.vertical ? { vertical: true } : {} };
      const { point, score } = bestPoint(rect, item, page, margin, placed, zones, busy);
      rect.x = point.x;
      rect.y = point.y;
      rect.fontSize = fontSize;
      const cover = faceCoverRatio(rect, page, zones);
      if (!chosen || cover < 0.02 || score < chosen.score) {
        chosen = { rect, score };
        if (cover <= 1e-3 && score < W_PLACED) break;
      }
    }
    if (!chosen) return;
    chosen.rect.tail = chosen.rect.y + chosen.rect.height / 2 < page.height / 2 ? "down" : "up";
    placed.push(chosen.rect);
  });
  return placed;
}
function planBlend(items, page, measure, style, zones, slots = [], panelPadding, casts, busy) {
  const baseFont = blendFontSize(page);
  const margin = Math.round(page.width * 0.02);
  const forceVertical = style === "blend-vertical";
  const subtitle = style === "blend-subtitle";
  const capped = items.slice(0, PANEL_DIALOGUE_MAX$1).filter((item) => item.text.trim());
  if (slots.length && !subtitle) {
    const pad = Math.max(3, Math.round(page.width * (panelPadding ?? 0.012)));
    const groups = assignDialogueToSlots(capped, slots, casts);
    const out = capped.map(() => null);
    const placedAll = [];
    slots.forEach((slot, si) => {
      const inner = innerOf(slot, page, pad);
      const placedHere = [];
      const fontSize = Math.max(11, Math.min(baseFont, Math.round(Math.min(inner.width, inner.height) * 0.09)));
      capped.forEach((item, idx) => {
        if (groups[idx] !== si) return;
        if (typeof item.x === "number" && typeof item.y === "number") return;
        const vertical = forceVertical || item.dir === "v";
        let rect;
        if (vertical) {
          const { cols, width, height } = layoutBlendV(item.text, inner.height * 0.85, fontSize);
          rect = { x: 0, y: 0, width, height, lines: cols, vertical: true };
        } else {
          const { lines, width, height } = layoutBlendH(item.text, inner.width * 0.9, fontSize, measure);
          if (!lines.length) return;
          rect = { x: 0, y: 0, width, height, lines };
        }
        if (rect.width > inner.width || rect.height > inner.height * 0.9) return;
        let point = { x: inner.x, y: inner.y };
        let score = Infinity;
        for (const candidate of candidatesInSlot(rect, inner, placedHere)) {
          const s = scoreInSlot(rect, candidate, inner, slot, item, page, placedAll, zones, busy);
          if (s < score) {
            score = s;
            point = candidate;
          }
        }
        rect.x = point.x;
        rect.y = point.y;
        rect.fontSize = fontSize;
        rect.itemIndex = idx;
        placedHere.push(rect);
        placedAll.push(rect);
        out[idx] = rect;
      });
    });
    const pinned = capped.filter((item) => typeof item.x === "number" && typeof item.y === "number");
    if (pinned.length) {
      const manual = [];
      for (const item of pinned) {
        const vertical = forceVertical || item.dir === "v";
        let rect;
        if (vertical) {
          const { cols, width, height } = layoutBlendV(item.text, page.height * 0.42, baseFont);
          rect = { x: 0, y: 0, width, height, lines: cols, vertical: true };
        } else {
          const { lines, width, height } = layoutBlendH(item.text, page.width * 0.42, baseFont, measure);
          if (!lines.length) continue;
          rect = { x: 0, y: 0, width, height, lines };
        }
        rect.x = Math.min(Math.max(margin, item.x * page.width - rect.width / 2), page.width - rect.width - margin);
        rect.y = Math.min(Math.max(margin, item.y * page.height - rect.height / 2), page.height - rect.height - margin);
        manual.push(rect);
      }
      let j = 0;
      capped.forEach((item, idx) => {
        if (typeof item.x === "number" && typeof item.y === "number") out[idx] = manual[j++] ?? null;
      });
    }
    return out.filter((r) => !!r);
  }
  const maxW = page.width * (subtitle ? 0.86 : 0.42);
  const maxH = page.height * 0.42;
  const placed = [];
  items.slice(0, PANEL_DIALOGUE_MAX$1).forEach((item, index2) => {
    if (!item.text.trim()) return;
    const vertical = forceVertical || !subtitle && item.dir === "v";
    let rect;
    if (vertical) {
      const { cols, width, height } = layoutBlendV(item.text, maxH, baseFont);
      rect = { x: 0, y: 0, width, height, lines: cols, vertical: true };
    } else {
      const { lines, width, height } = layoutBlendH(item.text, maxW, baseFont, measure);
      if (!lines.length) return;
      rect = { x: 0, y: 0, width, height, lines };
    }
    if (subtitle) {
      rect.x = Math.min(Math.max(margin, page.width * 0.5 - rect.width / 2), page.width - rect.width - margin);
      rect.y = page.height - rect.height - Math.max(margin, Math.round(page.height * 0.04));
      for (let guard = 0; guard < 8; guard += 1) {
        const hit = placed.find((o) => overlapArea(rect, o) > 0);
        if (!hit) break;
        rect.y = Math.max(margin, hit.y - rect.height - baseFont * 0.25);
      }
      placed.push(rect);
      return;
    }
    placeRect(rect, item, index2, page, margin, zones, placed, false, busy);
  });
  return placed;
}
function perColOf(cols) {
  return Math.max(0, ...cols.map((c) => [...c].length));
}
function roundRectPath(ctx, rect, radius) {
  const { x, y, width, height } = rect;
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}
function drawHeart(ctx, x, y, size, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.beginPath();
  ctx.moveTo(0, 9);
  ctx.bezierCurveTo(-11, -3, -5, -12, 0, -5);
  ctx.bezierCurveTo(5, -12, 11, -3, 0, 9);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}
function drawBubbles(image, items, opts = {}) {
  var _a;
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!width || !height) return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, width, height);
  const style = normalizeBubbleStyle(opts.style);
  const fontStack = BUBBLE_FONT_STACKS[normalizeBubbleFont(opts.font)];
  const busy = opts.busy ?? readBusyGrid(image) ?? void 0;
  const planOpts = busy ? { ...opts, busy } : opts;
  if (isBlendStyle(style)) {
    drawBlend(ctx, items, fontStack, width, height, style, planOpts);
    return canvas;
  }
  const fontSize = bubbleFontSize({ width, height });
  ctx.font = `400 ${fontSize}px ${fontStack}`;
  const bubbles = planBubbles(items, { width, height }, (s) => ctx.measureText(s).width, planOpts);
  const ink = boxInkFor(style);
  for (const bubble of bubbles) {
    const fs = bubble.fontSize ?? fontSize;
    const font = (w) => `${w} ${fs}px ${fontStack}`;
    const lineWidth = Math.max(2, Math.round(fs * 0.09));
    const tailSize = fs * 0.5;
    if (bubble.tail) {
      const baseY = bubble.tail === "down" ? bubble.y + bubble.height : bubble.y;
      const tipY = bubble.tail === "down" ? baseY + tailSize : baseY - tailSize;
      const towardCenter = bubble.x + bubble.width / 2 < width / 2 ? 0.72 : 0.28;
      const baseX = typeof bubble.tailX === "number" ? bubble.tailX : bubble.x + bubble.width * towardCenter;
      const inner = lineWidth / 2;
      ctx.beginPath();
      ctx.moveTo(baseX - tailSize * 0.5, baseY - Math.sign(baseY - tipY) * inner);
      ctx.lineTo(baseX, tipY);
      ctx.lineTo(baseX + tailSize * 0.5, baseY - Math.sign(baseY - tipY) * inner);
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#1a1a1a";
      ctx.lineWidth = lineWidth;
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.fill();
      roundRectPath(ctx, bubble, fs * 0.45);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.strokeStyle = "#1a1a1a";
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(baseX - tailSize * 0.5, bubble.tail === "down" ? bubble.y + bubble.height - lineWidth : bubble.y, tailSize, lineWidth + 1);
    } else {
      roundRectPath(ctx, bubble, fs * 0.35);
      ctx.fillStyle = "rgba(18,16,15,0.82)";
      ctx.fill();
      ctx.strokeStyle = "#e8e4dc";
      ctx.lineWidth = Math.max(1.5, fs * 0.06);
      ctx.stroke();
    }
    ctx.fillStyle = ink.color;
    ctx.font = font("400");
    if (ink.glow) {
      ctx.shadowColor = ink.glow;
      ctx.shadowBlur = fs * 0.7;
    }
    ctx.textBaseline = "top";
    if (bubble.vertical) {
      const step = fs * 1.15;
      const colSpacing = fs * 0.26;
      const colX = (ci) => bubble.x + bubble.width - fs * 0.7 - (ci + 1) * fs - ci * colSpacing;
      const totalH = Math.min(perColOf(bubble.lines), ((_a = bubble.lines[0]) == null ? void 0 : _a.length) ?? 0) * step;
      bubble.lines.forEach((col, ci) => [...col].forEach((ch, ri) => ctx.fillText(ch, colX(ci), bubble.y + (bubble.height - totalH) / 2 + ri * step)));
    } else {
      const textHeight = bubble.lines.length * fs * 1.4;
      let cursorY = bubble.y + (bubble.height - textHeight) / 2 + fs * 0.08;
      for (const line of bubble.lines) {
        ctx.fillText(line, bubble.x + fs * 0.7, cursorY);
        cursorY += fs * 1.4;
      }
    }
    ctx.shadowBlur = 0;
  }
  return canvas;
}
function drawBlend(ctx, items, fontStack, width, height, style, opts = {}) {
  const baseFont = blendFontSize({ width, height });
  ctx.textBaseline = "top";
  ctx.font = `400 ${baseFont}px ${fontStack}`;
  ctx.lineJoin = "round";
  const measure = (s) => ctx.measureText(s).width;
  const rects = planBubbles(items, { width, height }, measure, { ...opts, style });
  const capped = items.slice(0, PANEL_DIALOGUE_MAX$1).filter((i) => i.text.trim());
  const needsSampling = style === "blend" || style === "blend-vertical";
  rects.forEach((rect, index2) => {
    const item = capped[typeof rect.itemIndex === "number" ? rect.itemIndex : index2];
    if (!item) return;
    const fontSize = rect.fontSize ?? baseFont;
    const spacing = style === "blend-subtitle" ? fontSize * 0.1 : blendSpacing(fontSize);
    ctx.font = `400 ${fontSize}px ${fontStack}`;
    let avg = { r: 246, g: 238, b: 236 };
    if (needsSampling) {
      try {
        const sx = Math.max(0, Math.floor(rect.x - 8));
        const sy = Math.max(0, Math.floor(rect.y - 8));
        const sw = Math.min(width - sx, Math.ceil(rect.width + 16));
        const sh = Math.min(height - sy, Math.ceil(rect.height + 16));
        if (sw > 0 && sh > 0) {
          const data = ctx.getImageData(sx, sy, sw, sh).data;
          let r = 0, g = 0, b = 0, n = 0;
          for (let i = 0; i < data.length; i += 16) {
            if (data[i + 3] < 8) continue;
            r += data[i];
            g += data[i + 1];
            b += data[i + 2];
            n += 1;
          }
          if (n > 0) avg = { r: r / n, g: g / n, b: b / n };
        }
      } catch {
      }
    }
    const ink = blendInkFor(style, avg);
    if (ink.band) {
      const padX = fontSize * 0.5;
      const padY = fontSize * 0.3;
      roundRectPath(ctx, { x: rect.x - padX, y: rect.y - padY, width: rect.width + padX * 2, height: rect.height + padY * 2 }, fontSize * 0.28);
      ctx.fillStyle = ink.band;
      ctx.fill();
    }
    ctx.fillStyle = ink.color;
    if (ink.halo) {
      ctx.strokeStyle = ink.halo;
      ctx.lineWidth = Math.max(1.5, fontSize * 0.08);
    }
    if (ink.glow) {
      ctx.shadowColor = ink.glow;
      ctx.shadowBlur = fontSize * 0.6;
    }
    const drawChar = (ch, x, y) => {
      if (ink.halo) ctx.strokeText(ch, x, y);
      ctx.fillText(ch, x, y);
    };
    if (rect.vertical) {
      const step = fontSize * 1.15;
      rect.lines.forEach((col, ci) => {
        const colX = rect.x + rect.width - (ci + 1) * fontSize - ci * spacing;
        [...col].forEach((ch, ri) => drawChar(ch, colX, rect.y + ri * step));
      });
      ctx.shadowBlur = 0;
      if (item.mood === "whisper" && style !== "blend-subtitle") {
        const hx = Math.max(4, Math.min(width - fontSize * 3, rect.x + rect.width / 2));
        const hy = Math.min(height - fontSize * 2, rect.y + rect.height + fontSize * 0.4);
        drawHeart(ctx, hx, hy, fontSize * 0.9, "#D47F8E");
        drawHeart(ctx, hx + fontSize * 1.3, hy + fontSize * 0.4, fontSize * 0.6, "#D47F8E");
      }
    } else {
      let cursorY = rect.y + fontSize * 0.15;
      for (const line of rect.lines) {
        let x = rect.x;
        for (const ch of [...line]) {
          drawChar(ch, x, cursorY);
          x += measure(ch) + spacing;
        }
        cursorY += fontSize * 1.35;
      }
      ctx.shadowBlur = 0;
      if (item.mood === "whisper" && style !== "blend-subtitle") {
        const hx = Math.min(width - fontSize * 3, rect.x + rect.width + spacing * 0.6);
        const hy = Math.max(4, Math.min(height - fontSize * 2, rect.y + rect.height - fontSize * 0.2));
        drawHeart(ctx, hx, hy, fontSize * 0.9, "#D47F8E");
        drawHeart(ctx, hx + fontSize * 1.3, hy + fontSize * 0.4, fontSize * 0.6, "#D47F8E");
      }
    }
  });
}
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片加载失败"));
    img.src = src;
  });
}
async function fetchBytes(src) {
  try {
    const response2 = await fetch(src, { mode: "cors" });
    if (response2.ok) return await response2.blob();
  } catch {
  }
  const aliased = `/${src.replace(/^\/+/, "")}`;
  const response = await fetch(aliased, { mode: "cors" });
  if (!response.ok) throw new Error(`fetch 失败: ${response.status}`);
  return await response.blob();
}
async function loadDrawableImage(src) {
  if (/^(blob|data):/i.test(src)) {
    return { image: await loadImage(src), cleanup: () => {
    } };
  }
  const blob = await fetchBytes(src);
  const url = URL.createObjectURL(blob);
  try {
    return { image: await loadImage(url), cleanup: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}
async function compositeDialogue(imageUrl, items, opts = {}) {
  try {
    if (!items.length) return null;
    const { image, cleanup } = await loadDrawableImage(imageUrl);
    try {
      const canvas = drawBubbles(image, items, opts);
      if (!canvas) return null;
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) return null;
      const url = URL.createObjectURL(blob);
      return { url, filename: "dialogue.png", revoke: () => URL.revokeObjectURL(url) };
    } finally {
      cleanup();
    }
  } catch {
    return null;
  }
}
function artifactLayoutOf(artifact) {
  var _a;
  const v = (_a = artifact.metadata) == null ? void 0 : _a.layout;
  return v === "irregular" || v === "inset" || v === "unframed" ? v : "regular";
}
function artifactPageTypeOf(artifact) {
  var _a;
  const v = (_a = artifact.metadata) == null ? void 0 : _a.pageType;
  return v === "a" || v === "b" || v === "c" || v === "d" ? v : "auto";
}
function artifactPanelCountOf(artifact) {
  var _a;
  const v = (_a = artifact.metadata) == null ? void 0 : _a.panelCount;
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
}
function clamp01$1(v) {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(Math.min(1, Math.max(0, v)) * 1e4) / 1e4 : void 0;
}
function comicBaseImageOf(artifact) {
  var _a;
  const raw = (_a = artifact.metadata) == null ? void 0 : _a.rawImagePath;
  if (typeof raw === "string" && raw.trim() && raw !== artifact.imagePath) return raw;
  return artifact.imagePath;
}
function comicOverlayPlan(artifact, settings2) {
  const items = (artifact.dialogue ?? []).filter((item) => item && typeof item.text === "string" && item.text.trim()).map((item) => {
    const { x: rawX, y: rawY, ...rest } = item;
    const x = clamp01$1(rawX);
    const y = clamp01$1(rawY);
    return {
      ...rest,
      text: item.text.trim(),
      ...x !== void 0 && y !== void 0 ? { x, y } : {}
    };
  });
  if (!items.length) return null;
  const comic = resolveModeSettings(settings2, "comic");
  const style = comic.comicBubbleStyle ?? settings2.bubbleStyle;
  const font = comic.comicBubbleFont ?? settings2.bubbleFont;
  const layout = artifactLayoutOf(artifact);
  const pageType = artifactPageTypeOf(artifact);
  const panelCount = artifactPanelCountOf(artifact);
  const slots = panelSlots(layout, panelCount, pageType);
  const noGo = layoutNoGoZones(layout, pageType);
  const meta = artifact.metadata ?? {};
  const panelCast = Array.isArray(meta.panelCast) ? meta.panelCast.map(
    (cast) => (Array.isArray(cast) ? cast : []).map((name) => String(name ?? "")).filter(Boolean)
  ) : void 0;
  const opts = {
    style,
    font,
    ...slots.length ? { panels: slots } : {},
    ...noGo.length ? { avoid: noGo } : {},
    ...panelCast && panelCast.length ? { panelCast } : {}
  };
  return { items, opts, style, font };
}
function normalizeDialogueEdits(value) {
  if (!Array.isArray(value)) return void 0;
  const out = [];
  for (const raw of value.slice(0, 4)) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw;
    const text = typeof rec.text === "string" ? rec.text.trim().slice(0, 60) : "";
    if (!text) continue;
    const item = { text };
    if (typeof rec.speaker === "string" && rec.speaker.trim()) item.speaker = rec.speaker.trim().slice(0, 16);
    if (typeof rec.area === "string" && ["tl", "tc", "tr", "ml", "mr", "bl", "bc", "br"].includes(rec.area)) {
      item.area = rec.area;
    }
    if (rec.dir === "v") item.dir = "v";
    if (rec.mood === "shout" || rec.mood === "whisper") item.mood = rec.mood;
    if (typeof rec.panel === "number" && Number.isFinite(rec.panel) && rec.panel >= 1) {
      item.panel = Math.round(rec.panel);
    }
    const x = clamp01$1(rec.x);
    const y = clamp01$1(rec.y);
    if (x !== void 0 && y !== void 0) {
      item.x = x;
      item.y = y;
    }
    out.push(item);
  }
  return out.length ? out : void 0;
}
async function saveImageFile(src, filename) {
  try {
    const { image, cleanup } = await loadDrawableImage(src);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return false;
      ctx.drawImage(image, 0, 0);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) return false;
      const url = URL.createObjectURL(blob);
      try {
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        return true;
      } finally {
        URL.revokeObjectURL(url);
      }
    } finally {
      cleanup();
    }
  } catch {
    return false;
  }
}
let overlay = null;
function openLightbox(imageUrl, caption) {
  ensureOverlay();
  if (!overlay) return;
  overlay.innerHTML = "";
  overlay.classList.remove("is-comic");
  const img = document.createElement("img");
  img.className = "sti-lightbox-img";
  img.src = imageUrl;
  img.alt = caption ?? "图片";
  overlay.appendChild(img);
  const close2 = document.createElement("button");
  close2.className = "sti-lightbox-close";
  close2.textContent = "×";
  close2.setAttribute("aria-label", "关闭");
  close2.addEventListener("click", closeLightbox);
  overlay.appendChild(close2);
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
function openComicLightbox(ctx) {
  if (!ctx.plan.items.length) {
    openLightbox(ctx.baseSrc);
    return;
  }
  ensureOverlay();
  if (!overlay) return;
  overlay.innerHTML = "";
  overlay.classList.add("is-comic");
  const state2 = {
    ctx,
    showBubbles: true,
    editing: false,
    moving: false,
    moveIndex: 0,
    draft: ctx.plan.items.map((item) => ({ ...item })),
    imgToken: 0,
    saveToken: 0,
    current: null
  };
  const bar = document.createElement("div");
  bar.className = "sti-lb-bar";
  bar.addEventListener("click", (e) => e.stopPropagation());
  overlay.appendChild(bar);
  const downloadBtn = iconButton("download", "下载当前版本（带字 / 无字跟随开关）");
  downloadBtn.addEventListener("click", () => {
    void saveImageFile(
      state2.showBubbles && state2.current ? state2.current.url : ctx.baseSrc,
      `comic_${Date.now().toString(36)}.png`
    );
  });
  bar.appendChild(downloadBtn);
  if (ctx.onEditPrompt) {
    const promptBtn = iconButton("prompt", "改提示词并重画这一页");
    promptBtn.addEventListener("click", () => {
      var _a;
      return (_a = ctx.onEditPrompt) == null ? void 0 : _a.call(ctx);
    });
    bar.appendChild(promptBtn);
  }
  const bubbleBtn = iconButton("bubble", "带字 / 无字切换（合成失败自动退回无字原图）");
  bubbleBtn.classList.add("is-on");
  bubbleBtn.addEventListener("click", () => {
    state2.showBubbles = !state2.showBubbles;
    bubbleBtn.classList.toggle("is-on", state2.showBubbles);
    syncMoveTools();
    refreshImage(state2, img);
  });
  bar.appendChild(bubbleBtn);
  const editBtn = iconButton("edit", "编辑台词：增删改后保存，立即重合成（不消耗出图额度）");
  editBtn.addEventListener("click", () => {
    state2.editing = !state2.editing;
    if (state2.editing) state2.moving = false;
    editBtn.classList.toggle("is-on", state2.editing);
    syncMoveTools();
    renderBottom();
    renderPanel2();
  });
  bar.appendChild(editBtn);
  const moveBtn = iconButton("move", "选中一句台词，再点击图上位置把它钉在那里（不被自动排版挪动）");
  moveBtn.addEventListener("click", () => {
    state2.moving = !state2.moving;
    if (state2.moving) state2.editing = false;
    moveBtn.classList.toggle("is-on", state2.moving);
    editBtn.classList.toggle("is-on", state2.editing);
    syncMoveTools();
    renderBottom();
    renderPanel2();
  });
  bar.appendChild(moveBtn);
  const close2 = iconButton("close", "关闭 (Esc)");
  close2.addEventListener("click", closeLightbox);
  bar.appendChild(close2);
  function syncMoveTools() {
    const disabled = !state2.showBubbles;
    editBtn.disabled = disabled;
    moveBtn.disabled = disabled;
    if (disabled) {
      state2.moving = false;
      state2.editing = false;
    }
  }
  const stage = document.createElement("div");
  stage.className = "sti-lb-stage";
  overlay.appendChild(stage);
  const img = document.createElement("img");
  img.className = "sti-lightbox-img";
  img.alt = "漫画页";
  stage.appendChild(img);
  stage.addEventListener("click", (event) => {
    if (!state2.moving) return;
    event.stopPropagation();
    const rect = img.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = Math.round(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * 1e4) / 1e4;
    const y = Math.round(Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) * 1e4) / 1e4;
    const item = state2.draft[state2.moveIndex];
    if (!item) return;
    item.x = x;
    item.y = y;
    void persist(state2, img);
    renderBottom();
  });
  const bottom = document.createElement("div");
  bottom.className = "sti-lb-bottom";
  bottom.addEventListener("click", (e) => e.stopPropagation());
  overlay.appendChild(bottom);
  const panel = document.createElement("div");
  panel.className = "sti-lb-dlg";
  panel.addEventListener("click", (e) => e.stopPropagation());
  overlay.appendChild(panel);
  function renderBottom() {
    bottom.innerHTML = "";
    bottom.style.display = state2.moving && !state2.editing ? "flex" : "none";
    if (bottom.style.display === "none") return;
    const hint = document.createElement("span");
    hint.className = "sti-lb-hint";
    hint.textContent = "点击台词选中，再点图上位置钉住：";
    bottom.appendChild(hint);
    state2.draft.forEach((item, index2) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "sti-lb-chip" + (index2 === state2.moveIndex ? " is-on" : "") + (typeof item.x === "number" ? " is-done" : "");
      chip.textContent = truncate(item.text, 12);
      chip.addEventListener("click", (event) => {
        event.stopPropagation();
        state2.moveIndex = index2;
        renderBottom();
      });
      bottom.appendChild(chip);
    });
  }
  function renderPanel2() {
    panel.innerHTML = "";
    panel.style.display = state2.editing ? "flex" : "none";
    if (!state2.editing) return;
    const head = document.createElement("div");
    head.className = "sti-lb-dlg__head";
    const name = document.createElement("div");
    name.className = "sti-lb-dlg__name";
    name.textContent = "台词（最多 4 条，每条 60 字内）";
    head.appendChild(name);
    const closePanel = document.createElement("button");
    closePanel.type = "button";
    closePanel.className = "sti-lb-dlg__x";
    closePanel.textContent = "×";
    closePanel.addEventListener("click", () => {
      state2.editing = false;
      editBtn.classList.remove("is-on");
      renderPanel2();
    });
    head.appendChild(closePanel);
    panel.appendChild(head);
    const list = document.createElement("div");
    list.className = "sti-lb-dlg__list";
    state2.draft.forEach((item, index2) => {
      const row = document.createElement("div");
      row.className = "sti-lb-dlg__row";
      const no = document.createElement("span");
      no.className = "sti-lb-dlg__no";
      no.textContent = String(index2 + 1);
      const text = document.createElement("input");
      text.type = "text";
      text.className = "sti-lb-dlg__text";
      text.value = item.text;
      text.maxLength = 60;
      text.addEventListener("input", () => {
        item.text = text.value;
      });
      const del = document.createElement("button");
      del.type = "button";
      del.className = "sti-lb-dlg__del";
      del.textContent = "−";
      del.title = "删除这一条";
      del.addEventListener("click", () => {
        state2.draft.splice(index2, 1);
        if (state2.moveIndex >= state2.draft.length) state2.moveIndex = Math.max(0, state2.draft.length - 1);
        renderPanel2();
      });
      row.append(no, text, del);
      list.appendChild(row);
    });
    panel.appendChild(list);
    const actions = document.createElement("div");
    actions.className = "sti-lb-dlg__actions";
    const add = document.createElement("button");
    add.type = "button";
    add.className = "sti-lb-dlg__btn";
    add.textContent = "加一条";
    add.disabled = state2.draft.length >= 4;
    add.addEventListener("click", () => {
      state2.draft.push({ text: "" });
      renderPanel2();
    });
    const save = document.createElement("button");
    save.type = "button";
    save.className = "sti-lb-dlg__btn sti-lb-dlg__btn--main";
    save.textContent = "保存并重合成";
    save.addEventListener("click", () => {
      void (async () => {
        await persist(state2, img);
        state2.editing = false;
        editBtn.classList.remove("is-on");
        renderPanel2();
      })();
    });
    actions.append(add, save);
    panel.appendChild(actions);
  }
  overlay.style.display = "flex";
  overlay.onclick = (e) => {
    if (e.target === overlay) closeLightbox();
  };
  syncMoveTools();
  renderBottom();
  renderPanel2();
  refreshImage(state2, img);
}
function iconButton(icon, title) {
  const paths = {
    download: '<path d="M12 4v11m0 0 4.5-4.5M12 15l-4.5-4.5M5 19h14"/>',
    bubble: '<path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-4 4V6z"/>',
    edit: '<path d="M4 20h4L20 8l-4-4L4 16v4zM14 6l4 4"/>',
    prompt: '<path d="M4 6h16M4 12h10M4 18h7"/><path d="M18 12l2 2-5 5h-2v-2l5-5z"/>',
    move: '<path d="M12 3v18M3 12h18M12 3l-2.5 2.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>'
  };
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "sti-lb-btn";
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[icon]}</svg>`;
  return btn;
}
async function persist(state2, img) {
  const token = ++state2.saveToken;
  refreshImage(state2, img);
  const draft = normalizeDialogueEdits(state2.draft);
  const saved = await state2.ctx.onSave(draft);
  if (token !== state2.saveToken) return;
  if (!saved) return;
  state2.ctx.plan = { items: state2.ctx.plan.items, opts: saved.opts };
}
function refreshImage(state2, img) {
  var _a;
  const token = ++state2.imgToken;
  if (!state2.showBubbles) {
    (_a = state2.current) == null ? void 0 : _a.revoke();
    state2.current = null;
    img.src = state2.ctx.baseSrc;
    return;
  }
  if (!state2.current) img.src = state2.ctx.baseSrc;
  void (async () => {
    var _a2;
    const result = await compositeDialogue(state2.ctx.baseSrc, state2.draft, state2.ctx.plan.opts);
    if (token !== state2.imgToken) {
      result == null ? void 0 : result.revoke();
      return;
    }
    if (!result) return;
    (_a2 = state2.current) == null ? void 0 : _a2.revoke();
    state2.current = result;
    img.src = result.url;
  })();
}
function truncate(text, max) {
  const clean = text.trim() || "（空）";
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
let gallery = null;
let galleryItems = [];
let galleryIndex = 0;
function openGallery(items, startIndex = 0) {
  if (items.length === 0) return;
  galleryItems = items;
  galleryIndex = Math.min(Math.max(startIndex, 0), items.length - 1);
  ensureGallery();
  renderGallery();
  if (gallery) gallery.style.display = "flex";
}
function ensureGallery() {
  if (gallery) return;
  const el2 = document.createElement("div");
  el2.id = "sti-gallery";
  el2.className = "sti-lightbox sti-gallery";
  el2.style.display = "none";
  el2.addEventListener("click", (e) => {
    if (e.target === el2) closeGallery();
  });
  const prev = document.createElement("button");
  prev.type = "button";
  prev.className = "sti-gallery-nav prev";
  prev.textContent = "‹";
  prev.addEventListener("click", (e) => {
    e.stopPropagation();
    stepGallery(-1);
  });
  el2.appendChild(prev);
  const stage = document.createElement("div");
  stage.className = "sti-gallery-stage";
  el2.appendChild(stage);
  const next = document.createElement("button");
  next.type = "button";
  next.className = "sti-gallery-nav next";
  next.textContent = "›";
  next.addEventListener("click", (e) => {
    e.stopPropagation();
    stepGallery(1);
  });
  el2.appendChild(next);
  const close2 = document.createElement("button");
  close2.className = "sti-lightbox-close";
  close2.textContent = "×";
  close2.setAttribute("aria-label", "关闭");
  close2.addEventListener("click", closeGallery);
  el2.appendChild(close2);
  document.body.appendChild(el2);
  gallery = el2;
  el2.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") stepGallery(-1);
    if (e.key === "ArrowRight") stepGallery(1);
    if (e.key === "Escape") closeGallery();
  });
  el2.tabIndex = 0;
}
function renderGallery() {
  if (!gallery) return;
  const stage = gallery.querySelector(".sti-gallery-stage");
  if (!stage) return;
  stage.innerHTML = "";
  const item = galleryItems[galleryIndex];
  if (!item) return;
  const img = document.createElement("img");
  img.className = "sti-lightbox-img";
  img.src = item.src;
  img.alt = item.caption ?? "图片";
  stage.appendChild(img);
  const cap = document.createElement("div");
  cap.className = "sti-lightbox-caption";
  cap.textContent = `${galleryIndex + 1}/${galleryItems.length}${item.caption ? " · " + item.caption : ""}`;
  stage.appendChild(cap);
  const single = galleryItems.length <= 1;
  gallery.querySelectorAll(".sti-gallery-nav").forEach((n) => {
    n.style.display = single ? "none" : "";
  });
}
function stepGallery(delta) {
  if (galleryItems.length === 0) return;
  galleryIndex = (galleryIndex + delta + galleryItems.length) % galleryItems.length;
  renderGallery();
}
function closeGallery() {
  if (gallery) gallery.style.display = "none";
}
function destroyLightbox() {
  if (overlay) {
    overlay.remove();
    overlay = null;
  }
  if (gallery) {
    gallery.remove();
    gallery = null;
  }
  galleryItems = [];
}
let mask = null;
function ensureMask() {
  if (mask) return mask;
  const el2 = document.createElement("div");
  el2.className = "sti-dlg-mask";
  el2.style.display = "none";
  document.body.appendChild(el2);
  mask = el2;
  return el2;
}
function openPromptDialog(options) {
  const host = ensureMask();
  host.innerHTML = "";
  host.style.display = "flex";
  host.onclick = (event) => {
    if (event.target === host) close();
  };
  const panel = document.createElement("div");
  panel.className = "sti-prompt-dlg";
  panel.addEventListener("click", (event) => event.stopPropagation());
  host.appendChild(panel);
  const head = document.createElement("div");
  head.className = "sti-prompt-dlg__head";
  const title = document.createElement("div");
  title.className = "sti-prompt-dlg__title";
  title.textContent = "改提示词并重画";
  head.appendChild(title);
  if (options.subtitle) {
    const sub = document.createElement("div");
    sub.className = "sti-prompt-dlg__sub";
    sub.textContent = options.subtitle;
    head.appendChild(sub);
  }
  const x = document.createElement("button");
  x.type = "button";
  x.className = "sti-prompt-dlg__x";
  x.textContent = "×";
  x.setAttribute("aria-label", "关闭");
  x.addEventListener("click", close);
  head.appendChild(x);
  panel.appendChild(head);
  const body = document.createElement("div");
  body.className = "sti-prompt-dlg__body";
  panel.appendChild(body);
  const promptLabel = document.createElement("label");
  promptLabel.className = "sti-prompt-dlg__label";
  promptLabel.textContent = "正向提示词（Base：人数 / 场景 / 构图 / 光线）";
  const promptArea = document.createElement("textarea");
  promptArea.className = "sti-prompt-dlg__area";
  promptArea.value = options.prompt;
  promptArea.spellcheck = false;
  promptArea.rows = 8;
  body.append(promptLabel, promptArea);
  const nlLabel = document.createElement("label");
  nlLabel.className = "sti-prompt-dlg__label";
  nlLabel.textContent = "自然语言画面描述（nl，可留空）";
  const nlArea = document.createElement("textarea");
  nlArea.className = "sti-prompt-dlg__area is-nl";
  nlArea.value = options.nl;
  nlArea.spellcheck = false;
  nlArea.rows = 4;
  body.append(nlLabel, nlArea);
  const charAreas = [];
  const characters = (options.characters ?? []).filter((c) => String(c.name ?? "").trim());
  if (characters.length) {
    const cap = document.createElement("div");
    cap.className = "sti-prompt-dlg__label";
    cap.textContent = "角色词（每个人自己的 prompts，NAI 用它们锁定本人外貌与动作）";
    body.appendChild(cap);
    for (const character of characters) {
      const box = document.createElement("div");
      box.className = "sti-prompt-dlg__char";
      const head2 = document.createElement("div");
      head2.className = "sti-prompt-dlg__char-name";
      head2.textContent = character.name;
      const area = document.createElement("textarea");
      area.className = "sti-prompt-dlg__area is-char";
      area.value = character.tag ?? "";
      area.spellcheck = false;
      area.rows = 3;
      const nl = document.createElement("textarea");
      nl.className = "sti-prompt-dlg__area is-nl is-char-nl";
      nl.value = String(character.nl ?? "");
      nl.spellcheck = false;
      nl.rows = 2;
      nl.placeholder = "这个角色的外观句（nl，可留空；仅 NAI 4.5/V5 生效）";
      box.append(head2, area, nl);
      body.appendChild(box);
      charAreas.push({ name: character.name, area, nlArea: nl });
    }
  }
  const hint = document.createElement("p");
  hint.className = "sti-prompt-dlg__hint";
  hint.textContent = characters.length ? "改完点保存会立刻用新词重画这一页，台词气泡按当前台词重新合成。角色词留空等于把这个人从画面里去掉。" : "角色块（<characters>）不受影响；保存后立刻用新词重画这一页，台词气泡会按当前台词重新合成。";
  body.appendChild(hint);
  const foot = document.createElement("div");
  foot.className = "sti-prompt-dlg__foot";
  const status = document.createElement("span");
  status.className = "sti-prompt-dlg__status";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "sti-prompt-dlg__btn";
  cancel.textContent = "取消";
  cancel.addEventListener("click", close);
  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "sti-prompt-dlg__btn sti-prompt-dlg__btn--main";
  apply.textContent = "保存并重画";
  foot.append(status, cancel, apply);
  panel.appendChild(foot);
  let busy = false;
  apply.addEventListener("click", () => {
    if (busy) return;
    const prompt = promptArea.value.trim();
    if (!prompt) {
      status.textContent = "正向提示词不能为空。";
      promptArea.focus();
      return;
    }
    busy = true;
    status.textContent = "";
    apply.disabled = true;
    cancel.disabled = true;
    apply.textContent = "重画中…";
    void (async () => {
      try {
        const editedCharacters = charAreas.map((entry) => ({
          name: entry.name,
          tag: entry.area.value.replace(/\s+/g, " ").trim(),
          ...entry.nlArea.value.trim() ? { nl: entry.nlArea.value.replace(/\s+/g, " ").trim() } : {}
        })).filter((entry) => entry.tag);
        const result = await options.onApply(prompt, nlArea.value.trim(), editedCharacters);
        if (result.ok) {
          close();
          return;
        }
        status.textContent = result.message ?? "重画失败。";
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : String(err);
      } finally {
        busy = false;
        apply.disabled = false;
        cancel.disabled = false;
        apply.textContent = "保存并重画";
      }
    })();
  });
  promptArea.focus();
}
function close() {
  if (!mask) return;
  mask.style.display = "none";
  mask.innerHTML = "";
}
function destroyPromptDialog() {
  if (mask) {
    mask.remove();
    mask = null;
  }
}
const SETTINGS_KEY = "baibai_image";
function str(v) {
  return typeof v === "string" ? v.trim() : "";
}
function parsePromptSet(raw) {
  const settings2 = raw && typeof raw === "object" ? raw : {};
  const autoTag = settings2.autoTag && typeof settings2.autoTag === "object" ? settings2.autoTag : {};
  const prompts = autoTag.prompts && typeof autoTag.prompts === "object" ? autoTag.prompts : {};
  return {
    jailbreak: str(prompts.jailbreak),
    spec: str(prompts.naiV5Spec) || str(prompts.naiSpec),
    thinking: str(prompts.naiV5Thinking) || str(prompts.naiThinking)
  };
}
function expandNlSections(text, nl) {
  return String(text ?? "").replace(
    /\{\{([#^])nl\}\}([\s\S]*?)\{\{\/nl\}\}/g,
    (_match, kind, body) => kind === "#" === nl ? body : ""
  );
}
const CONTRACT_PRIORITY = "【本任务的输出信封】\n上面的规范管的是**画什么、怎么写词**：人物与服装怎么取证、什么算自创、连续场景怎么保持同一套衣服、Base 与每个角色块怎么分工。这些规则全部有效。\n信封（要不要 position / images / changes，有没有 negative、size 怎么给）以【任务协议】为准；**但「Base 只写全局内容、单个角色的外貌服装表情动作只写进该角色自己那一块」这条分工不受影响**。\n不要把整段 JSON 塞进 tag，也不要输出协议里没有的字段。";
function buildSpecHead(set, options) {
  const parts = [];
  if (set.jailbreak) parts.push(expandNlSections(set.jailbreak, options.nl));
  if (set.spec) parts.push(expandNlSections(set.spec, options.nl));
  return parts.map((p) => p.trim()).filter(Boolean).join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}
function buildThinking(set, options) {
  return set.thinking ? expandNlSections(set.thinking, options.nl).replace(/\n{3,}/g, "\n\n").trim() : "";
}
function buildSpecPreamble(set, options) {
  const body = buildSpecHead(set, options);
  if (!body) return "";
  return `${body}

${CONTRACT_PRIORITY}`;
}
function readPromptSet() {
  var _a;
  const ctx = getContext();
  return parsePromptSet((_a = ctx.extensionSettings) == null ? void 0 : _a[SETTINGS_KEY]);
}
function withSpecPreamble(system, nl) {
  const set = readPromptSet();
  const head = buildSpecPreamble(set, { nl });
  const thinking = buildThinking(set, { nl });
  const middle = head ? `${head}

------

${system}` : system;
  return thinking ? `${middle}

------

${thinking}` : middle;
}
const HOST_ID = "bbi-app-host";
const NAV_LABEL = "渠道";
const TAB_LABEL = "NAI";
function shadowRoot() {
  const host = document.getElementById(HOST_ID);
  return (host == null ? void 0 : host.shadowRoot) ?? null;
}
function panelWindow() {
  var _a;
  return ((_a = shadowRoot()) == null ? void 0 : _a.querySelector(".bbi-window")) ?? null;
}
function sleep$2(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitFor(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (; ; ) {
    const value = fn();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep$2(120);
  }
}
function openEntries() {
  return [
    () => {
      const menu = document.getElementById("bbi-menu-item");
      if (!menu) return false;
      menu.click();
      return true;
    },
    () => {
      const topbar = document.querySelector("#bbi-topbar-button .drawer-toggle");
      if (!topbar) return false;
      topbar.click();
      return true;
    },
    () => {
      var _a;
      const orb = (_a = shadowRoot()) == null ? void 0 : _a.querySelector(".bbi-orb");
      if (!orb) return false;
      orb.click();
      return true;
    }
  ];
}
async function ensurePanelOpen(timeoutMs) {
  if (panelWindow()) return shadowRoot();
  const root = shadowRoot();
  if (!root) return null;
  const perEntry = Math.max(1200, Math.round(timeoutMs / 3));
  for (const click of openEntries()) {
    if (panelWindow()) return shadowRoot();
    if (!click()) continue;
    const opened = await waitFor(() => panelWindow() ? shadowRoot() : null, perEntry);
    if (opened) return opened;
  }
  return null;
}
function navLabelOf(btn) {
  var _a;
  const label = (_a = btn.querySelector(".bbi-nav-label")) == null ? void 0 : _a.textContent;
  return (btn.getAttribute("title") ?? btn.getAttribute("aria-label") ?? label ?? btn.textContent ?? "").replace(/\s+/g, " ").trim();
}
function pickNavButton(buttons, label) {
  const exact = buttons.filter((btn) => navLabelOf(btn) === label);
  return exact.length === 1 ? exact[0] : null;
}
function tabLabelOf(btn) {
  return (btn.textContent ?? "").replace(/\s+/g, " ").trim();
}
function pickTab(tabs, label) {
  const exact = tabs.filter((btn) => tabLabelOf(btn) === label);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const prefix = tabs.filter((btn) => tabLabelOf(btn).startsWith(label));
  return prefix.length === 1 ? prefix[0] : null;
}
function planNameOf(btn) {
  var _a;
  return (((_a = btn.querySelector(".item-name")) == null ? void 0 : _a.textContent) ?? btn.textContent ?? "").replace(/\s+/g, " ").trim();
}
function pickPlanRadio(radios, planName) {
  const exact = radios.filter((btn) => planNameOf(btn) === planName);
  if (exact.length === 1) return { radio: exact[0], ambiguous: false };
  if (exact.length > 1) return { radio: null, ambiguous: true };
  const fuzzy = planName ? radios.filter((btn) => planNameOf(btn).includes(planName)) : [];
  if (fuzzy.length === 1) return { radio: fuzzy[0], ambiguous: false };
  return { radio: null, ambiguous: fuzzy.length > 1 };
}
function isRadioChecked(radio) {
  return (radio == null ? void 0 : radio.getAttribute("aria-checked")) === "true";
}
function navButtons(root) {
  return Array.from(root.querySelectorAll("button.bbi-nav-item"));
}
function tabButtons(root) {
  return Array.from(
    root.querySelectorAll(
      'button[role="tab"], button.bbi-seg, button.bbi-tab, .bbi-segmented button'
    )
  );
}
function planRadios(root) {
  return Array.from(root.querySelectorAll('.plan-item button.item-main[role="radio"]'));
}
function probe(root) {
  if (!root) return { hasHost: false, open: false, navs: [], tabs: [], plans: [] };
  return {
    hasHost: true,
    open: !!panelWindow(),
    navs: navButtons(root).map(navLabelOf).filter(Boolean),
    tabs: tabButtons(root).map(tabLabelOf).filter(Boolean),
    plans: planRadios(root).map(planNameOf).filter(Boolean)
  };
}
function describe(root) {
  const p = probe(root);
  if (!p.hasHost) return "柏宝绘未加载（找不到 #bbi-app-host）";
  const parts = [
    `面板${p.open ? "已开" : "未开"}`,
    `导航[${p.navs.join("/") || "空"}]`,
    `页签[${p.tabs.join("/") || "空"}]`,
    `方案行 ${p.plans.length} 个`
  ];
  return parts.join(" · ");
}
async function gotoNai(root) {
  const nav = pickNavButton(navButtons(root), NAV_LABEL);
  const tabs = tabButtons(root);
  if (nav && !nav.classList.contains("is-active")) {
    nav.click();
    await waitFor(() => tabButtons(shadowRoot() ?? root).length ? true : null, 2500);
    return "pending";
  }
  if (!nav && tabs.length === 0) return "pending";
  let tab = pickTab(tabButtons(shadowRoot() ?? root), TAB_LABEL);
  if (!tab) {
    const all = tabButtons(shadowRoot() ?? root);
    if (all.length === 1) tab = all[0];
  }
  if (!tab) return "stuck";
  if (!tab.classList.contains("is-on")) {
    tab.click();
    await sleep$2(240);
    return "pending";
  }
  return "ready";
}
function closePanelIfWeOpened(weOpened) {
  if (!weOpened) return;
  const root = shadowRoot();
  if (!root) return;
  const close2 = Array.from(root.querySelectorAll("button.bbi-icon-btn")).find(
    (btn) => (btn.getAttribute("title") ?? "") === "关闭"
  );
  close2 == null ? void 0 : close2.click();
}
async function switchBaiBaiPlan(planId, options = {}) {
  const opts = typeof options === "number" ? { timeoutMs: options } : options;
  const timeoutMs = opts.timeoutMs ?? 15e3;
  const force = opts.force === true;
  const snap = readOutConfig();
  const target = snap.plans.find((p) => p.id === planId);
  if (!target) {
    return { ok: false, reason: "error", message: "方案不存在（可能已在柏宝绘里被删除）。" };
  }
  if (snap.backend !== "nai") {
    return {
      ok: false,
      reason: "wrong-backend",
      message: `柏宝绘当前出图渠道是「${snap.backend}」，不是 NAI；按模式分配方案只对 NAI 生效。请先在柏宝绘里把出图后端改成 NAI。`
    };
  }
  if (!force && snap.activePlanId === planId) {
    return { ok: true, reason: "already", message: `「${target.name}」已经是当前方案。` };
  }
  const weOpened = !panelWindow();
  let root = await ensurePanelOpen(5e3);
  if (!root) {
    return {
      ok: false,
      reason: "no-ui",
      message: `打不开柏宝绘面板，无法切换出图方案（${describe(shadowRoot())}）。请确认柏宝绘已启用。`
    };
  }
  const deadline = Date.now() + timeoutMs;
  let ambiguous = false;
  let radio = null;
  while (Date.now() < deadline) {
    root = panelWindow() ? shadowRoot() : await ensurePanelOpen(3e3);
    if (!root) break;
    const navState = await gotoNai(root);
    if (navState !== "ready") {
      if (navState === "stuck") await sleep$2(200);
      continue;
    }
    const picked = pickPlanRadio(planRadios(root), target.name);
    if (picked.radio) {
      radio = picked.radio;
      break;
    }
    if (picked.ambiguous) {
      ambiguous = true;
      break;
    }
    await sleep$2(200);
  }
  if (ambiguous) {
    closePanelIfWeOpened(weOpened);
    return {
      ok: false,
      reason: "ambiguous",
      message: `柏宝绘里有多个方案名含「${target.name}」，无法确定该点哪一个。请把方案名改成互不包含的写法。`
    };
  }
  if (!radio) {
    const scene = describe(shadowRoot());
    closePanelIfWeOpened(weOpened);
    return {
      ok: false,
      reason: "no-ui",
      message: `没能在柏宝绘「渠道 → NAI」里找到方案「${target.name}」（${scene}）。请确认它是"出图方案"里的一行，而不是接入点。`
    };
  }
  if (radio.hasAttribute("disabled")) {
    closePanelIfWeOpened(weOpened);
    return { ok: false, reason: "no-ui", message: `方案「${target.name}」被禁用，无法选中。` };
  }
  const wasChecked = isRadioChecked(radio);
  if (!wasChecked) {
    radio.click();
    let confirmed = await waitFor(() => {
      const now = pickPlanRadio(planRadios(shadowRoot() ?? root), target.name).radio;
      return isRadioChecked(now) ? true : null;
    }, 2500);
    if (!confirmed) {
      const row = radio.closest(".plan-item");
      row == null ? void 0 : row.click();
      confirmed = await waitFor(() => {
        const now = pickPlanRadio(planRadios(shadowRoot() ?? root), target.name).radio;
        return isRadioChecked(now) ? true : null;
      }, 2500);
    }
    if (!confirmed) {
      const now = describe(shadowRoot());
      closePanelIfWeOpened(weOpened);
      return {
        ok: false,
        reason: "no-ui",
        message: `已点击方案「${target.name}」，但柏宝绘没有真的切过去（${now}）。`
      };
    }
  }
  closePanelIfWeOpened(weOpened);
  const agreed = await waitFor(
    () => readOutConfig().activePlanId === planId ? true : null,
    1200
  );
  if (!agreed) {
    const after = readOutConfig();
    console.warn(
      `[配图] 方案已在面板上切到「${target.name}」，但设置副本仍显示「${after.activePlanName || "未知"}」，以其自身落盘延迟处理，不影响本次出图。（因此判断"现在用的是哪套"不能只看这份副本——收尾还原方案时一律走 force。）`
    );
  }
  if (wasChecked) {
    return force ? { ok: true, reason: "already", message: `面板上已经是「${target.name}」，无需再切。` } : { ok: true, reason: "switched", message: `已切到「${target.name}」。` };
  }
  return { ok: true, reason: "switched", message: `已切到「${target.name}」。` };
}
const ITEM = {
  id: "sti-menu-studio",
  label: "配图",
  title: "ST 故事插画 · 生成配图 / 配图设置 / 提示词 / 出图日志"
};
function buildItem() {
  const wrap = document.createElement("div");
  wrap.className = "extension_container interactable";
  wrap.tabIndex = 0;
  const link = document.createElement("a");
  link.id = ITEM.id;
  link.className = "list-group-item";
  link.href = "#";
  link.title = ITEM.title;
  const icon = document.createElement("i");
  icon.className = "fa-solid fa-wand-magic-sparkles";
  link.appendChild(icon);
  const text = document.createElement("span");
  text.textContent = " " + ITEM.label;
  link.appendChild(text);
  link.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openStudio("generate");
    const menu = document.getElementById("extensionsMenu");
    if (menu) {
      menu.style.display = "none";
      menu.classList.remove("visible");
    }
  });
  wrap.appendChild(link);
  return wrap;
}
function injectWandMenu() {
  let timer2 = 0;
  const tryInject = () => {
    const menu = document.getElementById("extensionsMenu");
    if (!menu) return;
    if (!document.getElementById(ITEM.id)) menu.appendChild(buildItem());
    if (document.getElementById(ITEM.id)) window.clearInterval(timer2);
  };
  tryInject();
  timer2 = window.setInterval(tryInject, 800);
  return () => window.clearInterval(timer2);
}
function destroyWandMenu() {
  var _a, _b, _c;
  (_b = (_a = document.getElementById(ITEM.id)) == null ? void 0 : _a.closest(".extension_container")) == null ? void 0 : _b.remove();
  (_c = document.getElementById(ITEM.id)) == null ? void 0 : _c.remove();
}
const MAX_ENTRIES = 80;
const MAX_TEXT = 4e3;
const entries = [];
let nextId = 1;
function clip$1(text) {
  const value = String(text ?? "");
  return value.length <= MAX_TEXT ? value : `${value.slice(0, MAX_TEXT)}…（原长 ${value.length}）`;
}
function push(record) {
  const entry = {
    ...record,
    prompt: clip$1(record.prompt),
    ...record.nl ? { nl: clip$1(record.nl) } : {},
    ...record.negative ? { negative: clip$1(record.negative) } : {},
    ...record.error ? { error: clip$1(record.error) } : {},
    id: nextId,
    at: Date.now()
  };
  nextId += 1;
  entries.unshift(entry);
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  return entry;
}
function recordImageLog(input) {
  return push({ kind: "image", ...input });
}
function recordLlmError(input) {
  return push({
    kind: "llm",
    mode: input.mode,
    floor: input.floor,
    prompt: input.prompt ?? "",
    status: "error",
    error: input.error
  });
}
function recordPlanSwitch(input) {
  return push({
    kind: "plan",
    mode: input.mode,
    floor: 0,
    prompt: input.detail ?? "",
    plan: input.plan,
    status: input.status
  });
}
function recordNotice(input) {
  return push({
    kind: "notice",
    mode: input.mode,
    floor: input.floor,
    prompt: input.text,
    status: "ok"
  });
}
function getImageLog() {
  return entries;
}
function clearImageLog() {
  entries.length = 0;
}
let el = null;
let labelEl = null;
let dotEl = null;
let timer = null;
let hideTimer = null;
let state = null;
let onOpenLog = null;
const STAGE_TEXT = {
  queued: "排队中",
  reading: "读剧情中",
  waiting: "等柏宝绘出图",
  review: "整理提示词",
  generating: "出图中",
  completed: "完成"
};
function ensure() {
  if (el && labelEl && dotEl && document.body.contains(el)) {
    return { root: el, label: labelEl, dot: dotEl };
  }
  const root = document.createElement("div");
  root.className = "sti-run";
  root.style.display = "none";
  root.setAttribute("role", "status");
  root.setAttribute("aria-live", "polite");
  const dot = document.createElement("span");
  dot.className = "sti-run-dot";
  root.appendChild(dot);
  const label = document.createElement("span");
  label.className = "sti-run-label";
  root.appendChild(label);
  root.addEventListener("click", () => {
    onOpenLog == null ? void 0 : onOpenLog();
  });
  document.body.appendChild(root);
  el = root;
  labelEl = label;
  dotEl = dot;
  return { root, label, dot };
}
function setRunStatusLogOpener(fn) {
  onOpenLog = fn;
}
function elapsedSecondsOf(snapshot) {
  const end = snapshot.endedAt ?? Date.now();
  return Math.max(0, Math.round((end - snapshot.startedAt) / 1e3));
}
function formatElapsed(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m${String(s).padStart(2, "0")}s`;
}
function runStatusText(snapshot) {
  const mode = MODE_LABEL$1[snapshot.mode] ?? snapshot.mode;
  const stage = STAGE_TEXT[snapshot.stage] ?? snapshot.stage;
  const parts = [mode, stage];
  if (snapshot.page && snapshot.totalPages) parts.push(`第 ${snapshot.page}/${snapshot.totalPages} 格`);
  if (snapshot.level !== "error") parts.push(formatElapsed(elapsedSecondsOf(snapshot)));
  const head = parts.join(" · ");
  return snapshot.message ? `${head}：${snapshot.message}` : head;
}
function paint() {
  if (!state) {
    if (el) el.style.display = "none";
    return;
  }
  const { root, label, dot } = ensure();
  root.style.display = "flex";
  root.className = `sti-run is-${state.level}`;
  dot.className = `sti-run-dot is-${state.level}`;
  label.textContent = runStatusText(state);
  root.title = state.level === "error" ? "出错了，点开看日志" : "点开看这次出图的日志";
}
function startTimer() {
  if (timer) return;
  timer = setInterval(paint, 1e3);
}
function stopTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}
function updateRunStatus(patch) {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  const sameTask = state && state.level === "running" && state.mode === patch.mode;
  state = {
    level: "running",
    mode: patch.mode,
    stage: patch.stage,
    ...patch.page ? { page: patch.page } : {},
    ...patch.totalPages ? { totalPages: patch.totalPages } : {},
    startedAt: sameTask ? state.startedAt : Date.now(),
    ...sameTask && (state == null ? void 0 : state.message) ? { message: state.message } : {}
  };
  paint();
  startTimer();
}
function finishRunStatus(level, message = "") {
  stopTimer();
  if (!state) return;
  state = { ...state, level, endedAt: Date.now(), message, stage: "completed" };
  paint();
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    state = null;
    paint();
  }, level === "error" ? 1e4 : 4e3);
}
function getRunStatus() {
  return state;
}
function clearRunStatus() {
  stopTimer();
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  state = null;
  paint();
}
function destroyRunStatus() {
  clearRunStatus();
  el == null ? void 0 : el.remove();
  el = null;
  labelEl = null;
  dotEl = null;
}
function truthy(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.trim().length > 0;
  return false;
}
const CONDITION_RE = /\{\{([#^])([a-zA-Z0-9_-]+)\}\}([\s\S]*?)\{\{\/\2\}\}/g;
const VAR_RE = /\{\{([a-zA-Z0-9_-]+)\}\}/g;
function renderTemplate(template, vars = {}) {
  const source = String(template ?? "");
  if (!source) return "";
  let text = source;
  for (let depth = 0; depth < 8; depth += 1) {
    let changed = false;
    text = text.replace(CONDITION_RE, (_all, sigil, name, inner) => {
      changed = true;
      const on2 = truthy(vars[name]);
      const keep = sigil === "#" ? on2 : !on2;
      return keep ? inner : "";
    });
    if (!changed) break;
  }
  text = text.replace(VAR_RE, (_all, name) => {
    const value = vars[name];
    if (value === null || value === void 0) return "";
    return String(value);
  });
  return text;
}
function collapseBlankLines(text) {
  return String(text ?? "").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}
function renderCompact(template, vars = {}) {
  return collapseBlankLines(renderTemplate(template, vars));
}
function overrideKey(id, variant) {
  return variant === "many" ? `${id}@many` : id;
}
const CAST_SCHEMA = '"cast":[{"name":"角色名（照抄库里的名字；用户扮演的「你」写人设名）","outfit":"English danbooru phrases: 这一整批共用的当前着装，版型+主色+关键配件（例如 white dress shirt, black slacks, loosened tie）","look":"English danbooru phrases: 这个人的外貌（发色/瞳色/体型/特征）。**固定外貌库里有这个人的条目时留空**，库是权威、不要改写；库里没有的（例如用户扮演的「你」）必须按正文/角色参考补全"}]';
const OUTFIT_RULE = "`cast` 是本批的**服装定妆**：每个出场角色一条，`outfit` 用英文写清版型、主色、关键配件（white dress shirt, black pleated skirt, brown loafers）。【角色固定外貌库】里该角色有「固定着装」时**照抄那一串，不要改写**；没有时按正文/角色卡/世界书定一次，正文没写就合理定一套具体的。同一批所有格共用这一串，**不许因为这一格没提衣服就换一套**；正文明确换装/穿脱/衣物破损时才写新的那一套。`characters[].act` 里**不要再写任何服装词**——服装只由 cast 提供，代码会把它拼到每一格。";
const COMMON_RULES = [
  "画面必须是正文里真的发生的那件事，不要编造没写过的动作，也不要画成「站着摆姿势」。",
  OUTFIT_RULE,
  "characters 里每一项的 act 是这张图的**主要信息**：用英文写这个角色在这一刻具体在做什么、和谁互动、手里拿着什么（例如 pulling the other's sleeve, leaning against the door, holding a broken cup）。",
  "只写 1girl / solo / standing / looking at viewer 这类空景词的图等于没画剧情——至少要有 3 条「动作或与场景互动」的 tag。",
  "characters 最多 2 项（同框超过两人时，只保留主角与核心互动对象；宁可裁人，也不要让人残缺）。两人互动时主动方和被动方 act 必须分开写。",
  "characters[].name **必须照抄【角色固定外貌库】里的名字**。正文里用「你」「他」「那个金发男生」或另一个叫法时，先判断指的是库里哪一位，再写库里的名字——名字写错就等于这个人没有外貌，会被画成路人。",
  "{{#nl}}nl 里写两个人时必须用正文里的角色名当主语，禁止用 he/she/the man 泛指。{{/nl}}",
  "tags 里必须交代这三件事：① 人数与互动；② 地点或环境（classroom / dormitory / arched corridor / street / outdoors）；③ 光线或时间（sunlight / backlighting / golden hour / night / indoor lighting）。",
  "characters[].act 只写「这个人」的动作、表情、以及和场景/道具的接触；外貌、发型、瞳色、服装由柏宝绘角色库提供，这里**绝对不要写**。",
  "{{#nl}}nl 用英文自然语言写同一件事，不要分点、不要换行。{{/nl}}",
  "{{^nl}}这套出图方案没有自然语言通道：不要输出 nl 字段（写了也不会被用，只会稀释 tag 权重）。{{/nl}}",
  "禁止写：画风、画质（masterpiece / best quality / absurdres）、画师名、角色外貌与服装细节、负面词——这些由柏宝绘的方案负责。",
  "不要解释，不要 markdown 代码块，不要多余文字。"
].join("\n");
const SPEECH_ROOM_RULE = "{{#nl}}有台词的那一格，nl 里要写明主角位于画面下半部或偏左右一侧、画面上方留出安静的空白（气泡会叠在那里）——人物头顶顶到画面上沿时，气泡只能盖在脸上。{{/nl}}";
const ILLUSTRATION = `你是一位专业的图像提示词（tag）编辑。你的任务是根据给定剧情，输出结构化的英文生图标签。
严格遵守：
1. 先按前面的规范在心里过一遍检查清单（要写出来就写在 <thinking>…</thinking> 里，并且必须闭合）；然后只输出一个 JSON 对象，JSON 之外不要任何解释文字、不要 Markdown 代码围栏。
2. 结构：{"segments":[{"id":"...","source":"character|scene|global","characterName":"角色名(仅character段)","english":["英文tag",...],"chinese":["中文辅助翻译",...],"order":数字}]{{#nl}},"nl":"可选英文自然语言描述"{{/nl}},"negative":"可选英文负面词","size":"portrait|landscape"}。
3. english / nl / negative 必须是纯英文，绝不能出现中文——中文只放在 chinese 字段作辅助阅读。
4. character 段只写角色固定外貌（来自提供的角色快照，原样保留其 tag，不得改写）；scene 段写本次画面新增的动作、场景、构图、光线、情绪 tag。
4a. **Base 与角色块是硬边界**：scene / global 段里绝对不要出现任何单个角色的外貌、服装、发色、瞳色、体型——这些只属于该角色的 character 段。两边都写，等于把两套头发两套衣服摊给同框所有人，模型只能随机分配。
4b. scene 段至少 5 个 tag，必须包含：一个景别（close-up / upper body / medium shot / full body / wide shot）、地点、光线或时间、以及人与人之间的共享互动。
5. 一次只策划一个明确的瞬间，不要描述整段剧情的时间跨度。
6. 场景与动作必须以给定剧情和上下文为依据，不得凭空添加关键剧情事实。
7. segment 按 order 从小到大排列；无需的字段直接省略，不要填空字符串或空数组。
8. 若剧情里的名场面适合漫画分镜，仍按单幅插画输出（漫画由专门的模式处理）。
9. **画进这张图的每一个人**都要有自己的 character 段：name 照抄角色库里的名字，外貌照抄该条目的 tag（不改写、不合并）。漏掉一个人，图上就少一个人；不打算画进来的人不要写。
10. {{#nl}}nl 必须写：英文 1~2 句，把「谁、在哪里、正在做什么」串起来——柏宝绘的 nl 通道决定这些细节能不能真的落在画面上。{{/nl}}{{^nl}}不要生成 nl 字段：这套出图方案不需要自然语言通道，写了反而会稀释 tag 权重。{{/nl}}
{{#hasFlags}}
补充约束：
{{#noChinese}}不要生成 chinese 字段（用户已关闭中文辅助）。{{/noChinese}}
{{#noNegative}}不要生成 negative 字段。{{/noNegative}}
{{#sizeClause}}画幅倾向：{{sizeClause}}。{{/sizeClause}}
{{/hasFlags}}`;
const COMIC = `你是一位漫画分镜编辑。你要输出的是**一张画布上一页漫画**的分镜计划：整页由 NovelAI 一次画成多格版面，而不是每格单独出一张图。
只输出一个 JSON 对象，不要解释文字、不要 Markdown 代码围栏。
结构：{"pages":[{"pageIndex":0,"title":"页标题(中文短语)","layout":"regular|irregular|inset|unframed","tags":"整页共用英文 tag，逗号分隔"{{#nl}},"nl":"整页 nl（可省略：各格 nl 优先）"{{/nl}},"dialogue":[{"text":"中文台词","speaker":"说话人名字","panel":1,"area":"tl|tr|bl|br","dir":"v","mood":"whisper"}],"panels":[{"index":0,"title":"这一格画了什么(中文短语)","shot":"wide shot|medium shot|close-up|extreme close-up","subject":"这一格的信息点(一句中文：读者要看到什么)","characters":[{"name":"角色","act":"English danbooru phrases: 这一格在做什么","look":"English 外貌短语，仅角色库里没有的人填"}],"mood":"氛围"{{#nl}},"nl":"English，一句 20~35 词：镜头距离 + 谁在画面哪一侧 + 在做什么 + 空白留在哪"{{/nl}}}]}]}
硬要求：
1. 一页 = 一张图。整页 tag 只写在 page.tags 里，**不要按格分别写 tag**。
2. page.tags 必须写出：在场的人**在做什么**（共享动作与互动）、在哪里、画面里的关键物件。**人物和动作是画面主体**，只写构图词的图等于没画。**单个角色的外貌、发色、瞳色、服装一律不写进 page.tags**——它们由 panels[].characters[].name 对应的角色库条目提供，代码会拼成每个角色自己的提示词；两边都写会把两套衣服糊给同框所有人。tag 写足 15~25 个没关系（构图、地点、道具、共享动作、光线都算），但每一个都必须是画面里真的有的东西。
3. 构图词必须按【分镜规则】里该档的写法**原样照抄**（含 1.4:: 这类权重写法），少一个就不是漫画。
4. 景别 tag 整页只写一个（cowboy shot / upper body 之类），{{#nl}}各格远近只写在 nl 里{{/nl}}{{^nl}}各格远近只能用构图 tag 区分{{/nl}}。
5. {{#nl}}**每一格都必须写 nl**（page.nl 可以省略）：一句英文，20~35 词，写清「镜头距离 + 谁在画面哪一侧 + 正在做什么 + 画面的空白留在哪」。只写「两人在桌边」这种没有镜头信息的句子，两格就会长得一模一样。{{/nl}}{{^nl}}这套方案没有自然语言通道，不要生成 nl：每一格画了什么只能靠 tags 与 panels 表达，因此 tags 必须把各格的人物与动作都写进去。{{/nl}}
5b. **每格必须换镜头**：给每格写 shot（wide shot / medium shot / close-up / extreme close-up）与 subject（这一格的信息点）。相邻两格不许同景别；同一页要同时有「交代空间」的大景与「推近」的特写。
5c. **禁止重播**：两格不许画同一个姿势、同一个动作。至少换掉「谁在动」「动的是哪只手/哪一侧」「镜头在人物哪一边」里的两项。
5d. **人数与角色块必须对得上**：page.tags 写了 1girl, 1boy 就必须有两条 characters；角色库里没有的那位（通常是用户扮演的「你」）**必须给 look 字段**（以 1girl 或 1boy 开头的英文外貌短语：发色/瞳色/体型/特征，从角色参考/正文/人设摘要里取），否则这个人的脸没有任何约束，画出来就是陌生人。
6. panels 数组只用来标「每一格画了什么」：{{#fixedPanels}}**每页固定 {{panelsPerPage}} 格**——panels 必须正好 {{panelsPerPage}} 条，nl 必须按 {{panelsPerPage}} 格分区写，版面也必须真的切出 {{panelsPerPage}} 格。{{/fixedPanels}}{{^fixedPanels}}2~4 条，title 是中文短标题（会印在卡片上），格数必须与 nl 里描述的一致；**版面必须真的切出这么多格**——说 three panels 就要画三格，不能拿两格模板套四段内容。{{/fixedPanels}}
7. dialogue 是中文口语台词，最多 4 条、每条 20 字内，不写旁白；台词不许写进 tags 或 nl。panel 字段是这句出现在第几格（1 起，按阅读顺序）——气泡只会画在那**一格**里，所以必须与该格 characters 里说话的人对得上；对不上就别写这句。speaker 写说话人名字（照抄 characters 里的名字）：它不会被画进气泡，只用来定位，写对了气泡才会贴着说话的人。
8. tags / nl 里绝对不允许出现 speech bubble、text、english text、dialogue、caption —— 画面里不能有字。
9. 有台词的页，nl 里要让人物偏下、格内上方留出干净空间给气泡；人物头顶顶到页边时气泡只能盖在脸上。**但不要为了留白把有地点、有道具、有互动的页改成白底档**——那等于把剧情发生的世界删掉，只让人偏下就够了。
{{#hasRule}}

【分镜规则（必须遵守）】
{{panelRule}}
{{/hasRule}}

【输出约束】最多 {{maxPages}} 页；{{#dialogue}}dialogue 必须写：每页 2~3 条中文台词，取自这一段里真的说过的话；实在没有对白才用一句旁白式台词顶上。{{/dialogue}}{{^dialogue}}本次不要输出 dialogue 字段。{{/dialogue}}
{{#noChinese}}除台词外的辅助中文一律不要输出。{{/noChinese}}`;
const STATUS_SINGLE = `读一段角色扮演正文，把「这一楼最要紧的那一个画面」翻成一张插画，只输出一个 JSON 对象。
格式：{"title":"中文，14 字以内，这一楼发生了什么",${CAST_SCHEMA},"characters":[{"name":"出场角色名（照抄正文里的叫法）","act":"English danbooru phrases: what THIS character is doing this frame"}],"mood":"中文，6 字以内","tags":"10-16 个英文 danbooru 短 tag，逗号分隔"{{#nl}},"nl":"English, 1-2 sentences describing this frame"{{/nl}}}
tags 里写互动词（couple / kiss / hug）与人数（1boy, 1girl 等）。
${COMMON_RULES}
景别只写 close-up / upper body / medium shot 里的一个（卡片是偏半身的构图，不要写 full body 或 wide shot）。
没有角色出场时输出 {"title":"","cast":[],"characters":[],"mood":"","tags":"","nl":""}。`;
const STATUS_MANY = `读一段角色扮演正文，把这一楼发生的事挑成 {{count}} 个先后画面，像一条小分镜，只输出一个 JSON 对象。
格式：{"title":"中文，14 字以内，这一楼讲了一件什么事",${CAST_SCHEMA},"panels":[{"title":"中文，14 字以内，这一格发生了什么","characters":[{"name":"出场角色名（照抄正文里的叫法）","act":"English danbooru phrases: what THIS character is doing this frame"}],"mood":"中文，6 字以内","tags":"10-16 个英文 danbooru 短 tag，逗号分隔"{{#nl}},"nl":"English, 1-2 sentences describing this frame"{{/nl}}}]}
panels 按正文的时间顺序排列：第一格是这一楼的开头，最后一格是落点。
每一格必须是不同的瞬间：换动作、换位置、换张力。不许重复或拆格凑数；没那么多就少给几格（至少 1 格）。
${COMMON_RULES}
每格景别只写 close-up / upper body / medium shot 里的一个，相邻两格不要一样（卡片是偏半身构图，不要写 full body 或 wide shot）。
没有角色出场时输出 {"title":"","cast":[],"panels":[]}。`;
const BONUS_LINES = '"lines":[{"speaker":"说话角色名（照抄正文里的叫法）；旁白写「旁白」","text":"中文，20 字以内"}]';
const BONUS_SINGLE = `读一段角色扮演正文，忘掉它的剧情，只为其中的角色设计一个「平行宇宙彩蛋」：一段与正文剧情无关的架空小片段，只输出一个 JSON 对象。
格式：{"title":"中文，14 字以内，以「彩蛋：」开头",${CAST_SCHEMA},"characters":[{"name":"出场角色名","act":"English danbooru phrases: what THIS character is doing"}],"mood":"中文，6 字以内","tags":"10-16 个英文 danbooru 短 tag"{{#nl}},"nl":"English, 1-2 sentences"{{/nl}},${BONUS_LINES}}
题材、场景、基调完全自由发挥：温馨日常、热血战斗、悬疑惊悚、虐心催泪、史诗冒险、荒诞搞笑都可以。唯一硬要求：角色必须是正文里的那几位，性格照旧。
每次都换花样：别落在咖啡店、甜品店这类用滥的套路里。
每格给 2~4 条 lines（对话/旁白），短句符合口吻；旁白 speaker 写「旁白」。只画一个画面。
彩蛋不是正文的延续：不要接着正文里刚发生的事画。
${COMMON_RULES}
${SPEECH_ROOM_RULE}`;
const BONUS_MANY = `读一段角色扮演正文，忘掉它的剧情，只为其中的角色设计一个「平行宇宙彩蛋」：一段与正文剧情无关的架空小片段，只输出一个 JSON 对象。
格式：{"title":"中文，14 字以内，以「彩蛋：」开头",${CAST_SCHEMA},"characters":[{"name":"出场角色名","act":"English danbooru phrases: what THIS character is doing"}],"mood":"中文，6 字以内","tags":"10-16 个英文 danbooru 短 tag"{{#nl}},"nl":"English, 1-2 sentences"{{/nl}},${BONUS_LINES},"panels":[{"title":"中文，14 字以内，这一格发生了什么","characters":[{"name":"出场角色名","act":"English danbooru phrases: what THIS character is doing"}],"mood":"中文，6 字以内","tags":"10-16 个英文 danbooru 短 tag"{{#nl}},"nl":"English, 1-2 sentences"{{/nl}},"lines":[{"speaker":"说话角色名；旁白写「旁白」","text":"中文，20 字以内"}]}]}
题材、场景、基调完全自由发挥：温馨日常、热血战斗、悬疑惊悚、虐心催泪、史诗冒险、荒诞搞笑都可以。唯一硬要求：角色必须是正文里的那几位，性格照旧。
每次都换花样：别落在咖啡店、甜品店这类用滥的套路里。
每格给 2~4 条 lines（对话/旁白），短句符合口吻；旁白 speaker 写「旁白」。把彩蛋拆成最多 {{count}} 个先后画面（panels），按时间顺序，每格不同瞬间。
彩蛋不是正文的延续：不要接着正文里刚发生的事画。
${COMMON_RULES}
${SPEECH_ROOM_RULE}`;
const MANGA_BASE_RULES = "禁止写：黑白、网点、screentone、画风、角色外貌；也禁止 big head / chibi / super deformed 比例词（正常比例）。\n禁止写 speech bubble / text / dialogue / caption / comic panel border —— 画面里不许出现任何文字、气泡或分格线。";
const MANGA_SINGLE = `读一段角色扮演正文，把「这一楼最有画面的那一个瞬间」画成一格黑白漫画，只输出一个 JSON 对象。
格式：{"title":"中文，14 字以内，这一格发生了什么",${CAST_SCHEMA},"characters":[{"name":"出场角色名（照抄正文里的叫法）","act":"English danbooru phrases: what THIS character is doing this frame"}],"mood":"中文，6 字以内","tags":"10-20 个英文 danbooru 短 tag，逗号分隔"{{#nl}},"nl":"English, 1-2 sentences describing this frame"{{/nl}}{{#dialogue}},${BONUS_LINES}{{/dialogue}}}
${COMMON_RULES}
tags 里必须有一个景别，从这几类挑最合适的：extreme close-up / close-up / upper body / cowboy shot / full body / wide shot / medium shot / from above / from below / from side / dutch angle。按内容挑，多格时相邻两格景别不同。
**这一格必须画出正文里那个具体动作发生的场面**：谁、在哪里、正在做什么。除景别与表情外，至少要有一条「与场景互动的动作」tag（sitting on the bed / holding an umbrella / leaning against the wall / kneeling on the floor）和一条地点 tag（bedroom / classroom / street / outdoors …）。只有外貌、人数、表情的图会变成一张与剧情无关的头像。
${MANGA_BASE_RULES}
{{#dialogue}}每格给 1~3 条 lines：台词用中文短句、符合角色口吻，必须是正文里真的说过、或那一刻自然会说的话；旁白的 speaker 写「旁白」。台词由本地画成气泡叠在图上，**绝对不要写进 tags 或 nl**。
${SPEECH_ROOM_RULE}{{/dialogue}}
{{#safe}}这一格必须能公开发布：衣着完整，不画裸露、性行为、内衣特写、走光。挑能放到台面上的瞬间，用表情、留白、构图表达张力。tags 与 act 里不许出现 nude / nipples / underwear / sex 这类词。{{/safe}}
没有角色出场时输出 {"title":"","cast":[],"characters":[],"mood":"","tags":"","nl":""}。`;
const MANGA_MANY = `读一段角色扮演正文，把这一楼发生的事挑成最多 {{count}} 个先后画面，像一页黑白漫画的分格，只输出一个 JSON 对象。
格式：{"title":"中文，14 字以内",${CAST_SCHEMA},"panels":[{"title":"中文，14 字以内，这一格发生了什么","characters":[{"name":"出场角色名（照抄正文里的叫法）","act":"English danbooru phrases: what THIS character is doing this frame"}],"mood":"中文，6 字以内","tags":"10-20 个英文 danbooru 短 tag，逗号分隔"{{#nl}},"nl":"English, 1-2 sentences describing this frame"{{/nl}}{{#dialogue}},${BONUS_LINES}{{/dialogue}}}]}
panels 按时间顺序排列；每一格必须是不同的瞬间（换动作、位置、张力），不许重复或拆格凑数，没那么多就少给几格。
${COMMON_RULES}
tags 里必须有一个景别：extreme close-up / close-up / upper body / cowboy shot / full body / wide shot 等；相邻两格景别不同。
**每一格都要画出正文里那一刻的场面**：谁、在哪里、正在做什么。除景别与表情外，每格至少一条「与场景互动的动作」tag（sitting on the bed / holding an umbrella / leaning against the wall）和一条地点 tag。只写外貌与人数的图会变成一页与剧情无关的头像。
${MANGA_BASE_RULES}
{{#dialogue}}每格给 1~3 条 lines：中文短句、符合角色口吻，按时间顺序连起来要能读懂这一楼发生了什么；旁白的 speaker 写「旁白」。台词由本地画成气泡叠在图上，**绝对不要写进 tags 或 nl**。
${SPEECH_ROOM_RULE}{{/dialogue}}
{{#safe}}每格必须能公开发布：衣着完整，不画裸露、性行为、内衣特写；用表情、留白、构图表达张力，tags 与 act 里不许出现 NSFW 词。{{/safe}}
没有角色出场时输出 {"title":"","cast":[],"panels":[]}。`;
const PROMPT_DOCS = [
  {
    id: "illustration",
    label: "正文插画",
    hint: "读选段 → 输出 tag 段（segment）与 nl。改字段名会导致解析失败。",
    vars: ["nl", "hasFlags", "noChinese", "noNegative", "sizeClause"],
    defaults: { single: ILLUSTRATION }
  },
  {
    id: "comic",
    label: "正文漫画分镜",
    hint: "一页一张图。{{panelRule}} 是系统按「分镜档位 / 页型 / 后端」注入的规则块，别删。",
    vars: ["nl", "hasRule", "panelRule", "maxPages", "dialogue", "noChinese", "fixedPanels", "panelsPerPage"],
    defaults: { single: COMIC }
  },
  {
    id: "status",
    label: "QQ 人状态栏",
    hint: "只画这一楼最要紧的一张。{{count}} 是多格模式要的格数。",
    vars: ["nl", "count"],
    defaults: { single: STATUS_SINGLE, many: STATUS_MANY }
  },
  {
    id: "bonus",
    label: "QQ 人彩蛋",
    hint: "架空小片段，与正文剧情无关，但人物性格照旧。",
    vars: ["nl", "count"],
    defaults: { single: BONUS_SINGLE, many: BONUS_MANY }
  },
  {
    id: "manga",
    label: "黑白漫小剧场",
    hint: "单格黑白漫画；{{#safe}} 是安全模式，{{#dialogue}} 是台词，{{#nl}} 是方案是否要自然语言。",
    vars: ["nl", "count", "safe", "dialogue"],
    defaults: { single: MANGA_SINGLE, many: MANGA_MANY }
  }
];
function promptDocOf(id) {
  return PROMPT_DOCS.find((doc) => doc.id === id);
}
function defaultTemplate(id, variant) {
  const doc = promptDocOf(id);
  if (!doc) return "";
  if (variant === "many") return doc.defaults.many ?? doc.defaults.single;
  return doc.defaults.single;
}
function resolveTemplate(id, variant, overrides) {
  const custom = overrides == null ? void 0 : overrides[overrideKey(id, variant)];
  if (typeof custom === "string" && custom.trim()) return custom;
  return defaultTemplate(id, variant);
}
function renderPromptDoc(id, variant, vars, overrides) {
  const template = resolveTemplate(id, variant, overrides);
  return renderCompact(template, vars);
}
function isCustomized(id, variant, overrides) {
  const custom = overrides == null ? void 0 : overrides[overrideKey(id, variant)];
  return typeof custom === "string" && !!custom.trim();
}
const PANEL_ID = "sti-config-panel";
const OVERLAY_ID$1 = "sti-config-overlay";
const MODE_LABEL = {
  "illustration": "正文插画",
  "comic": "正文漫画分镜",
  "chibi-status": "QQ 人状态栏",
  "chibi-bonus": "QQ 人彩蛋",
  "bw-manga": "黑白漫小剧场",
  "restore": "还原方案"
};
let panelEl = null;
let overlayEl = null;
let promptDocId = "illustration";
let promptVariant = "single";
function ensurePanel() {
  if (panelEl && overlayEl && document.body.contains(panelEl)) {
    return { panel: panelEl, overlay: overlayEl };
  }
  const overlay2 = document.createElement("div");
  overlay2.id = OVERLAY_ID$1;
  overlay2.className = "sti-config-overlay";
  overlay2.addEventListener("click", () => hideConfigPanel());
  document.body.appendChild(overlay2);
  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.className = "sti-config-panel";
  document.body.appendChild(panel);
  panelEl = panel;
  overlayEl = overlay2;
  return { panel, overlay: overlay2 };
}
function showConfigPanel(tab = "settings") {
  const { panel, overlay: overlay2 } = ensurePanel();
  render(panel, tab);
  panel.style.display = "flex";
  overlay2.style.display = "block";
}
function hideConfigPanel() {
  if (panelEl) panelEl.style.display = "none";
  if (overlayEl) overlayEl.style.display = "none";
}
function section(title, subtitle) {
  const wrap = document.createElement("div");
  wrap.className = "sti-config-section";
  const h = document.createElement("div");
  h.className = "sti-config-h";
  h.textContent = title;
  wrap.appendChild(h);
  if (subtitle) {
    const s = document.createElement("div");
    s.className = "sti-config-sub";
    s.textContent = subtitle;
    wrap.appendChild(s);
  }
  return wrap;
}
function render(panel, tab = "settings") {
  panel.innerHTML = "";
  const snap = readOutConfig();
  const head = document.createElement("div");
  head.className = "sti-config-head";
  const title = document.createElement("h2");
  title.textContent = tab === "log" ? "出图日志" : tab === "prompts" ? "提示词" : "配图设置";
  head.appendChild(title);
  const close2 = document.createElement("button");
  close2.type = "button";
  close2.className = "sti-config-close";
  close2.textContent = "×";
  close2.addEventListener("click", () => hideConfigPanel());
  head.appendChild(close2);
  panel.appendChild(head);
  panel.appendChild(buildStudioTabs(tab));
  if (tab === "log") {
    const logBody = document.createElement("div");
    logBody.className = "sti-config-body";
    logBody.appendChild(renderLogSection());
    panel.appendChild(logBody);
    return;
  }
  if (tab === "prompts") {
    const promptBody = document.createElement("div");
    promptBody.className = "sti-config-body";
    promptBody.appendChild(renderPromptSettings(panel));
    panel.appendChild(promptBody);
    return;
  }
  const body = document.createElement("div");
  body.className = "sti-config-body";
  const cur = section(
    "当前出图方案",
    "以下是柏宝绘此刻实际用于出图的配置，本面板实时同步。正文插图固定用这套——插件不会替你改。"
  );
  const curBox = document.createElement("div");
  curBox.className = "sti-config-current";
  curBox.innerHTML = `<div class="sti-config-cur-row"><span>方案</span><b>${esc(snap.activePlanName || "（未配置）")}</b></div><div class="sti-config-cur-row"><span>模型</span><b>${esc(activeModel(snap))}</b></div><div class="sti-config-cur-row"><span>接入点</span><b>${esc(activeEndpointName(snap))}</b></div>`;
  cur.appendChild(curBox);
  const hint = moneySavingHint(snap);
  if (hint) {
    const hintEl = document.createElement("div");
    hintEl.className = "sti-config-money-hint";
    hintEl.textContent = hint;
    cur.appendChild(hintEl);
  }
  const activePlan = snap.plans.find((p) => p.id === snap.activePlanId);
  if (activePlan && activePlan.layoutWords.length > 0) {
    const warn = document.createElement("div");
    warn.className = "sti-config-money-hint";
    warn.textContent = `这套方案的画师串里有「${activePlan.layoutWords.join(" / ")}」：它会让每张图都画成一整页多格，而本插件的每张卡片只放一格。想让卡片是单格，请换一条不带分格词的画师串（柏宝绘 → 画师串）。`;
    cur.appendChild(warn);
  }
  body.appendChild(cur);
  body.appendChild(renderPromptSource());
  body.appendChild(renderAutomationSettings());
  body.appendChild(renderTheaterSettings());
  body.appendChild(renderComicSettings());
  body.appendChild(renderUiSettings());
  const modePlans = getSettings(DEFAULT_SETTINGS).modeOutPlans ?? {};
  const assigned = Object.entries(modePlans).filter(([mode, id]) => !!id && mode !== "illustration");
  if (assigned.length > 0) {
    const perMode = section(
      "各创作模式指定的方案",
      "出图前把柏宝绘临时切到对应方案，出完自动切回原样（正文插图不受影响）。要改请到选段弹窗底部「出图方案」。"
    );
    const box = document.createElement("div");
    box.className = "sti-config-eplist";
    for (const [mode, planId] of assigned) {
      const plan = snap.plans.find((p) => p.id === planId);
      const row = document.createElement("div");
      row.className = "sti-config-ep";
      const label = MODE_LABEL[mode] ?? mode;
      row.textContent = plan ? `${label} → ${plan.name} · ${plan.endpointName}` + (plan.layoutWords.length ? "（⚠ 画师串含分格词，单格会被画成整页）" : "") : `${label} → 方案已失效（${planId.slice(0, 8)}…）`;
      box.appendChild(row);
    }
    perMode.appendChild(box);
    body.appendChild(perMode);
  }
  const plans = section("切换方案", "点「切为当前」会在柏宝绘里切到该方案（走它自己的逻辑，落盘也同步）。若按钮无响应，请先打开一次柏宝绘设置面板。");
  const planList = document.createElement("div");
  planList.className = "sti-config-list";
  if (snap.plans.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sti-config-empty";
    empty.textContent = "柏宝绘里还没有出图方案，请先在柏宝绘设置 → 后端 → NovelAI 里建一套。";
    planList.appendChild(empty);
  }
  for (const p of snap.plans) {
    const row = document.createElement("div");
    row.className = `sti-config-item ${p.id === snap.activePlanId ? "active" : ""}`;
    const info = document.createElement("div");
    info.className = "sti-config-item-info";
    const name = document.createElement("div");
    name.className = "sti-config-item-name";
    name.textContent = p.name + (p.id === snap.activePlanId ? " · 当前" : "");
    const meta = document.createElement("div");
    meta.className = "sti-config-item-meta";
    meta.textContent = `${p.model || "(未填模型)"} · ${p.endpointName}${p.portraitSize ? ` · ${p.portraitSize}` : ""}` + (p.artistName ? ` · 画师串 ${p.artistName}` : "") + (p.layoutWords.length ? " · ⚠ 画师串含分格词，会画成整页" : "");
    info.appendChild(name);
    info.appendChild(meta);
    row.appendChild(info);
    if (p.id !== snap.activePlanId) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sti-config-switch-btn";
      btn.textContent = "切为当前";
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "切换中…";
        const result = await switchBaiBaiPlan(p.id);
        if (result.ok) {
          showConfigPanel();
        } else {
          btn.disabled = false;
          btn.textContent = "重试";
          alert(result.message);
        }
      });
      row.appendChild(btn);
    }
    planList.appendChild(row);
  }
  plans.appendChild(planList);
  body.appendChild(plans);
  const eps = section("接入点（只读）", "来自柏宝绘。增删/改地址请在柏宝绘设置里操作；密钥不会显示。");
  const epList = document.createElement("div");
  epList.className = "sti-config-eplist";
  for (const e of snap.endpoints) {
    const row = document.createElement("div");
    row.className = "sti-config-ep";
    row.textContent = `${e.name} · ${maskUrl(e.url)}${e.hasKey ? " · 已设密钥" : " · 未设密钥"}`;
    epList.appendChild(row);
  }
  if (snap.endpoints.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sti-config-empty";
    empty.textContent = "柏宝绘里没有接入点。";
    epList.appendChild(empty);
  }
  eps.appendChild(epList);
  body.appendChild(eps);
  const tag = section("Tag 生成副 API", "创作模式里的「跟随柏宝绘 tagGen」读的就是这里。你在柏宝绘改指派，弹窗自动跟随。");
  const channels = listSharedChannelInfos();
  const tagId = readTagGenChannelId();
  const tagCh = channels.find((c) => c.id === tagId);
  const tagBox = document.createElement("div");
  tagBox.className = "sti-config-current";
  tagBox.innerHTML = `<div class="sti-config-cur-row"><span>当前指派</span><b>${esc(tagCh ? `${tagCh.name} / ${tagCh.model}` : tagId || "跟随主 API（未指派）")}</b></div><div class="sti-config-cur-row"><span>共享渠道数</span><b>${channels.length} 条</b></div>`;
  tag.appendChild(tagBox);
  body.appendChild(tag);
  panel.appendChild(body);
  const foot = document.createElement("div");
  foot.className = "sti-config-foot";
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.textContent = "刷新同步";
  refresh.addEventListener("click", () => showConfigPanel());
  foot.appendChild(refresh);
  const note = document.createElement("span");
  note.textContent = "出图仍由柏宝绘执行；本页开关只影响本插件。";
  foot.appendChild(note);
  panel.appendChild(foot);
}
const SHOT_OPTIONS = [
  ["1", "1 格 · 单画面"],
  ["2", "2 格 · 起 → 落"],
  ["3", "3 格 · 起 → 转 → 落"],
  ["4", "4 格 · 小分镜"]
];
const CHANCE_OPTIONS = [
  ["0", "0% · 不出"],
  ["25", "25% · 偶尔"],
  ["50", "50% · 一半"],
  ["100", "100% · 每楼都出"]
];
let insideToggle = false;
function patchSettings(mutate) {
  const next = getSettings(DEFAULT_SETTINGS);
  const empty = {
    enabled: false,
    autoTrigger: false,
    profileId: "",
    shots: 1
  };
  next.modes = next.modes ?? {};
  for (const mode of ["illustration", "comic", "chibi-status", "chibi-bonus", "bw-manga"]) {
    next.modes[mode] = { ...empty, ...next.modes[mode] ?? {} };
  }
  mutate(next);
  saveSettings(next);
  if (!insideToggle) showConfigPanel();
  window.dispatchEvent(new CustomEvent("sti-settings-changed"));
}
function settingRow(label, hint) {
  const el2 = document.createElement("div");
  el2.className = "sti-set-row";
  const left = document.createElement("div");
  left.className = "sti-set-label";
  left.textContent = label;
  if (hint) {
    const small = document.createElement("small");
    small.textContent = hint;
    left.appendChild(small);
  }
  const control = document.createElement("div");
  control.className = "sti-set-control";
  el2.appendChild(left);
  el2.appendChild(control);
  return { el: el2, control };
}
function toggleRow(label, checked, onChange, hint, key) {
  const { el: el2, control } = settingRow(label, hint);
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = checked;
  if (key) cb.dataset.stiToggle = key;
  cb.addEventListener("change", () => {
    insideToggle = true;
    try {
      onChange(cb.checked);
    } finally {
      insideToggle = false;
    }
    cb.blur();
    if (key) syncToggles(key, cb.checked);
  });
  control.appendChild(cb);
  return el2;
}
function syncToggles(key, value) {
  const nodes = document.querySelectorAll(`input[data-sti-toggle="${key}"]`);
  for (const node of nodes) node.checked = value;
}
function selectRow(label, value, options, onChange, hint) {
  const { el: el2, control } = settingRow(label, hint);
  const select = document.createElement("select");
  for (const [val, text] of options) {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = text;
    if (val === value) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => onChange(select.value));
  control.appendChild(select);
  return el2;
}
function renderAutomationSettings() {
  const s = getSettings(DEFAULT_SETTINGS);
  const group = document.createElement("div");
  group.className = "sti-config-group";
  const head = document.createElement("div");
  head.className = "sti-config-group-h";
  head.textContent = "自动出图（每层 AI 回复后）";
  group.appendChild(head);
  const tip = document.createElement("div");
  tip.className = "sti-config-sub";
  tip.textContent = "五个模式各自独立：勾上哪个就自动跑哪个，没勾的只能手动生成。自动出图会持续消耗额度——先只开你想要的那一两套。";
  group.appendChild(tip);
  const rows = [
    ["illustration", "正文插图（柏宝绘卡片）", "往正文插 <bbi_image> tag 再点卡片出图：与柏宝绘自己的图一模一样（能重绘、改词、进请求历史），刷新不丢。"],
    ["comic", "正文漫画分镜", "按一页一张图出多格版面，还要先跑一次读剧情。每页都算一次出图，最贵，默认关。"],
    ["chibi-status", "QQ 人状态栏", "楼层底部一张卡片，按剧情时间顺序排出几格。"],
    ["chibi-bonus", "QQ 人彩蛋", "与正文无关的平行小片段；勾上后按下面的概率触发。"],
    ["bw-manga", "黑白漫小剧场", "正常比例、黑白画风；每格一张图，可带对白气泡。"]
  ];
  for (const [mode, label, hint] of rows) {
    const conf = resolveModeSettings(s, mode);
    group.appendChild(toggleRow(
      label,
      !!conf.autoTrigger,
      (v) => patchSettings((st) => {
        st.modes[mode].autoTrigger = v;
      }),
      hint,
      `mode:${mode}:autoTrigger`
    ));
  }
  group.appendChild(toggleRow(
    "出图后把柏宝绘方案切回原样",
    s.restorePlanAfterTask !== false,
    (v) => patchSettings((st) => {
      st.restorePlanAfterTask = v;
    }),
    "柏宝绘的「当前方案」是全局的。小剧场按模式切走之后，如果不切回来，接下来正文插图就会用 QQ 人/黑白漫那套模型与画师串出图。默认开着——正文永远用你自己选的那套。"
  ));
  return group;
}
function renderTheaterSettings() {
  var _a, _b, _c;
  const s = getSettings(DEFAULT_SETTINGS);
  const status = (_a = s.modes) == null ? void 0 : _a["chibi-status"];
  const bonus = (_b = s.modes) == null ? void 0 : _b["chibi-bonus"];
  const manga = (_c = s.modes) == null ? void 0 : _c["bw-manga"];
  const group = document.createElement("div");
  group.className = "sti-config-group";
  const head = document.createElement("div");
  head.className = "sti-config-group-h";
  head.textContent = "小剧场（QQ 人 / 彩蛋 / 黑白漫）";
  group.appendChild(head);
  const tip = document.createElement("div");
  tip.className = "sti-config-sub";
  tip.textContent = "三套互不影响，可以同时开；同时开时每层出图量会叠加。画风与画师串跟随下面选中的出图方案。";
  group.appendChild(tip);
  const a = section("① QQ 人小剧场状态栏", "楼层底部一张卡片，按剧情时间顺序排出「怎么走到这个结果」的几格。");
  a.appendChild(selectRow(
    "每层格数",
    String((status == null ? void 0 : status.shots) ?? 1),
    SHOT_OPTIONS,
    (v) => patchSettings((st) => {
      st.modes["chibi-status"].shots = Number(v);
      st.chibiStatusShots = Number(v);
    })
  ));
  a.appendChild(selectRow(
    "画风",
    (status == null ? void 0 : status.chibiStyle) ?? "card",
    [["card", "Q 版（大头小身）"], ["thumb", "写实小图"]],
    (v) => patchSettings((st) => {
      st.modes["chibi-status"].chibiStyle = v === "thumb" ? "thumb" : "card";
      st.chibiStatusStyle = v === "thumb" ? "thumb" : "card";
    })
  ));
  a.appendChild(planSelectRow("chibi-status"));
  group.appendChild(a);
  const b = section("② 彩蛋小剧场", "与正文剧情无关的平行小片段，题材放开，每次换花样。");
  b.appendChild(selectRow(
    "每条格数",
    String((bonus == null ? void 0 : bonus.shots) ?? 1),
    SHOT_OPTIONS,
    (v) => patchSettings((st) => {
      st.modes["chibi-bonus"].shots = Number(v);
      st.chibiBonusShots = Number(v);
    })
  ));
  b.appendChild(selectRow(
    "自动触发概率",
    String((bonus == null ? void 0 : bonus.chibiBonusChance) ?? s.chibiBonusChance ?? 25),
    CHANCE_OPTIONS,
    (v) => patchSettings((st) => {
      st.modes["chibi-bonus"].chibiBonusChance = Number(v);
      st.chibiBonusChance = Number(v);
    }),
    "只在「新楼层自动出图」开着时生效；手动点彩蛋不受概率限制。"
  ));
  b.appendChild(planSelectRow("chibi-bonus"));
  group.appendChild(b);
  const c = section("③ 黑白漫小剧场", "正常比例；黑白由「黑白锁定」与出图方案里的画师串共同决定。");
  c.appendChild(selectRow(
    "每条格数",
    String((manga == null ? void 0 : manga.shots) ?? 1),
    SHOT_OPTIONS,
    (v) => patchSettings((st) => {
      st.modes["bw-manga"].shots = Number(v);
      st.mangaShots = Number(v);
    })
  ));
  c.appendChild(toggleRow(
    "黑白锁定（正向 monochrome / greyscale）",
    (manga == null ? void 0 : manga.bwMangaMono) !== false,
    (v) => patchSettings((st) => {
      st.modes["bw-manga"].bwMangaMono = v;
    }),
    "正向上锁黑白、洗掉提示词里的彩色语义词（colorful / vivid / full color），负面再压 color 一类词。不动你的画师串。关掉 = 完全交给画师串。"
  ));
  c.appendChild(toggleRow(
    "安全模式（避开露点/性描写）",
    (manga == null ? void 0 : manga.bwMangaSafeMode) !== false,
    (v) => patchSettings((st) => {
      st.modes["bw-manga"].bwMangaSafeMode = v;
      st.mangaSafe = v;
    }),
    "只洗露点/性描写相关的 tag 与动作，并补一串 nsfw 负面词；不管黑白，也不动你的画师串。"
  ));
  c.appendChild(planSelectRow("bw-manga"));
  c.appendChild(toggleRow(
    "气泡对白",
    (manga == null ? void 0 : manga.bwMangaDialogue) !== false,
    (v) => patchSettings((st) => {
      st.modes["bw-manga"].bwMangaDialogue = v;
    }),
    "读剧情时顺便让模型写 1~3 句中文台词，出图后由本地 canvas 画成气泡叠上去。（原文档的黑白漫没有台词，这里做成可关。）"
  ));
  c.appendChild(selectRow(
    "气泡样式",
    (manga == null ? void 0 : manga.bwMangaBubbleStyle) ?? "classic",
    [
      ["classic", "描边气泡"],
      ["bubble-vertical", "竖排气泡"],
      ["blend", "融入式（无框）"],
      ["blend-ink", "融入式 · 墨字"],
      ["blend-subtitle", "字幕条"]
    ],
    (v) => patchSettings((st) => {
      st.modes["bw-manga"].bwMangaBubbleStyle = v;
    })
  ));
  group.appendChild(c);
  return group;
}
function planSelectRow(mode) {
  var _a;
  const snap = readOutConfig();
  const current = ((_a = getSettings(DEFAULT_SETTINGS).modeOutPlans) == null ? void 0 : _a[mode]) ?? "";
  const options = [["", "跟随当前方案"]];
  for (const plan of snap.plans) {
    options.push([
      plan.id,
      `${plan.name} · ${plan.endpointName} / ${plan.model || "未填模型"}${plan.layoutWords.length ? " · ⚠整页" : ""}`
    ]);
  }
  return selectRow(
    "出图方案",
    current,
    options,
    (v) => patchSettings((st) => {
      st.modeOutPlans = { ...st.modeOutPlans ?? {} };
      if (v) st.modeOutPlans[mode] = v;
      else delete st.modeOutPlans[mode];
    }),
    snap.plans.length === 0 ? "柏宝绘里还没有出图方案，请先在柏宝绘设置里建一套。" : snap.backend !== "nai" ? `柏宝绘当前出图渠道是「${snap.backend}」，按模式分配方案只对 NAI 生效——这样选会在生成时直接报错，不会白花钱。` : "出图前自动切到这套方案，出完切回原样；切不过去就停下报错（不会偷偷用旧方案烧钱）。"
  );
}
function renderComicSettings() {
  var _a;
  const s = getSettings(DEFAULT_SETTINGS);
  const comic = (_a = s.modes) == null ? void 0 : _a["comic"];
  const group = document.createElement("div");
  group.className = "sti-config-group";
  const head = document.createElement("div");
  head.className = "sti-config-group-h";
  head.textContent = "④ 正文漫画分镜";
  group.appendChild(head);
  const box = section("正文插图切成漫画格", "与三套小剧场并列；勾选「正文漫画分镜」时生效，图会按分镜插进正文。");
  box.appendChild(selectRow(
    "版面",
    (comic == null ? void 0 : comic.comicLayout) ?? "auto",
    [["auto", "自动（按剧情挑，推荐）"], ["regular", "规整分格"], ["irregular", "斜切分镜"], ["inset", "主图 + 嵌入格"], ["unframed", "无边框融白"]],
    (v) => patchSettings((st) => {
      st.modes["comic"].comicLayout = v;
      st.panelLayout = v === "auto" ? "regular" : v;
    }),
    "自动：写 tag 的模型读过这一段剧情，由它逐页决定用哪一档（动作戏给拼版、只有人的独白给白底特写）。看不懂这几档就留着自动。"
  ));
  box.appendChild(selectRow(
    "每页格数",
    String((comic == null ? void 0 : comic.comicPanelsPerPage) ?? 0),
    [["0", "跟随版面"], ["2", "2 格"], ["3", "3 格"], ["4", "4 格"]],
    (v) => patchSettings((st) => {
      st.modes["comic"].comicPanelsPerPage = Number(v);
    }),
    "一页切几格。定死之后，提示词、构图词（2/3/4koma）与 nl 分区会一起对齐——以前是模型说几格就几格，规整档的 2koma 会把三四段内容压进两格。"
  ));
  box.appendChild(selectRow(
    "最多页数",
    String((comic == null ? void 0 : comic.comicMaxPages) ?? 1),
    [["1", "1 页"], ["2", "2 页"], ["3", "3 页"]],
    (v) => patchSettings((st) => {
      st.modes["comic"].comicMaxPages = Number(v);
    })
  ));
  box.appendChild(toggleRow(
    "气泡对白",
    s.dialogueEnabled !== false,
    (v) => patchSettings((st) => {
      st.dialogueEnabled = v;
      st.modes["comic"].comicDialoguePolicy = v ? "always" : "auto";
    }),
    "开启后会把选段里的台词排进气泡，出图后合成一次到图上。"
  ));
  group.appendChild(box);
  return group;
}
function renderPromptSource() {
  const set = readPromptSet();
  const block = section(
    "读剧情用的提示词",
    "柏宝绘 → 设置 →「自定义提示词」里的 NAI 规范与思维链，会被一并压进我们读剧情的请求（和柏宝绘自己出图时一样）。留空就用插件自带的精简规则。"
  );
  const box = document.createElement("div");
  box.className = "sti-config-eplist";
  const rows = [
    ["NAI 规范", set.spec ? `已接入 · ${set.spec.length} 字` : "未填写 · 用插件内置精简规则"],
    ["思维链", set.thinking ? `已接入 · ${set.thinking.length} 字` : "未填写"],
    ["破限词", set.jailbreak ? `已接入 · ${set.jailbreak.length} 字` : "未填写"]
  ];
  for (const [label, value] of rows) {
    const row = document.createElement("div");
    row.className = "sti-config-ep";
    row.textContent = `${label} → ${value}`;
    box.appendChild(row);
  }
  block.appendChild(box);
  return block;
}
function renderUiSettings() {
  const s = getSettings(DEFAULT_SETTINGS);
  const group = document.createElement("div");
  group.className = "sti-config-group";
  const head = document.createElement("div");
  head.className = "sti-config-group-h";
  head.textContent = "入口与显示";
  group.appendChild(head);
  group.appendChild(toggleRow(
    "悬浮球（🎨）",
    s.showFloatingBall !== false,
    (v) => patchSettings((st) => {
      st.showFloatingBall = v;
    }),
    "关掉后仍可从魔杖菜单打开；悬浮球可以拖动，位置会记住。"
  ));
  group.appendChild(toggleRow(
    "划词时显示「生成配图」按钮",
    s.showSelectionToolbar !== false,
    (v) => patchSettings((st) => {
      st.showSelectionToolbar = v;
    }),
    "关掉后只能从魔杖菜单或悬浮球打开面板。"
  ));
  group.appendChild(toggleRow(
    "选段只提取 <content> 里的正文",
    s.preferContentTag !== false,
    (v) => patchSettings((st) => {
      st.preferContentTag = v;
    }),
    "兼容把思维链写进正文的预设，避免把思考过程算进剧情。"
  ));
  return group;
}
function renderPromptSettings(panel) {
  const wrap = document.createElement("div");
  const doc = promptDocOf(promptDocId) ?? PROMPT_DOCS[0];
  promptDocId = doc.id;
  const hasMany = !!doc.defaults.many;
  const variant = hasMany ? promptVariant : "single";
  const settings2 = getSettings(DEFAULT_SETTINGS);
  const overrides = settings2.promptOverrides ?? {};
  const customized = isCustomized(doc.id, variant, overrides);
  const current = resolveTemplate(doc.id, variant, overrides);
  wrap.appendChild(section(
    "内置提示词",
    "这就是插件「读剧情」时发给模型的原话（不含柏宝绘自定义提示词与角色库，那两段另行注入）。留空保存 = 恢复内置默认。"
  ));
  const chips = document.createElement("div");
  chips.className = "sti-prompt-chips";
  for (const item of PROMPT_DOCS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `sti-prompt-chip${item.id === doc.id ? " active" : ""}`;
    btn.textContent = item.label;
    if (isCustomized(item.id, "single", overrides) || item.defaults.many && isCustomized(item.id, "many", overrides)) {
      const dot = document.createElement("span");
      dot.className = "sti-prompt-dot";
      dot.title = "这一套有自定义版本";
      btn.appendChild(dot);
    }
    btn.addEventListener("click", () => {
      promptDocId = item.id;
      promptVariant = "single";
      render(panel, "prompts");
    });
    chips.appendChild(btn);
  }
  wrap.appendChild(chips);
  if (hasMany) {
    const seg = document.createElement("div");
    seg.className = "sti-prompt-seg";
    for (const [value, label] of [["single", "单格"], ["many", "多格"]]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `sti-prompt-seg-btn${variant === value ? " active" : ""}`;
      btn.textContent = label;
      const marked = isCustomized(doc.id, value, overrides);
      if (marked) {
        const dot = document.createElement("span");
        dot.className = "sti-prompt-dot";
        dot.title = "这一版已自定义";
        btn.appendChild(dot);
      }
      btn.addEventListener("click", () => {
        promptVariant = value;
        render(panel, "prompts");
      });
      seg.appendChild(btn);
    }
    wrap.appendChild(seg);
  }
  const hint = document.createElement("div");
  hint.className = "sti-config-sub";
  hint.textContent = doc.hint;
  wrap.appendChild(hint);
  const area = document.createElement("textarea");
  area.className = "sti-prompt-area";
  area.value = current;
  area.spellcheck = false;
  area.rows = 20;
  wrap.appendChild(area);
  const vars = document.createElement("div");
  vars.className = "sti-prompt-vars";
  vars.textContent = `可用变量：${doc.vars.map((v) => `{{${v}}}`).join("  ")} · 条件段写法 {{#name}}…{{/name}}（成立才保留）/ {{^name}}…{{/name}}（不成立才保留）`;
  wrap.appendChild(vars);
  const bar = document.createElement("div");
  bar.className = "sti-prompt-actions";
  const state2 = document.createElement("span");
  state2.className = `sti-prompt-state${customized ? " is-custom" : ""}`;
  state2.textContent = customized ? "● 已自定义" : "○ 内置默认";
  bar.appendChild(state2);
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "sti-prompt-btn";
  reset.textContent = "恢复默认";
  reset.disabled = !customized;
  reset.addEventListener("click", () => {
    const next = { ...getSettings(DEFAULT_SETTINGS) };
    const map = { ...next.promptOverrides ?? {} };
    delete map[overrideKey(doc.id, variant)];
    next.promptOverrides = map;
    saveSettings(next);
    render(panel, "prompts");
  });
  bar.appendChild(reset);
  const save = document.createElement("button");
  save.type = "button";
  save.className = "sti-prompt-btn is-primary";
  save.textContent = "保存";
  save.addEventListener("click", () => {
    const next = { ...getSettings(DEFAULT_SETTINGS) };
    const map = { ...next.promptOverrides ?? {} };
    const value = area.value.trim();
    if (!value) delete map[overrideKey(doc.id, variant)];
    else map[overrideKey(doc.id, variant)] = value;
    next.promptOverrides = map;
    saveSettings(next);
    render(panel, "prompts");
  });
  bar.appendChild(save);
  wrap.appendChild(bar);
  const note = document.createElement("div");
  note.className = "sti-config-sub sti-prompt-note";
  note.textContent = "改措辞、加规矩都没问题；但 JSON 的字段名（title / characters / tags / nl / cast / panels / lines …）是解析器的契约，改名会让这一块解析不出来。改坏了点「恢复默认」。";
  wrap.appendChild(note);
  return wrap;
}
function renderLogSection() {
  const entries2 = getImageLog();
  const live = getRunStatus();
  const box = section(
    "调用记录",
    "本插件自己记的（内存级，刷新即清）。正文插图/漫画走柏宝绘卡片，也会进它的「请求历史」；小剧场走公开出图接口，只在这里。"
  );
  const liveRow = document.createElement("div");
  liveRow.className = `sti-log-live ${live ? `is-${live.level}` : "is-idle"}`;
  const liveDot = document.createElement("span");
  liveDot.className = "sti-run-dot";
  liveRow.appendChild(liveDot);
  const liveText = document.createElement("span");
  liveText.textContent = live ? runStatusText(live) : "当前没有任务在跑。";
  liveRow.appendChild(liveText);
  box.appendChild(liveRow);
  const bar = document.createElement("div");
  bar.className = "sti-log-bar";
  const count = document.createElement("span");
  const failed = entries2.filter((e) => e.status === "error").length;
  count.textContent = `最近 ${entries2.length} 条（上限 80）${failed ? ` · 失败 ${failed} 条` : ""}`;
  bar.appendChild(count);
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "sti-cs-regen";
  clear.textContent = "清空";
  clear.addEventListener("click", () => {
    clearImageLog();
    showConfigPanel("log");
  });
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "sti-cs-link";
  refresh.textContent = "刷新";
  refresh.style.marginLeft = "8px";
  refresh.addEventListener("click", () => showConfigPanel("log"));
  bar.appendChild(refresh);
  bar.appendChild(clear);
  box.appendChild(bar);
  if (entries2.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sti-config-empty";
    empty.textContent = "还没有记录。生成一次图之后再回来看。";
    box.appendChild(empty);
    return box;
  }
  for (const entry of entries2.slice(0, 40)) {
    box.appendChild(buildLogRow(entry));
  }
  return box;
}
function buildLogRow(entry) {
  var _a;
  const row = document.createElement("details");
  row.className = `sti-log-item ${entry.status === "error" ? "is-error" : ""}`;
  const kindText = entry.kind === "llm" ? "读剧情" : entry.kind === "plan" ? "切方案" : entry.kind === "notice" ? "提示" : "出图";
  const summary = document.createElement("summary");
  summary.className = "sti-log-summary";
  summary.textContent = [
    formatTime(entry.at),
    kindText,
    // 'restore' 不是创作模式，是收尾的「还原方案」——直接显示中文，别让日志里冒英文键名
    entry.mode === "restore" ? "还原方案" : MODE_LABEL[entry.mode] ?? entry.mode,
    entry.kind === "plan" ? "" : `#${entry.floor}`,
    entry.kind === "notice" ? "" : entry.status === "error" ? "失败" : "成功",
    entry.durationMs !== void 0 ? `${(entry.durationMs / 1e3).toFixed(1)}s` : "",
    entry.plan ? `方案 ${entry.plan}` : "",
    entry.seed !== void 0 ? `seed ${entry.seed}` : ""
  ].filter(Boolean).join(" · ");
  row.appendChild(summary);
  const body = document.createElement("div");
  body.className = "sti-log-body";
  if (entry.error) {
    const err = document.createElement("div");
    err.className = "sti-log-error";
    err.textContent = entry.error;
    body.appendChild(err);
  }
  if (entry.kind === "plan") {
    if (entry.prompt) body.appendChild(logField("说明", entry.prompt));
    if (entry.plan) body.appendChild(logField("出图方案", entry.plan));
    row.appendChild(body);
    return row;
  }
  if (entry.kind === "notice") {
    if (entry.prompt) body.appendChild(logField("说明", entry.prompt));
    row.appendChild(body);
    return row;
  }
  body.appendChild(logField("正向", entry.prompt));
  if (entry.nl) body.appendChild(logField("nl", entry.nl));
  if (entry.negative) body.appendChild(logField("负面", entry.negative));
  body.appendChild(logField(
    "角色（柏宝绘角色库）",
    ((_a = entry.characters) == null ? void 0 : _a.length) ? entry.characters.map((c) => `${c.name}：${c.tag}`).join("\n") : "（这次没有带上任何角色外貌 —— 要么模型没写角色，要么名字没对上角色库）"
  ));
  if (entry.plan) body.appendChild(logField("出图方案", entry.plan));
  if (entry.model) body.appendChild(logField("模型", entry.model));
  if (entry.source) body.appendChild(logField("来源", entry.source === "card" ? "柏宝绘卡片" : "公开出图接口"));
  row.appendChild(body);
  return row;
}
function logField(label, value) {
  const wrap = document.createElement("div");
  wrap.className = "sti-log-field";
  const head = document.createElement("div");
  head.className = "sti-log-field-label";
  head.textContent = label;
  const text = document.createElement("div");
  text.className = "sti-log-field-value";
  text.textContent = value;
  wrap.appendChild(head);
  wrap.appendChild(text);
  return wrap;
}
function formatTime(at) {
  const d = new Date(at);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function activeModel(snap) {
  var _a;
  return ((_a = snap.plans.find((p) => p.id === snap.activePlanId)) == null ? void 0 : _a.model) || "(未配置)";
}
function activeEndpointName(snap) {
  const p = snap.plans.find((x) => x.id === snap.activePlanId);
  return (p == null ? void 0 : p.endpointName) || "(未配置)";
}
function maskUrl(url) {
  if (!url) return "(未填地址)";
  return url.length > 42 ? url.slice(0, 42) + "…" : url;
}
function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}
function destroyConfigPanel() {
  if (panelEl) {
    panelEl.remove();
    panelEl = null;
  }
  if (overlayEl) {
    overlayEl.remove();
    overlayEl = null;
  }
  destroyWandMenu();
}
const ARTIFACTS_KEY = "sti_artifacts";
const CHAT_META_KEY = "STStoryIllustrator";
const SCHEMA_VERSION = 1;
function readStore$2(raw) {
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
  return readStore$2(extra[ARTIFACTS_KEY]).artifacts;
}
function appendArtifact(floor, artifact) {
  const msg = getMessage(floor);
  if (!msg) return false;
  if (!msg.extra) msg.extra = {};
  const extra = msg.extra;
  const store = readStore$2(extra[ARTIFACTS_KEY]);
  store.artifacts.push(artifact);
  store.version = SCHEMA_VERSION;
  extra[ARTIFACTS_KEY] = store;
  touchChatIndex();
  return true;
}
function updateArtifact(floor, artifactId, patch) {
  const msg = getMessage(floor);
  if (!(msg == null ? void 0 : msg.extra)) return false;
  const extra = msg.extra;
  const store = readStore$2(extra[ARTIFACTS_KEY]);
  let found = false;
  store.artifacts = store.artifacts.map((a) => {
    if (a.id !== artifactId) return a;
    found = true;
    return { ...a, ...patch };
  });
  if (!found) return false;
  extra[ARTIFACTS_KEY] = store;
  touchChatIndex();
  return true;
}
function touchChatIndex() {
  const index2 = getChatMetadata(CHAT_META_KEY, { version: SCHEMA_VERSION, updatedAt: 0, count: 0 });
  touchChatMetadata(CHAT_META_KEY, {
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
const MANWA_TAG_NAME = "bbi_manwa";
const MANWA_SLOT_SELECTOR = "div[data-sti-manwa-slot]";
const MANWA_TAG_REGEX = /<bbi_manwa>[\s\S]+?<\/bbi_manwa>/gi;
const MANWA_SLOT_REGEX_ID = "sti-manwa-tag-slot";
const MANWA_HIDE_REGEX_ID = "sti-manwa-tag-hide";
function sanitizeId(id) {
  return String(id ?? "").replace(/[^\w-]/g, "").slice(0, 64);
}
function buildManwaTag(artifactId) {
  const id = sanitizeId(artifactId);
  if (!id) return "";
  return `<${MANWA_TAG_NAME}><id>${id}</id></${MANWA_TAG_NAME}>`;
}
function parseManwaTags(mes) {
  var _a;
  const text = String(mes ?? "");
  const out = [];
  const re = new RegExp(MANWA_TAG_REGEX.source, "gi");
  let match;
  while ((match = re.exec(text)) !== null) {
    const raw = match[0];
    const id = sanitizeId(((_a = /<id>([\s\S]*?)<\/id>/i.exec(raw)) == null ? void 0 : _a[1]) ?? "");
    if (id) out.push({ id, raw });
  }
  return out;
}
function lastManwaTagEnd(mes) {
  const text = String(mes ?? "");
  const re = new RegExp(MANWA_TAG_REGEX.source, "gi");
  let end = 0;
  let match;
  while ((match = re.exec(text)) !== null) end = match.index + match[0].length;
  return end;
}
const PLACEMENTS = [1, 2, 3];
const FIND_REGEX_LITERAL = "/<bbi_manwa>[\\s\\S]+?<\\/bbi_manwa>/gi";
function manwaSlotScript() {
  return {
    id: MANWA_SLOT_REGEX_ID,
    scriptName: "故事配图 · 漫画占位",
    findRegex: FIND_REGEX_LITERAL,
    replaceString: '<div data-sti-manwa-slot=""></div>',
    trimStrings: [],
    placement: [...PLACEMENTS],
    disabled: false,
    markdownOnly: true,
    promptOnly: false,
    runOnEdit: true,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null
  };
}
function manwaHideScript() {
  return {
    id: MANWA_HIDE_REGEX_ID,
    scriptName: "故事配图 · 隐藏漫画标签",
    findRegex: FIND_REGEX_LITERAL,
    replaceString: "",
    trimStrings: [],
    placement: [...PLACEMENTS],
    disabled: false,
    markdownOnly: false,
    promptOnly: true,
    runOnEdit: true,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null
  };
}
const MANAGED_SCRIPTS = [manwaSlotScript, manwaHideScript];
function ensureManwaRegexRegistered() {
  var _a;
  const ctx = getContext();
  const settings2 = ctx == null ? void 0 : ctx.extensionSettings;
  if (!settings2) return false;
  if (!Array.isArray(settings2.regex)) settings2.regex = [];
  const list = settings2.regex;
  for (const make of MANAGED_SCRIPTS) {
    const script = make();
    const index2 = list.findIndex((item) => (item == null ? void 0 : item.id) === script.id);
    if (index2 >= 0) list[index2] = { ...list[index2], ...script };
    else list.push(script);
  }
  try {
    (_a = ctx.saveSettingsDebounced) == null ? void 0 : _a.call(ctx);
  } catch {
  }
  return true;
}
function isManwaRegexRegistered() {
  var _a;
  const ctx = getContext();
  const list = (_a = ctx == null ? void 0 : ctx.extensionSettings) == null ? void 0 : _a.regex;
  if (!Array.isArray(list)) return false;
  return MANAGED_SCRIPTS.every((make) => list.some((item) => (item == null ? void 0 : item.id) === make().id));
}
async function insertManwaTag(input) {
  const { floor, chatId, swipeId, sendDate, tag, anchorText } = input;
  if (!tag) return { ok: false, reason: "no-context" };
  const ctx = getContext();
  if (!Array.isArray(ctx.chat) || typeof ctx.saveChat !== "function") return { ok: false, reason: "no-context" };
  if (getCurrentChatId() !== chatId) return { ok: false, reason: "chat-changed" };
  const msg = ctx.chat[floor];
  if (!msg || typeof msg.mes !== "string") return { ok: false, reason: "floor-changed" };
  if (sendDate) {
    const actual = typeof msg.send_date === "string" ? msg.send_date.trim() : "";
    if (actual && actual !== sendDate) return { ok: false, reason: "floor-changed" };
  }
  const curSwipe = typeof msg.swipe_id === "number" ? msg.swipe_id : 0;
  if (curSwipe !== swipeId) return { ok: false, reason: "swipe-changed" };
  const currentText = msg.mes;
  if (currentText.includes(tag)) {
    await refreshFloor$1(ctx, floor, msg);
    return { ok: true, position: "after-anchor" };
  }
  const snippet = `

${tag}
`;
  const range = anchorText && anchorText.length >= 2 ? findAnchorRange(currentText, anchorText) : null;
  const anchorAt = range ? lineEndAfter(currentText, range.end) : -1;
  const tail = lastManwaTagEnd(currentText);
  let nextText;
  let position;
  if (anchorAt >= 0) {
    const insertAt = tail > anchorAt ? lineEndAfter(currentText, tail) : anchorAt;
    const head = currentText.slice(0, insertAt).replace(/[ \t]+$/, "");
    nextText = head + snippet + currentText.slice(insertAt);
    position = "after-anchor";
  } else {
    nextText = `${currentText.trimEnd()}${snippet}`;
    position = "appended";
  }
  msg.mes = nextText;
  const swipes = msg.swipes;
  if (Array.isArray(swipes) && swipeId >= 0 && swipeId < swipes.length) swipes[swipeId] = nextText;
  try {
    await ctx.saveChat();
  } catch {
    msg.mes = currentText;
    if (Array.isArray(swipes) && swipeId >= 0 && swipeId < swipes.length) swipes[swipeId] = currentText;
    return { ok: false, reason: "save-failed" };
  }
  await refreshFloor$1(ctx, floor, msg);
  return { ok: true, position };
}
async function refreshFloor$1(ctx, floor, msg) {
  var _a;
  try {
    if (typeof ctx.updateMessageBlock === "function") {
      await ctx.updateMessageBlock(floor, msg);
    }
  } catch {
  }
  try {
    const types = getEventTypes();
    (_a = ctx.eventSource) == null ? void 0 : _a.emit(types.MESSAGE_UPDATED ?? "message_updated", floor);
  } catch {
  }
}
function manwaAnchors(floor) {
  const mesText = document.querySelector(`.mes[mesid="${floor}"] .mes_text`);
  if (!mesText) return [];
  return [...mesText.querySelectorAll(MANWA_SLOT_SELECTOR)];
}
function toBaiBaiRequest(input, character) {
  const size = input.size === "landscape" ? "landscape" : "portrait";
  const group = input.character || character;
  return {
    prompt: input.prompt,
    ...input.nl ? { nl: input.nl } : {},
    ...input.negative ? { negative: input.negative } : {},
    ...input.characters && input.characters.length ? { characters: input.characters } : {},
    size,
    ...typeof input.seed === "number" ? { seed: input.seed } : {},
    save: input.save !== false,
    ...group ? { character: group } : {}
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
async function readBackendState() {
  return await getBackendStatus();
}
let switchPlan = (planId, options) => switchBaiBaiPlan(planId, options);
let savedPlanId = null;
let savedPlanName = "";
let holders = 0;
function acquirePlanGuard() {
  holders += 1;
}
async function ensureModeOutPlan(mode, settings2) {
  var _a;
  const planId = (_a = settings2.modeOutPlans) == null ? void 0 : _a[mode];
  if (!planId) return;
  const snap = readOutConfig();
  const target = snap.plans.find((p) => p.id === planId);
  if (!target) {
    const message = `${MODE_LABEL$1[mode]} 指定的出图方案已不存在（可能已在柏宝绘里删除）。请到「配图设置 → 小剧场 → 出图方案」重新指定。`;
    recordPlanSwitch({ mode, plan: planId.slice(0, 8), status: "error", detail: message });
    throw new Error(message);
  }
  if (snap.activePlanId === planId) return;
  if (savedPlanId === null) {
    savedPlanId = snap.activePlanId || "";
    savedPlanName = snap.activePlanName || "";
  }
  let result;
  try {
    result = await switchPlan(planId);
  } catch (e) {
    const detail = `${MODE_LABEL$1[mode]} 切换出图方案「${target.name}」时出错：${e instanceof Error ? e.message : String(e)}`;
    recordPlanSwitch({ mode, plan: target.name, status: "error", detail });
    throw new Error(detail);
  }
  if (!result.ok) {
    const detail = `${MODE_LABEL$1[mode]} 无法切到出图方案「${target.name}」：${result.message}`;
    recordPlanSwitch({ mode, plan: target.name, status: "error", detail });
    throw new Error(detail);
  }
  recordPlanSwitch({ mode, plan: target.name, status: "ok", detail: result.message });
}
const RESTORE_ATTEMPTS = 2;
const RESTORE_RETRY_MS = 700;
function sleep$1(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function warnUser(text) {
  var _a;
  const toastr = globalThis.toastr;
  try {
    (_a = toastr == null ? void 0 : toastr.warning) == null ? void 0 : _a.call(toastr, text);
  } catch {
  }
}
async function restoreOutPlan(settings2) {
  const target = savedPlanId;
  const targetName = savedPlanName;
  savedPlanId = null;
  savedPlanName = "";
  if (!target) return { ok: true };
  if (settings2.restorePlanAfterTask === false) {
    recordPlanSwitch({ mode: "restore", plan: targetName, status: "ok", detail: "已关闭「出图后还原方案」，保留当前方案。" });
    return { ok: true };
  }
  let lastMessage = "";
  for (let attempt = 1; attempt <= RESTORE_ATTEMPTS; attempt += 1) {
    try {
      const result = await switchPlan(target, { force: true, timeoutMs: 12e3 });
      if (result.ok) {
        const detail = attempt === 1 ? result.message : `${result.message}（第 ${attempt} 次尝试）`;
        recordPlanSwitch({ mode: "restore", plan: targetName || target, status: "ok", detail });
        return { ok: true };
      }
      lastMessage = result.message;
    } catch (e) {
      lastMessage = e instanceof Error ? e.message : String(e);
    }
    if (attempt < RESTORE_ATTEMPTS) await sleep$1(RESTORE_RETRY_MS);
  }
  const message = `出图已完成，但没能把柏宝绘的方案切回「${targetName || target}」：${lastMessage}。现在它停在这次出图用的那套上——请到柏宝绘「渠道 → NAI」手动切回，否则接下来的正文插图也会用这套模型与画师串。`;
  recordPlanSwitch({ mode: "restore", plan: targetName || target, status: "error", detail: message });
  recordNotice({ mode: "restore", floor: 0, text: message });
  warnUser("配图：方案没能切回原样，请到柏宝绘里手动切回。");
  return { ok: false, message };
}
async function releasePlanGuard(settings2) {
  holders = Math.max(0, holders - 1);
  if (holders > 0) return { ok: true, deferred: true };
  return restoreOutPlan(settings2);
}
const THINK_BLOCK = /<think(?:ing)?>[\s\S]*?(?:<\/think(?:ing)?>|$)/gi;
function stripThinkingBlocks(raw) {
  const text = String(raw ?? "");
  if (!/<think/i.test(text)) return text;
  return text.replace(THINK_BLOCK, "").trim();
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
function looksEnglish(text) {
  return /[A-Za-z]/.test(text) && !/[\u3040-\u30ff\u3400-\u9fff]/.test(text);
}
function characterTagOf(entry) {
  const fields = entry.fields ?? {};
  const order = ["sex", "hair", "eyes", "skin", "body", "extra", "outfit"];
  const parts = order.map((key) => String(fields[key] ?? "").trim()).filter(Boolean);
  if (parts.length) return parts.join(", ");
  const raw = String(entry.tag ?? "").trim();
  if (raw) return raw;
  for (const candidate of [String(entry.desc ?? "").trim(), String(entry.nl ?? "").trim()]) {
    if (candidate && looksEnglish(candidate)) return candidate;
  }
  return "";
}
function characterPromptsFromLibrary(names, library, acts, looks) {
  const byName = new Map(library.map((entry) => [entry.name, entry]));
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const raw of names) {
    const name = String(raw ?? "").trim();
    if (!name || seen.has(name)) continue;
    const entry = byName.get(name);
    const appearance = entry ? characterTagOf(entry) : "";
    if (!appearance) {
      const supplied = String((looks == null ? void 0 : looks.get(name)) ?? "").trim();
      if (!supplied) continue;
      const extraTags = ((acts == null ? void 0 : acts.get(name)) ?? []).map((a) => String(a ?? "").trim()).filter(Boolean);
      seen.add(name);
      out.push({ name, tag: [supplied, ...extraTags].join(", ") });
      if (out.length >= 32) break;
      continue;
    }
    const extra = ((acts == null ? void 0 : acts.get(name)) ?? []).map((a) => String(a ?? "").trim()).filter(Boolean);
    const tag = [appearance, ...extra].join(", ");
    seen.add(name);
    const nl = String((entry == null ? void 0 : entry.nl) ?? "").trim();
    out.push({ name, tag, ...nl ? { nl } : {} });
    if (out.length >= 32) break;
  }
  return out;
}
function ensurePageCast(page, library, selectedText = "", looks) {
  const usable = library.filter((c) => String(c.name ?? "").trim() && characterTagOf(c));
  const looked = new Set([...(looks == null ? void 0 : looks.keys()) ?? []].map((n) => String(n).trim()).filter(Boolean));
  if (!usable.length && !looked.size) return [];
  const usableByName = new Map(usable.map((c) => [String(c.name).trim(), c]));
  const picked = [];
  const add = (name) => {
    const clean = String(name ?? "").trim();
    if (!clean || picked.includes(clean) || picked.length >= 2) return;
    if (!usableByName.has(clean) && !looked.has(clean)) return;
    picked.push(clean);
  };
  for (const panel of page.panels ?? []) {
    for (const c of panel.characters ?? []) add((c == null ? void 0 : c.name) ?? "");
  }
  if (picked.length >= 2) return picked;
  const pageText = [
    page.tags ?? "",
    ...(page.panels ?? []).map((p) => `${p.tags ?? ""} ${p.title ?? ""} ${p.nl ?? ""}`),
    selectedText
  ].join(" ");
  const mentioned = [...usable.map((c) => String(c.name).trim()), ...looked].filter((name) => !picked.includes(name) && pageText.includes(name));
  mentioned.forEach(add);
  if (picked.length || usable.length > 2) return picked;
  usable.forEach((c) => add(String(c.name)));
  return picked;
}
const PERSONA_ALIASES = [
  "你",
  "您",
  "我",
  "user",
  "{{user}}",
  "the user",
  "player",
  "protagonist",
  "主角",
  "主人公"
];
function nameKey(value) {
  return String(value ?? "").replace(/\s+/g, "").toLowerCase();
}
function resolveCastNames(names, library, options = {}) {
  const looks = new Map(options.looks ?? []);
  const acts = new Map(
    [...options.acts ?? []].map(([key, list]) => [key, [...list]])
  );
  const usable = library.filter((c) => String(c.name ?? "").trim() && characterTagOf(c));
  const byKey = new Map(usable.map((c) => [nameKey(String(c.name)), String(c.name).trim()]));
  const personaName = String(options.personaName ?? "").trim();
  const personaKey = nameKey(personaName);
  let personaEntry = personaKey ? usable.find((c) => nameKey(String(c.name)) === personaKey) : void 0;
  if (!personaEntry && personaKey) {
    const partial = usable.filter((c) => {
      const key = nameKey(String(c.name));
      return key.length >= 2 && (personaKey.includes(key) || key.includes(personaKey));
    });
    if (partial.length === 1) personaEntry = partial[0];
  }
  const personaResolved = personaEntry ? String(personaEntry.name).trim() : personaName;
  const aliasKeys = new Set(PERSONA_ALIASES.map(nameKey));
  if (personaKey) aliasKeys.add(personaKey);
  if (personaResolved) aliasKeys.add(nameKey(personaResolved));
  const cast = [];
  const push2 = (name) => {
    const clean = String(name ?? "").trim();
    if (!clean || cast.includes(clean)) return;
    cast.push(clean);
  };
  for (const raw of names) {
    const clean = String(raw ?? "").trim();
    if (!clean) continue;
    const key = nameKey(clean);
    if (aliasKeys.has(key)) {
      const supplied = looks.get(clean);
      if (supplied && personaResolved && !looks.has(personaResolved)) looks.set(personaResolved, supplied);
      if (personaResolved) {
        const personaActs = acts.get(clean);
        if (personaActs == null ? void 0 : personaActs.length) {
          const merged = acts.get(personaResolved) ?? [];
          for (const act of personaActs) if (!merged.includes(act)) merged.push(act);
          acts.set(personaResolved, merged);
          acts.delete(clean);
        }
        push2(personaResolved);
        continue;
      }
      push2(clean);
      continue;
    }
    push2(byKey.get(key) ?? clean);
  }
  const declared = Math.max(0, Math.round(Number(options.declared) || 0));
  const max = Math.max(1, Math.min(4, Math.round(Number(options.max) || 3)));
  if (declared >= 2 && cast.length < Math.min(declared, max)) {
    if (personaResolved && !cast.includes(personaResolved)) {
      if (personaEntry || looks.has(personaResolved) || looks.get(personaName)) {
        if (!looks.has(personaResolved) && looks.get(personaName)) {
          looks.set(personaResolved, looks.get(personaName));
        }
        push2(personaResolved);
      }
    }
  }
  if (declared >= 2 && cast.length < Math.min(declared, max) && usable.length <= 2) {
    for (const entry of usable) {
      if (cast.length >= Math.min(declared, max)) break;
      push2(String(entry.name));
    }
  }
  return { cast, looks, acts };
}
function splitSegments(segments, native) {
  const all = [...segments];
  if (!native) {
    return { base: composeEnglishPrompt(all), characters: [], fallback: false };
  }
  const characterSegs = all.filter((seg) => seg.source === "character" && !!String(seg.characterName ?? "").trim());
  const baseSegs = all.filter((seg) => !characterSegs.includes(seg));
  const base = composeEnglishPrompt(baseSegs);
  const byName = /* @__PURE__ */ new Map();
  for (const seg of characterSegs) {
    const name = String(seg.characterName ?? "").trim();
    const list = byName.get(name) ?? [];
    list.push(...seg.english);
    byName.set(name, list);
  }
  const characters = [];
  for (const [name, tags] of byName) {
    const seen = /* @__PURE__ */ new Set();
    const kept = [];
    for (const raw of tags) {
      const piece = raw.trim();
      if (!piece) continue;
      const bare = piece.replace(/^\s*[\d.]+\s*::/, "").replace(/^\s*::/, "").replace(/::\s*$/, "").trim().toLowerCase();
      if (bare && seen.has(bare)) continue;
      if (bare) seen.add(bare);
      kept.push(piece);
    }
    if (kept.length) characters.push({ name, tag: kept.join(", ") });
  }
  if (!base.trim() || characters.length === 0) {
    return { base: composeEnglishPrompt(all), characters: [], fallback: true };
  }
  return { base, characters, fallback: false };
}
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
const PANEL_SELF_CHECK = "【输出前自检，逐条核对后再输出】\n- tag 里是否原样包含了本档要求的构图词（含权重写法）？漏了必须补上。\n- nl 的第一句是否说清了版面？只描述画面内容而不提版面，等于没写。\n- 景别 tag 是否只有一个？\n- 每一格是否写了 nl，且相邻两格的镜头距离、信息点都不一样？（两格画同一个动作 = 白画一格）\n- 这是漫画分镜图，不是一张普通插画。任何一条不满足，就重写再输出。";
const PANEL_ART_CLAUSE = "【分镜设计（每一格都要过一遍，这是漫画好不好看的分水岭）】\n- **镜头距离要分配**：整页至少一格交代空间（wide shot / full body，看得到环境与两人的相对位置），至少一格推近（close-up 或 extreme close-up：脸、手、接触点、关键道具）。相邻两格不许用同一个景别。\n- **每格的信息点必须不同**：建立空间 / 动作发生 / 反应表情 / 细节放大，四种角色轮着来；同一页里四格才允许出现两次同类，而且必须换机位。\n- **禁止重播**：两格不许画同一个姿势、同一个动作。至少换掉「谁在动」「动的是哪只手/哪一侧」「镜头在人物哪一边」里的两项。\n- **每格都要写 nl**（一句，20~35 词），必须写清四件事：镜头距离 + 谁在画面哪一侧 + 正在做什么 + 画面的空白留在哪。只写「两人在桌边」这种没有镜头信息的句子，两格就会长得一模一样。\n- **留白是版面的一部分**：格间只留细黑 gutter，白底档的小格与主画之间留宽白边；人物不要填满每一个角，大面积空白不是浪费，是让读者的眼睛休息、也是气泡要落的地方。\n- **人物大小要有变化**：远景里人小、特写里脸大，不要每格都是半身居中。";
const PANEL_NO_POS_CLAUSE = "分格图不需要 pos：NAI 的坐标是整张图的坐标系，一格里的角色会被拉到整图某个位置、也就是被拉出格子。这个字段整个省略。";
function compositionTags(layout) {
  return PANEL_TAGS_BY_LAYOUT[layout].join(", ");
}
function resolvePanelsPerPage(layout, value) {
  const v = Number(value);
  if (Number.isFinite(v) && v >= 2 && v <= 4) return Math.round(v);
  if (normalizeLayoutChoice(layout) === "auto") return 0;
  return normalizePanelLayout(layout) === "regular" ? 2 : 0;
}
function panelTagsForCount(layout, count) {
  const kind = normalizePanelLayout(layout);
  if (kind === "regular" && count >= 3) {
    return ["1.4::multiple views::", "1.5::split screen::", `1.4::${count >= 4 ? 4 : 3}koma::`];
  }
  return PANEL_TAGS_BY_LAYOUT[kind];
}
function normalizePanelLayout(v) {
  return v === "irregular" || v === "inset" || v === "unframed" ? v : "regular";
}
function normalizeLayoutChoice(v) {
  return v === "regular" || v === "irregular" || v === "inset" || v === "unframed" ? v : "auto";
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
    const panelRaw = typeof item.panel === "string" ? Number(item.panel) : item.panel;
    const panel = typeof panelRaw === "number" && Number.isFinite(panelRaw) && panelRaw >= 0 && panelRaw <= 8 ? Math.round(panelRaw) : void 0;
    const dirRaw = typeof item.dir === "string" ? item.dir.trim().toLowerCase() : "";
    const dir = dirRaw === "v" || dirRaw === "h" ? dirRaw : void 0;
    const moodRaw = typeof item.mood === "string" ? item.mood.trim().toLowerCase() : "";
    const mood = moodRaw === "shout" || moodRaw === "whisper" || moodRaw === "calm" ? moodRaw : void 0;
    items.push({
      ...speaker ? { speaker } : {},
      ...area ? { area } : {},
      ...panel ? { panel } : {},
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
    portrait: "A manga page on a white background: an unframed character illustration occupies the center with generous white space around it, and small panels framed by thin black borders — one across the top, one in the bottom right corner — show close-up details of the same moment, each small panel floating on the white page with a wide clean white gap between it and the main illustration, never touching the characters.",
    landscape: "A manga page on a white background: an unframed character illustration occupies the center with generous white space around it, and small panels framed by thin black borders — one across the top, one along the right edge — show close-up details of the same moment, each small panel floating on the white page with a wide clean white gap between it and the main illustration, never touching the characters."
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
  const format = mode === "json" ? '页对象上加 `dialogue` 字段，形如 `[{"text":"放学一起走吗？","speaker":"旁白里的名字","panel":2,"area":"tl"}]`' : '在该条生图标签里写子标签 `<dialogue>[{"text":"放学一起走吗？","speaker":"名字","panel":2,"area":"tl"}]</dialogue>`';
  return `【对白气泡】这一张是漫画页，剧情里「谁说了什么」值得画进图时，${format}。
   - text：简短中文口语，一条不超过 20 个字；最多 4 条，${DIALOGUE_POLICY_TEXT[policy]}；
   - panel：这一句出现在**第几格**（1 起，按阅读顺序）。气泡只会画在这一格里，
     所以必须和该格 characters 里说话的人对得上；分不清就省略，省略时按顺序分配；
   - speaker：说话人的名字（照抄 characters 里的写法）。不会画进气泡，只用来定位；
   - area：气泡在本格里的粗略方位（tl/tc/tr/ml/mr/bl/bc/br），按说话人位置挑，可省略；
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
function regularMultiRule(nlOn, count) {
  const n = count >= 4 ? 4 : 3;
  const shape = n === 4 ? "上方两格、下方两格（2×2 四等分，每格约占页面四分之一）" : "上方一条宽格（约页面 40% 高度），下方左右两个等宽格";
  const leads = n === 4 ? '"In the top-left panel, ..." / "In the top-right panel, ..." / "In the bottom-left panel, ..." / "In the bottom-right panel, ..."' : '"In the upper panel, ..." / "In the lower left panel, ..." / "In the lower right panel, ..."';
  const ninth = nlOn ? `9. nl 必须按格写：先一句总述版面（${n} 格怎么分），之后逐格一句，用 ${leads} 这类句式。不要用 Panel 1 / Panel 2 编号，也不要写对白。` : "9. 本次没有 nl 通道：格内容只能靠 tag 表达，让人物动作在格与格之间发生变化。";
  return [
    `[漫画分镜｜一张画布切${n}格]`,
    "",
    `这一张是${n}格漫画，不是普通插画：同一张画布被细黑边框切成 ${n} 格，读者从上往下、从左往右读。所有格讲同一件事的不同层，不是${n}件不相干的事。`,
    "",
    `1. 构图 tag 必须写全这三个，原样照抄（含权重写法），一个都不能少，紧跟人数 tag、排在外貌之前：${compositionTags("regular").replace("2koma", `${n}koma`)}。 不要写 panel layout、comic panel、manga（0 帖空 tag）；也不要写 comic（整本漫画语义，会拉成黑白网点）。`,
    `2. 版面：${shape}。格间只留细黑 gutter（约页宽 3%），人物画大撑到格边，所有格合计覆盖页面九成以上。`,
    "3. 相邻两格至少要有两个肉眼可辨的差异（人在做的事、画面里的东西、远近）；只有一个差异会被当噪声抹平。",
    "4. 景别 tag 仍然只写一个，用 cowboy shot 或 full body；各格各自的远近写在 nl 里。",
    `5. ${n} 格里出现的人必须一致，同一个人在所有格保持同一套外观词。`,
    `6. 画幅写 portrait：${n} 格按上面说的排法铺满整页。不要写 landscape。`,
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
    "4. 特写小格 1～2 个，带细黑边框浮在白边上：顶部横条（宽约全宽、高约 15~20%）装脸部特写；贴边小格（右侧或右下角、宽约三分之一）装手/接触点。**小格与主画之间必须留出宽白边**（至少约页高 5%、页宽 4% 的纯白），小格绝不贴着人物或主画边缘——挤在一起会糊成一坨，读者分不清哪格是哪格。小格来自主画面同一瞬间、同一套外观词。",
    "5. 景别 tag 仍然只写一个（cowboy shot 或 full body）；小格特写写在 nl 里。",
    "6. 画幅写 portrait：白底竖页，人物居中占主要位置；顶部横条贴上边缘、与主画之间留白；贴边小格在右下角、与主画之间留白。",
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
function autoRule(nlOn, panels) {
  const table = [
    `- "regular"（规整等分）：构图词 ${compositionTags("regular")}。2 格上下等分；3 格是上方一条宽格 + 下方左右两格。适合「同一个动作的上下两拍」「一问一答」「递进（上格动作、下格结果）」，最稳、最容易画对，**有场景、有道具、有互动就用它**。`,
    `- "irregular"（大小不等拼版）：构图词 ${compositionTags("irregular")}。2～4 格，至少一格面积是另一格两倍以上。适合有主次的场面：一个大格交代全景，一到两个小格给反应或细节。禁止上下各一半这种等分。`,
    `- "inset"（白底人物页 + 带框特写格）：构图词 ${compositionTags("inset")}。白底、只有人物，**几乎没有场景**（环境最多一两件小道具）；2~3 个带细黑框的小格浮在白边上。**只有「纯情绪、纯独白、没有地点可画」的页才用它**；有餐厅/教室/街道这类明确地点时用它是错的，会把场景全删掉。`,
    `- "unframed"（白底无框大字插画 + 带框特写格）：构图词 ${compositionTags("unframed")}。主插画无边框、人物占画面八成以上、手臂伸到页外；只有特写格带框。最像日系漫画的跨页感，适合名场面、情绪爆点。`
  ].join("\n");
  const ninth = nlOn ? "9. 先按你选的档位写 nl 的第一句版面句（regular/irregular 说清怎么分格、inset/unframed 说清白底主画与特写格的位置），再**逐格写一句该格自己的 nl**（镜头 + 谁在哪 + 在做什么 + 空白在哪）。不要用 Panel 1 / Panel 2 编号，不要写对白。" : "9. 本次没有 nl 通道：各格内容只能靠 tag 表达，让人物动作与镜头在格与格之间发生变化。";
  return [
    "[漫画分镜｜版面自选]",
    "",
    "这一张是一页漫画：一页 = 一张图，整页由 NovelAI 一次画成多格版面，不是一格一张图。",
    "",
    "1. **版面由你按剧情挑**，并在这一页的 `layout` 字段里写出你选的那一档（只能是下面四个值之一）：",
    table,
    "2. 挑法（按顺序判断）：① 这段有明确地点、道具、两人以上的互动 → **regular 或 irregular**，不要用白底档；② 只有人、只有情绪、没有地点可画 → inset（白底为主）或 unframed（跨页感）；③ 拿不准 → regular。",
    "3. **格数默认 3 格**：两拍就说完的用 2 格，有明确的三段（建立空间 → 动作/接触 → 反应或细节）用 3 格，情绪爆点最多 4 格。只画 2 格时，那 2 格必须承担不同的信息（不是同一个动作画两遍）。",
    "3a. 有台词的一页**不要为了留白换档位**：在 regular/irregular 里让人物偏下、格内上方留出安静空白就够了；把有餐厅、教室、街道的页改成白底档，等于把剧情发生的世界全删了。",
    "3b. 无论哪一档，格与格之间只留细黑 gutter（约页宽 3%）；白底档里特写小格与主画之间必须留出宽白边（至少约页高 5%），小格绝不贴在主画上，也不许把每一格都塞满——留白是版面的一部分。",
    panels >= 2 ? `4. **每页固定 ${panels} 格**：不管选哪一档，版面都必须真的切出 ${panels} 格，panels 条数与 nl 分区句数也必须是 ${panels}。` : "4. 格数 2～4（默认 3）。**同一页的 layout、panels 条数、nl 里的分区句数必须三者一致**：说 3 格就真的画 3 格，不能拿两格模板套三段内容。",
    "5. 构图词只照抄你选的那一档那几行，原样保留 1.4:: 这类权重写法；**不要把两档的构图词混着写**（混写必然画出四不像的版面）。",
    "6. 多页时相邻两页不要用同一档，同一档也别连续画同样的格数，节奏会平。",
    "7. 景别 tag 整页只写一个；各格远近写在每格自己的 shot 与 nl 里。",
    "8. 同一批人在每一格保持同一套外观词；focus tag 全图最多 1~2 个。**page.tags 的人数词必须和 characters 条数对得上**：写了 `1girl, 1boy` 就要有两个角色块，否则另一个人的脸没有任何约束，画出来就是陌生人。",
    PANEL_FORBIDDEN_CLAUSE,
    ninth
  ].join("\n");
}
function buildPanelRule(enabled, options) {
  if (!enabled) return "";
  const choice = normalizeLayoutChoice(options.layout);
  const nlOn = options.nl !== false;
  const pageType = normalizePanelPageType(options.pageType);
  let body;
  if (choice === "auto") {
    body = autoRule(nlOn, resolvePanelsPerPage("auto", options.panelsPerPage));
  } else {
    const layout = normalizePanelLayout(choice);
    const panels = resolvePanelsPerPage(layout, options.panelsPerPage);
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
        body = panels >= 3 ? regularMultiRule(nlOn, panels) : regularRule(nlOn);
        break;
    }
  }
  const parts = [body, PANEL_ART_CLAUSE, PANEL_SELF_CHECK];
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
    const look = typeof o.look === "string" ? o.look.replace(/\s+/g, " ").trim().slice(0, 160) : "";
    if (!name) continue;
    out.push(act ? { name, act, ...look && /[A-Za-z]/.test(look) && !/[\u3400-\u9fff]/.test(look) ? { look } : {} } : { name, act: "", ...look && /[A-Za-z]/.test(look) && !/[\u3400-\u9fff]/.test(look) ? { look } : {} });
  }
  return out;
}
function normalizePageLayout(raw, panelCount, fallback) {
  if (raw === "regular" || raw === "irregular" || raw === "inset" || raw === "unframed") return raw;
  if (fallback) return fallback;
  return panelCount >= 3 ? "irregular" : "regular";
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
    ...typeof o.shot === "string" && o.shot.trim() ? { shot: o.shot.trim().slice(0, 60) } : {},
    ...typeof o.subject === "string" && o.subject.trim() ? { subject: o.subject.trim().slice(0, 200) } : {},
    tags,
    ...typeof o.nl === "string" && o.nl.trim() ? { nl: o.nl.trim().slice(0, 2e3) } : {},
    ...(() => {
      const dialogue = normalizeDialogueItems(o.dialogue);
      return dialogue.length ? { dialogue } : {};
    })()
  };
}
function normalizePage(raw, pageIndex, warnings, fallbackLayout) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(`第 ${pageIndex + 1} 页不是对象，已跳过`);
    return null;
  }
  const o = raw;
  const pageTags = typeof o.tags === "string" ? o.tags.trim().slice(0, 4e3) : "";
  const pageNl = typeof o.nl === "string" ? o.nl.trim().slice(0, 4e3) : "";
  const pageDialogue = normalizeDialogueItems(o.dialogue);
  const rawPanels = Array.isArray(o.panels) ? o.panels : [];
  const panels = [];
  for (let i = 0; i < Math.min(rawPanels.length, 12); i += 1) {
    const panel = normalizePanel(rawPanels[i], i);
    if (panel) panels.push(panel);
    else warnings.push(`第 ${pageIndex + 1} 页第 ${i + 1} 格数据无效，已跳过`);
  }
  if (!pageTags && panels.length === 0) {
    warnings.push(`第 ${pageIndex + 1} 页既没有 tags 也没有有效分格，已跳过`);
    return null;
  }
  return {
    pageIndex: typeof o.pageIndex === "number" && Number.isFinite(o.pageIndex) ? Math.max(0, Math.floor(o.pageIndex)) : pageIndex,
    title: typeof o.title === "string" ? o.title.trim().slice(0, 120) : `第 ${pageIndex + 1} 页`,
    layout: normalizePageLayout(o.layout, panels.length, fallbackLayout),
    ...pageTags ? { tags: pageTags } : {},
    ...pageNl ? { nl: pageNl } : {},
    ...pageDialogue.length ? { dialogue: pageDialogue } : {},
    panels
  };
}
function parseComicPagePlan(input, options = {}) {
  const warnings = [];
  let data = input;
  if (typeof data === "string") {
    const trimmed = stripThinkingBlocks(data).trim();
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
    const page = normalizePage(rawPages[i], i, warnings, options.fallbackLayout);
    if (page) pages.push(page);
  }
  return { pages, warnings };
}
function extractJson(text) {
  const raw = stripThinkingBlocks(String(text ?? ""));
  if (!raw.trim()) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const inner = fenced[1].trim();
    if (inner) return inner;
  }
  const start = raw.search(/[\[{]/);
  if (start < 0) return null;
  const open = raw[start];
  const close2 = open === "{" ? "}" : "]";
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
    else if (ch === close2) {
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
function characterToSegment(character, order, includeChinese) {
  const englishTags = characterTagOf(character).split(",").map((t) => t.trim()).filter(Boolean);
  if (englishTags.length === 0) return null;
  const cn = includeChinese && character.nl ? [character.nl.trim()] : includeChinese && character.desc ? [character.desc.trim()] : [];
  const name = String(character.name ?? "").trim() || "角色";
  return {
    id: `char-${order}-${name}`,
    source: "character",
    characterName: name,
    english: englishTags,
    ...cn.length ? { chinese: cn } : {},
    enabled: true,
    order
  };
}
function buildIllustrationSystemPrompt(options, overrides) {
  const hasFlags = !options.includeChinese || !options.includeNegative || !!options.size;
  return renderPromptDoc("illustration", "single", {
    nl: options.includeNl,
    hasFlags,
    noChinese: !options.includeChinese,
    noNl: !options.includeNl,
    noNegative: !options.includeNegative,
    sizeClause: options.size ?? ""
  }, overrides);
}
function ensureCharacterSegments(response, characters, selectedText, includeChinese) {
  const usable = characters.filter((c) => String(c.name ?? "").trim() && characterTagOf(c));
  if (!usable.length) return response;
  const existing = new Set(
    response.segments.filter((seg) => seg.source === "character").map((seg) => String(seg.characterName ?? "").trim()).filter(Boolean)
  );
  const room = Math.max(0, 2 - existing.size);
  if (room === 0) return response;
  const text = String(selectedText ?? "");
  const mentioned = usable.filter((c) => {
    const name = String(c.name).trim();
    return !existing.has(name) && text.includes(name);
  });
  const picked = mentioned.length ? mentioned.slice(0, room) : existing.size === 0 && usable.length <= 2 ? usable.slice(0, room) : [];
  if (!picked.length) return response;
  const segs = [];
  picked.forEach((character, i) => {
    const seg = characterToSegment(character, i - picked.length, includeChinese);
    if (seg) segs.push(seg);
  });
  if (!segs.length) return response;
  return { ...response, segments: [...segs, ...response.segments] };
}
function buildIllustrationUserPrompt(scene, characters, blocks = {}) {
  const parts = [];
  if (blocks.bookBlock) parts.push(blocks.bookBlock);
  parts.push("【本次画面主体（选段，必须以此为准）】\n" + scene.selectedText);
  if (scene.floorText) parts.push("【所在楼层全文（情境参考）】\n" + scene.floorText);
  if (scene.previousText) parts.push("【前文（仅补充，勿当成本画面正在发生的动作）】\n" + scene.previousText);
  if (scene.nextText) parts.push("【后文（仅补充）】\n" + scene.nextText);
  if (blocks.castBlock) parts.push(blocks.castBlock);
  if (blocks.libraryBlock) {
    parts.push(blocks.libraryBlock);
  } else if (characters.length > 0) {
    const lines = characters.filter((c) => !!String(c.name ?? "").trim()).map((c) => `- ${c.name}: ${c.tag || "（没有外貌数据，请按正文写具体）"}${c.nl ? ` (${c.nl})` : ""}`);
    if (lines.length) {
      parts.push("【角色固定外貌（character 段须原样保留其 tag；标注「没有外貌数据」的按正文补）】\n" + lines.join("\n"));
    }
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
function buildComicSystemPrompt(options, overrides) {
  const ruleOptions = {
    panelsPerPage: options.panelsPerPage ?? 0,
    backend: options.backend,
    charPrompts: options.charPrompts,
    nl: options.nl,
    lockedSize: options.lockedSize,
    layout: normalizeLayoutChoice(options.panelLayout),
    pageType: normalizePanelPageType(options.pageType),
    dialogue: options.dialogue,
    dialogueMode: options.dialogueMode,
    dialoguePolicy: normalizeDialoguePolicy(options.dialoguePolicy)
  };
  const rule = buildPanelRule(options.panelMode, ruleOptions);
  const choice = normalizeLayoutChoice(options.panelLayout);
  const fixedPanels = choice === "auto" ? 0 : resolvePanelsPerPage(normalizePanelLayout(choice), options.panelsPerPage);
  return renderPromptDoc("comic", "single", {
    // 方案没有自然语言通道时，整页 nl 分区描述就无从谈起
    nl: options.nl !== false,
    // 不启用分镜时别谈「每页几格」——那一页根本不是漫画页
    fixedPanels: options.panelMode && fixedPanels >= 2,
    panelsPerPage: fixedPanels >= 2 ? fixedPanels : "",
    hasRule: !!rule,
    panelRule: rule,
    maxPages: Math.max(1, Math.min(8, options.maxPages)),
    dialogue: options.dialogue,
    noChinese: !options.includeChinese
  }, overrides);
}
function buildComicUserPrompt(scene, characters, extraInstruction, blocks = {}) {
  const parts = [];
  if (blocks.bookBlock) parts.push(blocks.bookBlock);
  parts.push("【剧情（据此排分镜）】\n" + scene.selectedText);
  if (scene.floorText) parts.push("【所在楼层全文】\n" + scene.floorText);
  if (scene.previousText) parts.push("【前文（仅补充）】\n" + scene.previousText);
  if (scene.nextText) parts.push("【后文（仅补充）】\n" + scene.nextText);
  if (blocks.castBlock) parts.push(blocks.castBlock);
  if (blocks.libraryBlock) {
    parts.push(blocks.libraryBlock);
  } else if (characters.length > 0) {
    const lines = characters.filter((c) => !!String(c.name ?? "").trim()).map((c) => `- ${c.name}: ${c.tag || "（没有外貌数据，请按正文写具体）"}${c.nl ? ` (${c.nl})` : ""}`);
    if (lines.length) parts.push("【在场角色（保持外貌一致）】\n" + lines.join("\n"));
  }
  if (extraInstruction) parts.push("【本次特别要求】\n" + extraInstruction);
  parts.push("请只输出一个 JSON 对象（pages 数组）；一页一张图，tag 写在 page.tags 上，nl 逐格分区写。");
  return parts.join("\n\n");
}
const mainApiLlmCaller = async (system, user) => {
  const prompt = `${system}

---

${user}`;
  return await generateQuietPrompt(prompt);
};
const defaultLlmCaller = async (system, user) => {
  const tagGen = readTagGenChannelId();
  if (!tagGen) return await mainApiLlmCaller(system, user);
  return await generateViaChannelStrict("tagGen", system, user);
};
function makeModeLlmCaller(settings2, mode) {
  const channelId = resolveChannelId(mode, settings2.modeChannels, settings2.llmSource);
  const base = channelId === "main" ? mainApiLlmCaller : async (system, user) => generateViaChannelStrict(channelId, system, user);
  return async (system, user) => base(withSpecPreamble(system, nlForMode(settings2, mode)), user);
}
async function generateIllustrationPlan(input) {
  const caller = input.caller ?? defaultLlmCaller;
  const system = buildIllustrationSystemPrompt(input.options, input.promptOverrides);
  const user = buildIllustrationUserPrompt(input.scene, input.characters ?? [], {
    ...input.bookBlock ? { bookBlock: input.bookBlock } : {},
    ...input.libraryBlock ? { libraryBlock: input.libraryBlock } : {},
    ...input.castBlock ? { castBlock: input.castBlock } : {}
  });
  try {
    const raw = await caller(system, user);
    const parsed = parseIllustrationResponse(raw);
    if (!parsed) {
      return { ok: false, error: "LLM 未返回可解析的结构化 Tag（JSON 解析失败或无有效片段）。" };
    }
    const data = ensureCharacterSegments(
      parsed,
      input.characters ?? [],
      input.scene.selectedText,
      input.options.includeChinese
    );
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
async function generateComicPlan(input) {
  const caller = input.caller ?? defaultLlmCaller;
  const system = buildComicSystemPrompt(input.options, input.promptOverrides);
  const user = buildComicUserPrompt(
    input.scene,
    input.characters ?? [],
    input.options.extraInstruction,
    { ...input.bookBlock ? { bookBlock: input.bookBlock } : {} }
  );
  try {
    const raw = await caller(system, user);
    const parsed = parseComicPagePlan(raw, input.options.panelLayout === "auto" || !input.options.panelLayout ? {} : { fallbackLayout: normalizePanelLayout(input.options.panelLayout) });
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
const FRAMING_TAGS = [
  "extreme close-up",
  "close-up",
  "closeup",
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
const MANGA_STYLE_BLOCKLIST = [
  "screentone",
  "greyscale",
  "grayscale",
  "monochrome",
  "black and white",
  "speech bubble",
  "caption",
  "comic panel",
  "panel layout",
  "thought bubble"
];
const HAS_CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
const MAX_TAGS = 14;
const MAX_TAGS_MANGA = 20;
function framingOf(tag) {
  const hit = FRAMING_TAGS.find((word) => tag === word || tag.includes(word));
  return hit ?? "";
}
function sanitizeStatusTags(raw, options = {}) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  const maxTags = options.maxTags ?? MAX_TAGS;
  let keptFraming = "";
  for (const piece of String(raw ?? "").split(/[,，、\n]/)) {
    let tag = piece.trim().toLowerCase();
    if (!tag) continue;
    tag = tag.replace(/^\(?\s*[\d.]+::/, "").replace(/::$/, "").replace(/^\(|\)$/g, "");
    tag = tag.replace(/:\s*[\d.]+$/, "").trim();
    if (!tag || HAS_CJK.test(tag)) continue;
    const framing = framingOf(tag);
    if (options.allowFraming && framing) {
      if (keptFraming) continue;
      keptFraming = framing;
    } else if (STYLE_BLOCKLIST.some((word) => tag === word || tag.includes(word)) || options.allowFraming && MANGA_STYLE_BLOCKLIST.some((word) => tag === word || tag.includes(word))) {
      continue;
    }
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= maxTags) break;
  }
  return out;
}
function emptyFrame() {
  return { title: "", characters: [], roles: [], mood: "", tags: "", nl: "" };
}
const MAX_OUTFIT_CHARS = 160;
function parseOutfits(record) {
  const out = [];
  const push2 = (name, outfit) => {
    const n = typeof name === "string" ? name.trim() : "";
    const o = typeof outfit === "string" ? outfit.replace(/\s+/g, " ").trim() : "";
    if (!n || !o) return;
    if (out.length >= 4) return;
    if (out.some((item) => item.name === n)) return;
    if (HAS_CJK.test(o)) return;
    out.push({ name: n, outfit: o.slice(0, MAX_OUTFIT_CHARS) });
  };
  const cast = record.cast ?? record.outfits;
  if (Array.isArray(cast)) {
    for (const item of cast) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const rec = item;
      push2(rec.name, rec.outfit ?? rec.current ?? rec.clothing);
    }
  } else if (cast && typeof cast === "object") {
    for (const [name, outfit] of Object.entries(cast)) push2(name, outfit);
  }
  return out;
}
const MAX_LOOK_CHARS = 160;
function parseLooks(record) {
  const out = [];
  const cast = record.cast ?? record.looks;
  if (!Array.isArray(cast)) return out;
  for (const item of cast) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item;
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    const raw = rec.look ?? rec.appearance;
    const look = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
    if (!name || !look) continue;
    if (out.length >= 4) continue;
    if (out.some((x) => x.name === name)) continue;
    if (HAS_CJK.test(look) || !/[A-Za-z]/.test(look)) continue;
    out.push({ name, look: look.slice(0, MAX_LOOK_CHARS) });
  }
  return out;
}
function parseStatusReply(raw, kind = "status") {
  const empty = { ...emptyFrame(), panels: [] };
  const manga = kind === "manga";
  const sanitize = manga ? { allowFraming: true, maxTags: MAX_TAGS_MANGA } : {};
  const text = stripThinkingBlocks(String(raw ?? ""));
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
    const push2 = (item) => {
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
    if (Array.isArray(frame.characters)) frame.characters.forEach(push2);
    else push2(frame.characters);
    push2(frame.character);
    const tagsRaw = Array.isArray(frame.tags) ? frame.tags.join(", ") : pick(frame.tags);
    const tags = sanitizeStatusTags(tagsRaw, sanitize);
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
  const outfits = parseOutfits(record);
  const looks = parseLooks(record);
  return {
    ...head,
    title: (pick(record.title) || head.title).slice(0, 40),
    panels,
    ...outfits.length ? { outfits } : {},
    ...looks.length ? { looks } : {}
  };
}
function clampMangaShots(raw) {
  const value = Math.round(Number(raw) || 1);
  return Math.min(Math.max(value, 1), STATUS_MAX_PANELS);
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
const MANGA_BW_POSITIVE = "monochrome, greyscale";
const MANGA_BW_NEGATIVE = "color, colorful, full color, vivid colors, saturated, chromatic, rainbow, multicolored";
const COLOR_STYLE_RE = new RegExp(
  `\\b(?:${[
    "colorful",
    "colou?red",
    "full[ -]?color",
    "multi[ -]?colou?red",
    "technicolou?r",
    "vivid",
    "vibrant",
    "saturated",
    "saturation",
    "chromatic",
    "rainbow",
    "pastel colors?",
    "neon colors?",
    "colou?r palette",
    "colou?r scheme"
  ].join("|")})\\b`,
  "i"
);
function stripMangaColorTags(tags) {
  const hits = [];
  const kept = String(tags ?? "").split(/[,，]/).map((p) => p.trim()).filter(Boolean).filter((part) => {
    if (!COLOR_STYLE_RE.test(part)) return true;
    hits.push(part);
    return false;
  });
  return { tags: kept.join(", "), hits };
}
function mergeNegative(...parts) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const part of parts) {
    for (const piece of String(part ?? "").split(/[,，]/)) {
      const tag = piece.trim();
      if (!tag) continue;
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(tag);
    }
  }
  return out.join(", ");
}
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
  const outfits = (reading.outfits ?? []).filter((item) => {
    if (!UNSAFE_RE.test(item.outfit)) return true;
    hits.push(`${item.name} 的服装描写`);
    return false;
  });
  const kept = { ...reading };
  if (outfits.length) kept.outfits = outfits;
  else delete kept.outfits;
  const head = panels[0];
  if (!head) {
    return { reading: { ...kept, panels, tags: "", roles: [], characters: [], nl: "" }, hits };
  }
  return { reading: { ...kept, ...head, title: reading.title, panels }, hits };
}
const BODY_LIMIT = 2400;
const BODY_LIMIT_STORY = 3600;
const FRAMING_RE = /\b(?:upper body|cowboy shot|close[- ]?up|portrait|headshot)\b/i;
function clampBody(body, many) {
  const text = String(body ?? "");
  const limit = many ? BODY_LIMIT_STORY : BODY_LIMIT;
  return text.length > limit ? text.slice(-limit) : text;
}
const DOC_OF_KIND = {
  status: "status",
  bonus: "bonus",
  manga: "manga"
};
function buildTheaterPrompt(input) {
  const count = Math.min(Math.max(Math.round(Number(input.shots) || 1), 1), STATUS_MAX_PANELS);
  const many = count > 1;
  const body = clampBody(input.body, many || input.kind === "bonus");
  const name = input.characterName || "（未命名）";
  const docId = DOC_OF_KIND[input.kind] ?? "status";
  const systemVars = {
    count,
    nl: input.nl !== false
  };
  if (input.kind === "manga") {
    systemVars.safe = input.mangaSafe !== false;
    systemVars.dialogue = input.dialogue === true;
  }
  let system = renderPromptDoc(docId, many ? "many" : "single", systemVars, input.promptOverrides);
  const bodyLabel = input.kind === "bonus" ? "正文（只用来认人，不用来取材）：" : "正文：";
  const roster = (input.roster ?? []).map((n) => String(n ?? "").trim()).filter(Boolean).slice(0, 12);
  const rosterLine = roster.length ? `可用角色（柏宝绘角色库；characters[].name 必须照抄其中一项，不要自己造人）：${roster.join("、")}
` : "";
  const reference = [input.bookBlock, input.castBlock, input.libraryBlock].filter(Boolean).join("\n\n");
  if (reference) system = `${system}

${reference}`;
  return {
    system,
    user: `${rosterLine}角色：${name}
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
function buildMangaPrompt(appearances, tags, mono = true) {
  const looks = appearances.map((t) => t.trim()).filter(Boolean).join(", ");
  const body = mono ? stripMangaColorTags(tags).tags : String(tags ?? "").trim();
  const framing = body && !MANGA_FRAMING_RE.test(body) ? "cowboy shot" : "";
  return [mono ? MANGA_BW_POSITIVE : "", looks, body, framing].filter(Boolean).join(", ");
}
function buildMangaNl(nl) {
  const text = String(nl ?? "").trim();
  if (!text) return "";
  return `One single comic panel filling the whole frame, no panel borders. ${text}`;
}
function withMangaMono(prompt) {
  const text = String(prompt ?? "").trim();
  if (!text) return text;
  if (/\b(?:monochrome|greyscale|grayscale)\b/i.test(text)) return text;
  return `${MANGA_BW_POSITIVE}, ${text}`;
}
function buildTheaterImagePrompt(kind, appearances, tags, chibi, mono = true) {
  return kind === "manga" ? buildMangaPrompt(appearances, tags, mono) : buildStatusPrompt(appearances, tags, chibi);
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
const THEATER_KEY = "sti_theater";
function emptyStore() {
  return { version: 1, buckets: { status: [], bonus: [], manga: [] } };
}
function readStore$1(raw) {
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
  return readStore$1(extra == null ? void 0 : extra[THEATER_KEY]).buckets[bucket];
}
function hasStory(floor, bucket) {
  return getStories(floor, bucket).length > 0;
}
function newSetId() {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
function getSets(floor, bucket) {
  const list = getStories(floor, bucket);
  const order = [];
  const map = /* @__PURE__ */ new Map();
  for (const story of list) {
    const key = story.setId && story.setId.trim() ? story.setId : `single-${story.storyId}`;
    if (!map.has(key)) {
      map.set(key, []);
      order.push(key);
    }
    map.get(key).push(story);
  }
  const sets = [];
  for (const key of order) {
    const panels = (map.get(key) ?? []).slice().sort((a, b) => a.index - b.index);
    const first = panels[0];
    if (!first) continue;
    const cast = dedupe(panels.flatMap((p) => p.cast ?? []));
    const mood = panels.map((p) => p.mood).find((m) => !!m) ?? "";
    sets.push({
      setId: key,
      kind: bucket,
      title: first.setTitle ?? first.title ?? "",
      cast,
      mood,
      panels,
      sourceText: first.sourceText ?? "",
      characterName: first.characterName ?? "",
      createdAt: first.storyAt ?? 0
    });
  }
  return sets;
}
function saveSet(floor, bucket, stories) {
  if (stories.length === 0) return false;
  const msg = getMessage(floor);
  if (!msg) return false;
  if (!msg.extra) msg.extra = {};
  const extra = msg.extra;
  const store = readStore$1(extra[THEATER_KEY]);
  for (const story of stories) {
    store.buckets[bucket].push({
      ...story,
      ...story.lines && story.lines.length ? { lines: story.lines } : { lines: void 0 }
    });
  }
  return writeStore(floor, store);
}
function updatePanel(floor, bucket, setId, index2, patch) {
  const msg = getMessage(floor);
  if (!(msg == null ? void 0 : msg.extra)) return false;
  const extra = msg.extra;
  const store = readStore$1(extra[THEATER_KEY]);
  const list = store.buckets[bucket];
  const at = list.findIndex((s) => s.setId === setId && s.index === index2);
  if (at < 0) return false;
  list[at] = { ...list[at], ...patch };
  return writeStore(floor, store);
}
function replaceSet(floor, bucket, setId, stories) {
  const msg = getMessage(floor);
  if (!(msg == null ? void 0 : msg.extra)) return false;
  const extra = msg.extra;
  const store = readStore$1(extra[THEATER_KEY]);
  const kept = store.buckets[bucket].filter((s) => s.setId !== setId);
  const firstAt = store.buckets[bucket].findIndex((s) => s.setId === setId);
  const merged = kept.slice();
  const insertAt = firstAt < 0 ? merged.length : Math.min(firstAt, merged.length);
  merged.splice(insertAt, 0, ...stories.map((s) => ({
    ...s,
    ...s.lines && s.lines.length ? { lines: s.lines } : { lines: void 0 }
  })));
  store.buckets[bucket] = merged;
  return writeStore(floor, store);
}
function removeSet(floor, bucket, setId) {
  const msg = getMessage(floor);
  if (!(msg == null ? void 0 : msg.extra)) return false;
  const extra = msg.extra;
  const store = readStore$1(extra[THEATER_KEY]);
  const before = store.buckets[bucket].length;
  store.buckets[bucket] = store.buckets[bucket].filter((s) => s.setId !== setId);
  if (store.buckets[bucket].length === before) return false;
  return writeStore(floor, store);
}
function dedupe(list) {
  const out = [];
  for (const item of list) {
    const v = String(item ?? "").trim();
    if (!v || out.includes(v)) continue;
    out.push(v);
  }
  return out;
}
const FIELD_LABELS = [
  ["fandom", "同人身份"],
  ["sex", "性别"],
  ["hair", "头发"],
  ["eyes", "眼睛"],
  ["skin", "肤色"],
  ["body", "体型"],
  ["extra", "标志特征"],
  ["outfit", "固定着装"]
];
function formatLibraryEntry(entry, locked = entry.scope === "global") {
  const parts = [];
  const fields = entry.fields ?? {};
  for (const [key, label] of FIELD_LABELS) {
    const value = String(fields[key] ?? "").trim();
    if (value) parts.push(`${label}=${value}`);
  }
  if (!parts.length) {
    const tag = String(entry.tag ?? "").trim();
    if (tag) parts.push(`外貌=${tag}`);
  }
  const nl = String(entry.nl ?? "").trim();
  if (nl) parts.push(`外观句=${nl}`);
  const body = parts.join(", ");
  return `- ${entry.name}${locked ? "［全局］" : ""}: ${body || "（库中暂无外貌数据：请按正文/柏宝书为这一次补全，不要换成别人）"}`;
}
function buildLibraryBlock(entries2) {
  const usable = entries2.filter((entry) => String(entry.name ?? "").trim());
  if (!usable.length) return "";
  const lines = usable.map((entry) => formatLibraryEntry(entry, entry.scope === "global"));
  return [
    "【角色固定外貌库 · 来自柏宝绘，只读】",
    "以下名字是**唯一合法**的 characters[].name。正文里的称呼与这里不同（「你」「Cecilia」「那个金发男生」）时，",
    "先判断指的是库里哪一位，再照抄库里的名字；判不出来才用正文叫法。",
    "外貌（发色/瞳色/体型/标志特征/固定着装）：库里有的**照抄、不要改写**；库里没有的按正文/柏宝书补一次，**不要换人**；",
    "它只写进**该角色自己那一块**（characters[] 或 character 段），不要写进 Base / scene / page.tags。",
    ...lines
  ].join("\n");
}
function clip(text, limit) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}
function buildCastBlock(ctx) {
  const lines = [];
  if (ctx.personaName) {
    lines.push(`- 用户扮演：${ctx.personaName}（正文里的「你」指的就是这一位，出图必须画成这个人）`);
  }
  if (ctx.cardName) {
    lines.push(`- 角色卡主角：${ctx.cardName}（正文里与他对话/互动的一方）`);
  }
  const persona = clip(ctx.personaText, 600);
  const card = clip(ctx.cardText, 600);
  if (persona) lines.push(`- 用户人设摘要：${persona}`);
  if (card) lines.push(`- 角色卡摘要：${card}`);
  if (!lines.length) return "";
  return ["【本聊天的人物对应】", ...lines].join("\n");
}
function readCastContext(fallbackCardName = "") {
  const ctx = getContext();
  const personaName = String(ctx.name1 ?? "").trim();
  const cardName = String(ctx.name2 ?? fallbackCardName ?? "").trim();
  let personaText = "";
  try {
    const substitute = ctx.substituteParams;
    if (typeof substitute === "function") {
      personaText = String(substitute.call(ctx, "{{persona}}") ?? "");
    }
  } catch {
    personaText = "";
  }
  if (!personaText) {
    const powerUser = globalThis.power_user;
    if (powerUser && typeof powerUser.persona_description === "string") {
      personaText = powerUser.persona_description;
    }
  }
  let cardText = "";
  const characters = ctx.characters;
  const characterId = typeof ctx.characterId === "number" ? ctx.characterId : -1;
  const card = characters && characterId >= 0 ? characters[characterId] : void 0;
  const data = card == null ? void 0 : card.data;
  if (data) {
    cardText = [data.description, data.personality].filter((v) => typeof v === "string" && !!v.trim()).join(" / ");
  }
  return { personaName, cardName, personaText, cardText };
}
function normalizeName$1(name) {
  return String(name ?? "").replace(/[\s（）()「」『』【】·.,，。:：!！?？~～]/g, "").toLowerCase();
}
const PEOPLE_COUNT_RE = /(?:^|,)\s*\d+\s*(?:people|girls|boys|others|girl|boy|other|person)\b/gi;
const WORD_NUMBER = {
  single: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5
};
function declaredPeople(tags) {
  const text = String(tags ?? "");
  let total = 0;
  for (const match of text.matchAll(/\b(\d+)\s*(?:people|girls|boys|others|girl|boy|other|person)\b/gi)) {
    total += Number(match[1]) || 0;
  }
  if (!total) {
    for (const match of text.matchAll(/\b(single|one|two|three|four|five)\s+(?:people|girls|boys|others|girl|boy|other|person)\b/gi)) {
      total += WORD_NUMBER[match[1].toLowerCase()] ?? 0;
    }
  }
  if (!total && /\b(couple|pair)\b/i.test(text)) total = 2;
  return total;
}
function alignPeopleCount(tags, blocks) {
  const text = String(tags ?? "");
  if (blocks <= 0) return text;
  const declared = declaredPeople(text);
  if (!declared || declared === blocks) return text;
  const stripped = text.replace(PEOPLE_COUNT_RE, "").replace(/\s*,\s*,/g, ",").replace(/^\s*,\s*|\s*,\s*$/g, "").trim();
  return stripped || text;
}
function combinedPanelTags(panel) {
  const pieces = [];
  for (const role of panel.roles ?? []) {
    if (role.act) pieces.push(role.act);
  }
  pieces.push(panel.tags);
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const piece of pieces.join(",").split(",")) {
    const tag = piece.trim();
    if (!tag) continue;
    if (/[\u3400-\u9fff\uf900-\ufaff]/.test(tag)) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out.join(", ");
}
function checkReading(reading, body, kind) {
  if (!reading.panels.length) return { ok: false, reason: "没有解析出任何分格" };
  const rich = reading.panels.some(
    (panel) => combinedPanelTags(panel).split(",").filter((t) => t.trim()).length >= 5
  );
  if (!rich) return { ok: false, reason: "每格的 tag 都太少，画面信息不足" };
  if (kind === "bonus") return { ok: true };
  const names = /* @__PURE__ */ new Set();
  for (const panel of reading.panels) {
    for (const name of panel.characters) if (name) names.add(name.trim());
  }
  if (names.size === 0) return { ok: false, reason: "格子里没有任何出场角色" };
  const text = String(body ?? "");
  const hit = [...names].some((name) => name.length >= 2 && text.includes(name));
  if (!hit) {
    return {
      ok: false,
      reason: `格子里写的角色（${[...names].slice(0, 3).join("、")}）在正文里没有出现`
    };
  }
  return { ok: true };
}
async function readTheater(input, extraInstruction = "") {
  var _a;
  const { system, user } = buildTheaterPrompt({
    kind: input.kind,
    characterName: input.characterName,
    body: input.body,
    shots: clampMangaShots(input.shots),
    mangaSafe: input.mangaSafe,
    dialogue: input.dialogue === true,
    nl: input.nl !== false,
    ...((_a = input.roster) == null ? void 0 : _a.length) ? { roster: input.roster } : {},
    ...input.bookBlock ? { bookBlock: input.bookBlock } : {},
    ...input.libraryBlock ? { libraryBlock: input.libraryBlock } : {},
    ...input.castBlock ? { castBlock: input.castBlock } : {},
    ...input.promptOverrides ? { promptOverrides: input.promptOverrides } : {}
  });
  const finalSystem = extraInstruction ? `${system}

【追加要求】${extraInstruction}` : system;
  const raw = await input.llm(finalSystem, user);
  let reading = parseStatusReply(raw, input.kind);
  const hits = [];
  if (input.kind === "manga" && input.mangaSafe) {
    const scrubbed = scrubMangaReading(reading);
    reading = scrubbed.reading;
    hits.push(...scrubbed.hits);
  }
  return { reading, hits };
}
async function runTheaterOne(input) {
  var _a, _b, _c;
  try {
    let { reading, hits } = await readTheater(input);
    let check = checkReading(reading, input.body, input.kind);
    if (!check.ok) {
      console.warn(`[ST-Story-Illustrator] ${input.kind} 读剧情不合格（${check.reason}），重问一次。`);
      const rosterHint = ((_a = input.roster) == null ? void 0 : _a.length) ? `角色名只能从这几个里选：${input.roster.join("、")}（照抄，不要改写）。` : "";
      const retried = await readTheater(
        input,
        `上一次的输出不合格：${check.reason}。这次必须做到：tags 与 characters[].act 写的都是**正文里真的发生的事**，动作具体到能画出来（例如 holding sword, sitting on bed, crying, looking away），不许只给 1girl / solo / standing 这类空景词；角色名照抄正文里的叫法。` + rosterHint
      );
      reading = retried.reading;
      hits = [...hits, ...retried.hits];
      check = checkReading(reading, input.body, input.kind);
    }
    if (!check.ok) {
      return {
        ok: false,
        stories: [],
        error: `读剧情这一步没通过（${check.reason}），已放弃出图以免白花钱。请换一个更会写 tag 的副 API 模型。`,
        hits
      };
    }
    if (reading.panels.length === 0) {
      return { ok: false, stories: [], error: "读剧情未返回可解析的分镜。", hits };
    }
    const names = /* @__PURE__ */ new Set();
    for (const panel of reading.panels) {
      for (const n of panel.characters) if (n) names.add(n);
      for (const l of panel.lines ?? []) if (l.speaker && l.speaker !== "旁白") names.add(l.speaker);
    }
    const fixedSeed = statusSeedFor([...names]);
    const outfitByName = /* @__PURE__ */ new Map();
    for (const item of reading.outfits ?? []) {
      const key = normalizeName$1(item.name);
      if (key && item.outfit && !outfitByName.has(key)) outfitByName.set(key, item.outfit);
    }
    const lookByName = /* @__PURE__ */ new Map();
    for (const item of reading.looks ?? []) {
      const key = normalizeName$1(item.name);
      if (key && item.look && !lookByName.has(key)) lookByName.set(key, item.look);
    }
    const lookOf = (name) => {
      const key = normalizeName$1(name);
      const base = normalizeName$1(String(name ?? "").split(/[（(【\[]/)[0]);
      return lookByName.get(key) ?? (base ? lookByName.get(base) : void 0) ?? "";
    };
    const outfitOf = (name, look) => {
      const key = normalizeName$1(name);
      const base = normalizeName$1(String(name ?? "").split(/[（(【\[]/)[0]);
      return outfitByName.get(key) ?? (base ? outfitByName.get(base) : void 0) ?? (look == null ? void 0 : look.outfit) ?? "";
    };
    const stories = [];
    const missingLooks = /* @__PURE__ */ new Set();
    const nativeCharacters = input.supportsCharacters !== false;
    for (let i = 0; i < reading.panels.length; i += 1) {
      const panel = reading.panels[i];
      (_b = input.onPanel) == null ? void 0 : _b.call(input, i, reading.panels.length);
      const panelNames = panel.characters.length ? panel.characters : [...names].filter((n) => `${panel.nl ?? ""} ${panel.title ?? ""}`.includes(n));
      const resolvedNames = panelNames.length ? panelNames : names.size === 1 ? [...names] : [];
      const looks = input.readLooks(resolvedNames);
      for (const look of looks) {
        if (look.tag) continue;
        const supplied = lookOf(look.name);
        if (supplied) look.tag = supplied;
        else missingLooks.add(look.name);
      }
      const acts = /* @__PURE__ */ new Map();
      for (const role of panel.roles ?? []) {
        const name = String(role.name ?? "").trim();
        const act = String(role.act ?? "").trim();
        if (name && act) acts.set(name, act);
      }
      const characters = nativeCharacters ? looks.filter((look) => look.tag).map((look) => {
        const act = acts.get(look.name) ?? acts.get(look.name.trim()) ?? "";
        const outfit = outfitOf(look.name, look);
        const tag = [look.tag, outfit, act].filter(Boolean).join(", ");
        return {
          name: look.name,
          tag,
          ...look.nl ? { nl: look.nl } : {}
        };
      }) : [];
      const missingActs = looks.filter((look) => !look.tag).map((look) => [acts.get(look.name) ?? "", outfitOf(look.name, look)].filter(Boolean).join(", ")).filter(Boolean);
      const appearances = nativeCharacters ? [] : looks.map((look) => [look.tag, outfitOf(look.name, look)].filter(Boolean).join(", ")).filter(Boolean);
      const baseTags = nativeCharacters ? alignPeopleCount([panel.tags, ...missingActs].filter(Boolean).join(", "), characters.length) : combinedPanelTags(panel);
      const prompt = buildTheaterImagePrompt(
        input.kind,
        appearances,
        baseTags,
        input.chibi,
        input.mangaBw !== false
      );
      const nl = input.nl === false ? void 0 : input.kind === "manga" ? buildMangaNl(panel.nl) : panel.nl;
      const negativeText = input.kind === "manga" ? mergeNegative(
        input.mangaBw !== false ? MANGA_BW_NEGATIVE : "",
        input.mangaSafe ? MANGA_SAFE_NEGATIVE : ""
      ) : "";
      const negative = negativeText || void 0;
      const seed = decideSeed(input.backend, void 0, fixedSeed);
      const result = await input.generate(
        {
          prompt,
          ...nl ? { nl } : {},
          ...negative ? { negative } : {},
          ...characters.length ? { characters } : {},
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
        manga: input.kind === "manga",
        kind: input.kind,
        // 重画这张要用的原始参数：不存就只能「整条重出」，单格没法还原
        prompt,
        ...negative ? { negative } : {},
        ...characters.length ? { characters } : {},
        seed: result.seed ?? seed,
        ...((_c = input.profile) == null ? void 0 : _c.id) ? { profileId: input.profile.id } : {}
      });
    }
    if (stories.length === 0) {
      return { ok: false, stories, error: "所有分格出图均失败。", hits, ...missingLooks.size ? { missingLooks: [...missingLooks] } : {} };
    }
    return {
      ok: true,
      stories,
      hits,
      ...missingLooks.size ? { missingLooks: [...missingLooks] } : {}
    };
  } catch (err) {
    return {
      ok: false,
      stories: [],
      error: err instanceof Error ? err.message : String(err),
      hits: []
    };
  }
}
function getBookApi() {
  const api = globalThis.STBaiBaiBook;
  return (api == null ? void 0 : api.apiVersion) === 1 ? api : null;
}
function oneLine(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}
function fmtProtagonist(protagonist) {
  const p = protagonist ?? {};
  const parts = [];
  const fields = [
    ["性别", "gender"],
    ["年龄", "age"],
    ["身份", "identity"],
    ["外貌", "appearance"],
    ["着装", "outfit"],
    ["状态", "condition"]
  ];
  for (const [label, key] of fields) {
    const v = oneLine(p[key]);
    if (v) parts.push(`${label}:${v}`);
  }
  return parts.join("；");
}
function fmtNpc(n) {
  const name = oneLine(n.name);
  const bracket = [oneLine(n.gender), oneLine(n.age), oneLine(n.title)].filter(Boolean).join("·");
  let line = bracket ? `${name}(${bracket})` : name;
  const rel = oneLine(n.relation);
  if (rel) line += ` —— 与主角:${rel}`;
  const tail = [];
  const desc = oneLine(n.desc);
  if (desc) tail.push(`外貌:${desc}`);
  const outfit = oneLine(n.outfit);
  if (outfit) tail.push(`着装:${outfit}`);
  const condition = oneLine(n.condition);
  if (condition) tail.push(`状态:${condition}`);
  if (n.follow === true) tail.push("随行");
  else {
    const loc = oneLine(n.location);
    if (loc) tail.push(`在:${loc}`);
  }
  return tail.length ? `${line} 〔${tail.join(";")}〕` : line;
}
function formatBookRoles(snapshot, bodyText, protagonistName = "") {
  const lines = [];
  const lead = oneLine(protagonistName);
  const protagonist = fmtProtagonist(snapshot.protagonist);
  if (protagonist) lines.push(lead ? `主角(${lead}):${protagonist}` : `主角:${protagonist}`);
  const npcs = Array.isArray(snapshot.npcs) ? snapshot.npcs : [];
  const npcLines = [];
  for (const raw of npcs) {
    const n = raw ?? {};
    const name = oneLine(n.name);
    if (!name) continue;
    if (n.important === true || n.follow === true || String(bodyText ?? "").includes(name)) {
      npcLines.push(`- ${fmtNpc(n)}`);
    }
  }
  if (npcLines.length) lines.push(`重要角色:
${npcLines.join("\n")}`);
  return lines.join("\n");
}
function readBookRoles(floor, bodyText, protagonistName = "") {
  var _a, _b;
  const api = getBookApi();
  if (!api) return null;
  try {
    let snapshot;
    let timing = "before_latest";
    if (typeof api.getContextAtFloor === "function") {
      const data = api.getContextAtFloor({ floor });
      const valid = !!((_b = (_a = data.floorData) == null ? void 0 : _a.memory) == null ? void 0 : _b.valid);
      timing = valid ? "after_latest" : "before_latest";
      snapshot = valid ? data.snapshotAfter : data.snapshotBefore;
    } else {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const floorData = api.getFloor(floor);
        timing = floorData.memory.valid ? "after_latest" : "before_latest";
        const s = api.getSnapshot({ floor, at: timing === "after_latest" ? "after" : "before" });
        if (floorData.revision === s.revision) {
          snapshot = s;
          break;
        }
      }
      if (!snapshot) return null;
    }
    if (!snapshot) return null;
    const roles = formatBookRoles(snapshot, bodyText, protagonistName);
    if (!roles) return null;
    return {
      timing,
      text: `【角色参考（柏宝书同步的最新状态，只读）】
${roles}`
    };
  } catch (error) {
    console.warn("[ST-Story-Illustrator] 读取柏宝书角色状态失败，本次只用角色库与正文。", error);
    return null;
  }
}
const COMPOSITE_FOLDER = "ST创作_带字";
async function blobUrlToBase64(url) {
  try {
    const response = await fetch(url);
    const blob = await response.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result ?? "");
        const comma = result.indexOf(",");
        resolve(comma >= 0 ? result.slice(comma + 1) : null);
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}
async function uploadComposite(base64, filename) {
  const ctx = getContext();
  const headers = typeof ctx.getRequestHeaders === "function" ? ctx.getRequestHeaders() : {};
  try {
    const response = await fetch("/api/images/upload", {
      method: "POST",
      headers,
      body: JSON.stringify({
        image: base64,
        format: "png",
        ch_name: COMPOSITE_FOLDER,
        filename
      })
    });
    if (!response.ok) return null;
    const data = await response.json();
    return typeof data.path === "string" && data.path ? data.path : null;
  } catch {
    return null;
  }
}
async function bakeDialogueIntoImage(input) {
  const items = input.dialogue.filter((item) => {
    var _a;
    return (_a = item.text) == null ? void 0 : _a.trim();
  });
  if (!items.length || !input.imagePath) return null;
  const composite = await compositeDialogue(input.imagePath, items, {
    ...input.style ? { style: input.style } : {},
    ...input.font ? { font: input.font } : {},
    ...input.slots && input.slots.length ? { panels: input.slots } : {},
    ...input.noGo && input.noGo.length ? { avoid: input.noGo } : {},
    ...input.panelCast && input.panelCast.length ? { panelCast: input.panelCast } : {}
  });
  if (!composite) return null;
  try {
    const base64 = await blobUrlToBase64(composite.url);
    if (!base64) return null;
    const stamp = Date.now().toString(36);
    const filename = `sti_bubble_${stamp}_${Math.random().toString(36).slice(2, 6)}.png`;
    return await uploadComposite(base64, filename);
  } finally {
    composite.revoke();
  }
}
function kindOfMode(mode) {
  if (mode === "chibi-status") return "status";
  if (mode === "chibi-bonus") return "bonus";
  return "manga";
}
function modeOfKind(kind) {
  if (kind === "status") return "chibi-status";
  if (kind === "bonus") return "chibi-bonus";
  return "bw-manga";
}
function pickProfile(profiles, mode) {
  return profiles.find((p) => p.mode === mode);
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
async function bakeTheaterLines(imagePath, lines, settings2, kind) {
  if (!imagePath || !(lines == null ? void 0 : lines.length)) return { path: imagePath, baked: false };
  const modeSettings = resolveModeSettings(settings2, modeOfKind(kind));
  const baked = await bakeDialogueIntoImage({
    imagePath,
    dialogue: lines.map((line) => ({
      text: line.text,
      ...line.speaker && line.speaker !== "旁白" ? { speaker: line.speaker } : {}
    })),
    ...modeSettings.bwMangaBubbleStyle ? { style: modeSettings.bwMangaBubbleStyle } : {},
    ...settings2.bubbleFont ? { font: settings2.bubbleFont } : {}
  });
  return baked ? { path: baked, baked: true } : { path: imagePath, baked: false };
}
function normalizeName(name) {
  return String(name ?? "").replace(/[\s（）()「」『』【】·.,，。:：!！?？~～]/g, "").toLowerCase();
}
function makeLookReader(characters, primary = "") {
  const cardName = typeof primary === "string" ? primary : primary.cardName ?? "";
  const personaName = typeof primary === "string" ? "" : primary.personaName ?? "";
  const byNorm = /* @__PURE__ */ new Map();
  for (const c of characters) {
    byNorm.set(normalizeName(c.name), c);
    const base = normalizeName(String(c.name ?? "").split(/[（(【\[]/)[0]);
    if (base && !byNorm.has(base)) byNorm.set(base, c);
  }
  const card = cardName ? byNorm.get(normalizeName(cardName)) : void 0;
  const persona = personaName ? byNorm.get(normalizeName(personaName)) : void 0;
  const onlyOne = characters.length === 1 ? characters[0] : void 0;
  const userWord = /^(你|我|你们|我们|you|i|me|us)$/i;
  const otherWord = /^(他|她|它|他们|她们|对方|那人|那个人|男子|男人|少年|少女|女孩|男孩|he|she|they|him|her|the man|the woman)$/i;
  return (names) => {
    const toLook = (name, entry) => {
      var _a;
      const outfit = String(((_a = entry.fields) == null ? void 0 : _a.outfit) ?? "").trim();
      return {
        name,
        tag: entry.tag,
        ...entry.nl ? { nl: entry.nl } : {},
        ...outfit ? { outfit } : {}
      };
    };
    const out = names.map((name) => {
      const key = normalizeName(name);
      const base = normalizeName(String(name ?? "").split(/[（(【\[]/)[0]);
      const hit = byNorm.get(key) ?? (base ? byNorm.get(base) : void 0);
      if (hit) return toLook(name, hit);
      const word = String(name ?? "").trim();
      const fallback = userWord.test(word) ? persona ?? onlyOne : otherWord.test(word) ? card ?? onlyOne : void 0;
      return fallback ? toLook(name, fallback) : { name, tag: "" };
    });
    const unresolved = out.filter((item) => !item.tag);
    if (unresolved.length === 1) {
      const usedNames = new Set(out.filter((item) => item.tag).map((item) => item.name));
      const free = characters.filter((entry) => !usedNames.has(entry.name));
      if (free.length === 1 && free[0].tag) {
        const picked = toLook(unresolved[0].name, free[0]);
        unresolved[0].tag = picked.tag;
        if (picked.nl) unresolved[0].nl = picked.nl;
        if (picked.outfit) unresolved[0].outfit = picked.outfit;
      }
    }
    return out;
  };
}
async function runTheaterTask(input) {
  var _a;
  const { mode, settings: settings2, floor } = input;
  const kind = kindOfMode(mode);
  const modeSettings = resolveModeSettings(settings2, mode);
  const characters = await getCharacters(floor);
  const profile = pickProfile(settings2.profiles ?? [], mode);
  const backendState = await readBackendState().catch(() => null);
  const supportsCharacters = (backendState == null ? void 0 : backendState.supportsCharacters) !== false;
  const cast = readCastContext(input.characterName);
  const libraryBlock = buildLibraryBlock(characters.characters);
  const castBlock = buildCastBlock(cast);
  const book = readBookRoles(floor, input.body, readPersonaName());
  if (!libraryBlock) {
    recordNotice({
      mode,
      floor,
      text: "柏宝绘角色库是空的（或这一楼之前还没有档案）：这次出图没有任何外貌可抄，画出来的人不会是故事里的角色。请到柏宝绘 →「角色」里确认条目存在，或先用它的自动打标跑一楼建档。"
    });
  }
  const result = await runTheaterOne({
    kind,
    chatId: input.chatId,
    floor,
    swipe: input.swipe,
    characterName: input.characterName,
    body: input.body,
    shots: modeSettings.shots,
    chibi: kind !== "manga" && modeSettings.chibiStyle !== "thumb",
    mangaSafe: modeSettings.bwMangaSafeMode ?? true,
    mangaBw: modeSettings.bwMangaMono !== false,
    dialogue: kind === "manga" && modeSettings.bwMangaDialogue !== false,
    roster: characters.characters.map((c) => c.name),
    // 要不要写 nl 看这套方案自己的开关（NAI4 一律 false；4.5/V5 跟方案面板走）
    nl: nlForMode(settings2, mode),
    ...book ? { bookBlock: book.text } : {},
    ...libraryBlock ? { libraryBlock } : {},
    ...castBlock ? { castBlock } : {},
    ...settings2.promptOverrides ? { promptOverrides: settings2.promptOverrides } : {},
    supportsCharacters,
    backend: "nai",
    ...profile ? { profile } : {},
    ...input.onPanel ? { onPanel: input.onPanel } : {},
    // 副 API 报错即停，不回退主 API（并把原文记进日志）
    llm: async (system, user) => {
      try {
        return await makeModeLlmCaller(settings2, mode)(system, user);
      } catch (err) {
        recordLlmError({
          mode,
          floor,
          error: err instanceof Error ? err.message : String(err),
          prompt: `【system】
${system}

【user】
${user}`
        });
        throw err;
      }
    },
    generate: async (genInput, genProfile) => {
      var _a2, _b, _c;
      const startedAt = Date.now();
      try {
        await ensureModeOutPlan(mode, settings2);
        const r = await baiBaiAdapter.generate({
          prompt: genInput.prompt,
          ...genInput.nl ? { nl: genInput.nl } : {},
          ...genInput.negative ? { negative: genInput.negative } : {},
          ...((_a2 = genInput.characters) == null ? void 0 : _a2.length) ? { characters: genInput.characters } : {},
          seed: genInput.seed,
          size: genInput.size,
          save: true
        }, genProfile ?? fallbackProfile(mode));
        recordImageLog({
          mode,
          floor,
          source: "api",
          plan: readOutConfig().activePlanName,
          prompt: genInput.prompt,
          ...genInput.nl ? { nl: genInput.nl } : {},
          ...genInput.negative ? { negative: genInput.negative } : {},
          ...((_b = genInput.characters) == null ? void 0 : _b.length) ? { characters: genInput.characters } : {},
          ...genInput.size ? { size: genInput.size } : {},
          ...typeof r.seed === "number" ? { seed: r.seed } : typeof genInput.seed === "number" ? { seed: genInput.seed } : {},
          status: "ok",
          durationMs: Date.now() - startedAt
        });
        return { path: r.path, dataUrl: r.dataUrl, seed: r.seed };
      } catch (err) {
        recordImageLog({
          mode,
          floor,
          source: "api",
          plan: readOutConfig().activePlanName,
          prompt: genInput.prompt,
          ...genInput.nl ? { nl: genInput.nl } : {},
          ...genInput.negative ? { negative: genInput.negative } : {},
          ...((_c = genInput.characters) == null ? void 0 : _c.length) ? { characters: genInput.characters } : {},
          ...genInput.size ? { size: genInput.size } : {},
          status: "error",
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - startedAt
        });
        throw err;
      }
    },
    readLooks: makeLookReader(characters.characters, {
      cardName: input.characterName,
      personaName: cast.personaName
    })
  });
  return {
    ok: result.ok,
    stories: result.stories,
    ...result.error ? { error: result.error } : {},
    ...((_a = result.missingLooks) == null ? void 0 : _a.length) ? { missingLooks: result.missingLooks } : {}
  };
}
function randomSeed$1() {
  return Math.floor(Math.random() * 4294967295);
}
async function rerollComicPage(floor, artifactId, overrides = {}) {
  const artifact = getArtifacts(floor).find((a) => a.id === artifactId);
  if (!artifact) return { ok: false, message: "找不到这一页。" };
  if (artifact.mode !== "comic") return { ok: false, message: "这张不是漫画页。" };
  const prompt = (overrides.prompt ?? artifact.prompt ?? "").trim();
  if (!prompt) return { ok: false, message: "正向提示词不能为空。" };
  const nl = (overrides.nl !== void 0 ? overrides.nl : artifact.nl ?? "").trim();
  const edited = overrides.prompt !== void 0 || overrides.nl !== void 0;
  const settings2 = getSettings(DEFAULT_SETTINGS);
  const comic = resolveModeSettings(settings2, "comic");
  const meta = artifact.metadata ?? {};
  const storedCharacters = Array.isArray(meta.characters) ? meta.characters : [];
  const characters = overrides.characters ?? storedCharacters;
  const pageType = meta.pageType ?? comic.comicPageType ?? "auto";
  const seed = randomSeed$1();
  const startedAt = Date.now();
  acquirePlanGuard();
  try {
    await ensureModeOutPlan("comic", settings2);
    const result = await baiBaiAdapter.generate(
      {
        prompt,
        ...nl ? { nl } : {},
        ...characters.length ? { characters } : {},
        ...typeof meta.characterName === "string" && meta.characterName ? { character: meta.characterName } : {},
        seed,
        size: "portrait",
        save: true
      },
      pickProfile(settings2.profiles ?? [], "comic") ?? fallbackProfile("comic")
    );
    const rawPath = result.path ?? result.dataUrl;
    if (!rawPath) {
      recordImageLog({
        mode: "comic",
        floor,
        source: "api",
        plan: readOutConfig().activePlanName,
        prompt,
        size: "portrait",
        seed,
        status: "error",
        error: "出图没有返回图片。",
        durationMs: Date.now() - startedAt
      });
      return { ok: false, message: "出图没有返回图片。" };
    }
    updateArtifact(floor, artifactId, {
      imagePath: rawPath,
      originalImagePath: void 0,
      // 改过词就把新词落回 artifact：再点「重画」用的就是改后的版本
      ...edited || overrides.characters ? { prompt, nl: nl || void 0 } : {},
      metadata: {
        ...meta,
        // 角色词改动一并落回：重画要还原「当时画的是谁、穿什么」
        ...overrides.characters ? { characters: overrides.characters } : {},
        rawImagePath: rawPath,
        bubbleBakedPath: void 0,
        ...meta.pageType ? {} : { pageType },
        ...edited || overrides.characters ? { promptEditedAt: Date.now() } : {},
        ...typeof result.seed === "number" ? { seed: result.seed } : { seed }
      }
    });
    recordImageLog({
      mode: "comic",
      floor,
      source: "api",
      plan: readOutConfig().activePlanName,
      prompt,
      ...nl ? { nl } : {},
      ...characters.length ? { characters } : {},
      size: "portrait",
      ...typeof result.seed === "number" ? { seed: result.seed } : { seed },
      status: "ok",
      durationMs: Date.now() - startedAt
    });
    void saveChatSafe();
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordImageLog({
      mode: "comic",
      floor,
      source: "api",
      plan: readOutConfig().activePlanName,
      prompt,
      size: "portrait",
      seed,
      status: "error",
      error: message,
      durationMs: Date.now() - startedAt
    });
    return { ok: false, message };
  } finally {
    await releasePlanGuard(settings2);
  }
}
const INLINE_CLASS = "sti-inline-card";
const TRAILING_AREA_CLASS = "sti-trailing-area";
const TRAILING_AREA_ID = "sti-trailing-area-";
const MOUNTED_ATTR$1 = "data-sti-mounted";
const cardOverlays = /* @__PURE__ */ new WeakMap();
function revokeCardOverlay(card) {
  var _a;
  (_a = cardOverlays.get(card)) == null ? void 0 : _a.revoke();
  cardOverlays.delete(card);
}
const MODE_LABELS = {
  "illustration": "插画",
  "comic": "漫画分镜",
  "chibi-status": "QQ人状态",
  "chibi-bonus": "QQ人彩蛋",
  "bw-manga": "黑白漫"
};
function mountFloor(floor) {
  var _a, _b, _c;
  const mes = document.querySelector(`.mes[mesid="${floor}"]`);
  if (!mes) return;
  const visible = getArtifacts(floor).filter((a) => {
    var _a2;
    return ((_a2 = a.metadata) == null ? void 0 : _a2.embeddedInBody) !== true;
  });
  const byId = new Map(visible.map((a) => [a.id, a]));
  const refs = parseManwaTags(((_a = getMessage(floor)) == null ? void 0 : _a.mes) ?? "");
  const tagged = refs.length > 0;
  const expected = /* @__PURE__ */ new Set();
  if (tagged) {
    for (const ref of refs) if (byId.has(ref.id)) expected.add(ref.id);
    for (const artifact of visible) {
      if (artifact.mountMode === "inline" && ((_b = artifact.metadata) == null ? void 0 : _b.inlineFallback) === true) expected.add(artifact.id);
    }
  } else {
    for (const artifact of visible) {
      if (artifact.mountMode === "inline") expected.add(artifact.id);
    }
  }
  for (const artifact of visible) {
    if (artifact.mountMode !== "inline") expected.add(artifact.id);
  }
  for (const node of Array.from(mes.querySelectorAll(`[${MOUNTED_ATTR$1}="${floor}"]`))) {
    if (node.classList.contains(TRAILING_AREA_CLASS)) continue;
    const id = node.getAttribute("data-sti-artifact-id") ?? "";
    const artifact = byId.get(id);
    const stale = !expected.has(id) || artifact && node.getAttribute("data-sti-src") !== artifact.imagePath;
    if (stale) {
      revokeCardOverlay(node);
      node.remove();
    }
  }
  const missing = (id) => {
    if (!expected.has(id)) return void 0;
    if (mes.querySelector(`[data-sti-artifact-id="${id}"]`)) return void 0;
    return byId.get(id);
  };
  if (tagged) {
    const anchors = manwaAnchors(floor);
    const count = Math.min(anchors.length, refs.length);
    for (let i = 0; i < count; i += 1) {
      const artifact = missing(refs[i].id);
      if (!artifact) continue;
      anchors[i].appendChild(buildCard$1(artifact, floor, true));
    }
  }
  for (const artifact of visible) {
    if (artifact.mountMode !== "inline") continue;
    if (tagged && ((_c = artifact.metadata) == null ? void 0 : _c.inlineFallback) !== true) continue;
    if (!missing(artifact.id)) continue;
    mountInline(mes, floor, artifact);
  }
  const trailing = visible.filter((a) => a.mountMode !== "inline" && missing(a.id));
  if (trailing.length > 0) mountTrailing(mes, floor, trailing);
  else {
    const wantsTrailing = visible.some((a) => a.mountMode !== "inline" && expected.has(a.id));
    if (!wantsTrailing) {
      const area = mes.querySelector(`#${CSS.escape(`${TRAILING_AREA_ID}${floor}`)}`);
      if (area) area.remove();
    }
  }
}
function remountAll() {
  const nodes = document.querySelectorAll(".mes[mesid]");
  for (const node of Array.from(nodes)) {
    const floor = parseInt(node.getAttribute("mesid") ?? "", 10);
    if (Number.isFinite(floor)) mountFloor(floor);
  }
}
function ensureFloorMounted(floor) {
  mountFloor(floor);
}
function mountInline(mes, floor, artifact) {
  const mesText = mes.querySelector(".mes_text");
  if (!mesText) return;
  const card = buildCard$1(artifact, floor, true);
  let inserted = false;
  if (artifact.textAnchor) {
    const block = locateAnchorBlock(mesText, artifact.textAnchor.selectedText);
    if (block) {
      insertAfterBlock(mesText, block, card);
      inserted = true;
    }
  }
  if (!inserted) mesText.appendChild(card);
}
const BLOCK_TAGS = /* @__PURE__ */ new Set(["P", "DIV", "LI", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "TR", "PRE"]);
function pickTextSegment(segments, selectedText) {
  const text = String(selectedText ?? "").trim();
  if (!text || !segments.length) return -1;
  let joined = "";
  const spans = [];
  for (const seg of segments) {
    spans.push({ start: joined.length, end: joined.length + seg.length });
    joined += seg;
  }
  const range = findAnchorRange(joined, text);
  if (!range) return -1;
  const hit = spans.findIndex((s) => range.end > s.start && range.end <= s.end);
  return hit >= 0 ? hit : spans.length - 1;
}
function locateAnchorBlock(root, selectedText) {
  const text = String(selectedText ?? "").trim();
  if (!text) return null;
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while (node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || parent.closest(`[${MOUNTED_ATTR$1}]`) || parent.closest("bbi_image")) continue;
    const value = node.textContent ?? "";
    if (!value) continue;
    nodes.push({ node, text: value });
  }
  if (!nodes.length) return null;
  const index2 = pickTextSegment(nodes.map((n) => n.text), text);
  if (index2 < 0) return null;
  let block = nodes[index2].node.parentElement ?? root;
  while (block.parentElement && block.parentElement !== root && !BLOCK_TAGS.has(block.tagName)) {
    block = block.parentElement;
  }
  return block;
}
function insertAfterBlock(root, block, card) {
  var _a;
  let anchor = block;
  while ((_a = anchor.nextElementSibling) == null ? void 0 : _a.matches(`[${MOUNTED_ATTR$1}]`)) {
    anchor = anchor.nextElementSibling;
  }
  if (anchor === root.lastElementChild) root.appendChild(card);
  else root.insertBefore(card, anchor.nextSibling);
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
    area.appendChild(buildCard$1(artifact, floor, false));
  }
}
function buildCard$1(artifact, floor, inline) {
  const card = document.createElement("div");
  const comic = inline && artifact.mode === "comic";
  card.className = [
    inline ? INLINE_CLASS : "sti-floor-card",
    ...comic ? ["is-comic"] : []
  ].join(" ");
  card.setAttribute(MOUNTED_ATTR$1, String(floor));
  card.setAttribute("data-sti-artifact-id", artifact.id);
  card.setAttribute("data-sti-src", artifact.imagePath);
  const img = document.createElement("img");
  img.className = "sti-card-image";
  img.src = artifact.imagePath;
  img.alt = `${MODE_LABELS[artifact.mode] || artifact.mode} 作品`;
  img.loading = "lazy";
  if (comic) {
    attachBubbleOverlay(card, img, artifact);
    img.addEventListener("click", () => openComicCardLightbox(floor, artifact.id, img.alt));
  } else {
    img.addEventListener("click", () => openLightbox(artifact.imagePath, img.alt));
  }
  card.appendChild(img);
  if (comic) {
    card.appendChild(buildComicActions(artifact, floor));
  } else {
    const caption = document.createElement("div");
    caption.className = "sti-card-caption";
    caption.appendChild(document.createTextNode(artifact.nl ? artifact.nl.slice(0, 80) : ""));
    if (caption.textContent) card.appendChild(caption);
  }
  return card;
}
function svgIcon(name) {
  const paths = {
    // 循环箭头（重绘）
    redraw: '<path d="M20 11a8 8 0 1 0-2.34 5.66M20 5v6h-6" fill="none"/>',
    // 下载
    download: '<path d="M12 4v11m0 0 4.5-4.5M12 15l-4.5-4.5M5 19h14" fill="none"/>',
    // 对话气泡（气泡 / 台词）
    dialog: '<path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-4 4V6z" fill="none"/>',
    // 铅笔（改提示词）
    edit: '<path d="M4 20h4L20 8l-4-4L4 16v4zM14 6l4 4" fill="none"/>'
  };
  return `<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}
function buildComicActions(artifact, floor) {
  const wrap = document.createElement("div");
  wrap.className = "sti-figure-actions";
  const make = (label, icon) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sti-figure-fab";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.innerHTML = svgIcon(icon);
    btn.addEventListener("click", (e) => e.stopPropagation());
    return btn;
  };
  const status = document.createElement("span");
  status.className = "sti-card-status";
  const edit = make("改提示词", "edit");
  edit.title = "改这一页的提示词（正向词 / nl）并重画";
  edit.addEventListener("click", () => editComicPrompt(floor, artifact.id));
  const redraw = make("重画这一页", "redraw");
  redraw.title = "同一套提示词、换一个种子重画这一页（台词气泡会重新合成）";
  redraw.addEventListener("click", () => {
    if (redraw.disabled) return;
    redraw.disabled = true;
    redraw.classList.add("is-busy");
    status.textContent = "";
    void (async () => {
      try {
        const result = await rerollComicPage(floor, artifact.id);
        if (!result.ok) {
          status.textContent = result.message ?? "重画失败。";
          redraw.disabled = false;
          redraw.classList.remove("is-busy");
          return;
        }
        mountFloor(floor);
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : String(err);
        redraw.disabled = false;
        redraw.classList.remove("is-busy");
      }
    })();
  });
  const download = make("下载这张图", "download");
  download.title = "下载当前显示的这一版（带字 / 无字跟随页面）";
  download.addEventListener("click", () => {
    const img = document.querySelector(`[data-sti-artifact-id="${artifact.id}"] img`);
    void saveImageFile((img == null ? void 0 : img.src) ?? artifact.imagePath, `comic_${Date.now().toString(36)}.png`);
  });
  const dialog = make("气泡与台词", "dialog");
  dialog.title = "打开大图：气泡开关、改台词、移动气泡位置";
  dialog.addEventListener("click", () => openComicCardLightbox(floor, artifact.id, imgAlt(artifact)));
  wrap.append(edit, redraw, download, dialog, status);
  return wrap;
}
function editComicPrompt(floor, artifactId) {
  var _a, _b, _c;
  const artifact = getArtifacts(floor).find((a) => a.id === artifactId);
  if (!artifact) return;
  const page = typeof ((_a = artifact.metadata) == null ? void 0 : _a.pageTitle) === "string" ? artifact.metadata.pageTitle : "";
  const panelCount = typeof ((_b = artifact.metadata) == null ? void 0 : _b.panelCount) === "number" ? artifact.metadata.panelCount : 0;
  const cast = Array.isArray((_c = artifact.metadata) == null ? void 0 : _c.characters) ? artifact.metadata.characters.filter((c) => c && typeof c.name === "string" && typeof c.tag === "string").map((c) => ({ name: c.name, tag: c.tag, ...c.nl ? { nl: c.nl } : {} })) : [];
  openPromptDialog({
    prompt: artifact.prompt ?? "",
    nl: artifact.nl ?? "",
    ...cast.length ? { characters: cast } : {},
    ...page || panelCount ? { subtitle: [page, panelCount ? `${panelCount} 格` : "", cast.length ? `${cast.length} 人` : ""].filter(Boolean).join(" · ") } : {},
    onApply: async (prompt, nl, characters) => {
      const result = await rerollComicPage(floor, artifactId, {
        prompt,
        nl,
        ...characters.length ? { characters } : {}
      });
      if (result.ok) mountFloor(floor);
      return result;
    }
  });
}
function imgAlt(artifact) {
  return `${MODE_LABELS[artifact.mode] || artifact.mode} 作品`;
}
function attachBubbleOverlay(card, img, artifact) {
  const settings2 = getSettings(DEFAULT_SETTINGS);
  const plan = comicOverlayPlan(artifact, settings2);
  if (!plan) return;
  const baseSrc = comicBaseImageOf(artifact);
  let generation = 0;
  const held = { current: null };
  const myToken = ++generation;
  void (async () => {
    var _a;
    const result = await compositeDialogue(baseSrc, plan.items, plan.opts);
    if (myToken !== generation || !result) {
      result == null ? void 0 : result.revoke();
      return;
    }
    (_a = held.current) == null ? void 0 : _a.revoke();
    held.current = result;
    img.src = result.url;
    card.setAttribute("data-sti-bubbled", "");
  })();
  cardOverlays.set(card, {
    revoke: () => {
      var _a;
      generation += 1;
      (_a = held.current) == null ? void 0 : _a.revoke();
      held.current = null;
    }
  });
}
function openComicCardLightbox(floor, artifactId, alt) {
  const latest = getArtifacts(floor).find((a) => a.id === artifactId);
  if (!latest) return;
  const settings2 = getSettings(DEFAULT_SETTINGS);
  const plan = comicOverlayPlan(latest, settings2);
  if (!plan) {
    openLightbox(latest.imagePath, alt);
    return;
  }
  openComicLightbox({
    baseSrc: comicBaseImageOf(latest),
    plan,
    onEditPrompt: () => {
      closeLightbox();
      editComicPrompt(floor, artifactId);
    },
    onSave: async (items) => {
      updateArtifact(floor, artifactId, { dialogue: items ?? [] });
      void saveChatSafe();
      mountFloor(floor);
      const fresh = getArtifacts(floor).find((a) => a.id === artifactId);
      if (!fresh) return null;
      return comicOverlayPlan(fresh, settings2);
    }
  });
}
function randomSeed() {
  return Math.floor(Math.random() * 4294967295);
}
async function rerollPanel(floor, kind, setId, index2, edit) {
  var _a, _b, _c;
  const settings2 = getSettings(DEFAULT_SETTINGS);
  const set = getSets(floor, kind).find((s) => s.setId === setId);
  const panel = set == null ? void 0 : set.panels.find((p) => p.index === index2);
  if (!panel) return { ok: false, message: "找不到这一格。" };
  if (!((edit == null ? void 0 : edit.prompt) ?? panel.prompt ?? "").trim()) {
    return { ok: false, message: "这一格没存下当时的出图词，请用「整条重出」。" };
  }
  const mode = modeOfKind(kind);
  const mono = kind === "manga" && resolveModeSettings(settings2, "bw-manga").bwMangaMono !== false;
  const rawPrompt = ((edit == null ? void 0 : edit.prompt) ?? panel.prompt ?? "").trim();
  const promptText = mono ? withMangaMono(rawPrompt) : rawPrompt;
  const negativeText = kind === "manga" ? mergeNegative(mono ? MANGA_BW_NEGATIVE : "", panel.negative) : panel.negative ?? "";
  const negative = negativeText || void 0;
  acquirePlanGuard();
  const rawNl = edit ? edit.nl : panel.story ?? "";
  const seed = randomSeed();
  const startedAt = Date.now();
  try {
    await ensureModeOutPlan(mode, settings2);
    const nl = nlForMode(settings2, mode) ? kind === "manga" ? buildMangaNl(rawNl) : rawNl : void 0;
    const result = await baiBaiAdapter.generate(
      {
        prompt: promptText,
        ...nl ? { nl } : {},
        ...negative ? { negative } : {},
        // 外貌不再拼在 prompt 里，重画时必须把当时那几个人一起带上，
        // 否则重画出来的脸会换人（用户看到的就是「重画一次变了个角色」）。
        ...((_a = panel.characters) == null ? void 0 : _a.length) ? { characters: panel.characters } : {},
        seed,
        size: "portrait",
        save: true
      },
      pickProfile(settings2.profiles ?? [], mode) ?? fallbackProfile(mode)
    );
    const raw = result.path ?? result.dataUrl;
    if (!raw) return { ok: false, message: "出图没有返回图片。" };
    recordImageLog({
      mode,
      floor,
      source: "api",
      plan: readOutConfig().activePlanName,
      prompt: promptText,
      ...nl ? { nl } : {},
      ...negative ? { negative } : {},
      ...((_b = panel.characters) == null ? void 0 : _b.length) ? { characters: panel.characters } : {},
      size: "portrait",
      ...typeof result.seed === "number" ? { seed: result.seed } : { seed },
      status: "ok",
      durationMs: Date.now() - startedAt
    });
    let path = raw;
    let originalPath;
    if (kind === "manga" && ((_c = panel.lines) == null ? void 0 : _c.length)) {
      const baked = await bakeTheaterLines(raw, panel.lines, settings2, kind);
      if (baked.baked) {
        originalPath = raw;
        path = baked.path;
      }
    }
    updatePanel(floor, kind, setId, index2, {
      imagePath: path,
      ...originalPath ? { originalPath } : {},
      seed: result.seed ?? seed,
      storyAt: Date.now(),
      // 改过的词写回这一格：不改的话下次 ↻ 又把旧词画一遍，用户会以为改词没生效
      ...edit ? { prompt: promptText, story: edit.nl } : {}
    });
    await saveChatSafe();
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordImageLog({
      mode,
      floor,
      source: "api",
      prompt: promptText,
      size: "portrait",
      status: "error",
      error: message,
      durationMs: Date.now() - startedAt
    });
    return { ok: false, message };
  } finally {
    await releasePlanGuard(settings2);
  }
}
async function rerollSet(floor, kind, setId) {
  var _a;
  const settings2 = getSettings(DEFAULT_SETTINGS);
  const set = getSets(floor, kind).find((s) => s.setId === setId);
  if (!set) return { ok: false, message: "找不到这张卡片。" };
  const body = (set.sourceText ?? "").trim();
  if (!body) {
    return { ok: false, message: "这张卡片没存下当时的选段，请重新选段生成。" };
  }
  const mode = modeOfKind(kind);
  acquirePlanGuard();
  let result = null;
  try {
    await ensureModeOutPlan(mode, settings2);
    result = await runTheaterTask({
      mode,
      settings: settings2,
      floor,
      chatId: getCurrentChatId(),
      swipe: getSwipeId(floor),
      body,
      characterName: set.characterName
    });
  } finally {
    await releasePlanGuard(settings2);
  }
  if (!result) return { ok: false, message: "整条重出失败。" };
  if (!result.ok) return { ok: false, message: result.error ?? "整条重出失败。" };
  const total = result.stories.length;
  const stories = [];
  for (const story of result.stories) {
    let imagePath = story.imagePath;
    let originalPath;
    if (kind === "manga" && ((_a = story.lines) == null ? void 0 : _a.length) && imagePath) {
      const baked = await bakeTheaterLines(imagePath, story.lines, settings2, kind);
      if (baked.baked) {
        originalPath = imagePath;
        imagePath = baked.path;
      }
    }
    stories.push({
      ...story,
      imagePath,
      ...originalPath ? { originalPath } : {},
      setId,
      setTitle: story.title ?? set.title,
      setSize: total,
      sourceText: body,
      characterName: set.characterName
    });
  }
  replaceSet(floor, kind, setId, stories);
  await saveChatSafe();
  return { ok: true };
}
const OVERLAY_ID = "sti-pe-overlay";
function closeEditor() {
  var _a;
  (_a = document.getElementById(OVERLAY_ID)) == null ? void 0 : _a.remove();
}
function openPromptEditor(options) {
  var _a;
  closeEditor();
  const { panel } = options;
  const overlay2 = document.createElement("div");
  overlay2.className = "sti-pe-overlay";
  overlay2.id = OVERLAY_ID;
  overlay2.addEventListener("mousedown", (e) => {
    if (e.target === overlay2) closeEditor();
  });
  const box = document.createElement("div");
  box.className = "sti-pe-box";
  const head = document.createElement("div");
  head.className = "sti-pe-head";
  const title = document.createElement("h3");
  title.textContent = `改词 · 第 ${panel.index + 1} 格`;
  head.appendChild(title);
  const close2 = document.createElement("button");
  close2.type = "button";
  close2.className = "sti-pe-x";
  close2.textContent = "×";
  close2.setAttribute("aria-label", "关闭");
  close2.addEventListener("click", closeEditor);
  head.appendChild(close2);
  box.appendChild(head);
  const tip = document.createElement("p");
  tip.className = "sti-pe-tip";
  tip.textContent = "下面两段就是出图时真正发给柏宝绘的内容。正向是 danbooru 短 tag，nl 是自然语言描述；画风、画师串、模型由柏宝绘的方案决定，不在这里。";
  box.appendChild(tip);
  const promptLabel = document.createElement("label");
  promptLabel.className = "sti-pe-label";
  promptLabel.textContent = "正向 tag";
  const promptInput = document.createElement("textarea");
  promptInput.className = "sti-pe-input";
  promptInput.rows = 4;
  promptInput.value = panel.prompt ?? "";
  promptLabel.appendChild(promptInput);
  box.appendChild(promptLabel);
  const nlLabel = document.createElement("label");
  nlLabel.className = "sti-pe-label";
  nlLabel.textContent = "nl（自然语言描述）";
  const nlInput = document.createElement("textarea");
  nlInput.className = "sti-pe-input";
  nlInput.rows = 3;
  nlInput.value = panel.story ?? "";
  nlLabel.appendChild(nlInput);
  box.appendChild(nlLabel);
  if ((_a = panel.characters) == null ? void 0 : _a.length) {
    const cast = document.createElement("div");
    cast.className = "sti-pe-cast";
    cast.textContent = `外貌来自柏宝绘角色库：${panel.characters.map((c) => c.name).join("、")}（要改外貌请去柏宝绘 →「角色」改档，这里改了也会被覆盖）`;
    box.appendChild(cast);
  }
  const foot = document.createElement("div");
  foot.className = "sti-pe-foot";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "sti-pe-btn";
  cancel.textContent = "取消";
  cancel.addEventListener("click", closeEditor);
  foot.appendChild(cancel);
  const save = document.createElement("button");
  save.type = "button";
  save.className = "sti-pe-btn is-main";
  save.textContent = "保存并重画";
  save.addEventListener("click", async () => {
    var _a2;
    const prompt = promptInput.value.trim();
    if (!prompt) {
      promptInput.focus();
      return;
    }
    save.disabled = true;
    save.textContent = "重画中…";
    const result = await rerollPanel(options.floor, options.kind, options.setId, panel.index, {
      prompt,
      nl: nlInput.value.trim()
    });
    save.disabled = false;
    save.textContent = "保存并重画";
    if (!result.ok) {
      const err = document.createElement("div");
      err.className = "sti-pe-error";
      err.textContent = result.message ?? "重画失败。";
      box.appendChild(err);
      return;
    }
    closeEditor();
    (_a2 = options.onSaved) == null ? void 0 : _a2.call(options);
  });
  foot.appendChild(save);
  box.appendChild(foot);
  overlay2.appendChild(box);
  document.body.appendChild(overlay2);
  promptInput.focus();
  promptInput.setSelectionRange(promptInput.value.length, promptInput.value.length);
}
const AREA_ID = "sti-theater-area-";
const AREA_CLASS = "sti-cs-bar";
const MOUNTED_ATTR = "data-sti-theater-mounted";
const BUCKET_LABELS = {
  status: "Q 版小剧场",
  bonus: "彩蛋时刻",
  manga: "黑白漫"
};
const KIND_ORDER = ["status", "bonus", "manga"];
function mountTheater(floor) {
  const mes = document.querySelector(`.mes[mesid="${floor}"]`);
  if (!mes) return;
  unmountTheater(floor);
  const groups = [];
  for (const kind of KIND_ORDER) {
    for (const set of getSets(floor, kind)) groups.push({ kind, set });
  }
  if (groups.length === 0) return;
  const mesBlock = mes.querySelector(".mes_block") ?? mes;
  const area = document.createElement("div");
  area.id = `${AREA_ID}${floor}`;
  area.className = AREA_CLASS;
  area.setAttribute(MOUNTED_ATTR, String(floor));
  for (const { kind, set } of groups) {
    area.appendChild(buildCard(floor, kind, set));
  }
  mesBlock.appendChild(area);
}
function unmountTheater(floor) {
  const mes = document.querySelector(`.mes[mesid="${floor}"]`);
  if (!mes) return;
  const areas = mes.querySelectorAll(`[${MOUNTED_ATTR}="${floor}"]`);
  for (const area of Array.from(areas)) area.remove();
}
function remountAllTheater() {
  const nodes = document.querySelectorAll(".mes[mesid]");
  for (const node of Array.from(nodes)) {
    const floor = parseInt(node.getAttribute("mesid") ?? "", 10);
    if (Number.isFinite(floor)) {
      try {
        mountTheater(floor);
      } catch {
      }
    }
  }
}
function ensureTheaterMounted(floor) {
  const mes = document.querySelector(`.mes[mesid="${floor}"]`);
  if (!mes) return;
  if (mes.querySelector(`[${MOUNTED_ATTR}="${floor}"]`)) {
    const expected = KIND_ORDER.reduce((sum, kind) => sum + getSets(floor, kind).length, 0);
    const actual = mes.querySelectorAll(`[${MOUNTED_ATTR}="${floor}"] .sti-cs-card`).length;
    if (expected === actual) return;
  }
  const has = KIND_ORDER.some((kind) => getSets(floor, kind).length > 0);
  if (!has) return;
  mountTheater(floor);
}
function buildCard(floor, kind, set) {
  var _a;
  const card = document.createElement("details");
  card.className = "sti-cs-card";
  card.open = true;
  card.setAttribute("data-sti-set", `${kind}:${set.setId}`);
  const total = set.panels.length;
  const cover = firstImage(set.panels);
  const summary = document.createElement("summary");
  summary.className = "sti-cs-summary";
  if (cover) {
    const thumb = document.createElement("img");
    thumb.className = "sti-cs-thumb";
    thumb.src = cover;
    thumb.alt = "";
    thumb.loading = "lazy";
    summary.appendChild(thumb);
  }
  const kicker = document.createElement("span");
  kicker.className = "sti-cs-kicker";
  kicker.textContent = kind === "bonus" ? BUCKET_LABELS.bonus : `${BUCKET_LABELS[kind]} · ${total} 格`;
  summary.appendChild(kicker);
  const headline = document.createElement("span");
  headline.className = "sti-cs-headline";
  headline.textContent = set.title || "小剧场";
  summary.appendChild(headline);
  const chevron = document.createElement("i");
  chevron.className = "fa-solid fa-chevron-down sti-cs-chevron";
  summary.appendChild(chevron);
  card.appendChild(summary);
  const single = total === 1 && (((_a = set.panels[0].lines) == null ? void 0 : _a.length) ?? 0) > 0;
  const body = document.createElement("div");
  body.className = single ? "sti-cs-body is-story" : "sti-cs-body";
  if (single) {
    body.appendChild(buildSinglePanel(floor, kind, set, set.panels[0]));
  } else {
    const strip = document.createElement("div");
    strip.className = "sti-cs-strip";
    for (const panel of set.panels) {
      strip.appendChild(buildStripPanel(floor, kind, set, panel, total));
    }
    body.appendChild(strip);
  }
  body.appendChild(buildFoot(floor, kind, set));
  card.appendChild(body);
  return card;
}
function buildStripPanel(floor, kind, set, panel, total) {
  const figure = document.createElement("figure");
  figure.className = "sti-cs-panel";
  const shot = document.createElement("div");
  shot.className = "sti-cs-shot";
  const cell = document.createElement("div");
  cell.className = "sti-cs-cell";
  cell.tabIndex = 0;
  cell.setAttribute("role", "button");
  if (panel.imagePath) {
    const img = document.createElement("img");
    img.className = "sti-cs-cell-img";
    img.src = panel.imagePath;
    img.alt = panel.title ?? `第 ${panel.index + 1} 格`;
    img.loading = "lazy";
    cell.appendChild(img);
    cell.addEventListener("click", () => openPanel(set, panel));
    cell.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openPanel(set, panel);
      }
    });
  } else {
    const ph = document.createElement("div");
    ph.className = "sti-cs-placeholder";
    ph.textContent = "未出图";
    cell.appendChild(ph);
  }
  const num = document.createElement("span");
  num.className = "sti-cs-num";
  num.textContent = `${panel.index + 1}/${total}`;
  cell.appendChild(num);
  shot.appendChild(cell);
  shot.appendChild(buildRerollButton(floor, kind, set, panel));
  figure.appendChild(shot);
  const cap = document.createElement("figcaption");
  cap.className = "sti-cs-panel-cap";
  const capText = document.createElement("span");
  capText.className = "sti-cs-cap-text";
  capText.textContent = panel.title ?? "";
  cap.appendChild(capText);
  if (panel.prompt) cap.appendChild(buildEditButton(floor, kind, set, panel));
  figure.appendChild(cap);
  return figure;
}
function buildSinglePanel(floor, kind, set, panel) {
  const row = document.createElement("div");
  row.className = "sti-cs-single";
  const shot = document.createElement("div");
  shot.className = "sti-cs-shot is-figure";
  const figure = document.createElement("div");
  figure.className = "sti-cs-cell";
  figure.tabIndex = 0;
  figure.setAttribute("role", "button");
  if (panel.imagePath) {
    const img = document.createElement("img");
    img.className = "sti-cs-photo";
    img.src = panel.imagePath;
    img.alt = panel.title ?? "小剧场";
    img.loading = "lazy";
    figure.appendChild(img);
    figure.addEventListener("click", () => openPanel(set, panel));
  }
  shot.appendChild(figure);
  shot.appendChild(buildRerollButton(floor, kind, set, panel));
  row.appendChild(shot);
  const meta = document.createElement("div");
  meta.className = "sti-cs-meta";
  const title = document.createElement("div");
  title.className = "sti-cs-caption";
  title.textContent = panel.title || set.title || "小剧场";
  if (panel.prompt) {
    const edit = buildEditButton(floor, kind, set, panel);
    edit.classList.add("is-inline");
    title.appendChild(edit);
  }
  meta.appendChild(title);
  const sub = document.createElement("div");
  sub.className = "sti-cs-cast";
  sub.textContent = (panel.cast ?? []).join(" · ");
  if (panel.mood) {
    const chip = document.createElement("span");
    chip.className = "sti-cs-chip";
    chip.textContent = panel.mood;
    sub.appendChild(chip);
  }
  if (sub.textContent) meta.appendChild(sub);
  const lines = document.createElement("div");
  lines.className = "sti-cs-lines";
  for (const line of panel.lines ?? []) {
    const rowEl = document.createElement("div");
    rowEl.className = line.speaker === "旁白" || !line.speaker ? "sti-cs-line is-narr" : "sti-cs-line";
    if (line.speaker && line.speaker !== "旁白") {
      const b = document.createElement("b");
      b.textContent = `${line.speaker}：`;
      rowEl.appendChild(b);
    }
    rowEl.appendChild(document.createTextNode(line.text));
    lines.appendChild(rowEl);
  }
  if (lines.childElementCount > 0) meta.appendChild(lines);
  row.appendChild(meta);
  return row;
}
function buildFoot(floor, kind, set, total) {
  const foot = document.createElement("div");
  foot.className = "sti-cs-foot";
  if (set.cast.length > 0) {
    const cast = document.createElement("span");
    cast.className = "sti-cs-cast";
    cast.textContent = set.cast.join(" · ");
    foot.appendChild(cast);
  }
  if (set.mood) {
    const chip = document.createElement("span");
    chip.className = "sti-cs-chip";
    chip.textContent = set.mood;
    foot.appendChild(chip);
  }
  const spacer = document.createElement("span");
  spacer.className = "sti-cs-spacer";
  foot.appendChild(spacer);
  const reroll = document.createElement("button");
  reroll.type = "button";
  reroll.className = "sti-cs-regen";
  reroll.textContent = "整条重出";
  reroll.addEventListener("click", async () => {
    await runBusy(reroll, "重出中…", async () => {
      const result = await rerollSet(floor, kind, set.setId);
      if (!result.ok) throw new Error(result.message ?? "整条重出失败。");
      mountTheater(floor);
    });
  });
  foot.appendChild(reroll);
  if (set.panels.some((p) => !!p.imagePath)) {
    const gallery2 = document.createElement("button");
    gallery2.type = "button";
    gallery2.className = "sti-cs-link";
    gallery2.textContent = "逐格看大图";
    gallery2.addEventListener("click", () => {
      openGallery(
        set.panels.filter((p) => !!p.imagePath).map((p) => ({ src: p.imagePath, caption: p.title ?? "" }))
      );
    });
    foot.appendChild(gallery2);
  }
  const del = document.createElement("button");
  del.type = "button";
  del.className = "sti-cs-link danger";
  del.textContent = "删除";
  del.addEventListener("click", async () => {
    removeSet(floor, kind, set.setId);
    await saveChatSafe();
    mountTheater(floor);
  });
  foot.appendChild(del);
  return foot;
}
function buildEditButton(floor, kind, set, panel) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "sti-cs-edit";
  btn.title = "改词并重画（看得到这一格真正发出去的提示词）";
  btn.setAttribute("aria-label", "改词");
  btn.textContent = "改词";
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openPromptEditor({
      floor,
      kind,
      setId: set.setId,
      panel,
      onSaved: () => mountTheater(floor)
    });
  });
  return btn;
}
function buildRerollButton(floor, kind, set, panel) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "sti-cs-reroll";
  btn.title = "重画这张";
  btn.setAttribute("aria-label", "重画这张");
  btn.textContent = "↻";
  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await runBusy(btn, "…", async () => {
      const result = await rerollPanel(floor, kind, set.setId, panel.index);
      if (!result.ok) throw new Error(result.message ?? "重画失败。");
      mountTheater(floor);
    });
  });
  return btn;
}
function openPanel(set, panel) {
  const images = set.panels.filter((p) => !!p.imagePath).map((p) => ({ src: p.imagePath, caption: p.title ?? "" }));
  if (images.length <= 1) {
    if (panel.imagePath) openLightbox(panel.imagePath, panel.title);
    return;
  }
  const at = images.findIndex((i) => i.src === panel.imagePath);
  openGallery(images, at < 0 ? 0 : at);
}
async function runBusy(btn, busyText, task) {
  const label = btn.textContent ?? "";
  btn.disabled = true;
  btn.textContent = busyText;
  btn.classList.add("is-busy");
  try {
    await task();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    notify(message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
    btn.classList.remove("is-busy");
  }
}
function notify(message, level) {
  var _a;
  const toastr = window.toastr;
  if (toastr) {
    (_a = toastr.error) == null ? void 0 : _a.call(toastr, message);
  } else {
    console.error("[ST-Story-Illustrator]", message);
  }
}
function firstImage(panels) {
  var _a;
  return (_a = panels.find((p) => !!p.imagePath)) == null ? void 0 : _a.imagePath;
}
const listeners = /* @__PURE__ */ new Set();
let observer = null;
let scheduled = false;
let lastFlush = 0;
const MIN_INTERVAL_MS = 250;
function flush() {
  scheduled = false;
  lastFlush = Date.now();
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.error("[ST-Story-Illustrator] #chat 变更回调异常", error);
    }
  }
}
function schedule() {
  if (scheduled) return;
  scheduled = true;
  const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastFlush));
  if (wait === 0) {
    requestAnimationFrame(flush);
    return;
  }
  window.setTimeout(() => requestAnimationFrame(flush), wait);
}
function ensureChatObserver() {
  if (observer) return true;
  const chat = document.getElementById("chat");
  if (!chat) return false;
  observer = new MutationObserver(schedule);
  observer.observe(chat, { childList: true, subtree: true });
  return true;
}
function onChatMutation(listener) {
  listeners.add(listener);
  ensureChatObserver();
  return () => {
    listeners.delete(listener);
  };
}
function destroyChatObserver() {
  listeners.clear();
  observer == null ? void 0 : observer.disconnect();
  observer = null;
  scheduled = false;
  lastFlush = 0;
}
const BALL_ID = "sti-fab";
const HIDE_ID = "sti-fab-hide";
const DRAG_THRESHOLD = 4;
let ball = null;
let startX = 0;
let startY = 0;
let originLeft = 0;
let originTop = 0;
let moved = false;
let dragging = false;
function currentSettings() {
  return getSettings(DEFAULT_SETTINGS);
}
function defaultPosition() {
  const size = 46;
  const left = Math.max(8, window.innerWidth - size - 18);
  const top = Math.max(8, window.innerHeight - size - 110);
  return { left, top };
}
function mountFloatingBall() {
  const settings2 = currentSettings();
  if (settings2.showFloatingBall === false) {
    unmountFloatingBall();
    return;
  }
  if (ball && document.body.contains(ball)) return;
  const pos = settings2.floatingBallPos ?? defaultPosition();
  const el2 = document.createElement("div");
  el2.id = BALL_ID;
  el2.className = "sti-fab";
  el2.title = "ST 故事插画 · 点一下打开配图面板，可拖动";
  el2.textContent = "🎨";
  el2.style.left = `${clamp(pos.left, 0, window.innerWidth - 46)}px`;
  el2.style.top = `${clamp(pos.top, 0, window.innerHeight - 46)}px`;
  el2.tabIndex = 0;
  const hide = document.createElement("button");
  hide.type = "button";
  hide.id = HIDE_ID;
  hide.className = "sti-fab-hide";
  hide.title = "隐藏悬浮球（可在配图设置里重新打开）";
  hide.textContent = "×";
  hide.addEventListener("pointerdown", (e) => e.stopPropagation());
  hide.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    hideFloatingBall();
  });
  el2.appendChild(hide);
  el2.addEventListener("pointerdown", onPointerDown);
  el2.addEventListener("click", (e) => {
    e.preventDefault();
    if (moved) {
      moved = false;
      return;
    }
    openStudio("generate");
  });
  el2.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openStudio("generate");
    }
  });
  document.body.appendChild(el2);
  ball = el2;
  window.addEventListener("resize", keepInside);
}
function onPointerDown(e) {
  var _a, _b;
  if (!ball) return;
  if (((_a = e.target) == null ? void 0 : _a.id) === HIDE_ID) return;
  dragging = true;
  moved = false;
  startX = e.clientX;
  startY = e.clientY;
  originLeft = ball.offsetLeft;
  originTop = ball.offsetTop;
  ball.classList.add("dragging");
  (_b = ball.setPointerCapture) == null ? void 0 : _b.call(ball, e.pointerId);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
}
function onPointerMove(e) {
  if (!dragging || !ball) return;
  const dx = e.clientX - startX;
  const dy = e.clientY - startY;
  if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
  moved = true;
  const left = clamp(originLeft + dx, 0, window.innerWidth - ball.offsetWidth);
  const top = clamp(originTop + dy, 0, window.innerHeight - ball.offsetHeight);
  ball.style.left = `${left}px`;
  ball.style.top = `${top}px`;
}
function onPointerUp() {
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", onPointerUp);
  if (!dragging || !ball) return;
  dragging = false;
  ball.classList.remove("dragging");
  if (moved) {
    const settings2 = currentSettings();
    settings2.floatingBallPos = { left: ball.offsetLeft, top: ball.offsetTop };
    saveSettings(settings2);
  }
}
function keepInside() {
  if (!ball) return;
  const left = clamp(ball.offsetLeft, 0, window.innerWidth - ball.offsetWidth);
  const top = clamp(ball.offsetTop, 0, window.innerHeight - ball.offsetHeight);
  ball.style.left = `${left}px`;
  ball.style.top = `${top}px`;
}
function hideFloatingBall() {
  const settings2 = currentSettings();
  settings2.showFloatingBall = false;
  saveSettings(settings2);
  unmountFloatingBall();
  window.dispatchEvent(new CustomEvent("sti-settings-changed"));
}
function unmountFloatingBall() {
  if (ball) {
    ball.remove();
    ball = null;
  }
  window.removeEventListener("resize", keepInside);
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", onPointerUp);
  dragging = false;
}
function syncFloatingBall() {
  unmountFloatingBall();
  mountFloatingBall();
}
function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), Math.max(min, max));
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
            var _a2, _b2;
            task.progress = progress;
            task.updatedAt = Date.now();
            (_b2 = (_a2 = this.options).onProgress) == null ? void 0 : _b2.call(_a2, task, progress);
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
function bareTagOf(segment) {
  return segment.replace(/^\s*[\d.]+::/, "").replace(/^\s*::/, "").replace(/::\s*$/, "").trim().toLowerCase();
}
function isPlainSegment(segment) {
  const text = segment.trim();
  if (!text) return false;
  if (!text.includes("::")) return true;
  return /^[\d.]+\s*::.*::\s*$/.test(text);
}
const PANEL_FAMILY$1 = [
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
function enforcePanelPrompt(prompt, layout, panelsPerPage = 0) {
  const kind = normalizePanelLayout(layout);
  const source = String(prompt ?? "").trim();
  if (!source) return { prompt: source, removed: [], added: [] };
  const count = resolvePanelsPerPage(kind, panelsPerPage);
  const forbidden = new Set(PANEL_FORBIDDEN_BY_LAYOUT[kind]);
  if (kind === "regular" && count >= 3) forbidden.add("2koma");
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
    if (!PANEL_FAMILY$1.includes(bare)) {
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
  const missing = panelTagsForCount(kind, count).filter((tag) => !present.has(bareTagOf(tag)));
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
  const enforced = enforcePanelPrompt(input.prompt, decision.layout, input.panelsPerPage ?? 0);
  return {
    prompt: enforced.prompt,
    nl: applyPanelToNl(input.nl, decision.layout, input.orientation, input.pageType),
    applied: true,
    layout: decision.layout,
    removed: enforced.removed,
    added: enforced.added
  };
}
const PANEL_FAMILY = /* @__PURE__ */ new Set([
  "multiple views",
  "2koma",
  "3koma",
  "4koma",
  "split screen",
  "white background",
  "3格漫画",
  "三场景漫画构图",
  "非对称漫画页面布局",
  "开放分镜漫画构图",
  "无边框中央插画",
  "第二场景周围没有长方形画框",
  "主场景周围没有长方形包围",
  "人物自然融入白色空间"
]);
function bareTag$1(segment) {
  return segment.replace(/^\s*[\d.]+::/, "").replace(/^\s*::/, "").replace(/::\s*$/, "").trim().toLowerCase();
}
function contentTagCount(tags) {
  return String(tags ?? "").split(",").map(bareTag$1).filter((tag) => tag && !PANEL_FAMILY.has(tag)).length;
}
function hasStoryContent(pages) {
  for (const page of pages) {
    if (page.tags && contentTagCount(page.tags) >= 2) return true;
    if (page.tags && contentTagCount(page.tags) === 0) continue;
    for (const panel of page.panels) {
      if (contentTagCount(panel.tags) >= 2) return true;
    }
  }
  return false;
}
function mergeCharacterTags(prompt, names, library) {
  const present = new Set(prompt.split(",").map(bareTag$1).filter(Boolean));
  const wanted = names.map((name) => library.find((c) => c.name === name)).filter((c) => !!c);
  const sources = wanted.length ? wanted : library.length === 1 ? library : [];
  const extra = [];
  for (const character of sources.slice(0, 2)) {
    for (const raw of String(character.tag ?? "").split(",")) {
      const piece = raw.trim();
      if (!piece) continue;
      const key = bareTag$1(piece);
      if (!key || present.has(key)) continue;
      present.add(key);
      extra.push(piece);
    }
  }
  return extra.length ? `${prompt}, ${extra.join(", ")}` : prompt;
}
const LAYOUT_NL_HEAD = {
  regular: "A two-panel comic page: one canvas split horizontally by a thin black border, read from top to bottom.",
  irregular: "An irregular comic page: unequally sized panels separated by thin black gutters, read from top to bottom.",
  inset: "A manga page on a white background: an unframed character illustration in the center with narrow white margins, plus one or two small close-up panels with thin black borders.",
  unframed: "A manga page on a white background: the main unframed illustration fills the page with narrow white margins, plus narrow close-up panels with thin black borders."
};
const LAYOUT_GAP_NOTE = {
  regular: "The gutters between panels are narrow, clean white bands about 3% of the page width; panels never overlap and the page is filled edge to edge.",
  irregular: "Every panel has its own thin black border with a narrow white gutter between panels; the page is filled edge to edge rather than floating in the middle.",
  inset: "The bordered close-up panels float on the white page with a wide, completely empty white gap between them and the main illustration (at least 5% of the page height); they never touch the characters or each other.",
  unframed: "Only the small inset panels have thin black borders, and each floats on clean white space with a wide empty margin; the main illustration has no frame at all and its white margins stay completely empty."
};
function panelNlBody(panel) {
  const nl = String(panel.nl ?? "").trim();
  const shot = String(panel.shot ?? "").trim();
  const subject = String(panel.subject ?? "").trim();
  const acts = (panel.characters ?? []).map((c) => [String(c.name ?? "").trim(), String(c.act ?? "").trim()].filter(Boolean).join(" ")).filter(Boolean).join("; ");
  const detail = subject || acts || String(panel.title ?? "").trim();
  if (nl) {
    if (shot && !nl.toLowerCase().includes(shot.toLowerCase())) return `${shot}: ${nl}`;
    return nl;
  }
  if (!detail) return "";
  return shot ? `${shot}: ${detail}` : detail;
}
function layoutNlHead(layout, count) {
  if (layout !== "regular" || count < 3) return LAYOUT_NL_HEAD[layout] ?? LAYOUT_NL_HEAD.regular;
  if (count >= 4) {
    return "A four-panel comic page in a two-by-two grid, separated by thin black gutters, read from top to bottom, left to right.";
  }
  return "A three-panel comic page: one wide panel across the top and two smaller panels side by side below, separated by thin black gutters, read from top to bottom.";
}
const AREA_LEAD = {
  regular: ["In the upper panel", "The lower panel shows", "In the third panel", "The bottom panel shows"],
  irregular: ["In the large panel", "In the narrow panel", "In the small panel", "In the bottom strip"],
  inset: ["In the main illustration", "In the top strip", "In the small framed panel", "In the side panel"],
  unframed: ["In the main illustration", "In the top strip", "In the small framed panel", "In the side panel"]
};
function bareTag(segment) {
  return segment.replace(/^\s*[\d.]+::/, "").replace(/^\s*::/, "").replace(/::\s*$/, "").trim().toLowerCase();
}
function mergePanelTags(page) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const panel of page.panels ?? []) {
    for (const raw of String(panel.tags ?? "").split(",")) {
      const piece = raw.trim();
      if (!piece) continue;
      const key = bareTag(piece);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(piece);
    }
  }
  return out.join(", ");
}
function buildPageNl(page) {
  var _a, _b;
  const head = layoutNlHead(page.layout, ((_a = page.panels) == null ? void 0 : _a.length) ?? 0);
  const leads = AREA_LEAD[page.layout] ?? AREA_LEAD.regular;
  const parts = [head];
  let wrote = false;
  (_b = page.panels) == null ? void 0 : _b.forEach((panel, index2) => {
    const body = panelNlBody(panel);
    if (!body) return;
    const lead = leads[Math.min(index2, leads.length - 1)];
    parts.push(lead.endsWith("shows") ? `${lead} ${body}` : `${lead}, ${body}`);
    wrote = true;
  });
  parts.push(LAYOUT_GAP_NOTE[page.layout] ?? LAYOUT_GAP_NOTE.regular);
  if (!wrote) {
    const titles = (page.panels ?? []).map((p) => p.title).filter(Boolean);
    if (titles.length > 0) parts.push(`The panels in reading order: ${titles.join(" / ")}.`);
  }
  return parts.join(" ");
}
function collectPageDialogue(page) {
  if (page.dialogue && page.dialogue.length > 0) return page.dialogue;
  const out = [];
  const panels = page.panels ?? [];
  for (let i = 0; i < panels.length; i += 1) {
    for (const item of panels[i].dialogue ?? []) {
      if (out.length >= 4) return out;
      out.push(item.panel ? item : { ...item, panel: i + 1 });
    }
  }
  return out;
}
function findCastShortfall(pages, characters, options = {}) {
  if (options.nativeCharacters === false) return null;
  for (const page of pages) {
    const declared = declaredPeople(String(page.tags ?? "").trim() || mergePanelTags(page));
    if (declared < 2) continue;
    const composed = composePagePrompt(page, [...characters], options);
    if (composed.characters.length > 0 && composed.characters.length < declared) {
      return {
        pageIndex: page.pageIndex,
        title: page.title,
        declared,
        blocks: composed.characters.length
      };
    }
  }
  return null;
}
function composePagePrompt(page, characters = [], options = {}) {
  const base = String(page.tags ?? "").trim() || mergePanelTags(page);
  const names = [];
  const acts = /* @__PURE__ */ new Map();
  const looks = /* @__PURE__ */ new Map();
  for (const panel of page.panels ?? []) {
    for (const c of panel.characters ?? []) {
      if (!(c == null ? void 0 : c.name)) continue;
      if (!names.includes(c.name)) names.push(c.name);
      const look = String(c.look ?? "").trim();
      if (look && !looks.has(c.name)) looks.set(c.name, look);
      const act = String(c.act ?? "").trim();
      if (act) {
        const list = acts.get(c.name) ?? [];
        if (!list.includes(act)) list.push(act);
        acts.set(c.name, list);
      }
    }
  }
  const declared = options.declared ?? declaredPeople(base);
  const rawCast = names.length ? names.slice(0, 6) : ensurePageCast(page, characters, options.selectedText ?? "", looks);
  const resolved = resolveCastNames(rawCast, characters, {
    ...options.personaName ? { personaName: options.personaName } : {},
    declared,
    max: 3,
    looks,
    acts
  });
  const cast = resolved.cast;
  const native = options.nativeCharacters !== false;
  const multiPanel = (page.panels ?? []).length > 1;
  const characterPrompts = native ? characterPromptsFromLibrary(cast, characters, multiPanel ? void 0 : resolved.acts, resolved.looks) : [];
  const prompt = characterPrompts.length ? base : mergeCharacterTags(base, cast, characters);
  const panelHasDetail = (page.panels ?? []).some(
    (panel) => !!String(panel.nl ?? "").trim() || !!String(panel.shot ?? "").trim() || !!String(panel.subject ?? "").trim()
  );
  const pageNl = String(page.nl ?? "").trim();
  let nl = panelHasDetail || !pageNl ? buildPageNl(page) : pageNl;
  if (nl === pageNl && !/gutter|white space|white gap/i.test(nl)) {
    nl = `${nl} ${LAYOUT_GAP_NOTE[page.layout] ?? LAYOUT_GAP_NOTE.regular}`;
  }
  return {
    prompt,
    nl,
    dialogue: collectPageDialogue(page),
    panelTitles: (page.panels ?? []).map((p) => p.title).filter(Boolean),
    characters: characterPrompts
  };
}
const BBI_IMAGE_EXTRA_KEY = "bbiImage";
const BBI_SLOT_SELECTOR = "div[data-bbi-slot]";
const CARD_GENERATE_SELECTOR = ".bbi-figure__generate";
const CARD_IMAGE_SELECTOR = ".bbi-figure__img";
const CARD_HINT_SELECTOR = ".bbi-figure__hint";
function sanitizeTagText(value) {
  return String(value ?? "").replace(/<[^>]*>/g, " ").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}
function serializeCharacterPrompts(characters) {
  const clean = (characters ?? []).map((c) => {
    const name = sanitizeTagText(c.name);
    const tag = sanitizeTagText(c.tag);
    const nl = sanitizeTagText(c.nl);
    return { name, tag, ...nl ? { nl } : {} };
  }).filter((c) => c.name && c.tag).slice(0, 32);
  if (!clean.length) return "";
  return `<characters>${JSON.stringify(clean)}</characters>`;
}
function buildBbiTag(input) {
  const prompt = sanitizeTagText(input.prompt);
  const nl = sanitizeTagText(input.nl);
  const negative = sanitizeTagText(input.negative);
  const size = input.size === "landscape" ? "landscape" : "portrait";
  const nlPart = nl ? `<nl>${nl}</nl>` : "";
  const negativePart = negative ? `<negative>${negative}</negative>` : "";
  const charactersPart = serializeCharacterPrompts(input.characters);
  return `<bbi_image>${prompt}${nlPart}${negativePart}${charactersPart}<size>${size}</size></bbi_image>`;
}
function lastImageTagEnd(mes) {
  const text = String(mes ?? "");
  const re = /<bbi_image>[\s\S]+?<\/bbi_image>/gi;
  let end = 0;
  let match;
  while ((match = re.exec(text)) !== null) end = match.index + match[0].length;
  return end;
}
function countImageTags(mes) {
  return (String(mes ?? "").match(/<bbi_image>[\s\S]+?<\/bbi_image>/gi) ?? []).length;
}
function promptHash(text) {
  let h1 = 3735928559;
  let h2 = 1103547991;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ h1 >>> 16, 2246822507) ^ Math.imul(h2 ^ h2 >>> 13, 3266489909);
  h2 = Math.imul(h2 ^ h2 >>> 16, 2246822507) ^ Math.imul(h1 ^ h1 >>> 13, 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}
async function insertImageTag(input) {
  const { floor, chatId, swipeId, sendDate, tag, anchorText } = input;
  if (!tag) return { ok: false, reason: "no-context" };
  const ctx = getContext();
  if (!Array.isArray(ctx.chat) || typeof ctx.saveChat !== "function") {
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
  const currentText = msg.mes;
  const existing = currentText.indexOf(tag);
  if (existing >= 0) {
    const seq22 = countImageTags(currentText.slice(0, existing));
    await refreshFloor(ctx, floor, msg);
    return { ok: true, seq: seq22, position: "after-anchor" };
  }
  const snippet = `

${tag}
`;
  const range = anchorText && anchorText.length >= 2 ? findAnchorRange(currentText, anchorText) : null;
  const anchorAt = range ? lineEndAfter(currentText, range.end) : -1;
  const lastTagEnd = lastImageTagEnd(currentText);
  let nextText;
  let position;
  let insertAt;
  if (anchorAt >= 0 && anchorAt >= lastTagEnd) {
    insertAt = anchorAt;
    const head = currentText.slice(0, insertAt).replace(/[ \t]+$/, "");
    nextText = head + snippet + currentText.slice(insertAt);
    position = "after-anchor";
  } else {
    insertAt = currentText.length;
    nextText = `${currentText.trimEnd()}${snippet}`;
    position = "appended";
  }
  const seq2 = countImageTags(currentText.slice(0, insertAt));
  msg.mes = nextText;
  const swipes = msg.swipes;
  if (Array.isArray(swipes) && swipeId >= 0 && swipeId < swipes.length) {
    swipes[swipeId] = nextText;
  }
  try {
    await ctx.saveChat();
  } catch {
    msg.mes = currentText;
    if (Array.isArray(swipes) && swipeId >= 0 && swipeId < swipes.length) {
      swipes[swipeId] = currentText;
    }
    return { ok: false, reason: "save-failed" };
  }
  await refreshFloor(ctx, floor, msg);
  return { ok: true, seq: seq2, position };
}
async function refreshFloor(ctx, floor, msg) {
  var _a;
  try {
    if (typeof ctx.updateMessageBlock === "function") {
      await ctx.updateMessageBlock(floor, msg);
    }
  } catch {
  }
  try {
    const types = getEventTypes();
    (_a = ctx.eventSource) == null ? void 0 : _a.emit(types.MESSAGE_UPDATED ?? "message_updated", floor);
  } catch {
  }
}
function findSlotAnchor(floor, seq2) {
  const mesText = document.querySelector(`.mes[mesid="${floor}"] .mes_text`);
  if (!mesText) return null;
  const anchors = [...mesText.querySelectorAll(BBI_SLOT_SELECTOR)];
  return anchors[seq2] ?? null;
}
async function triggerCardGenerate(floor, seq2, timeoutMs = 1e4) {
  var _a;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const anchor = findSlotAnchor(floor, seq2);
    const shadow = (anchor == null ? void 0 : anchor.shadowRoot) ?? null;
    if (shadow) {
      if (shadow.querySelector(CARD_IMAGE_SELECTOR)) return { ok: true, action: "already" };
      const button = shadow.querySelector(CARD_GENERATE_SELECTOR);
      if (button) {
        const label = (button.textContent ?? "").trim();
        if (label.includes("重新生成") || label.includes("本楼")) {
          return { ok: false, reason: "blocked", message: label };
        }
        button.click();
        return { ok: true, action: "clicked" };
      }
      const hint = shadow.querySelector(CARD_HINT_SELECTOR);
      const hintText = ((_a = hint == null ? void 0 : hint.textContent) == null ? void 0 : _a.trim()) ?? "";
      if (hintText) return { ok: false, reason: "blocked", message: hintText };
    }
    await sleep(150);
  }
  return { ok: false, reason: findSlotAnchor(floor, seq2) ? "timeout" : "no-card" };
}
function readStore(floor) {
  var _a;
  const ctx = getContext();
  const msg = (_a = ctx.chat) == null ? void 0 : _a[floor];
  const extra = msg == null ? void 0 : msg.extra;
  const store = extra == null ? void 0 : extra[BBI_IMAGE_EXTRA_KEY];
  return store && typeof store === "object" ? store : null;
}
function latestEntry(floor, swipeId, hash, seq2) {
  var _a, _b;
  const list = (_b = (_a = readStore(floor)) == null ? void 0 : _a[String(swipeId)]) == null ? void 0 : _b[hash];
  if (!Array.isArray(list) || list.length === 0) return null;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if ((list[i].slotSeq ?? 0) === seq2) return list[i];
  }
  return null;
}
async function waitForEntry(floor, swipeId, hash, seq2, timeoutMs = 9e4) {
  var _a, _b, _c;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entry = latestEntry(floor, swipeId, hash, seq2);
    if (entry) {
      if (entry.status === "ready" && entry.path) return { ok: true, entry };
      if (entry.status === "error") {
        return { ok: false, reason: "error", message: "柏宝绘出图失败（详情见柏宝绘「请求历史」）" };
      }
    }
    const phase = (_c = (_b = (_a = findSlotAnchor(floor, seq2)) == null ? void 0 : _a.shadowRoot) == null ? void 0 : _b.querySelector("[data-phase]")) == null ? void 0 : _c.getAttribute("data-phase");
    if (phase === "error") {
      return { ok: false, reason: "error", message: "柏宝绘出图失败（详情见柏宝绘「请求历史」）" };
    }
    await sleep(800);
  }
  return { ok: false, reason: "timeout" };
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
const IMAGE_TAG = /<bbi_image>[\s\S]+?<\/bbi_image>/gi;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function hasReadyImage(floor, swipeId, tag) {
  const msg = getMessage(floor);
  const extra = msg == null ? void 0 : msg.extra;
  const store = extra == null ? void 0 : extra.bbiImage;
  if (!store) return false;
  const bucket = store[String(swipeId)];
  if (!bucket) return false;
  const list = bucket[promptHash(tag)];
  if (!Array.isArray(list)) return false;
  return list.some((entry) => (entry == null ? void 0 : entry.status) === "ready");
}
function imageTagsOf(floor) {
  var _a;
  const mes = String(((_a = getMessage(floor)) == null ? void 0 : _a.mes) ?? "");
  return [...mes.matchAll(IMAGE_TAG)].map((m) => m[0]);
}
async function waitForBaiBaiImages(floor, options = {}) {
  var _a;
  const timeoutMs = options.timeoutMs ?? 9e4;
  const graceMs = options.graceMs ?? 2500;
  const pollMs = options.pollMs ?? 800;
  const sleep2 = options.sleep ?? defaultSleep;
  const startedAt = Date.now();
  let notified = false;
  let swipeId = 0;
  try {
    const msg = getMessage(floor);
    if (typeof (msg == null ? void 0 : msg.swipe_id) === "number") swipeId = msg.swipe_id;
  } catch {
  }
  for (; ; ) {
    const tags = imageTagsOf(floor);
    const elapsed = Date.now() - startedAt;
    if (tags.length === 0) {
      if (elapsed >= graceMs) return { tags: 0, pending: 0, timedOut: false, waitedMs: elapsed };
      await sleep2(Math.min(pollMs, Math.max(0, graceMs - elapsed)));
      continue;
    }
    const pending = tags.filter((tag) => !hasReadyImage(floor, swipeId, tag)).length;
    if (pending === 0) return { tags: tags.length, pending: 0, timedOut: false, waitedMs: elapsed };
    if (!notified) {
      notified = true;
      (_a = options.onWait) == null ? void 0 : _a.call(options, { tags: tags.length, pending });
    }
    if (elapsed >= timeoutMs) return { tags: tags.length, pending, timedOut: true, waitedMs: elapsed };
    await sleep2(Math.min(pollMs, Math.max(0, timeoutMs - elapsed)));
  }
}
function sceneFromSegment(segment) {
  const context = getSurroundingContext(segment, 1);
  return {
    selectedText: segment.text,
    ...context.previousText ? { previousText: context.previousText } : {},
    ...context.nextText ? { nextText: context.nextText } : {}
  };
}
async function runIllustration(task, ctx, deps) {
  var _a, _b, _c, _d;
  const segment = task.source;
  const floor = getAnchorFloor(segment);
  if (floor === null) throw new Error("无法确定挂载楼层。");
  ctx.report({ stage: "reading" });
  const characters = await getCharacters(floor);
  const cast = readCastContext(((_a = segment.messages.find((m) => !m.isUser)) == null ? void 0 : _a.speaker) ?? "");
  const libraryBlock = buildLibraryBlock(characters.characters);
  const castBlock = buildCastBlock(cast);
  const book = readBookRoles(floor, segment.text, readPersonaName());
  if (!libraryBlock) {
    recordNotice({
      mode: "illustration",
      floor,
      text: "柏宝绘角色库是空的（或这一楼之前还没有档案）：这次插图没有任何外貌可抄，画出来的人不会是故事里的角色。请到柏宝绘 →「角色」里确认条目存在。"
    });
  }
  const wantNl = nlForMode(deps.fullSettings, "illustration");
  const plan = await generateIllustrationPlan({
    scene: sceneFromSegment(segment),
    characters: characters.characters,
    options: {
      includeChinese: deps.fullSettings.includeChinese,
      includeNl: wantNl,
      includeNegative: true
    },
    ...book ? { bookBlock: book.text } : {},
    ...libraryBlock ? { libraryBlock } : {},
    ...castBlock ? { castBlock } : {},
    caller: makeModeLlmCaller(deps.fullSettings, "illustration"),
    promptOverrides: deps.fullSettings.promptOverrides
  });
  if (!plan.ok || !plan.data) {
    recordLlmError({ mode: "illustration", floor, error: plan.error ?? "Tag 计划生成失败。" });
    throw new Error(plan.error ?? "Tag 计划生成失败。");
  }
  ctx.report({ stage: "review" });
  const tagSegments = plan.data.segments.map((seg) => ({
    ...seg,
    chinese: seg.chinese ?? []
  }));
  const nativeCharacters = (await readBackendState()).supportsCharacters !== false;
  const split = splitSegments(tagSegments, nativeCharacters);
  const prompt = split.base;
  if (!prompt.trim()) throw new Error("组装后的英文 prompt 为空。");
  ctx.report({ stage: "generating" });
  const tag = buildBbiTag({
    prompt,
    // 方案不要 nl 时，即便模型自作主张写了也不写进 tag：柏宝绘不会用它，
    // 却会留在正文里被后续「改词」看到，误导以为这张图带自然语言。
    ...wantNl && plan.data.nl ? { nl: plan.data.nl } : {},
    ...plan.data.negative ? { negative: plan.data.negative } : {},
    ...split.characters.length ? { characters: split.characters } : {},
    size: plan.data.size === "landscape" ? "landscape" : "portrait"
  });
  const hash = promptHash(tag);
  const inserted = await insertImageTag({
    floor,
    chatId: task.chatId,
    swipeId: ((_b = segment.messages[0]) == null ? void 0 : _b.swipeId) ?? 0,
    ...((_c = segment.messages[0]) == null ? void 0 : _c.sendDate) ? { sendDate: segment.messages[0].sendDate } : {},
    tag,
    anchorText: segment.text.slice(0, 120)
  });
  if (!inserted.ok) throw new Error(insertFailureMessage(inserted.reason));
  if (inserted.position === "appended") {
    recordNotice({
      mode: "illustration",
      floor,
      text: "没能在正文里定位到你划线的那段原文（可能选段被改过，或这一楼已有图片 tag），这张图已追加到本楼末尾。"
    });
  }
  const triggered = await triggerCardGenerate(floor, inserted.seq);
  if (!triggered.ok) throw new Error(cardFailureMessage(triggered));
  const imageStartedAt = Date.now();
  const waited = await waitForEntry(floor, ((_d = segment.messages[0]) == null ? void 0 : _d.swipeId) ?? 0, hash, inserted.seq);
  if (!waited.ok) console.warn("[ST-Story-Illustrator] 插画结果未取到：", waited.reason, waited.message);
  recordImageLog({
    mode: "illustration",
    floor,
    source: "card",
    plan: readOutConfig().activePlanName,
    model: activePlanModel(),
    prompt,
    ...plan.data.nl ? { nl: plan.data.nl } : {},
    ...plan.data.negative ? { negative: plan.data.negative } : {},
    size: plan.data.size ?? "portrait",
    ...waited.ok && typeof waited.entry.seed === "number" ? { seed: waited.entry.seed } : {},
    status: waited.ok ? "ok" : "error",
    ...waited.ok ? {} : { error: waited.message ?? waited.reason },
    durationMs: Date.now() - imageStartedAt
  });
  const imagePath = waited.ok ? waited.entry.path : "";
  const mesTextEl = document.querySelector(`.mes[mesid="${floor}"] .mes_text`);
  const anchor = mesTextEl ? buildAnchor(segment.text, extractPlainText(mesTextEl), 0) : void 0;
  const artifact = {
    id: createArtifactId(),
    taskId: task.id,
    mode: "illustration",
    chatId: task.chatId,
    sourceFloors: segment.floorIds,
    anchorFloor: floor,
    // 图片已经是正文内容（柏宝绘卡片），不再注入本插件卡片，避免重复与多余的说明文字
    mountMode: "trailing",
    ...anchor ? { textAnchor: anchor } : {},
    imagePath,
    prompt,
    ...plan.data.nl ? { nl: plan.data.nl } : {},
    ...plan.data.negative ? { negative: plan.data.negative } : {},
    metadata: {
      embeddedInBody: true,
      bbiTag: tag,
      bbiHash: hash,
      bbiSlotSeq: inserted.seq,
      ...waited.ok ? { bbiGenerationId: waited.entry.generationId } : {},
      ...waited.ok && typeof waited.entry.seed === "number" ? { seed: waited.entry.seed } : {}
    },
    createdAt: Date.now()
  };
  appendArtifact(floor, artifact);
  await saveChatSafe();
  mountFloor(floor);
  ctx.report({ stage: "completed" });
}
function insertFailureMessage(reason) {
  switch (reason) {
    case "chat-changed":
      return "排队期间切换了聊天，已放弃写入（不覆盖别人的编辑）。";
    case "floor-changed":
      return "排队期间楼层内容变了，已放弃写入。";
    case "swipe-changed":
      return "排队期间楼层滑动到了别的版本，已放弃写入。";
    case "save-failed":
      return "正文写入后保存聊天失败，已回滚。";
    default:
      return "无法写入正文（SillyTavern 上下文不可用）。";
  }
}
function cardFailureMessage(result) {
  if (result.reason === "blocked") return result.message || "柏宝绘未配置出图后端。";
  if (result.reason === "no-card") {
    return "正文已写入 tag，但楼层卡片没有出现。请确认柏宝绘已启用（它负责把 tag 显示成卡片）。";
  }
  return "正文已写入 tag，但没能自动点开柏宝绘的「生成图片」，请在楼层卡片上手动点一下。";
}
async function runComic(task, ctx, deps) {
  var _a, _b, _c, _d;
  const segment = task.source;
  const floor = getAnchorFloor(segment);
  if (floor === null) throw new Error("无法确定挂载楼层。");
  const modeSettings = resolveModeSettings(deps.fullSettings, "comic");
  const characterName = ((_a = segment.messages.find((m) => !m.isUser)) == null ? void 0 : _a.speaker) ?? "";
  const layout = modeSettings.comicLayout ?? "auto";
  const dialoguePolicy = modeSettings.comicDialoguePolicy ?? deps.fullSettings.dialoguePolicy ?? "auto";
  const showComposite = modeSettings.comicShowComposite !== false;
  const wantComicNl = nlForMode(deps.fullSettings, "comic");
  ensureManwaRegexRegistered();
  const manwaTagReady = isManwaRegexRegistered();
  ctx.report({ stage: "reading" });
  const characters = await getCharacters(floor);
  const comicNativeCharacters = (await readBackendState()).supportsCharacters !== false;
  const personaName = readPersonaName();
  const comicBook = readBookRoles(floor, segment.text, personaName);
  const comicLibrary = buildLibraryBlock(characters.characters);
  const comicCast = buildCastBlock(readCastContext(((_b = segment.messages.find((m) => !m.isUser)) == null ? void 0 : _b.speaker) ?? ""));
  const comicBlocks = {
    ...comicBook ? { bookBlock: comicBook.text } : {},
    ...comicLibrary ? { libraryBlock: comicLibrary } : {},
    ...comicCast ? { castBlock: comicCast } : {}
  };
  const planOptions = {
    panelMode: true,
    panelLayout: layout,
    pageType: modeSettings.comicPageType ?? "auto",
    // 漫画页必须有对白：这是它区别于「一张插画」的一半信息量
    dialogue: true,
    dialoguePolicy,
    dialogueMode: "json",
    // nl 是唯一能分区描述「上格/下格」的通道，关掉就只能靠 tag 碰运气。
    // 但它同样是方案的属性：方案没有自然语言通道时，漫画只能靠 tags + panels 表达。
    nl: wantComicNl,
    backend: "nai",
    // 我们确实会给每个角色单独一块（<characters>），所以把「分格图不要写 pos」那条也带上
    charPrompts: comicNativeCharacters,
    includeChinese: deps.fullSettings.includeChinese,
    maxPages: modeSettings.comicMaxPages ?? 1,
    panelsPerPage: resolvePanelsPerPage(layout, modeSettings.comicPanelsPerPage)
  };
  let plan = await generateComicPlan({
    scene: sceneFromSegment(segment),
    characters: characters.characters,
    options: planOptions,
    ...comicBlocks,
    caller: makeModeLlmCaller(deps.fullSettings, "comic"),
    promptOverrides: deps.fullSettings.promptOverrides
  });
  if (!plan.ok || !plan.data) {
    recordLlmError({ mode: "comic", floor, error: plan.error ?? "分镜计划生成失败。" });
    throw new Error(plan.error ?? "分镜计划生成失败。");
  }
  if (!hasStoryContent(plan.data)) {
    console.warn("[ST-Story-Illustrator] 分镜 tag 缺少画面内容，重试一次。");
    plan = await generateComicPlan({
      scene: sceneFromSegment(segment),
      characters: characters.characters,
      ...comicBlocks,
      options: {
        ...planOptions,
        extraInstruction: "上一次的 tags 里只有构图词，没有任何人物、动作、场景——那样的图与剧情无关。这次 page.tags 必须写出：谁在做什么、在哪里、画面里的关键物件（外貌由角色库提供，不要写进 page.tags）。"
      },
      caller: makeModeLlmCaller(deps.fullSettings, "comic"),
      promptOverrides: deps.fullSettings.promptOverrides
    });
    if (!plan.ok || !plan.data) throw new Error(plan.error ?? "分镜计划生成失败。");
    if (!hasStoryContent(plan.data)) {
      throw new Error("分镜计划里只有构图词、没有人物与动作（出图会与选段无关）。请换用更有能力的写 tag 模型。");
    }
  }
  const castGap = findCastShortfall(plan.data, characters.characters, {
    nativeCharacters: comicNativeCharacters,
    selectedText: segment.text,
    ...personaName ? { personaName } : {}
  });
  if (castGap) {
    console.warn(
      `[ST-Story-Illustrator] 第 ${castGap.pageIndex + 1} 页 Base 声称 ${castGap.declared} 人，但只建出 ${castGap.blocks} 个角色块，重问一次分镜。`
    );
    plan = await generateComicPlan({
      scene: sceneFromSegment(segment),
      characters: characters.characters,
      ...comicBlocks,
      options: {
        ...planOptions,
        extraInstruction: `上一版第 ${castGap.pageIndex + 1} 页的 tags 写了 ${castGap.declared} 个人，但 panels[].characters 只写了 ${castGap.blocks} 个——画面里那个人会成为没有外貌约束的陌生人。这次必须让「人数词 = characters 条数」：每个出场的人各写一条，角色库里没有的那位（通常是用户扮演的「你」）**必须给它 look**（英文外貌短语：发色/瞳色/体型/当前着装），取自【角色参考】或【本聊天的人物对应】里的人设摘要；实在拿不到外貌就把人数词改成 1，绝不写空。`
      },
      caller: makeModeLlmCaller(deps.fullSettings, "comic"),
      promptOverrides: deps.fullSettings.promptOverrides
    });
    if (!plan.ok || !plan.data) throw new Error(plan.error ?? "分镜计划生成失败。");
    const after = findCastShortfall(plan.data, characters.characters, {
      nativeCharacters: comicNativeCharacters,
      selectedText: segment.text,
      ...personaName ? { personaName } : {}
    });
    if (after) {
      recordNotice({
        mode: "comic",
        floor,
        text: `第 ${after.pageIndex + 1} 页写着 ${after.declared} 个人，但只能给出 ${after.blocks} 个角色词。多半是柏宝绘角色库里没有「${personaName || "你"}」这一条（或没填外貌），模型也补不出英文外貌。到柏宝绘「角色管理」给人设建一条（1girl/1boy + 发色/瞳色/体型），之后这一页就会有两个完整的人。`
      });
    }
  }
  await ensureModeOutPlan("comic", deps.fullSettings);
  const pinnedLayout = layout === "auto" ? void 0 : layout;
  const mesTextEl = document.querySelector(`.mes[mesid="${floor}"] .mes_text`);
  const inlineAnchor = mesTextEl ? buildAnchor(segment.text, extractPlainText(mesTextEl), 0) : void 0;
  if (!inlineAnchor) {
    recordNotice({
      mode: "comic",
      floor,
      text: "这一楼的正文结构读不到，漫画卡片会挂在楼层末尾（不是插在你划线的地方）。"
    });
  }
  let done = 0;
  const totalPages = plan.data.length;
  for (const page of plan.data) {
    if (ctx.signal.aborted) return;
    const pageLayout = pinnedLayout ?? page.layout;
    ctx.report({ stage: "generating", page: page.pageIndex + 1, totalPages });
    const pageForCompose = { ...page, layout: pageLayout };
    const composed = composePagePrompt(pageForCompose, characters.characters, {
      nativeCharacters: comicNativeCharacters,
      selectedText: segment.text,
      ...personaName ? { personaName } : {}
    });
    const enforced = enforceForGeneration({
      prompt: composed.prompt,
      nl: composed.nl,
      panelLayout: pageLayout,
      chibiOn: false,
      panelsPerPage: resolvePanelsPerPage(pageLayout, modeSettings.comicPanelsPerPage)
    });
    const pageStartedAt = Date.now();
    let result;
    try {
      result = await baiBaiAdapter.generate(
        {
          prompt: enforced.prompt,
          ...wantComicNl && enforced.nl ? { nl: enforced.nl } : {},
          ...composed.characters.length ? { characters: composed.characters } : {},
          ...characterName ? { character: characterName } : {},
          size: "portrait",
          // 图必须进图库：用户是在柏宝绘的图库里找图、复用、看提示词的
          save: true
        },
        pickProfile(deps.settings, "comic") ?? fallbackProfile("comic")
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordImageLog({
        mode: "comic",
        floor,
        source: "api",
        plan: readOutConfig().activePlanName,
        prompt: enforced.prompt,
        ...enforced.nl ? { nl: enforced.nl } : {},
        size: "portrait",
        status: "error",
        error: message,
        durationMs: Date.now() - pageStartedAt
      });
      console.warn("[ST-Story-Illustrator] 漫画页出图失败：", message);
      continue;
    }
    const rawPath = result.path ?? result.dataUrl ?? "";
    recordImageLog({
      mode: "comic",
      floor,
      source: "api",
      plan: readOutConfig().activePlanName,
      model: activePlanModel(),
      prompt: enforced.prompt,
      ...enforced.nl ? { nl: enforced.nl } : {},
      ...composed.characters.length ? { characters: composed.characters } : {},
      size: "portrait",
      ...typeof result.seed === "number" ? { seed: result.seed } : {},
      status: rawPath ? "ok" : "error",
      ...rawPath ? {} : { error: "出图没有返回图片。" },
      durationMs: Date.now() - pageStartedAt
    });
    if (!rawPath) continue;
    const panelCount = resolvePanelsPerPage(pageLayout, modeSettings.comicPanelsPerPage) || page.panels.length;
    const pageType = modeSettings.comicPageType ?? "auto";
    const artifact = {
      id: createArtifactId(),
      taskId: task.id,
      mode: "comic",
      chatId: task.chatId,
      sourceFloors: segment.floorIds,
      anchorFloor: floor,
      // 插在划线处（本插件卡片），不再借柏宝绘的楼层卡片
      mountMode: "inline",
      ...inlineAnchor ? { textAnchor: inlineAnchor } : {},
      pageIndex: page.pageIndex,
      imagePath: rawPath,
      prompt: enforced.prompt,
      ...enforced.nl ? { nl: enforced.nl } : {},
      ...showComposite && composed.dialogue.length ? { dialogue: composed.dialogue } : {},
      metadata: {
        // 重画要靠它还原「当时画的是谁」：没有角色块，重画一次就换人
        ...composed.characters.length ? { characters: composed.characters } : {},
        // 无字原图路径（带字版只在显示层合成，不落盘第二份）
        rawImagePath: rawPath,
        ...characterName ? { characterName } : {},
        pageTitle: page.title,
        // 版面元数据：显示层合成气泡要按「当时下发的格位」排，不能按今天的设置猜
        layout: pageLayout,
        pageType,
        panelCount,
        panelTitles: composed.panelTitles,
        // 每格出场的人：显示层靠它把台词反查到正确的格（说话人证据 > 模型写的格号）
        panelCast: page.panels.map((panel) => (panel.characters ?? []).map((c) => c.name).filter(Boolean)),
        ...typeof result.seed === "number" ? { seed: result.seed } : {}
      },
      createdAt: Date.now()
    };
    appendArtifact(floor, artifact);
    const tag = manwaTagReady ? buildManwaTag(artifact.id) : "";
    const inserted = tag ? await insertManwaTag({
      floor,
      chatId: task.chatId,
      swipeId: ((_c = segment.messages[0]) == null ? void 0 : _c.swipeId) ?? 0,
      ...((_d = segment.messages[0]) == null ? void 0 : _d.sendDate) ? { sendDate: segment.messages[0].sendDate } : {},
      tag,
      anchorText: segment.text.slice(0, 120)
    }) : { ok: false, reason: "no-context" };
    if (inserted.ok) {
      updateArtifact(floor, artifact.id, { metadata: { ...artifact.metadata, manwaTag: tag } });
    } else {
      updateArtifact(floor, artifact.id, {
        metadata: { ...artifact.metadata, inlineFallback: true }
      });
      recordNotice({
        mode: "comic",
        floor,
        text: `第 ${page.pageIndex + 1} 页已出图，但没能写进正文（${inserted.reason}）。这一页会临时挂在楼层里；它不是靠正文 tag 定位的，刷新后位置可能变。`
      });
    }
    done += 1;
  }
  await saveChatSafe();
  if (done === 0) throw new Error("所有漫画页出图均失败。");
  mountFloor(floor);
  ctx.report({ stage: "completed" });
}
async function runTheaterMode(task, ctx, deps) {
  var _a, _b, _c, _d, _e, _f;
  const segment = task.source;
  const mode = task.mode;
  const floor = getAnchorFloor(segment);
  if (floor === null) throw new Error("无法确定挂载楼层。");
  const kind = mode === "chibi-status" ? "status" : mode === "chibi-bonus" ? "bonus" : "manga";
  const characterName = ((_a = segment.messages.find((m) => !m.isUser)) == null ? void 0 : _a.speaker) ?? "";
  ctx.report({ stage: "reading" });
  await ensureModeOutPlan(mode, deps.fullSettings);
  const result = await runTheaterTask({
    mode,
    settings: deps.fullSettings,
    floor,
    chatId: task.chatId,
    swipe: ((_b = segment.messages[0]) == null ? void 0 : _b.swipeId) ?? 0,
    body: segment.text,
    characterName,
    onPanel: (index2, total2) => ctx.report({ stage: "generating", page: index2 + 1, totalPages: total2 })
  });
  if (!result.ok) throw new Error(result.error ?? "小剧场生成失败。");
  if ((_c = result.missingLooks) == null ? void 0 : _c.length) {
    recordNotice({
      mode,
      floor,
      text: `柏宝绘角色库里没有：${result.missingLooks.join("、")}。这几个人这次没有外貌 tag，画出来不会是他们的样子。到柏宝绘 →「角色」里补上；如果整个角色库是空的，先让柏宝绘的自动打标跑一遍，角色（发型/眼睛/服装）建好后再重出即可。`
    });
  }
  const warning = ((_d = result.missingLooks) == null ? void 0 : _d.length) ? `角色库里没有 ${result.missingLooks.join("、")}：这几个人这次没带上外貌。` : "";
  const setId = newSetId();
  const setTitle = ((_e = result.stories[0]) == null ? void 0 : _e.title) ?? "";
  const total = result.stories.length;
  const stories = [];
  for (const story of result.stories) {
    let imagePath = story.imagePath;
    let originalPath;
    if (kind === "manga" && ((_f = story.lines) == null ? void 0 : _f.length) && imagePath) {
      const baked = await bakeTheaterLines(imagePath, story.lines, deps.fullSettings, kind);
      if (baked.baked) {
        originalPath = imagePath;
        imagePath = baked.path;
      }
    }
    stories.push({
      ...story,
      imagePath,
      ...originalPath ? { originalPath } : {},
      setId,
      setTitle,
      setSize: total,
      sourceText: segment.text,
      characterName
    });
  }
  if (!saveSet(floor, kind, stories)) throw new Error("小剧场已生成，但写不进本楼（聊天上下文不可用）。");
  await saveChatSafe();
  mountTheater(floor);
  ctx.report({ stage: "completed", ...warning ? { message: warning } : {} });
}
function createTaskRunner(deps) {
  return async (task, ctx) => {
    acquirePlanGuard();
    try {
      const waitFloor = getAnchorFloor(task.source);
      if (waitFloor !== null) {
        const waited = await waitForBaiBaiImages(waitFloor, {
          onWait: ({ pending }) => ctx.report({ stage: "waiting", message: `等柏宝绘先出完正文插图（还剩 ${pending} 张）` })
        });
        if (waited.timedOut) {
          recordNotice({
            mode: task.mode,
            floor: waitFloor,
            text: `等了 ${Math.round(waited.waitedMs / 1e3)} 秒，柏宝绘还有 ${waited.pending} 张正文插图没出完。这次仍然继续生成，但它的那几张可能会用上本次切换的方案（画风可能不对）。`
          });
        }
      }
      switch (task.mode) {
        case "illustration":
          return await runIllustration(task, ctx, deps);
        case "comic":
          return await runComic(task, ctx, deps);
        case "chibi-status":
        case "chibi-bonus":
        case "bw-manga":
          return await runTheaterMode(task, ctx, deps);
        default:
          throw new Error(`未知创作模式: ${task.mode}`);
      }
    } finally {
      const restored = await releasePlanGuard(deps.fullSettings);
      if (!restored.ok && restored.message) {
        console.warn("[ST-Story-Illustrator]", restored.message);
      }
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
const AUTO_ORDER = [
  { mode: "illustration" },
  { mode: "comic" },
  { mode: "chibi-status", kind: "status" },
  { mode: "chibi-bonus", kind: "bonus" },
  { mode: "bw-manga", kind: "manga" }
];
function pickAutoModes(settings2, floor, ctx) {
  const random = ctx.random ?? Math.random;
  const picks = [];
  for (const { mode, kind } of AUTO_ORDER) {
    const conf = resolveModeSettings(settings2, mode);
    if (!conf.autoTrigger) continue;
    if (kind && ctx.hasStory(kind)) continue;
    if (!kind && ctx.hasArtifact(mode)) continue;
    if (kind === "bonus") {
      const chance = Number(conf.chibiBonusChance ?? (settings2 == null ? void 0 : settings2.chibiBonusChance) ?? 25);
      if (!Number.isFinite(chance) || chance <= 0) continue;
      if (chance < 100 && random() * 100 >= chance) continue;
    }
    if (ctx.busy(`${floor}:${mode}`)) continue;
    picks.push(mode);
  }
  return picks;
}
let initialized = false;
let settings = { ...DEFAULT_SETTINGS };
const cleanupFunctions = [];
let queue = null;
let runTaskId = "";
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
    registerStudio({
      generate: (options) => {
        hideConfigPanel();
        openGeneratePanel(options);
      },
      settings: () => {
        hideSelectionPanel();
        showConfigPanel("settings");
      },
      prompts: () => {
        hideSelectionPanel();
        showConfigPanel("prompts");
      },
      log: () => {
        hideSelectionPanel();
        hideConfigPanel();
        showConfigPanel("log");
      }
    });
    setRunStatusLogOpener(() => openStudio("log"));
    registerEvents();
    ensureManwaRegex();
    setupSelectionListener();
    cleanupFunctions.push(injectWandMenu());
    mountFloatingBall();
    initQueue();
    remountAllSafe();
    cleanupFunctions.push(onChatMutation(reconcileRendered));
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
    taskTimeoutMs: 12 * 60 * 1e3,
    onStatusChange: (task, status) => {
      var _a, _b, _c, _d;
      console.log(`[ST-Story-Illustrator] 任务 ${task.id} → ${status}`);
      if (status === "queued" || status === "reading" || status === "review" || status === "generating") {
        if (runTaskId !== task.id) {
          runTaskId = task.id;
          clearRunStatus();
        }
        updateRunStatus({
          mode: task.mode,
          stage: status,
          ...((_a = task.progress) == null ? void 0 : _a.page) ? { page: task.progress.page } : {},
          ...((_b = task.progress) == null ? void 0 : _b.totalPages) ? { totalPages: task.progress.totalPages } : {}
        });
      } else if (status === "completed") {
        finishRunStatus("ok", ((_c = task.progress) == null ? void 0 : _c.message) ?? "");
        if ((_d = task.progress) == null ? void 0 : _d.message) showToast(task.progress.message, "warn");
        releaseAutoKey(task);
        runTaskId = "";
      } else if (status === "failed") {
        finishRunStatus("error", task.error ?? "未知错误");
        releaseAutoKey(task);
        runTaskId = "";
      } else if (status === "cancelled") {
        finishRunStatus("error", "已取消");
        releaseAutoKey(task);
        runTaskId = "";
      }
    },
    onProgress: (task, progress) => {
      updateRunStatus({
        mode: task.mode,
        stage: progress.stage,
        ...progress.page ? { page: progress.page } : {},
        ...progress.totalPages ? { totalPages: progress.totalPages } : {}
      });
    },
    onError: (task, error) => {
      console.error(`[ST-Story-Illustrator] 任务 ${task.id} 失败:`, error);
      showToast(`${MODE_LABEL$1[task.mode]} 生成失败：${error.message}`, "error");
    }
  });
}
function ensureManwaRegex() {
  if (ensureManwaRegexRegistered()) return;
  let tries = 0;
  const timer2 = window.setInterval(() => {
    tries += 1;
    if (ensureManwaRegexRegistered() || tries > 20) window.clearInterval(timer2);
  }, 500);
  cleanupFunctions.push(() => window.clearInterval(timer2));
}
function remountAllSafe() {
  try {
    remountAll();
  } catch (e) {
    console.warn("[ST-Story-Illustrator] 挂载历史作品失败:", e);
  }
  try {
    remountAllTheater();
  } catch (e) {
    console.warn("[ST-Story-Illustrator] 挂载小剧场失败:", e);
  }
}
function reconcileRendered() {
  for (const node of Array.from(document.querySelectorAll(".mes[mesid]"))) {
    const floor = parseInt(node.getAttribute("mesid") ?? "", 10);
    if (!Number.isFinite(floor)) continue;
    try {
      ensureFloorMounted(floor);
    } catch {
    }
    try {
      ensureTheaterMounted(floor);
    } catch {
    }
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
    syncFloatingBall();
  });
  cleanupFunctions.push(offSettings);
  const onModeSettingsChanged = () => {
    settings = getSettings(DEFAULT_SETTINGS);
    applySettings();
    queue = null;
    initQueue();
    syncFloatingBall();
  };
  window.addEventListener("sti-settings-changed", onModeSettingsChanged);
  cleanupFunctions.push(() => window.removeEventListener("sti-settings-changed", onModeSettingsChanged));
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
    autoPending.clear();
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
  const offReceived = on(events.MESSAGE_RECEIVED, (...args) => {
    const floor = extractFloorFromEventArg(args[0]);
    if (floor < 0) return;
    if (!isAiStoryMessage(getMessage(floor))) return;
    autoPending.add(floor);
  });
  cleanupFunctions.push(offReceived);
  cleanupFunctions.push(on(events.CHARACTER_MESSAGE_RENDERED, (...args) => {
    reMount(...args);
    const floor = extractFloorFromEventArg(args[0]);
    if (floor >= 0 && autoPending.delete(floor)) maybeAutoTrigger(floor);
  }));
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
    if (valid && selection && settings.showSelectionToolbar !== false) showToolbar(selection);
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
function openGeneratePanel(options) {
  hideToolbar();
  const text = ((options == null ? void 0 : options.text) ?? "").trim();
  const floor = typeof (options == null ? void 0 : options.floor) === "number" ? options.floor : lastAssistantFloor();
  if (text) {
    showSelectionPanel(
      {
        ...floor >= 0 ? { initialFloor: floor } : {},
        selectedText: text,
        startAtLocal: true
      },
      handleSegmentConfirmed
    );
  } else {
    showSelectionPanel(
      { ...floor >= 0 ? { initialFloor: floor } : {}, startAtLocal: false },
      handleSegmentConfirmed
    );
  }
}
const autoRunning = /* @__PURE__ */ new Set();
const autoWaited = /* @__PURE__ */ new Set();
const autoPending = /* @__PURE__ */ new Set();
function releaseAutoKey(task) {
  const floor = task.source.floorIds[0];
  if (typeof floor === "number") autoRunning.delete(`${floor}:${task.mode}`);
}
function maybeAutoTrigger(floor) {
  if (!isAvailable()) {
    if (!autoWaited.has(floor)) {
      autoWaited.add(floor);
      void waitForApi(6).then((r) => {
        if (r.status === "available") maybeAutoTrigger(floor);
      });
    }
    return;
  }
  const picks = pickAutoModes(settings, floor, {
    hasStory: (kind) => hasStory(floor, kind),
    hasArtifact: (mode) => getArtifacts(floor).some((a) => a.mode === mode),
    busy: (key) => autoRunning.has(key)
  });
  if (picks.length === 0) {
    console.debug(`[ST-Story-Illustrator] 第 ${floor} 层没有需要自动生成的模式。`);
    return;
  }
  const segment = buildSingleSegment(floor);
  if (!segment) {
    console.warn(`[ST-Story-Illustrator] 第 ${floor} 层取不到正文，跳过自动出图。`);
    showToast("自动出图跳过：这一楼没有可读的正文。", "warn");
    return;
  }
  if (!queue) initQueue();
  for (const mode of picks) {
    autoRunning.add(`${floor}:${mode}`);
    const task = createVisualTask(segment, mode);
    task.status = "queued";
    queue == null ? void 0 : queue.enqueue(task);
  }
  showToast(`本楼自动生成 ${picks.length} 份，排队中。`, "info");
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
  destroyPromptDialog();
  destroyConfigPanel();
  destroyWandMenu();
  unmountFloatingBall();
  destroyRunStatus();
  destroyChatObserver();
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
