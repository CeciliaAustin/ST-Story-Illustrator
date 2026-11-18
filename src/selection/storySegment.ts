/**
 * 统一选段入口
 *
 * 实现 StorySegment 数据结构与构建器。
 * 支持：单楼、跨楼层范围、范围内排除楼层、手动编辑文本。
 * 以 SillyTavern chat 数组数据为准，不从 DOM 猜楼层。
 */

import type { StorySegment, StorySegmentMessage, StorySourceKind } from '../types';
import type { STChatMessage } from '../host/sillytavern';
import { getChat, getCurrentChatId, getSendDate, getSwipeId, stillCurrent } from '../host/sillytavern';
import { cleanMessageText, isSystemMessage, type CleanOptions } from './textCleaner';

// ============================================================
// 常量
// ============================================================

/** 最大跨楼层消息数 */
const MAX_MESSAGES_IN_SEGMENT = 50;

/** 单条消息最大文本长度 */
const MAX_MESSAGE_TEXT = 4000;

// ============================================================
// 选段选项
// ============================================================

/**
 * 选段构建选项。
 *
 * ST 的「隐藏楼层」本质是 `message.is_system === true`（/hide 命令写入）。默认我们会
 * 跳过它们（正常剧情选段不该包含隐藏内容），但用户可以勾「查看所有楼层」把它们放出来，
 * 用于确实需要引用隐藏楼层的场景。
 */
export interface SegmentBuildOptions {
  includeHidden?: boolean;
}

/** 楼层选项（供选段面板渲染）。 */
export interface FloorOption {
  floor: number;
  speaker: string;
  isUser: boolean;
  preview: string;
  /** 该楼层是被隐藏的（is_system） */
  hidden: boolean;
}

// ============================================================
// 清洗配置（由入口按设置注入）
// ============================================================

let cleanOptions: CleanOptions = { syncBaiBai: true, preferContent: true };

/** 设置选段清洗策略（与设置面板同步；preferContent 默认开启以兼容思维链插件）。 */
export function setSegmentCleanOptions(options: CleanOptions): void {
  cleanOptions = { ...cleanOptions, ...options };
}

/** 用当前配置清洗一条消息正文。 */
function cleanMes(mes: string | undefined): string {
  return cleanMessageText(mes, cleanOptions);
}

// ============================================================
// 消息提取
// ============================================================

/**
 * 从 ST chat 数组提取一条消息的选段信息。
 */
export function extractMessage(
  floor: number,
  chatId: string,
  options: SegmentBuildOptions = {},
): StorySegmentMessage | null {
  const chat = getChat();
  if (floor < 0 || floor >= chat.length) return null;

  const msg = chat[floor];
  if (!msg) return null;

  // 隐藏楼层（is_system）默认跳过；勾「查看所有楼层」后放开
  if (!options.includeHidden && isSystemMessage(msg)) return null;

  // 身份复核
  if (!stillCurrent(chatId, floor, getSwipeId(floor), getSendDate(floor) || undefined)) {
    return null;
  }

  const text = cleanMes(msg.mes).slice(0, MAX_MESSAGE_TEXT);
  if (!text) return null;

  return {
    floor,
    speaker: String(msg.name ?? (msg.is_user ? 'User' : 'Unknown')),
    isUser: msg.is_user === true,
    sendDate: typeof msg.send_date === 'string' ? msg.send_date.trim() : undefined,
    swipeId: typeof msg.swipe_id === 'number' ? msg.swipe_id : 0,
    text,
  };
}

// ============================================================
// StorySegment 构建
// ============================================================

/**
 * 构建单楼选段。
 */
export function buildSingleSegment(floor: number, options: SegmentBuildOptions = {}): StorySegment | null {
  const chatId = getCurrentChatId();
  if (!chatId) return null;

  const msg = extractMessage(floor, chatId, options);
  if (!msg) return null;

  return {
    chatId,
    sourceKind: 'single',
    floorIds: [floor],
    text: msg.text,
    messages: [msg],
    createdAt: Date.now(),
  };
}

/**
 * 构建跨楼层范围选段（按用户填写的楼层号区间）。
 *
 * @param startFloor 起始楼层（含）
 * @param endFloor 结束楼层（含）
 * @param excludeFloors 要排除的楼层列表
 * @param options includeHidden=true 时把隐藏楼层也纳入
 */
export function buildRangeSegment(
  startFloor: number,
  endFloor: number,
  excludeFloors: number[] = [],
  options: SegmentBuildOptions = {},
): StorySegment | null {
  const chatId = getCurrentChatId();
  if (!chatId) return null;

  const chat = getChat();
  const lo = Math.max(0, Math.min(startFloor, endFloor));
  const hi = Math.min(chat.length - 1, Math.max(startFloor, endFloor));
  const excludeSet = new Set(excludeFloors);

  const messages: StorySegmentMessage[] = [];
  const floorIds: number[] = [];

  for (let floor = lo; floor <= hi; floor++) {
    if (excludeSet.has(floor)) continue;
    if (messages.length >= MAX_MESSAGES_IN_SEGMENT) break;

    const msg = extractMessage(floor, chatId, options);
    if (!msg) continue;

    messages.push(msg);
    floorIds.push(floor);
  }

  if (messages.length === 0) return null;

  // 按原始顺序拼接，保留消息边界
  const text = messages.map(m => m.text).join('\n\n');

  return {
    chatId,
    sourceKind: 'range',
    floorIds,
    startFloor: lo,
    endFloor: hi,
    text,
    messages,
    createdAt: Date.now(),
  };
}

/**
 * 构建勾选楼层选段（picked）。
 *
 * @param floorIds 用户勾选的楼层列表（按顺序）
 */
export function buildPickedSegment(
  floorIds: number[],
  options: SegmentBuildOptions = {},
): StorySegment | null {
  const chatId = getCurrentChatId();
  if (!chatId || floorIds.length === 0) return null;

  const messages: StorySegmentMessage[] = [];
  const validFloorIds: number[] = [];

  for (const floor of floorIds) {
    if (messages.length >= MAX_MESSAGES_IN_SEGMENT) break;

    const msg = extractMessage(floor, chatId, options);
    if (!msg) continue;

    messages.push(msg);
    validFloorIds.push(floor);
  }

  if (messages.length === 0) return null;

  const text = messages.map(m => m.text).join('\n\n');

  return {
    chatId,
    sourceKind: 'picked',
    floorIds: validFloorIds,
    text,
    messages,
    createdAt: Date.now(),
  };
}

/**
 * 构建手动文本选段。
 *
 * 手动文本标记为 manual，不可伪造楼层归属。
 * 如果用户提供了楼层号，记录为来源楼层但不保证文本一致。
 */
export function buildManualSegment(text: string, floorIds: number[] = []): StorySegment | null {
  const chatId = getCurrentChatId();
  const cleanText = text.trim();
  if (!cleanText) return null;

  // 手动文本不提取 messages（因为文本是用户编辑过的）
  // 但可以记录来源楼层
  const messages: StorySegmentMessage[] = [];
  if (floorIds.length > 0 && chatId) {
    for (const floor of floorIds.slice(0, MAX_MESSAGES_IN_SEGMENT)) {
      const msg = extractMessage(floor, chatId);
      if (msg) messages.push(msg);
    }
  }

  return {
    chatId: chatId || 'manual',
    sourceKind: 'manual',
    floorIds,
    text: cleanText,
    messages,
    createdAt: Date.now(),
  };
}

// ============================================================
// 选段验证
// ============================================================

/**
 * 验证选段仍然有效。
 * 检查 chatId 未变、所有来源楼层仍然存在且身份一致。
 */
export function validateSegment(segment: StorySegment): boolean {
  if (segment.sourceKind === 'manual') {
    // 手动文本总是有效的
    return true;
  }

  const currentChatId = getCurrentChatId();
  if (currentChatId !== segment.chatId) return false;

  // 检查所有消息的身份
  for (const msg of segment.messages) {
    if (!stillCurrent(segment.chatId, msg.floor, msg.swipeId, msg.sendDate)) {
      return false;
    }
  }

  return true;
}

/**
 * 获取选段的锚定楼层（用于挂载结果）。
 *
 * 正文插画与正文漫画：挂载在选段结束楼层。
 * 小剧场：按来源楼层各自挂载。
 */
export function getAnchorFloor(segment: StorySegment): number | null {
  if (segment.sourceKind === 'manual') {
    return segment.floorIds.length > 0
      ? segment.floorIds[segment.floorIds.length - 1]
      : null;
  }

  if (segment.floorIds.length === 0) return null;
  return segment.floorIds[segment.floorIds.length - 1];
}

/**
 * 获取选段的前后文文本（用于 LLM 上下文）。
 *
 * @param segment 选段
 * @param range 前后楼层数（默认 1）
 */
export function getSurroundingContext(
  segment: StorySegment,
  range: number = 1,
): { previousText?: string; nextText?: string } {
  if (segment.sourceKind === 'manual' || segment.floorIds.length === 0) {
    return {};
  }

  const chatId = segment.chatId;
  if (getCurrentChatId() !== chatId) return {};

  const firstFloor = Math.min(...segment.floorIds);
  const lastFloor = Math.max(...segment.floorIds);

  // 前文
  const previousMessages: string[] = [];
  for (let f = firstFloor - 1; f >= Math.max(0, firstFloor - range); f--) {
    const msg = extractMessage(f, chatId);
    if (msg) {
      const chat = getChat();
      const raw = chat[f];
      if (raw && isSystemMessage(raw)) continue;
      previousMessages.unshift(msg.text);
    }
  }

  // 后文
  const nextMessages: string[] = [];
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
    previousText: previousMessages.length > 0 ? previousMessages.join('\n\n') : undefined,
    nextText: nextMessages.length > 0 ? nextMessages.join('\n\n') : undefined,
  };
}

// ============================================================
// 默认楼层
// ============================================================

/**
 * 获取默认选段楼层（最近一条 AI 回复）。
 */
export function defaultFloor(): number {
  const chat = getChat();
  for (let i = chat.length - 1; i >= 0; i--) {
    const msg = chat[i];
    if (!msg) continue;
    if (isSystemMessage(msg)) continue;
    if (msg.is_user === true) continue;
    const text = cleanMes(msg.mes);
    if (text.length > 0) return i;
  }
  // 如果没有 AI 消息，返回最后一条非系统消息
  for (let i = chat.length - 1; i >= 0; i--) {
    const msg = chat[i];
    if (!msg) continue;
    if (isSystemMessage(msg)) continue;
    const text = cleanMes(msg.mes);
    if (text.length > 0) return i;
  }
  return -1;
}

/**
 * 获取聊天中可选的楼层列表。
 *
 * 默认只列可见楼层；`includeHidden` 为 true 时把隐藏楼层（is_system）也列出来，
 * 并用 `hidden` 标记，供面板加「（隐藏）」提示。
 */
export function getAvailableFloors(options: SegmentBuildOptions = {}): FloorOption[] {
  const chat = getChat();
  const result: FloorOption[] = [];

  for (let i = 0; i < chat.length; i++) {
    const msg = chat[i];
    if (!msg) continue;
    const hidden = isSystemMessage(msg);
    if (hidden && !options.includeHidden) continue;
    const text = cleanMes(msg.mes);
    if (!text) continue;

    result.push({
      floor: i,
      speaker: String(msg.name ?? (msg.is_user ? 'User' : 'Unknown')),
      isUser: msg.is_user === true,
      preview: text.slice(0, 80),
      hidden,
    });
  }

  return result;
}

/** 当前聊天楼层总数（楼层号为 0..count-1）。 */
export function getChatFloorCount(): number {
  return getChat().length;
}
