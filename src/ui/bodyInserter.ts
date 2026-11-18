/**
 * 正文插图写入器
 *
 * 把生成的图片以 markdown 图片语法写进 message.mes 正文（锚定选段之后），
 * 使它成为正文的一部分：编辑正文不会丢、刷新/换设备仍在、导出聊天也带着。
 * 这正是「柏宝绘原生图片进入正文」的手感——图片是正文内容，不是浮在 DOM 上的卡片。
 *
 * 写入遵循 compare-and-swap：写前复核 chatId / send_date / swipe，
 * 排队期间消息变了就放弃写入（不覆盖别人的编辑）。
 */

import { getContext, getEventTypes, getCurrentChatId } from '../host/sillytavern';

export interface InsertImageIntoBodyInput {
  floor: number;
  chatId: string;
  swipeId: number;
  sendDate?: string;
  /** 图片地址（服务器路径或 dataUrl） */
  imagePath: string;
  /** 锚点文本：插在其后；找不到则追加到正文末尾 */
  anchorText?: string;
  /** 图片替代文本 */
  alt?: string;
}

export type InsertResult =
  | { ok: true; position: 'after-anchor' | 'appended' }
  | { ok: false; reason: 'no-context' | 'chat-changed' | 'floor-changed' | 'swipe-changed' | 'save-failed' | 'no-image' };

/** 构造写进正文的图片片段（markdown 图片，前后留空行）。 */
export function buildImageSnippet(imagePath: string, alt = '配图'): string {
  const safeAlt = alt.replace(/[\]\n\r]/g, ' ').trim() || '配图';
  return `\n\n![](${imagePath})`.replace('[]', `[${safeAlt}]`) + '\n';
}

/**
 * 把图片插入正文（CAS）。成功后触发消息重绘事件。
 */
export async function insertImageIntoBody(input: InsertImageIntoBodyInput): Promise<InsertResult> {
  const { floor, chatId, swipeId, sendDate, imagePath, anchorText } = input;
  if (!imagePath) return { ok: false, reason: 'no-image' };

  const ctx = getContext();
  if (!ctx || !Array.isArray(ctx.chat) || typeof ctx.saveChat !== 'function') {
    return { ok: false, reason: 'no-context' };
  }
  if (getCurrentChatId() !== chatId) return { ok: false, reason: 'chat-changed' };

  const msg = ctx.chat[floor];
  if (!msg || typeof msg.mes !== 'string') return { ok: false, reason: 'floor-changed' };

  // 身份复核：send_date / swipe 变了就放弃
  if (sendDate) {
    const actual = typeof msg.send_date === 'string' ? msg.send_date.trim() : '';
    if (actual && actual !== sendDate) return { ok: false, reason: 'floor-changed' };
  }
  const curSwipe = typeof msg.swipe_id === 'number' ? msg.swipe_id : 0;
  if (curSwipe !== swipeId) return { ok: false, reason: 'swipe-changed' };

  const snippet = buildImageSnippet(imagePath, input.alt);
  const currentText = msg.mes;

  let nextText: string;
  let position: 'after-anchor' | 'appended';
  if (anchorText && anchorText.length >= 2 && currentText.includes(anchorText)) {
    const at = currentText.indexOf(anchorText) + anchorText.length;
    nextText = currentText.slice(0, at) + snippet + currentText.slice(at);
    position = 'after-anchor';
  } else {
    nextText = `${currentText.trimEnd()}${snippet}`;
    position = 'appended';
  }

  // 幂等：正文里已经有这张图就不再插入
  if (currentText.includes(imagePath)) {
    return { ok: true, position };
  }

  // 写 mes 与 swipe
  msg.mes = nextText;
  if (Array.isArray(msg.swipes) && swipeId >= 0 && swipeId < msg.swipes.length) {
    msg.swipes[swipeId] = nextText;
  }

  try {
    await ctx.saveChat();
  } catch {
    // 回滚
    msg.mes = currentText;
    if (Array.isArray(msg.swipes) && swipeId >= 0 && swipeId < msg.swipes.length) {
      msg.swipes[swipeId] = currentText;
    }
    return { ok: false, reason: 'save-failed' };
  }

  // 触发重绘：优先 updateMessageBlock，回退到发事件
  await refreshMessage(ctx, floor, msg, position === 'appended' ? -1 : 0);
  return { ok: true, position };
}

async function refreshMessage(ctx: ReturnType<typeof getContext>, floor: number, msg: unknown, _unused: number): Promise<void> {
  try {
    const api = ctx as Record<string, unknown>;
    if (typeof api.updateMessageBlock === 'function') {
      await (api.updateMessageBlock as (id: number, m: unknown) => Promise<void>)(floor, msg);
      return;
    }
  } catch {
    // 回退到事件
  }
  try {
    const types = getEventTypes();
    const evt = types.MESSAGE_EDITED ?? 'message_edited';
    ctx.eventSource?.emit(evt, floor);
  } catch {
    // 最后手段：整段聊天重载
    try {
      const api = ctx as Record<string, unknown>;
      if (typeof api.reloadCurrentChat === 'function') await (api.reloadCurrentChat as () => Promise<void>)();
    } catch { /* ignore */ }
  }
}
