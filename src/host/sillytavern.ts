/**
 * SillyTavern 环境封装
 *
 * 提供对 ST getContext()、eventSource、eventTypes、extension_settings
 * 的安全访问。所有 ST 环境依赖都通过此模块获取，便于测试和适配。
 */

// ============================================================
// ST 环境类型（简化版，只包含本项目用到的部分）
// ============================================================

export interface STChatMessage {
  mes?: string;
  name?: string;
  is_user?: boolean;
  is_system?: boolean;
  send_date?: string;
  swipe_id?: number;
  extra?: Record<string, unknown>;
  [key: string]: unknown;
}

interface STContext {
  chat: STChatMessage[];
  chatId?: string;
  characterId?: number;
  characters?: Array<{
    name?: string;
    avatar?: string;
    data?: Record<string, unknown>;
    [key: string]: unknown;
  }>;
  name1?: string;
  name2?: string;
  eventSource?: {
    on(event: string, callback: (...args: unknown[]) => void): void;
    off(event: string, callback: (...args: unknown[]) => void): void;
    emit(event: string, ...args: unknown[]): void;
  };
  eventTypes?: Record<string, string>;
  extensionSettings?: Record<string, unknown>;
  saveSettingsDebounced?: () => void;
  getCurrentChatId?: () => string;
  chatMetadata?: Record<string, unknown>;
  saveMetadataDebounced?: () => void;
  generateQuietPrompt?: (prompt: string, options?: Record<string, unknown>) => Promise<string>;
  [key: string]: unknown;
}

// ============================================================
// 模块状态
// ============================================================

/** ST 的 getContext 函数（延迟获取） */
let getContextFn: (() => STContext) | null = null;

/** 缓存的事件类型映射 */
let eventTypesCache: Record<string, string> | null = null;

// ============================================================
// 初始化
// ============================================================

/**
 * 初始化 ST 环境访问。
 * 从 ST 的 extensions.js 导入 getContext。
 * 使用动态 import 避免静态依赖导致的构建问题。
 */
export async function initSTEnvironment(): Promise<boolean> {
  // 优先用全局 getContext（ST 在页面注入）
  const globalCtx = (globalThis as Record<string, unknown>).getContext;
  if (typeof globalCtx === 'function') {
    getContextFn = globalCtx as () => STContext;
    return true;
  }

  try {
    // 用变量 + @vite-ignore 让打包器保留为运行时动态 import（路径由 ST 运行时解析）。
    // 路径相对于 third-party/ST-Story-Illustrator/index.js
    const modulePath = '../../../extensions.js';
    const extensionsModule = await import(/* @vite-ignore */ modulePath) as Record<string, unknown>;
    if (typeof extensionsModule.getContext === 'function') {
      getContextFn = extensionsModule.getContext as () => STContext;
      return true;
    }
  } catch {
    // import 失败可能是路径不对或非 ST 环境
    console.warn('[ST-Story-Illustrator] 无法加载 SillyTavern extensions.js，扩展将在降级模式下运行。');
  }
  return false;
}

// ============================================================
// 上下文访问
// ============================================================

/**
 * 获取 ST 上下文。
 * 如果 ST 未就绪，返回空壳对象（不抛异常）。
 */
export function getContext(): STContext {
  if (getContextFn) {
    try {
      return getContextFn();
    } catch {
      // 上下文获取失败，返回空壳
    }
  }
  return {
    chat: [],
    chatId: undefined,
    eventSource: undefined,
    eventTypes: {},
    extensionSettings: {},
  };
}

/**
 * 获取当前聊天 ID。
 */
export function getCurrentChatId(): string {
  const ctx = getContext();
  if (typeof ctx.getCurrentChatId === 'function') {
    try {
      return ctx.getCurrentChatId() ?? '';
    } catch {
      // ignore
    }
  }
  return ctx.chatId ?? '';
}

/**
 * 获取聊天数组。
 */
export function getChat(): STChatMessage[] {
  return getContext().chat ?? [];
}

/**
 * 获取指定楼层的消息。
 */
export function getMessage(floor: number): STChatMessage | undefined {
  const chat = getChat();
  if (floor < 0 || floor >= chat.length) return undefined;
  return chat[floor];
}

// ============================================================
// 事件系统
// ============================================================

/**
 * 获取事件类型常量。
 * 合并 ST 原生事件和已知默认值。
 */
export function getEventTypes(): Record<string, string> {
  if (eventTypesCache) return eventTypesCache;

  const ctx = getContext();
  const fromST = ctx.eventTypes ?? {};

  // 合并已知事件类型（即使 ST 版本不同也能工作）
  eventTypesCache = {
    // 从 ST 获取
    ...fromST,
    // 硬编码兜底（确保关键事件存在）
    MESSAGE_RECEIVED: fromST.MESSAGE_RECEIVED ?? 'message_received',
    MESSAGE_SENT: fromST.MESSAGE_SENT ?? 'message_sent',
    GENERATION_ENDED: fromST.GENERATION_ENDED ?? 'generation_ended',
    CHARACTER_MESSAGE_RENDERED: fromST.CHARACTER_MESSAGE_RENDERED ?? 'character_message_rendered',
    USER_MESSAGE_RENDERED: fromST.USER_MESSAGE_RENDERED ?? 'user_message_rendered',
    MESSAGE_SWIPED: fromST.MESSAGE_SWIPED ?? 'message_swiped',
    MESSAGE_UPDATED: fromST.MESSAGE_UPDATED ?? 'message_updated',
    MESSAGE_DELETED: fromST.MESSAGE_DELETED ?? 'message_deleted',
    MESSAGE_EDITED: fromST.MESSAGE_EDITED ?? 'message_edited',
    CHAT_CHANGED: fromST.CHAT_CHANGED ?? 'chat_id_changed',
    CHAT_DELETED: fromST.CHAT_DELETED ?? 'chat_deleted',
    APP_READY: fromST.APP_READY ?? 'app_ready',
    EXTENSION_SETTINGS_LOADED: fromST.EXTENSION_SETTINGS_LOADED ?? 'extension_settings_loaded',
  };

  return eventTypesCache;
}

/**
 * 注册事件监听器。
 * 返回取消监听的函数。
 */
export function on(eventName: string, callback: (...args: unknown[]) => void): () => void {
  const ctx = getContext();
  const source = ctx.eventSource;
  if (!source || typeof source.on !== 'function') {
    console.warn(`[ST-Story-Illustrator] eventSource 不可用，无法监听 ${eventName}`);
    return () => {};
  }
  source.on(eventName, callback);
  return () => {
    try {
      source.off?.(eventName, callback);
    } catch {
      // ignore
    }
  };
}

// ============================================================
// 设置持久化
// ============================================================

const SETTINGS_KEY = 'STStoryIllustrator';

/**
 * 读取扩展设置。
 */
export function getSettings<T>(defaults: T): T {
  const ctx = getContext();
  const settings = ctx.extensionSettings ?? {};
  const stored = settings[SETTINGS_KEY] as T | undefined;
  if (!stored || typeof stored !== 'object') {
    return { ...defaults };
  }
  return { ...defaults, ...stored };
}

/**
 * 写入扩展设置（触发防抖保存）。
 */
export function saveSettings(settings: unknown): void {
  const ctx = getContext();
  if (!ctx.extensionSettings) {
    ctx.extensionSettings = {};
  }
  (ctx.extensionSettings as Record<string, unknown>)[SETTINGS_KEY] = settings;
  if (typeof ctx.saveSettingsDebounced === 'function') {
    ctx.saveSettingsDebounced();
  }
}

/**
 * 读取聊天元数据中的自定义字段。
 */
export function getChatMetadata<T>(key: string, defaults: T): T {
  const ctx = getContext();
  const meta = ctx.chatMetadata ?? {};
  const stored = (meta as Record<string, unknown>)[key] as T | undefined;
  if (stored === undefined) return defaults;
  return stored;
}

/**
 * 写入聊天元数据（触发防抖保存）。
 */
export function saveChatMetadata(key: string, value: unknown): void {
  const ctx = getContext();
  if (!ctx.chatMetadata) {
    ctx.chatMetadata = {};
  }
  (ctx.chatMetadata as Record<string, unknown>)[key] = value;
  if (typeof ctx.saveMetadataDebounced === 'function') {
    ctx.saveMetadataDebounced();
  }
}

// ============================================================
// LLM 请求
// ============================================================

/**
 * 使用 ST 当前配置的 API 发送静默 LLM 请求。
 * 不显示在 UI 上，不写入聊天记录。
 */
export async function generateQuietPrompt(
  prompt: string,
  options?: Record<string, unknown>,
): Promise<string> {
  const ctx = getContext();
  if (typeof ctx.generateQuietPrompt !== 'function') {
    throw new Error('SillyTavern generateQuietPrompt 不可用');
  }
  return await ctx.generateQuietPrompt(prompt, options);
}

// ============================================================
// 用户消息检测
// ============================================================

/**
 * 判断消息是否是 AI 生成的剧情消息（非用户、非系统）。
 */
export function isAiStoryMessage(message: STChatMessage | undefined): boolean {
  if (!message || typeof message.mes !== 'string' || !message.mes.trim()) {
    return false;
  }
  return !message.is_user && !(message.is_system && typeof message.extra?.type === 'string');
}

/**
 * 获取最后一层 AI 消息的楼层号。
 */
export function lastAssistantFloor(): number {
  const chat = getChat();
  for (let i = chat.length - 1; i >= 0; i--) {
    if (isAiStoryMessage(chat[i])) {
      return i;
    }
  }
  return -1;
}

/**
 * 获取消息的 send_date（用于楼层身份复核）。
 */
export function getSendDate(floor: number): string {
  const msg = getMessage(floor);
  const d = msg?.send_date;
  return typeof d === 'string' ? d.trim() : '';
}

/**
 * 获取消息的 swipe_id。
 */
export function getSwipeId(floor: number): number {
  const msg = getMessage(floor);
  return typeof msg?.swipe_id === 'number' ? msg.swipe_id : 0;
}

/**
 * 楼层身份复核：排队期间聊天可能切换、消息可能删除。
 */
export function stillCurrent(chatId: string, floor: number, swipe: number, sendDate?: string): boolean {
  if (getCurrentChatId() !== chatId) return false;
  const msg = getMessage(floor);
  if (!msg) return false;
  if (sendDate) {
    const actual = typeof msg.send_date === 'string' ? msg.send_date.trim() : '';
    if (actual && actual !== sendDate) return false;
  }
  const currentSwipe = typeof msg.swipe_id === 'number' ? msg.swipe_id : 0;
  if (currentSwipe !== swipe) return false;
  return true;
}
