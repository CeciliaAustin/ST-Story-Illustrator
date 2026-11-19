/**
 * ST-Story-Illustrator — 正文生图 tag（与柏宝绘原生卡片对接）
 *
 * 为什么不再自己写 markdown 图片：
 * - 柏宝绘的楼层卡片（重绘 / 改词 / 下载 / 删除 / 灯箱）只认正文里的 `<bbi_image>` tag，
 *   自己插 `![](url)` 既没有那些操作，刷新后也只剩一张裸图。
 * - 把 tag 写进 `message.mes` 后，柏宝绘的托管正则把 tag 换成锚点、卡片水合进锚点，
 *   于是「显示」完全由柏宝绘负责 —— 与它自己出的图一模一样，且随聊天持久化。
 * - 出图也交给卡片（点它的「生成图片」）：这样请求日志会进柏宝绘「请求历史」页，
 *   图库归档、并发闸门、429 退避全部复用，本插件不再有第二条出图链路。
 *
 * 本模块只做四件事（全部可失败、失败不抛）：
 * 1. 组装 / 插入 tag（CAS，排队期间消息变了就放弃）
 * 2. 找到该 tag 对应的锚点与卡片，点「生成图片」
 * 3. 轮询 `message.extra.bbiImage` 等结果落库
 * 4. 需要叠气泡时，改写该结果的 path 指向合成图
 */

import { getContext, getEventTypes, getCurrentChatId } from '../host/sillytavern';
import { findAnchorRange, lineEndAfter } from '../selection/anchor';

// ============================================================
// 常量
// ============================================================

/** 柏宝绘在 message.extra 里的命名空间（跨插件共享，勿改）。 */
export const BBI_IMAGE_EXTRA_KEY = 'bbiImage';
/** 显示侧锚点选择器（柏宝绘托管正则产出的空 div）。 */
export const BBI_SLOT_SELECTOR = 'div[data-bbi-slot]';
/** 卡片「生成图片」按钮。 */
const CARD_GENERATE_SELECTOR = '.bbi-figure__generate';
/** 卡片图片。 */
const CARD_IMAGE_SELECTOR = '.bbi-figure__img';
/** 卡片未配置后端时的引导文案容器。 */
const CARD_HINT_SELECTOR = '.bbi-figure__hint';

// ============================================================
// tag 组装
// ============================================================

export interface BbiTagCharacter {
  name: string;
  tag: string;
  nl?: string;
}

export interface BbiTagInput {
  prompt: string;
  nl?: string;
  negative?: string;
  size?: 'portrait' | 'landscape';
  /**
   * 每个可见角色自己的外貌/服装/表情/动作（柏宝绘的 `<characters>` 子标签）。
   *
   * 这是 NAI 4.5/V5 的**原生 Character Prompts** 通道：柏宝绘把它 JSON 化后放进
   * `<characters>…</characters>`，卡片再原样透传到 `v4_prompt.caption.char_captions`。
   * 有了它，Base 就不用（也不该）再写任何单个角色的外貌——
   * 这正是柏宝绘规范里「Base 只写全局，个人外貌写进各自的 character prompt」那条。
   */
  characters?: readonly BbiTagCharacter[];
}

/**
 * tag / nl / negative 里绝不允许出现子标签字面量：查找正则是非贪婪的，
 * 内容里混进一个 `</bbi_image>` 会让 tag 提前截断，后半截漏进 DOM 与提示词。
 * 这里直接把所有尖括号片段剥掉——danbooru tag 里出现 `<` 本身就不正常。
 */
export function sanitizeTagText(value: unknown): string {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * `<characters>` 子标签（柏宝绘 parseImageTagContent 用 JSON.parse 读它）。
 *
 * 序列化顺序与柏宝绘一致：name / tag / nl（nl 为空就整个键不写）。
 * 上限 32 项也是它的解析上限——多了会被它自己截断，这里先截保持一致。
 */
export function serializeCharacterPrompts(
  characters: readonly BbiTagCharacter[] | undefined,
): string {
  const clean = (characters ?? [])
    .map(c => {
      const name = sanitizeTagText(c.name);
      const tag = sanitizeTagText(c.tag);
      const nl = sanitizeTagText(c.nl);
      return { name, tag, ...(nl ? { nl } : {}) };
    })
    .filter(c => c.name && c.tag)
    .slice(0, 32);
  if (!clean.length) return '';
  return `<characters>${JSON.stringify(clean)}</characters>`;
}

/** 组装一条 `<bbi_image>` tag（插画形态，格式与柏宝绘 serializeImageTag 一致）。 */
export function buildBbiTag(input: BbiTagInput): string {
  const prompt = sanitizeTagText(input.prompt);
  const nl = sanitizeTagText(input.nl);
  const negative = sanitizeTagText(input.negative);
  const size = input.size === 'landscape' ? 'landscape' : 'portrait';
  const nlPart = nl ? `<nl>${nl}</nl>` : '';
  const negativePart = negative ? `<negative>${negative}</negative>` : '';
  const charactersPart = serializeCharacterPrompts(input.characters);
  return `<bbi_image>${prompt}${nlPart}${negativePart}${charactersPart}<size>${size}</size></bbi_image>`;
}

/** 最后一条生图 tag 的结束位置（没有 tag 时 0）。 */
export function lastImageTagEnd(mes: string): number {
  const text = String(mes ?? '');
  const re = /<bbi_image>[\s\S]+?<\/bbi_image>/gi;
  let end = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) end = match.index + match[0].length;
  return end;
}

/** 某个位置之后是否已经有生图 tag（决定新 tag 能不能插在这里）。 */
export function hasImageTagAfter(mes: string, index: number): boolean {
  const tail = String(mes ?? '').slice(Math.max(0, index));
  return /<bbi_image>[\s\S]+?<\/bbi_image>/i.test(tail);
}

/** 正文里已有的生图 tag 数量（= 下一条 tag 的槽位序号）。 */
export function countImageTags(mes: string): number {
  return (String(mes ?? '').match(/<bbi_image>[\s\S]+?<\/bbi_image>/gi) ?? []).length;
}

/**
 * 柏宝绘的 promptHash（cyrb53 派生，14 位 hex）。
 * **必须与柏宝绘逐字节一致**：卡片按 `promptHash(tag 原文)` 找自己的历史结果，
 * 算法差一位就永远查不到，表现为「图生成完了却显示未生成」。
 */
export function promptHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

// ============================================================
// 插入正文（CAS）
// ============================================================

export interface InsertTagInput {
  floor: number;
  chatId: string;
  swipeId: number;
  sendDate?: string;
  /** 已组装好的 tag 原文 */
  tag: string;
  /** 锚点文本：插在其后；找不到则追加到末尾 */
  anchorText?: string;
}

export type InsertTagResult =
  | { ok: true; seq: number; position: 'after-anchor' | 'appended' }
  | { ok: false; reason: 'no-context' | 'chat-changed' | 'floor-changed' | 'swipe-changed' | 'save-failed' };

type Ctx = ReturnType<typeof getContext> & Record<string, unknown>;

/** 插入 tag 到正文，并保存聊天。成功后触发该楼层重绘（柏宝绘据此水合卡片）。 */
export async function insertImageTag(input: InsertTagInput): Promise<InsertTagResult> {
  const { floor, chatId, swipeId, sendDate, tag, anchorText } = input;
  if (!tag) return { ok: false, reason: 'no-context' };

  const ctx = getContext() as Ctx;
  if (!Array.isArray(ctx.chat) || typeof ctx.saveChat !== 'function') {
    return { ok: false, reason: 'no-context' };
  }
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

  // 幂等：同一条 tag 已在正文里 → 直接复用它（不重复插）
  const existing = currentText.indexOf(tag);
  if (existing >= 0) {
    const seq = countImageTags(currentText.slice(0, existing));
    await refreshFloor(ctx, floor, msg);
    return { ok: true, seq, position: 'after-anchor' };
  }

  // tag 独占一行，前后留空行，避免与正文粘连（柏宝绘的剔除逻辑按「整行」还原）
  const snippet = `\n\n${tag}\n`;
  // 位置规则（这条关系到「插图与漫画能不能共存」）：
  //
  // 柏宝绘的卡片按 (swipeId, promptHash(tag 原文), **seq**) 找自己的图，
  // seq 就是 tag 在正文里的出现顺序。**把新 tag 插到旧 tag 前面，会让后面每一张的 seq
  // 整体后移**，它们的 slotSeq 却还停在旧值 → 旧卡被判成「提示词已改」而显示未生成。
  // 以前靠「插完把 slotSeq 整体 +1」补救，但那段补偿跑在 saveChat 之后、
  // 还要再写一次存档：中间任何一步失败（或柏宝绘那一刻正在写 extra），
  // 就留下一半挪了一半没挪的序号——用户看到的就是「前一张被后一张顶掉了」。
  //
  // 现在的规则简单到不需要补偿：**锚点必须落在最后一张图之后，否则追加到末尾**。
  // 序号永远只增不改，插图与漫画可以各插各的、互不影响。
  //
  // 定位用宽松匹配而不是 indexOf：划线拿到的是渲染后的文本，mes 里带 Markdown
  // 强调符与多余空行，逐字比一定对不上，以前就一路落到「追加到本楼末尾」
  // ——用户看到的正是「图跑到最下面去了」。
  const range = anchorText && anchorText.length >= 2
    ? findAnchorRange(currentText, anchorText)
    : null;
  const anchorAt = range ? lineEndAfter(currentText, range.end) : -1;
  const lastTagEnd = lastImageTagEnd(currentText);
  let nextText: string;
  let position: 'after-anchor' | 'appended';
  let insertAt: number;
  if (anchorAt >= 0 && anchorAt >= lastTagEnd) {
    // 插在选段所在**行之后**：插在字中间会把一句话劈成两段（还带 \n\n 断段）
    insertAt = anchorAt;
    const head = currentText.slice(0, insertAt).replace(/[ \t]+$/, '');
    nextText = head + snippet + currentText.slice(insertAt);
    position = 'after-anchor';
  } else {
    // 锚点在旧图之前（或找不到锚点）：只能追加。位置略靠后，但所有旧卡的序号不变。
    insertAt = currentText.length;
    nextText = `${currentText.trimEnd()}${snippet}`;
    position = 'appended';
  }
  const seq = countImageTags(currentText.slice(0, insertAt));

  msg.mes = nextText;
  const swipes = msg.swipes;
  if (Array.isArray(swipes) && swipeId >= 0 && swipeId < swipes.length) {
    swipes[swipeId] = nextText;
  }

  try {
    await (ctx.saveChat as () => Promise<void>)();
  } catch {
    msg.mes = currentText;
    if (Array.isArray(swipes) && swipeId >= 0 && swipeId < swipes.length) {
      swipes[swipeId] = currentText;
    }
    return { ok: false, reason: 'save-failed' };
  }

  await refreshFloor(ctx, floor, msg);
  return { ok: true, seq, position };
}

/**
 * 让 ST 重绘楼层，并**主动发 MESSAGE_UPDATED**。
 *
 * `updateMessageBlock` 只是把 `.mes_text` 的 innerHTML 换掉，它自己不发事件
 * （见 ST script.js 实现）；而柏宝绘的卡片水合挂在 MESSAGE_UPDATED 上。
 * 只重绘不发事件 → 锚点在 DOM 里、卡片永远不会挂上来，表现就是
 * 「tag 写进去了，楼层里却什么都没有」。
 */
async function refreshFloor(ctx: Ctx, floor: number, msg: unknown): Promise<void> {
  try {
    if (typeof ctx.updateMessageBlock === 'function') {
      await (ctx.updateMessageBlock as (id: number, m: unknown) => Promise<void>)(floor, msg);
    }
  } catch {
    // 重绘失败也要发事件：柏宝绘水合时会自己找锚点
  }
  try {
    const types = getEventTypes();
    ctx.eventSource?.emit(types.MESSAGE_UPDATED ?? 'message_updated', floor);
  } catch {
    // 没有 eventSource：下次任意渲染仍会水合
  }
}

// ============================================================
// 卡片触发
// ============================================================

/** 找第 seq 个锚点元素。 */
export function findSlotAnchor(floor: number, seq: number): HTMLElement | null {
  const mesText = document.querySelector<HTMLElement>(`.mes[mesid="${floor}"] .mes_text`);
  if (!mesText) return null;
  const anchors = [...mesText.querySelectorAll<HTMLElement>(BBI_SLOT_SELECTOR)];
  return anchors[seq] ?? null;
}

export type CardTriggerResult =
  | { ok: true; action: 'clicked' | 'already' }
  | { ok: false; reason: 'no-card' | 'blocked' | 'timeout'; message?: string };

/**
 * 等卡片水合完成，点它的「生成图片」。
 *
 * 为什么要绕 DOM：柏宝绘没有公开「按 tag 生成」的接口，只有卡片内部那条链路
 * （带请求日志、并发闸门、图库归档）。点按钮是最小侵入的复用方式。
 */
export async function triggerCardGenerate(
  floor: number,
  seq: number,
  timeoutMs = 10_000,
): Promise<CardTriggerResult> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const anchor = findSlotAnchor(floor, seq);
    const shadow = anchor?.shadowRoot ?? null;
    if (shadow) {
      if (shadow.querySelector(CARD_IMAGE_SELECTOR)) return { ok: true, action: 'already' };
      const button = shadow.querySelector<HTMLElement>(CARD_GENERATE_SELECTOR);
      if (button) {
        const label = (button.textContent ?? '').trim();
        // 同一个 class 有两种按钮：正常的「生成图片 / 重试」，以及「按当前方案重新生成本楼」
        // ——后者会跑柏宝绘自己的自动 tag、重写整楼正文，绝不能替用户点。
        if (label.includes('重新生成') || label.includes('本楼')) {
          return { ok: false, reason: 'blocked', message: label };
        }
        button.click();
        return { ok: true, action: 'clicked' };
      }
      const hint = shadow.querySelector<HTMLElement>(CARD_HINT_SELECTOR);
      const hintText = hint?.textContent?.trim() ?? '';
      if (hintText) return { ok: false, reason: 'blocked', message: hintText };
    }
    await sleep(150);
  }
  return { ok: false, reason: findSlotAnchor(floor, seq) ? 'timeout' : 'no-card' };
}

// ============================================================
// 结果读取（message.extra.bbiImage）
// ============================================================

export interface BbiImageEntry {
  generationId: string;
  path: string;
  prompt: string;
  seed: number | null;
  status: 'ready' | 'error';
  createdAt: number;
  slotSeq?: number;
}

type BbiStore = Record<string, Record<string, BbiImageEntry[]>>;

function readStore(floor: number): BbiStore | null {
  const ctx = getContext();
  const msg = ctx.chat?.[floor] as Record<string, unknown> | undefined;
  const extra = msg?.extra as Record<string, unknown> | undefined;
  const store = extra?.[BBI_IMAGE_EXTRA_KEY];
  return store && typeof store === 'object' ? (store as BbiStore) : null;
}

/** 该 (swipe, hash) 桶里属于本槽位的最新一条结果。 */
export function latestEntry(
  floor: number,
  swipeId: number,
  hash: string,
  seq: number,
): BbiImageEntry | null {
  const list = readStore(floor)?.[String(swipeId)]?.[hash];
  if (!Array.isArray(list) || list.length === 0) return null;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if ((list[i].slotSeq ?? 0) === seq) return list[i];
  }
  return null;
}

export type WaitEntryResult =
  | { ok: true; entry: BbiImageEntry }
  | { ok: false; reason: 'error' | 'timeout'; message?: string };

/**
 * 轮询等这一槽位出图落库。柏宝绘出图完成后写 `extra.bbiImage`，
 * 读它比读 DOM 可靠（卡片可能因懒渲染不在文档里）。
 */
export async function waitForEntry(
  floor: number,
  swipeId: number,
  hash: string,
  seq: number,
  timeoutMs = 90_000,
): Promise<WaitEntryResult> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entry = latestEntry(floor, swipeId, hash, seq);
    if (entry) {
      if (entry.status === 'ready' && entry.path) return { ok: true, entry };
      if (entry.status === 'error') {
        return { ok: false, reason: 'error', message: '柏宝绘出图失败（详情见柏宝绘「请求历史」）' };
      }
    }
    // 失败不会落库（卡片只记运行态），只能看卡片的 data-phase —— 否则要白等满超时
    const phase = findSlotAnchor(floor, seq)?.shadowRoot
      ?.querySelector('[data-phase]')?.getAttribute('data-phase');
    if (phase === 'error') {
      return { ok: false, reason: 'error', message: '柏宝绘出图失败（详情见柏宝绘「请求历史」）' };
    }
    await sleep(800);
  }
  return { ok: false, reason: 'timeout' };
}

/**
 * 把某条结果的图片路径换掉（叠完气泡后指向合成图），并保存聊天。
 * 原图仍在图库里，只是卡片显示合成版。
 */
export async function replaceEntryPath(
  floor: number,
  swipeId: number,
  hash: string,
  generationId: string,
  nextPath: string,
): Promise<boolean> {
  const ctx = getContext() as Ctx;
  const msg = ctx.chat?.[floor] as Record<string, unknown> | undefined;
  const extra = msg?.extra as Record<string, unknown> | undefined;
  const store = extra?.[BBI_IMAGE_EXTRA_KEY] as BbiStore | undefined;
  const list = store?.[String(swipeId)]?.[hash];
  if (!Array.isArray(list)) return false;
  const index = list.findIndex(e => e.generationId === generationId);
  if (index < 0) return false;
  if (list[index].path === nextPath) return true;
  list[index] = { ...list[index], path: nextPath };
  try {
    if (typeof ctx.saveChat === 'function') await (ctx.saveChat as () => Promise<void>)();
  } catch {
    return false;
  }
  await refreshFloor(ctx, floor, msg);
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * @deprecated 插入逻辑已改成「锚点必须在最后一张图之后，否则追加」，
 * **序号永远不会平移**，所以不再需要这段补偿。保留只为兼容旧调用方；
 * 新代码不要再用它——它会把本来正确的序号改错。
 *
 * 在正文中间插入新 tag 之后，把这一楼同 swipe 下序号 >= fromSeq 的旧结果整体后移一位。
 *
 * 为什么必须做：柏宝绘的卡片按 (promptHash, slotSeq) 找自己的图，slotSeq 就是 tag
 * 在正文里的顺序。我们把新 tag 插到选段处（可能在某张旧图前面），旧图的序号就整体
 * 变了；不跟着改，旧卡会被判成「提示词已改」而显示未生成。
 *
 * 只动 bbiImage 这一个槽位字段，不碰图片文件、不碰柏宝绘的其它状态；
 * 写失败就原样回滚（宁可序号旧，也不能留下半改的存档）。
 */
export async function shiftSlotSeqAfterInsert(
  floor: number,
  swipeId: number,
  fromSeq: number,
): Promise<number> {
  const ctx = getContext() as Ctx;
  const msg = ctx.chat?.[floor] as Record<string, unknown> | undefined;
  const extra = msg?.extra as Record<string, unknown> | undefined;
  const store = extra?.[BBI_IMAGE_EXTRA_KEY] as BbiStore | undefined;
  const buckets = store?.[String(swipeId)];
  if (!buckets) return 0;

  const next: BbiStore = JSON.parse(JSON.stringify(store)) as BbiStore;
  const nextBuckets = next[String(swipeId)] ?? {};
  let moved = 0;
  for (const list of Object.values(nextBuckets)) {
    if (!Array.isArray(list)) continue;
    for (let i = 0; i < list.length; i += 1) {
      const entry = list[i];
      const seq = typeof entry.slotSeq === 'number' ? entry.slotSeq : 0;
      if (seq < fromSeq) continue;
      list[i] = { ...entry, slotSeq: seq + 1 };
      moved += 1;
    }
  }
  if (!moved || !extra) return 0;

  extra[BBI_IMAGE_EXTRA_KEY] = next;
  try {
    if (typeof ctx.saveChat === 'function') await (ctx.saveChat as () => Promise<void>)();
  } catch {
    extra[BBI_IMAGE_EXTRA_KEY] = store;
    return 0;
  }
  await refreshFloor(ctx, floor, msg);
  return moved;
}
