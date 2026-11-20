/**
 * ST-Story-Illustrator — 漫画页专用正文标签 `<bbi_manwa>`
 *
 * 为什么不能再用 `<bbi_image>`：
 * - 柏宝绘按 `<bbi_image>` 的**出现顺序**给卡片编槽位（slotSeq），并且它的卡片水合
 *   会重写 `.mes_text`。两条链路写同一种 tag，就会互相抢槽位、互相把对方刚挂上的
 *   卡片冲掉——用户看到的就是「漫画卡被 bbi_image 吞掉了」。
 * - 我们的漫画页本来也不是给它出的（不点它的卡片、不走它的 extra 存储）。
 *
 * 为什么不自己找文本位置插卡片：
 * - 「定位选段所在的那一段」只能靠文本猜测，Markdown 强调符、弯引号、跨节点都会让
 *   匹配失败，失败就一路降级成「挂到楼末」——这正是用户反复说的「图跑到最下面」。
 *
 * 做法与柏宝绘完全同构（它也这么藏 `<bbi_image>`）：
 * 1. 往 `message.mes` 里写 `<bbi_manwa><id>…</id></bbi_manwa>`；
 * 2. 注册两条**托管正则**到 ST 的全局正则列表：
 *    - 显示侧：整条 tag → `<div data-sti-manwa-slot></div>`（提示词绝不进 DOM）
 *    - 提示词侧：整条 tag → 空串（绝不外泄给模型）
 * 3. 卡片水合进锚点：位置由 tag 决定，刷新后正则重建锚点，卡片跟着回来。
 *
 * 于是「在划线处」「刷新不丢」「不被柏宝绘冲掉」「不和 bbi_image 抢槽位」四件事
 * 是同一个机制顺带解决的，而不是四段补丁。
 */

import { getContext, getCurrentChatId, getEventTypes } from '../host/sillytavern';
import { findAnchorRange, lineEndAfter } from '../selection/anchor';

// ============================================================
// 常量
// ============================================================

export const MANWA_TAG_NAME = 'bbi_manwa';
/** 显示侧锚点选择器（只用 data 属性：class 会被 DOMPurify 加 custom- 前缀）。 */
export const MANWA_SLOT_SELECTOR = 'div[data-sti-manwa-slot]';
/** 与托管正则同源的运行时正则（解析 message.mes 原文用）。 */
export const MANWA_TAG_REGEX = /<bbi_manwa>[\s\S]+?<\/bbi_manwa>/gi;
/** ST 正则列表里的固定 id（幂等更新的依据，勿改）。 */
export const MANWA_SLOT_REGEX_ID = 'sti-manwa-tag-slot';
export const MANWA_HIDE_REGEX_ID = 'sti-manwa-tag-hide';

// ============================================================
// tag 组装 / 解析
// ============================================================

/** `<id>` 内容只允许这些字符：它是 artifact id，混进尖括号会把 tag 提前截断。 */
function sanitizeId(id: string): string {
  return String(id ?? '').replace(/[^\w-]/g, '').slice(0, 64);
}

/**
 * 组装一条漫画 tag。
 *
 * 只带 artifact id：图片路径、提示词、台词、版面全在 `message.extra.sti_artifacts`
 * 里（那是**我们自己的**命名空间）。tag 里再抄一份等于两处真相，
 * 改一次词就要同步两遍，迟早对不上。
 */
export function buildManwaTag(artifactId: string): string {
  const id = sanitizeId(artifactId);
  if (!id) return '';
  return `<${MANWA_TAG_NAME}><id>${id}</id></${MANWA_TAG_NAME}>`;
}

export interface ManwaTagRef {
  /** artifact id */
  id: string;
  /** tag 原文（含壳），用于日志/调试 */
  raw: string;
}

/** 按出现顺序解析正文里的全部漫画 tag。 */
export function parseManwaTags(mes: string): ManwaTagRef[] {
  const text = String(mes ?? '');
  const out: ManwaTagRef[] = [];
  const re = new RegExp(MANWA_TAG_REGEX.source, 'gi');
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const raw = match[0];
    const id = sanitizeId(/<id>([\s\S]*?)<\/id>/i.exec(raw)?.[1] ?? '');
    if (id) out.push({ id, raw });
  }
  return out;
}

/** 正文里已有多少条漫画 tag。 */
export function countManwaTags(mes: string): number {
  return parseManwaTags(mes).length;
}

/** 最后一条漫画 tag 的结束位置（没有时 0）。 */
export function lastManwaTagEnd(mes: string): number {
  const text = String(mes ?? '');
  const re = new RegExp(MANWA_TAG_REGEX.source, 'gi');
  let end = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) end = match.index + match[0].length;
  return end;
}

// ============================================================
// 托管正则（写进 ST 的全局正则列表）
// ============================================================

// regex_placement：0=MD_DISPLAY(已弃用) / 1=USER_INPUT / 2=AI_OUTPUT / 3=SLASH_COMMAND。
// 旁白楼（extra.type='narrator'）的显示 placement 是 3，必须带上；
// 提示词侧带上它同样无害（ST 自己不用 (SLASH_COMMAND, isPrompt) 这个组合）。
const PLACEMENTS = [1, 2, 3];

export interface ManagedRegexScript extends Record<string, unknown> {
  id: string;
  scriptName: string;
  findRegex: string;
  replaceString: string;
  placement: number[];
  disabled: boolean;
  markdownOnly: boolean;
  promptOnly: boolean;
  runOnEdit: boolean;
}

const FIND_REGEX_LITERAL = '/<bbi_manwa>[\\s\\S]+?<\\/bbi_manwa>/gi';

/** 显示侧：漫画 tag → 空锚点（卡片水合进锚点，提示词永不进 DOM）。 */
export function manwaSlotScript(): ManagedRegexScript {
  return {
    id: MANWA_SLOT_REGEX_ID,
    scriptName: '故事配图 · 漫画占位',
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
    maxDepth: null,
  };
}

/** 提示词侧：漫画 tag → 空串（发给模型时彻底移除）。 */
export function manwaHideScript(): ManagedRegexScript {
  return {
    id: MANWA_HIDE_REGEX_ID,
    scriptName: '故事配图 · 隐藏漫画标签',
    findRegex: FIND_REGEX_LITERAL,
    replaceString: '',
    trimStrings: [],
    placement: [...PLACEMENTS],
    disabled: false,
    markdownOnly: false,
    promptOnly: true,
    runOnEdit: true,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null,
  };
}

const MANAGED_SCRIPTS: Array<() => ManagedRegexScript> = [manwaSlotScript, manwaHideScript];

/**
 * 把两条托管正则写进 ST 的全局正则列表。
 *
 * 固定 id 保证幂等：用户改过的同 id 规则会被更新，其它正则原样保留，不会重复添加。
 * 返回 false 表示上下文拿不到（ST 还没就绪），调用方稍后重试即可。
 */
export function ensureManwaRegexRegistered(): boolean {
  const ctx = getContext() as unknown as {
    extensionSettings?: { regex?: unknown };
    saveSettingsDebounced?: () => void;
  };
  const settings = ctx?.extensionSettings;
  if (!settings) return false;
  if (!Array.isArray(settings.regex)) settings.regex = [];

  const list = settings.regex as Array<Record<string, unknown>>;
  for (const make of MANAGED_SCRIPTS) {
    const script = make();
    const index = list.findIndex(item => item?.id === script.id);
    if (index >= 0) list[index] = { ...list[index], ...script };
    else list.push(script);
  }
  try {
    ctx.saveSettingsDebounced?.();
  } catch {
    /* 保存失败不影响本次会话（下次启动会再写一遍） */
  }
  return true;
}

/** 正则是否已经写好（不走 saveSettings，只读）。 */
export function isManwaRegexRegistered(): boolean {
  const ctx = getContext() as unknown as { extensionSettings?: { regex?: unknown } };
  const list = ctx?.extensionSettings?.regex;
  if (!Array.isArray(list)) return false;
  return MANAGED_SCRIPTS.every(make => list.some((item: Record<string, unknown>) => item?.id === make().id));
}

// ============================================================
// 插入正文
// ============================================================

export interface InsertManwaInput {
  floor: number;
  chatId: string;
  swipeId: number;
  sendDate?: string;
  tag: string;
  /** 选段原文：tag 插在它所在**行**之后 */
  anchorText?: string;
}

export type InsertManwaResult =
  | { ok: true; position: 'after-anchor' | 'appended' }
  | { ok: false; reason: 'no-context' | 'chat-changed' | 'floor-changed' | 'swipe-changed' | 'save-failed' };

type Ctx = ReturnType<typeof getContext> & Record<string, unknown>;

/**
 * 新的漫画 tag 应该插在正文的哪个位置。
 *
 * 规则：从锚点行之后到「下一个非空文本行」之间，若已经排着漫画 tag（同一批页锚到
 * 同一句台词），就排到那串 tag 的末尾，保持页序；否则直接插在锚点行之后，让这一页
 * 真正待在它自己的台词旁边。这样多页不同 beat 不会全堆到一处。
 */
export function insertionPointAfterLineTags(text: string, anchorAt: number): number {
  const base = lineEndAfter(text, anchorAt);
  const re = new RegExp(MANWA_TAG_REGEX.source, 'gi');
  let cursor = base;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const tagLineStart = text.lastIndexOf('\n', match.index) + 1;
    // 只认紧跟在锚点行之后的连续 tag 块（允许中间空行/空白）
    const between = text.slice(cursor, tagLineStart);
    if (between.trim()) break;
    if (match.index + match[0].length > cursor) cursor = match.index + match[0].length;
  }
  return cursor;
}

/**
 * 把漫画 tag 插到正文里（CAS：排队期间换了聊天/楼层/swipe 就放弃）。
 *
 * 位置规则与插图不同，这里可以更宽松：`<bbi_manwa>` 不参与柏宝绘的槽位编号，
 * 插在任何位置都不会让别人的 slotSeq 变化。所以只要找得到锚点就插在**锚点那一行之后**，
 * 找不到才追加到末尾。
 */
export async function insertManwaTag(input: InsertManwaInput): Promise<InsertManwaResult> {
  const { floor, chatId, swipeId, sendDate, tag, anchorText } = input;
  if (!tag) return { ok: false, reason: 'no-context' };

  const ctx = getContext() as Ctx;
  if (!Array.isArray(ctx.chat) || typeof ctx.saveChat !== 'function') return { ok: false, reason: 'no-context' };
  if (getCurrentChatId() !== chatId) return { ok: false, reason: 'chat-changed' };

  const msg = ctx.chat[floor] as Record<string, unknown> | undefined;
  if (!msg || typeof msg.mes !== 'string') return { ok: false, reason: 'floor-changed' };
  if (sendDate) {
    const actual = typeof msg.send_date === 'string' ? msg.send_date.trim() : '';
    if (actual && actual !== sendDate) return { ok: false, reason: 'floor-changed' };
  }
  const curSwipe = typeof msg.swipe_id === 'number' ? msg.swipe_id : 0;
  if (curSwipe !== swipeId) return { ok: false, reason: 'swipe-changed' };

  const currentText = msg.mes;

  // 幂等：同一条 tag 已在正文里 → 不重复插
  if (currentText.includes(tag)) {
    await refreshFloor(ctx, floor, msg);
    return { ok: true, position: 'after-anchor' };
  }

  // tag 独占一行：柏宝绘的剔除逻辑按「整行」还原，我们的正则也是整条替换
  const snippet = `\n\n${tag}\n`;
  const range = anchorText && anchorText.length >= 2 ? findAnchorRange(currentText, anchorText) : null;
  const anchorAt = range ? lineEndAfter(currentText, range.end) : -1;

  let nextText: string;
  let position: 'after-anchor' | 'appended';
  if (anchorAt >= 0) {
    // 任务书 §8：每页各自锚到本页台词处。多页只有锚到**同一行**时才需要保持页序
    // （后插的排在已有 tag 之后）；锚到不同行时各插各的，不要一律堆到最后一个 tag。
    const insertAt = insertionPointAfterLineTags(currentText, anchorAt);
    const head = currentText.slice(0, insertAt).replace(/[ \t]+$/, '');
    nextText = head + snippet + currentText.slice(insertAt);
    position = 'after-anchor';
  } else {
    nextText = `${currentText.trimEnd()}${snippet}`;
    position = 'appended';
  }

  msg.mes = nextText;
  const swipes = msg.swipes;
  if (Array.isArray(swipes) && swipeId >= 0 && swipeId < swipes.length) swipes[swipeId] = nextText;

  try {
    await (ctx.saveChat as () => Promise<void>)();
  } catch {
    msg.mes = currentText;
    if (Array.isArray(swipes) && swipeId >= 0 && swipeId < swipes.length) swipes[swipeId] = currentText;
    return { ok: false, reason: 'save-failed' };
  }

  await refreshFloor(ctx, floor, msg);
  return { ok: true, position };
}

/**
 * 从正文里删掉某一条 `<bbi_manwa>` tag（纯函数，便于测试）。
 *
 * 插的时候是「独占一行」写的（`\n\n<tag>\n`），删的时候要把那整行连同一个换行一起收掉，
 * 否则每删一页正文就多一行空行——用户看得见，而且会一直累积。
 */
export function stripManwaTag(mes: string, artifactId: string): string {
  const id = sanitizeId(artifactId);
  if (!id) return String(mes ?? '');
  const text = String(mes ?? '');
  const re = new RegExp(MANWA_TAG_REGEX.source, 'gi');
  let out = '';
  let last = 0;
  let removed = false;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const tagId = sanitizeId(/<id>([\s\S]*?)<\/id>/i.exec(match[0])?.[1] ?? '');
    if (tagId !== id) continue;
    let start = match.index;
    let end = start + match[0].length;
    // 独占一行时把整行（含行首那个换行）一起删掉，不留空行
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const lineEnd = text.indexOf('\n', end);
    const beforeOnLine = text.slice(lineStart, start).trim();
    const afterOnLine = (lineEnd >= 0 ? text.slice(end, lineEnd) : text.slice(end)).trim();
    if (!beforeOnLine && !afterOnLine) {
      // 连同行首换行 + 行尾换行一起删：插入时是 `\n\n<tag>\n`，
      // 只删「行首换行 + tag」会留下 3 个连续换行（正文里越来越空）。
      if (lineStart > 0) start = lineStart - 1;
      end = lineEnd >= 0 ? lineEnd + 1 : text.length;
    }
    out += text.slice(last, start);
    last = end;
    removed = true;
  }
  if (!removed) return text;
  return out + text.slice(last);
}

export interface RemoveManwaInput {
  floor: number;
  artifactId: string;
}

export type RemoveManwaResult =
  | { ok: true; removed: boolean }
  | { ok: false; reason: 'no-context' | 'floor-changed' | 'save-failed' };

/**
 * 把某条漫画 tag 从正文里摘掉（CAS：保存失败就回滚）。
 *
 * 删除一页时必须先摘锚点再删数据：否则刷新后托管正则会照着残留的 tag
 * 重新造一个空锚点，而数据已经没了——那格空白会一直挂在那里。
 */
export async function removeManwaTag(input: RemoveManwaInput): Promise<RemoveManwaResult> {
  const { floor, artifactId } = input;
  const ctx = getContext() as Ctx;
  if (!Array.isArray(ctx.chat) || typeof ctx.saveChat !== 'function') return { ok: false, reason: 'no-context' };
  const msg = ctx.chat[floor] as Record<string, unknown> | undefined;
  if (!msg || typeof msg.mes !== 'string') return { ok: false, reason: 'floor-changed' };

  const currentText = msg.mes;
  const nextText = stripManwaTag(currentText, artifactId);
  if (nextText === currentText) return { ok: true, removed: false };

  msg.mes = nextText;
  const swipeId = typeof msg.swipe_id === 'number' ? msg.swipe_id : 0;
  const swipes = msg.swipes;
  if (Array.isArray(swipes) && swipeId >= 0 && swipeId < swipes.length) swipes[swipeId] = nextText;

  try {
    await (ctx.saveChat as () => Promise<void>)();
  } catch {
    msg.mes = currentText;
    if (Array.isArray(swipes) && swipeId >= 0 && swipeId < swipes.length) swipes[swipeId] = currentText;
    return { ok: false, reason: 'save-failed' };
  }

  await refreshFloor(ctx, floor, msg);
  return { ok: true, removed: true };
}

/** 重绘楼层并主动发 MESSAGE_UPDATED（`updateMessageBlock` 自己不发事件）。 */
async function refreshFloor(ctx: Ctx, floor: number, msg: unknown): Promise<void> {
  try {
    if (typeof ctx.updateMessageBlock === 'function') {
      await (ctx.updateMessageBlock as (id: number, m: unknown) => Promise<void>)(floor, msg);
    }
  } catch {
    /* 重绘失败也要发事件：水合时会自己找锚点 */
  }
  try {
    const types = getEventTypes();
    ctx.eventSource?.emit(types.MESSAGE_UPDATED ?? 'message_updated', floor);
  } catch {
    /* 没有 eventSource：下次任意渲染仍会水合 */
  }
}

/** 某楼层的漫画锚点（按 DOM 顺序）。 */
export function manwaAnchors(floor: number): HTMLElement[] {
  const mesText = document.querySelector<HTMLElement>(`.mes[mesid="${floor}"] .mes_text`);
  if (!mesText) return [];
  return [...mesText.querySelectorAll<HTMLElement>(MANWA_SLOT_SELECTOR)];
}
