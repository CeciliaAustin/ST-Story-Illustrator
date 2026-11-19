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
async function saveChatSafe() {
  const ctx = getContext();
  const save = ctx.saveChat;
  if (typeof save !== "function") return false;
  try {
    await save.call(ctx);
    return true;
  } catch {
    return false;
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
    await sleep$1(WAIT_INTERVAL_MS);
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
function sleep$1(ms) {
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
  // 默认不指定，跟随柏宝绘当前出图方案；用户在弹窗里可为每个模式分别指派
  modeOutPlans: {},
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
const IMAGE_SETTINGS_KEY = "baibai_image";
function asRecord(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : null;
}
function str(v, fallback = "") {
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
    const id = str(e.id).trim();
    if (!id) continue;
    const url = str(e.url).trim();
    out.push({
      id,
      name: str(e.name).trim() || id,
      url,
      hasKey: str(e.key).trim().length > 0
    });
  }
  return out;
}
function parsePlans(raw, endpoints) {
  var _a;
  if (!Array.isArray(raw)) return [];
  const byId = new Map(endpoints.map((e) => [e.id, e]));
  const out = [];
  for (const item of raw) {
    const p = asRecord(item);
    if (!p) continue;
    const id = str(p.id).trim();
    if (!id) continue;
    const endpointId = str(p.endpointId).trim();
    out.push({
      id,
      name: str(p.name).trim() || "未命名方案",
      model: str(p.model).trim(),
      endpointId,
      endpointName: ((_a = byId.get(endpointId)) == null ? void 0 : _a.name) ?? (endpointId || "(未指定)"),
      // 柏宝绘里尺寸直接存成形如 "832×1216" 的字符串
      portraitSize: str(p.portraitSize).trim(),
      landscapeSize: str(p.landscapeSize).trim(),
      modelFamily: detectModelFamily(str(p.model))
    });
  }
  return out;
}
function parseOutConfig(raw) {
  const settings2 = asRecord(raw) ?? {};
  const nai = asRecord(settings2.nai) ?? {};
  const endpoints = parseEndpoints(nai.endpoints);
  const plans = parsePlans(nai.plans, endpoints);
  const activePlanId = str(nai.activePlanId).trim();
  const active = plans.find((p) => p.id === activePlanId) ?? plans[0];
  const activeEndpoint = endpoints.find((e) => e.id === (active == null ? void 0 : active.endpointId));
  return {
    backend: str(settings2.defaultBackend, "nai"),
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
function moneySavingHint(snap) {
  const active = snap.plans.find((p) => p.id === snap.activePlanId);
  if (!active) return "";
  if (active.modelFamily === "5" && snap.plans.some((p) => p.modelFamily === "4.5" || p.modelFamily === "4")) {
    return "当前用的是 NAI5（较贵）。柏宝绘里已有更便宜的方案，可在柏宝绘里切到 NAI4.5 省钱。";
  }
  return "";
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
  for (const mode of Object.keys(MODE_LABELS$1)) {
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
      opt.textContent = `${plan.name}${family} · ${plan.endpointName}`;
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
  if (btn) btn.textContent = `确认选段 · 生成 ${selectedModes.size} 份`;
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
function findPlanRadio(root, planName) {
  const radios = Array.from(root.querySelectorAll('button.item-main[role="radio"]'));
  for (const btn of radios) {
    const nameEl = btn.querySelector(".item-name");
    const label = ((nameEl == null ? void 0 : nameEl.textContent) ?? btn.textContent ?? "").trim();
    if (label === planName || planName && label.includes(planName)) return btn;
  }
  return null;
}
function getBaiBaiShadowRoot() {
  const host = document.getElementById("bbi-app-host");
  return (host == null ? void 0 : host.shadowRoot) ?? null;
}
function openBaiBaiBackendPanel() {
  const menuItem = document.getElementById("bbi-menu-item");
  if (menuItem) {
    menuItem.click();
    return;
  }
  const orb = document.querySelector('.bbi-orb, [class*="bbi-floating-orb"]');
  orb == null ? void 0 : orb.click();
}
function tryClickPlanRadio(planName) {
  const shadow = getBaiBaiShadowRoot();
  if (!shadow) return false;
  const radio = findPlanRadio(shadow, planName);
  if (!radio || radio.hasAttribute("disabled")) return false;
  radio.click();
  return true;
}
async function confirmSwitched(planId, targetName) {
  const confirmDeadline = Date.now() + 2500;
  while (Date.now() < confirmDeadline) {
    if (readOutConfig().activePlanId === planId) {
      return { ok: true, reason: "switched", message: `已切到「${targetName}」。` };
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return {
    ok: false,
    reason: "no-ui",
    message: "已点击方案按钮，但未能确认切换结果。请到柏宝绘里确认当前方案是否为「" + targetName + "」。"
  };
}
async function switchBaiBaiPlan(planId, timeoutMs = 8e3) {
  const snap = readOutConfig();
  const target = snap.plans.find((p) => p.id === planId);
  if (!target) {
    return { ok: false, reason: "error", message: "方案不存在（可能已被删除）。" };
  }
  if (snap.activePlanId === planId) {
    return { ok: false, reason: "already", message: `「${target.name}」已经是当前方案。` };
  }
  if (tryClickPlanRadio(target.name)) {
    return await confirmSwitched(planId, target.name);
  }
  try {
    openBaiBaiBackendPanel();
  } catch {
  }
  const deadline = Date.now() + timeoutMs;
  let clicked = false;
  while (Date.now() < deadline) {
    if (tryClickPlanRadio(target.name)) {
      clicked = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!clicked) {
    return {
      ok: false,
      reason: "no-ui",
      message: "没能定位到柏宝绘的方案按钮。请打开柏宝绘设置（魔杖菜单 → 柏宝绘 → 后端），手动选「" + target.name + "」，本面板会自动同步。"
    };
  }
  return await confirmSwitched(planId, target.name);
}
const PANEL_ID = "sti-config-panel";
const OVERLAY_ID = "sti-config-overlay";
const MENU_ID = "sti-config-menu-item";
const MODE_LABEL = {
  "illustration": "正文插画",
  "comic": "正文漫画分镜",
  "chibi-status": "QQ 人状态栏",
  "chibi-bonus": "QQ 人彩蛋",
  "bw-manga": "黑白漫小剧场"
};
let panelEl = null;
let overlayEl = null;
function ensurePanel() {
  if (panelEl && overlayEl && document.body.contains(panelEl)) {
    return { panel: panelEl, overlay: overlayEl };
  }
  const overlay2 = document.createElement("div");
  overlay2.id = OVERLAY_ID;
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
function showConfigPanel() {
  const { panel, overlay: overlay2 } = ensurePanel();
  render(panel);
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
function render(panel) {
  panel.innerHTML = "";
  const snap = readOutConfig();
  const head = document.createElement("div");
  head.className = "sti-config-head";
  const title = document.createElement("h2");
  title.textContent = "出图配置同步";
  head.appendChild(title);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "sti-config-close";
  close.textContent = "×";
  close.addEventListener("click", () => hideConfigPanel());
  head.appendChild(close);
  panel.appendChild(head);
  const body = document.createElement("div");
  body.className = "sti-config-body";
  const cur = section("当前出图方案", "以下是柏宝绘此刻实际用于出图的配置，本面板实时同步。");
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
  body.appendChild(cur);
  const modePlans = getSettings(DEFAULT_SETTINGS).modeOutPlans ?? {};
  const assigned = Object.entries(modePlans).filter(([, id]) => !!id);
  if (assigned.length > 0) {
    const perMode = section(
      "各创作模式指定的方案",
      "出图前会自动把柏宝绘切到对应方案（串行执行，不会互相打断）。要改请到选段弹窗底部「出图方案」。"
    );
    const box = document.createElement("div");
    box.className = "sti-config-eplist";
    for (const [mode, planId] of assigned) {
      const plan = snap.plans.find((p) => p.id === planId);
      const row = document.createElement("div");
      row.className = "sti-config-ep";
      const label = MODE_LABEL[mode] ?? mode;
      row.textContent = plan ? `${label} → ${plan.name} · ${plan.endpointName}` : `${label} → 方案已失效（${planId.slice(0, 8)}…）`;
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
    meta.textContent = `${p.model || "(未填模型)"} · ${p.endpointName}${p.portraitSize ? ` · ${p.portraitSize}` : ""}`;
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
  note.textContent = "本面板只读柏宝绘配置，出图仍由柏宝绘执行。";
  foot.appendChild(note);
  panel.appendChild(foot);
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
function injectConfigMenu() {
  let done = false;
  const tryInject = () => {
    const menu = document.getElementById("extensionsMenu");
    if (!menu || document.getElementById(MENU_ID)) return;
    const item = document.createElement("div");
    item.className = "extension_container interactable";
    item.tabIndex = 0;
    const link = document.createElement("a");
    link.id = MENU_ID;
    link.className = "list-group-item";
    link.href = "#";
    link.title = "ST 故事插画 · 出图配置";
    link.innerHTML = '<i class="fa-solid fa-images"></i> <span>配图设置</span>';
    link.addEventListener("click", (e) => {
      e.preventDefault();
      showConfigPanel();
      const m = document.getElementById("extensionsMenu");
      if (m) m.style.display = "none";
    });
    item.appendChild(link);
    menu.appendChild(item);
    done = true;
  };
  tryInject();
  const timer = window.setInterval(() => {
    tryInject();
    if (done || document.getElementById(MENU_ID)) window.clearInterval(timer);
  }, 500);
  return () => window.clearInterval(timer);
}
function destroyConfigPanel() {
  var _a;
  if (panelEl) {
    panelEl.remove();
    panelEl = null;
  }
  if (overlayEl) {
    overlayEl.remove();
    overlayEl = null;
  }
  (_a = document.getElementById(MENU_ID)) == null ? void 0 : _a.remove();
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
function saveStory(floor, bucket, story) {
  const msg = getMessage(floor);
  if (!msg) return false;
  if (!msg.extra) msg.extra = {};
  const extra = msg.extra;
  const store = readStore$1(extra[THEATER_KEY]);
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
  const store = readStore$1(extra[THEATER_KEY]);
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
const PANEL_DIALOGUE_MAX$1 = 4;
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
    if (items.length >= PANEL_DIALOGUE_MAX$1) break;
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
- **tags 必须画出这一格正在发生的事**，至少要包含：① 出场角色的外观 tag（照抄角色快照里那串，一个角色 3~6 个即可，不要整串抄）；② 这个人正在做什么（动作/表情/姿势）；③ 在哪（室内外 + 一个具体地点）；④ 画面里的关键物件。**只写构图词的 tags 一律不合格**——那样的图与剧情毫无关系，是本次最严重的错误。
- 反例（错误）："multiple views, split screen, white background, cinematic lighting" —— 没有人物、没有动作，出图必然与剧情无关。
- 正例（正确）："1boy, short black hair, white shirt, leaning over a desk, holding a letter, nervous expression, classroom, afternoon, multiple views, split screen"。
- tags 里不要出现 speech bubble / text / dialogue / caption / english text —— 台词由插件在出图后合成，画面里出现字必然是乱码。
- nl 是英文自然语言描述，按格写（先总述版面，再逐格写）；台词是对白气泡用中文口语。
- **台词字段必须写**：从本格剧情里挑最值得说的一两句话（可以是呼喊、拟声词「咚！」「……」），不得整页省略。
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
function buildComicUserPrompt(scene, characters, extraInstruction) {
  const parts = [];
  parts.push("【剧情（据此排分镜）】\n" + scene.selectedText);
  if (scene.floorText) parts.push("【所在楼层全文】\n" + scene.floorText);
  if (scene.previousText) parts.push("【前文（仅补充）】\n" + scene.previousText);
  if (scene.nextText) parts.push("【后文（仅补充）】\n" + scene.nextText);
  if (characters.length > 0) {
    const lines = characters.map((c) => `- ${c.name}: ${c.tag ?? ""}${c.nl ? ` (${c.nl})` : ""}`);
    parts.push("【在场角色（保持外貌一致）】\n" + lines.join("\n"));
  }
  if (extraInstruction) parts.push("【本次特别要求】\n" + extraInstruction);
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
  const user = buildComicUserPrompt(input.scene, input.characters ?? [], input.options.extraInstruction);
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
function bareTag(segment) {
  return segment.replace(/^\s*[\d.]+::/, "").replace(/^\s*::/, "").replace(/::\s*$/, "").trim().toLowerCase();
}
function contentTagCount(tags) {
  return String(tags ?? "").split(",").map(bareTag).filter((tag) => tag && !PANEL_FAMILY.has(tag)).length;
}
function hasStoryContent(pages) {
  for (const page of pages) {
    for (const panel of page.panels) {
      if (contentTagCount(panel.tags) >= 2) return true;
    }
  }
  return false;
}
function mergeCharacterTags(prompt, names, library) {
  const present = new Set(prompt.split(",").map(bareTag).filter(Boolean));
  const wanted = names.map((name) => library.find((c) => c.name === name)).filter((c) => !!c);
  const sources = wanted.length ? wanted : library.length === 1 ? library : [];
  const extra = [];
  for (const character of sources.slice(0, 2)) {
    for (const raw of String(character.tag ?? "").split(",")) {
      const piece = raw.trim();
      if (!piece) continue;
      const key = bareTag(piece);
      if (!key || present.has(key)) continue;
      present.add(key);
      extra.push(piece);
    }
  }
  return extra.length ? `${prompt}, ${extra.join(", ")}` : prompt;
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
const PANEL_DIALOGUE_MAX = 4;
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
const FALLBACK_ORDER = ["tl", "tr", "bl", "br", "tc", "bc", "ml", "mr"];
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
function placeRect(rect, item, index2, page, margin, fontSize, placed, usedAreas, withTail) {
  let area = item.area;
  if (!area) area = FALLBACK_ORDER.find((c) => !usedAreas.has(c)) ?? FALLBACK_ORDER[index2 % FALLBACK_ORDER.length];
  if (area) usedAreas.add(area);
  const anchor = BUBBLE_ANCHORS[area ?? "tl"];
  if (typeof item.x === "number" && typeof item.y === "number") {
    rect.x = Math.min(Math.max(margin, item.x * page.width - rect.width / 2), page.width - rect.width - margin);
    rect.y = Math.min(Math.max(margin, item.y * page.height - rect.height / 2), page.height - rect.height - margin);
    if (withTail) rect.tail = item.y < 0.5 ? "down" : "up";
    placed.push(rect);
    return;
  }
  rect.x = Math.min(Math.max(margin, anchor.x * page.width - rect.width / 2), page.width - rect.width - margin);
  rect.y = Math.min(Math.max(margin, anchor.y * page.height - rect.height / 2), page.height - rect.height - margin);
  for (let guard = 0; guard < 8; guard += 1) {
    const hit = placed.find((o) => rect.x < o.x + o.width && rect.x + rect.width > o.x && rect.y < o.y + o.height && rect.y + rect.height > o.y);
    if (!hit) break;
    const down = hit.y + hit.height + fontSize * 0.3;
    if (down + rect.height <= page.height - margin) rect.y = down;
    else rect.y = Math.max(margin, hit.y - rect.height - fontSize * 0.3);
  }
  if (withTail) rect.tail = rect.y + rect.height / 2 < page.height / 2 ? "down" : "up";
  placed.push(rect);
}
function planBubbles(items, page, measure, opts = {}) {
  if (!page.width || !page.height) return [];
  const style = normalizeBubbleStyle(opts.style);
  if (isBlendStyle(style)) return planBlend(items, page, measure, style);
  return planBubbleBox(items, page, measure, style);
}
function planBubbleBox(items, page, measure, style) {
  const variant = bubbleVariantOf(style);
  const fontSize = Math.max(15, Math.min(44, Math.round(Math.min(page.width, page.height) * 0.034)));
  const lineHeight = fontSize * 1.4;
  const padX = fontSize * 0.7;
  const padY = fontSize * 0.55;
  const maxBubbleWidth = page.width * 0.42;
  const margin = Math.round(page.width * 0.02);
  const placed = [];
  const usedAreas = /* @__PURE__ */ new Set();
  items.slice(0, PANEL_DIALOGUE_MAX).forEach((item, index2) => {
    var _a;
    if (!item.text.trim()) return;
    if (variant === "vertical") {
      const step = fontSize * 1.15;
      const perCol = Math.max(3, Math.floor(page.height * 0.5 / step));
      const cols = [];
      const chars = [...item.text];
      for (let i = 0; i < chars.length; i += perCol) cols.push(chars.slice(i, i + perCol).join(""));
      const width2 = Math.ceil(cols.length * fontSize + (cols.length - 1) * fontSize * 0.26 + padX * 2);
      const height2 = Math.ceil(Math.min(perCol, ((_a = cols[0]) == null ? void 0 : _a.length) ?? 0) * step + padY * 2);
      placeRect({ x: 0, y: 0, width: width2, height: height2, lines: cols, vertical: true }, item, index2, page, margin, fontSize, placed, usedAreas, true);
      return;
    }
    const lines = wrapText(item.text, maxBubbleWidth - padX * 2, measure);
    if (!lines.length) return;
    const width = Math.ceil(Math.max(...lines.map(measure)) + padX * 2);
    const height = Math.ceil(lines.length * lineHeight + padY * 2);
    if (variant === "subtitle") {
      const area = ["bc", "bl", "br"][index2 % 3];
      const anchor = BUBBLE_ANCHORS[area];
      const rect = { x: 0, y: 0, width, height, lines };
      rect.x = Math.min(Math.max(margin, anchor.x * page.width - rect.width / 2), page.width - rect.width - margin);
      rect.y = page.height - rect.height - Math.max(margin, Math.round(page.height * 0.04));
      placed.push(rect);
      return;
    }
    placeRect({ x: 0, y: 0, width, height, lines }, item, index2, page, margin, fontSize, placed, usedAreas, true);
  });
  return placed;
}
function planBlend(items, page, measure, style) {
  const fontSize = blendFontSize(page);
  const margin = Math.round(page.width * 0.02);
  const maxW = page.width * (style === "blend-subtitle" ? 0.86 : 0.52);
  const maxH = page.height * 0.42;
  const forceVertical = style === "blend-vertical";
  const subtitle = style === "blend-subtitle";
  const subtitleAreas = ["bc", "bl", "br"];
  const placed = [];
  const usedAreas = /* @__PURE__ */ new Set();
  items.slice(0, PANEL_DIALOGUE_MAX).forEach((item, index2) => {
    if (!item.text.trim()) return;
    const vertical = forceVertical || !subtitle && item.dir === "v";
    let rect;
    if (vertical) {
      const { cols, width, height } = layoutBlendV(item.text, maxH, fontSize);
      rect = { x: 0, y: 0, width, height, lines: cols, vertical: true };
    } else {
      const { lines, width, height } = layoutBlendH(item.text, maxW, fontSize, measure);
      if (!lines.length) return;
      rect = { x: 0, y: 0, width, height, lines };
    }
    if (subtitle) {
      const area = subtitleAreas[index2 % subtitleAreas.length];
      const anchor = BUBBLE_ANCHORS[area];
      rect.x = Math.min(Math.max(margin, anchor.x * page.width - rect.width / 2), page.width - rect.width - margin);
      rect.y = page.height - rect.height - Math.max(margin, Math.round(page.height * 0.04));
      for (let guard = 0; guard < 8; guard += 1) {
        const hit = placed.find((o) => rect.x < o.x + o.width && rect.x + rect.width > o.x && rect.y < o.y + o.height && rect.y + rect.height > o.y);
        if (!hit) break;
        rect.y = Math.max(margin, hit.y - rect.height - fontSize * 0.25);
      }
      placed.push(rect);
      return;
    }
    placeRect(rect, item, index2, page, margin, fontSize, placed, usedAreas, false);
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
  if (isBlendStyle(style)) {
    drawBlend(ctx, items, fontStack, width, height, style);
    return canvas;
  }
  const fontSize = Math.max(15, Math.min(44, Math.round(Math.min(width, height) * 0.034)));
  const font = (w) => `${w} ${fontSize}px ${fontStack}`;
  ctx.font = font("400");
  const bubbles = planBubbles(items, { width, height }, (s) => ctx.measureText(s).width, opts);
  const lineWidth = Math.max(2, Math.round(fontSize * 0.09));
  const tailSize = fontSize * 0.5;
  const ink = boxInkFor(style);
  for (const bubble of bubbles) {
    if (bubble.tail) {
      const baseY = bubble.tail === "down" ? bubble.y + bubble.height : bubble.y;
      const tipY = bubble.tail === "down" ? baseY + tailSize : baseY - tailSize;
      const baseX = bubble.x + bubble.width * 0.28;
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
      roundRectPath(ctx, bubble, fontSize * 0.45);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.strokeStyle = "#1a1a1a";
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(baseX - tailSize * 0.5, bubble.tail === "down" ? bubble.y + bubble.height - lineWidth : bubble.y, tailSize, lineWidth + 1);
    } else {
      roundRectPath(ctx, bubble, fontSize * 0.35);
      ctx.fillStyle = "rgba(18,16,15,0.82)";
      ctx.fill();
      ctx.strokeStyle = "#e8e4dc";
      ctx.lineWidth = Math.max(1.5, fontSize * 0.06);
      ctx.stroke();
    }
    ctx.fillStyle = ink.color;
    if (ink.glow) {
      ctx.shadowColor = ink.glow;
      ctx.shadowBlur = fontSize * 0.7;
    }
    ctx.textBaseline = "top";
    if (bubble.vertical) {
      const step = fontSize * 1.15;
      const colSpacing = fontSize * 0.26;
      const colX = (ci) => bubble.x + bubble.width - fontSize * 0.7 - (ci + 1) * fontSize - ci * colSpacing;
      const totalH = Math.min(perColOf(bubble.lines), ((_a = bubble.lines[0]) == null ? void 0 : _a.length) ?? 0) * step;
      bubble.lines.forEach((col, ci) => [...col].forEach((ch, ri) => ctx.fillText(ch, colX(ci), bubble.y + (bubble.height - totalH) / 2 + ri * step)));
    } else {
      const textHeight = bubble.lines.length * fontSize * 1.4;
      let cursorY = bubble.y + (bubble.height - textHeight) / 2 + fontSize * 0.08;
      for (const line of bubble.lines) {
        ctx.font = font("400");
        ctx.fillText(line, bubble.x + fontSize * 0.7, cursorY);
        cursorY += fontSize * 1.4;
      }
    }
    ctx.shadowBlur = 0;
  }
  return canvas;
}
function drawBlend(ctx, items, fontStack, width, height, style) {
  const fontSize = blendFontSize({ width, height });
  const spacing = style === "blend-subtitle" ? fontSize * 0.1 : blendSpacing(fontSize);
  ctx.textBaseline = "top";
  ctx.font = `400 ${fontSize}px ${fontStack}`;
  ctx.lineJoin = "round";
  const measure = (s) => ctx.measureText(s).width;
  const rects = planBubbles(items, { width, height }, measure, { style });
  const capped = items.slice(0, PANEL_DIALOGUE_MAX).filter((i) => i.text.trim());
  const needsSampling = style === "blend" || style === "blend-vertical";
  rects.forEach((rect, index2) => {
    const item = capped[index2];
    if (!item) return;
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
async function loadDrawableImage(src) {
  if (/^(blob|data):/i.test(src)) {
    return { image: await loadImage(src), cleanup: () => {
    } };
  }
  const response = await fetch(src, { mode: "cors" });
  if (!response.ok) throw new Error(`fetch 失败: ${response.status}`);
  const blob = await response.blob();
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
    ...input.font ? { font: input.font } : {}
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
const BBI_IMAGE_EXTRA_KEY = "bbiImage";
const BBI_SLOT_SELECTOR = "div[data-bbi-slot]";
const CARD_GENERATE_SELECTOR = ".bbi-figure__generate";
const CARD_IMAGE_SELECTOR = ".bbi-figure__img";
const CARD_HINT_SELECTOR = ".bbi-figure__hint";
function sanitizeTagText(value) {
  return String(value ?? "").replace(/<[^>]*>/g, " ").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}
function buildBbiTag(input) {
  const prompt = sanitizeTagText(input.prompt);
  const nl = sanitizeTagText(input.nl);
  const negative = sanitizeTagText(input.negative);
  const size = input.size === "landscape" ? "landscape" : "portrait";
  const nlPart = nl ? `<nl>${nl}</nl>` : "";
  const negativePart = negative ? `<negative>${negative}</negative>` : "";
  return `<bbi_image>${prompt}${nlPart}${negativePart}<size>${size}</size></bbi_image>`;
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
  let nextText;
  let position;
  let insertAt;
  if (anchorText && anchorText.length >= 2 && currentText.includes(anchorText)) {
    insertAt = currentText.indexOf(anchorText) + anchorText.length;
    nextText = currentText.slice(0, insertAt) + snippet + currentText.slice(insertAt);
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
async function replaceEntryPath(floor, swipeId, hash, generationId, nextPath) {
  var _a, _b;
  const ctx = getContext();
  const msg = (_a = ctx.chat) == null ? void 0 : _a[floor];
  const extra = msg == null ? void 0 : msg.extra;
  const store = extra == null ? void 0 : extra[BBI_IMAGE_EXTRA_KEY];
  const list = (_b = store == null ? void 0 : store[String(swipeId)]) == null ? void 0 : _b[hash];
  if (!Array.isArray(list)) return false;
  const index2 = list.findIndex((e) => e.generationId === generationId);
  if (index2 < 0) return false;
  if (list[index2].path === nextPath) return true;
  list[index2] = { ...list[index2], path: nextPath };
  try {
    if (typeof ctx.saveChat === "function") await ctx.saveChat();
  } catch {
    return false;
  }
  await refreshFloor(ctx, floor, msg);
  return true;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
async function ensureModeOutPlan(mode, deps) {
  var _a;
  const planId = (_a = deps.fullSettings.modeOutPlans) == null ? void 0 : _a[mode];
  if (!planId) return;
  const snap = readOutConfig();
  if (!snap.plans.some((p) => p.id === planId)) {
    console.warn(`[ST-Story-Illustrator] ${mode} 指定的出图方案已不存在，改用当前方案。`);
    return;
  }
  if (snap.activePlanId === planId) return;
  try {
    const result = await switchBaiBaiPlan(planId);
    if (!result.ok && result.reason !== "already") {
      console.warn(`[ST-Story-Illustrator] 切换出图方案失败（继续用当前方案）：${result.message}`);
    }
  } catch (e) {
    console.warn("[ST-Story-Illustrator] 切换出图方案异常（继续用当前方案）:", e);
  }
}
async function runIllustration(task, ctx, deps) {
  var _a, _b, _c;
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
  ctx.report({ stage: "generating" });
  await ensureModeOutPlan("illustration", deps);
  const tag = buildBbiTag({
    prompt,
    ...plan.data.nl ? { nl: plan.data.nl } : {},
    ...plan.data.negative ? { negative: plan.data.negative } : {},
    size: plan.data.size === "landscape" ? "landscape" : "portrait"
  });
  const hash = promptHash(tag);
  const inserted = await insertImageTag({
    floor,
    chatId: task.chatId,
    swipeId: ((_a = segment.messages[0]) == null ? void 0 : _a.swipeId) ?? 0,
    ...((_b = segment.messages[0]) == null ? void 0 : _b.sendDate) ? { sendDate: segment.messages[0].sendDate } : {},
    tag,
    anchorText: segment.text.slice(0, 120)
  });
  if (!inserted.ok) throw new Error(insertFailureMessage(inserted.reason));
  const triggered = await triggerCardGenerate(floor, inserted.seq);
  if (!triggered.ok) throw new Error(cardFailureMessage(triggered));
  const waited = await waitForEntry(floor, ((_c = segment.messages[0]) == null ? void 0 : _c.swipeId) ?? 0, hash, inserted.seq);
  if (!waited.ok) console.warn("[ST-Story-Illustrator] 插画结果未取到：", waited.reason, waited.message);
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
  var _a, _b, _c;
  const segment = task.source;
  const floor = getAnchorFloor(segment);
  if (floor === null) throw new Error("无法确定挂载楼层。");
  const modeSettings = deps.fullSettings.modes["comic"];
  const swipeId = ((_a = segment.messages[0]) == null ? void 0 : _a.swipeId) ?? 0;
  const sendDate = (_b = segment.messages[0]) == null ? void 0 : _b.sendDate;
  const layout = modeSettings.comicLayout ?? "regular";
  const dialoguePolicy = modeSettings.comicDialoguePolicy ?? deps.fullSettings.dialoguePolicy ?? "auto";
  const bubbleStyle = modeSettings.comicBubbleStyle ?? deps.fullSettings.bubbleStyle;
  const bubbleFont = modeSettings.comicBubbleFont ?? deps.fullSettings.bubbleFont;
  const showComposite = modeSettings.comicShowComposite !== false;
  ctx.report({ stage: "reading" });
  const characters = await getCharacters(floor);
  const planOptions = {
    panelMode: true,
    panelLayout: layout,
    pageType: modeSettings.comicPageType ?? "auto",
    // 漫画页必须有对白：这是它区别于「一张插画」的一半信息量，不给模型就永远没有
    dialogue: true,
    dialoguePolicy,
    dialogueMode: "json",
    // nl 是唯一能分区描述「上格/下格」的通道，关掉就只能靠 tag 碰运气
    nl: true,
    backend: "nai",
    charPrompts: false,
    includeChinese: deps.fullSettings.includeChinese,
    maxPages: modeSettings.comicMaxPages ?? 1
  };
  let plan = await generateComicPlan({
    scene: sceneFromSegment(segment),
    characters: characters.characters,
    options: planOptions,
    caller: makeModeLlmCaller(deps.fullSettings, "comic")
  });
  if (!plan.ok || !plan.data) throw new Error(plan.error ?? "分镜计划生成失败。");
  if (!hasStoryContent(plan.data)) {
    console.warn("[ST-Story-Illustrator] 分镜 tag 缺少画面内容，重试一次。");
    plan = await generateComicPlan({
      scene: sceneFromSegment(segment),
      characters: characters.characters,
      options: {
        ...planOptions,
        extraInstruction: "上一次的分镜 tags 里只有构图词，没有任何人物、动作、场景——那样的图与剧情无关。这次每格的 tags 必须写出：角色外观（来自角色快照）、这个人正在做什么、在哪里、画面里的关键物件。"
      },
      caller: makeModeLlmCaller(deps.fullSettings, "comic")
    });
    if (!plan.ok || !plan.data) throw new Error(plan.error ?? "分镜计划生成失败。");
    if (!hasStoryContent(plan.data)) {
      throw new Error("分镜计划里每格都只有构图词、没有人物与动作（出图会与选段无关）。请换用更有能力的写 tag 模型。");
    }
  }
  const totalPanels = plan.data.reduce((sum, page) => sum + page.panels.length, 0);
  let done = 0;
  await ensureModeOutPlan("comic", deps);
  let previousTag = null;
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
      const prompt = mergeCharacterTags(
        enforced.prompt,
        panel.characters.map((c) => c.name),
        characters.characters
      );
      const tag = buildBbiTag({
        prompt,
        ...enforced.nl ? { nl: enforced.nl } : {},
        size: "portrait"
      });
      const hash = promptHash(tag);
      const inserted = await insertImageTag({
        floor,
        chatId: task.chatId,
        swipeId,
        ...sendDate ? { sendDate } : {},
        tag,
        anchorText: previousTag ?? segment.text.slice(0, 120)
      });
      if (!inserted.ok) throw new Error(insertFailureMessage(inserted.reason));
      previousTag = tag;
      const triggered = await triggerCardGenerate(floor, inserted.seq);
      if (!triggered.ok) throw new Error(cardFailureMessage(triggered));
      const waited = await waitForEntry(floor, swipeId, hash, inserted.seq);
      if (!waited.ok) {
        console.warn("[ST-Story-Illustrator] 分格结果未取到：", waited.reason, waited.message);
        done += 1;
        continue;
      }
      let imagePath = waited.entry.path;
      let bakedPath = "";
      if (showComposite && ((_c = panel.dialogue) == null ? void 0 : _c.length)) {
        const baked = await bakeDialogueIntoImage({
          imagePath,
          dialogue: panel.dialogue,
          style: bubbleStyle,
          font: bubbleFont
        });
        if (baked && await replaceEntryPath(floor, swipeId, hash, waited.entry.generationId, baked)) {
          bakedPath = baked;
          imagePath = baked;
        }
      }
      const artifact = {
        id: createArtifactId(),
        taskId: task.id,
        mode: "comic",
        chatId: task.chatId,
        sourceFloors: segment.floorIds,
        anchorFloor: floor,
        mountMode: "trailing",
        pageIndex: page.pageIndex,
        panelIndex: panel.index,
        imagePath,
        prompt,
        ...panel.nl ? { nl: panel.nl } : {},
        ...panel.dialogue ? { dialogue: panel.dialogue } : {},
        metadata: {
          // 图的显示交给柏宝绘卡片，本插件不再挂卡片
          embeddedInBody: true,
          pageTitle: page.title,
          panelTitle: panel.title,
          layout: page.layout,
          bbiTag: tag,
          bbiHash: hash,
          bbiSlotSeq: inserted.seq,
          bbiGenerationId: waited.entry.generationId,
          ...bakedPath ? { bubbleBakedPath: bakedPath } : {},
          ...typeof waited.entry.seed === "number" ? { seed: waited.entry.seed } : {}
        },
        createdAt: Date.now()
      };
      appendArtifact(floor, artifact);
      done += 1;
    }
  }
  await saveChatSafe();
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
  await ensureModeOutPlan(mode, deps);
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
    cleanupFunctions.push(injectConfigMenu());
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
    taskTimeoutMs: 12 * 60 * 1e3,
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
  const onModeSettingsChanged = () => {
    settings = getSettings(DEFAULT_SETTINGS);
    applySettings();
    queue = null;
    initQueue();
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
  destroyConfigPanel();
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
