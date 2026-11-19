/**
 * ST-Story-Illustrator — 气泡排版纯函数
 *
 * 移植自文档 §6.4/6.5（锚点、换行、防重叠、字色、融入式排版）。
 * 全部为纯函数：measure 由调用方注入（canvas measureText 或测试桩），不依赖 DOM。
 *
 * 2026-11 修订：放置从「九宫格锚点 + 往下压」改成「候选位置打分」。
 * 旧做法第一句固定落在 tl(0.24w, 0.15h)、气泡最宽 0.42w——右缘正好伸到
 * 画面中轴，也就是人物脸上。卡片和漫画页基本都是「人物居中、脸在上三分之一」，
 * 于是每条台词都糊在脸上。现在把主体区（脸 + 上半身）标出来，按重叠面积罚分，
 * 并把气泡最大宽度收到 0.34w：宁可多折两行，也不许压在脸上。
 */

import type { PanelBubbleArea } from '../types';
import {
  normalizeBubbleStyle,
  bubbleVariantOf,
  isBlendStyle,
  type AvoidZone,
  type PanelDialogueItem,
  type BubbleRect,
  type PlanOptions,
} from './bubbleTypes';
import { slotIndexAt, type PanelSlot } from './panelSlots';

export type { AvoidZone } from './bubbleTypes';

export const PANEL_DIALOGUE_MAX = 4;

/** 九宫格锚点：去掉正中（人物通常在正中，盖脸最难看）。 */
const BUBBLE_ANCHORS: Record<PanelBubbleArea, { x: number; y: number }> = {
  tl: { x: 0.24, y: 0.15 }, tc: { x: 0.5, y: 0.13 }, tr: { x: 0.76, y: 0.15 },
  ml: { x: 0.17, y: 0.44 }, mr: { x: 0.83, y: 0.44 },
  bl: { x: 0.24, y: 0.79 }, bc: { x: 0.5, y: 0.84 }, br: { x: 0.76, y: 0.79 },
};

/** 候选位置：横向只取「左沿 / 中 / 右沿」，纵向四档。中轴不再作为默认落点。 */
const SLOT_X = [0.16, 0.5, 0.84] as const;
const SLOT_Y = [0.10, 0.30, 0.62, 0.84] as const;

/** 主体避让区（归一化矩形，0~1）。见 bubbleTypes.AvoidZone。 */

/**
 * 默认主体区。
 *
 * 脸：横向 0.33~0.67、纵向 0.14~0.54 —— 半身/胸像构图的典型位置；
 * 身体：0.28~0.72、0.42~0.80 —— 压在肩上比压脸好，但也尽量躲开。
 * 这两个框不需要精确：它只是给候选打分用的「常识」，不是人脸检测。
 */
export const FACE_AVOID_ZONES: readonly AvoidZone[] = [
  { x: 0.33, y: 0.14, width: 0.34, height: 0.40, weight: 4 },
  { x: 0.28, y: 0.42, width: 0.44, height: 0.38, weight: 1.2 },
];

/** 中文无空格断词，逐字符贪心换行就是对的。 */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (measure(clean) <= maxWidth) return [clean];
  const lines: string[] = [];
  let current = '';
  for (const char of clean) {
    const candidate = current + char;
    if (current && measure(candidate) > maxWidth) {
      lines.push(current);
      current = char === ' ' ? '' : char;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines;
}

/** 有框气泡的字号（文档 §4.3：max(15, min(44, min(w,h)*0.034))）。 */
export function bubbleFontSize(page: { width: number; height: number }): number {
  return Math.max(15, Math.min(44, Math.round(Math.min(page.width, page.height) * 0.034)));
}

export function blendFontSize(page: { width: number; height: number }): number {
  return Math.max(13, Math.min(36, Math.round(Math.min(page.width, page.height) * 0.028)));
}

export function blendSpacing(fontSize: number): number {
  return fontSize * 0.26;
}

/** 融入式横排：宽度 = 字宽和 + 字距×(字数−1)。 */
export function layoutBlendH(
  text: string,
  maxWidth: number,
  fontSize: number,
  measure: (ch: string) => number,
) {
  const spacing = blendSpacing(fontSize);
  const widthOf = (s: string) => [...s].reduce((sum, ch) => sum + measure(ch), 0) + spacing * Math.max(0, [...s].length - 1);
  const lines = wrapText(text, maxWidth, widthOf);
  return {
    lines,
    width: Math.ceil(Math.max(0, ...lines.map(widthOf))),
    height: Math.ceil(lines.length * fontSize * 1.35),
  };
}

/** 融入式竖排：逐字成列，一列满换到左一列（从右往左读）。 */
export function layoutBlendV(text: string, maxHeight: number, fontSize: number) {
  const spacing = blendSpacing(fontSize);
  const step = fontSize * 1.15;
  const perCol = Math.max(4, Math.floor(maxHeight / step));
  const chars = [...text];
  const cols: string[] = [];
  for (let i = 0; i < chars.length; i += perCol) cols.push(chars.slice(i, i + perCol).join(''));
  return {
    cols,
    width: Math.ceil(cols.length * fontSize + (cols.length - 1) * spacing),
    height: Math.ceil(Math.min(perCol, cols[0]?.length ?? 0) * step),
  };
}

/** 从落点平均色推字色：浅底压深、深底翻浅；中间调或低对比必带描边。 */
export function deriveTextColor(avg: { r: number; g: number; b: number }): { color: string; halo: string | null } {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const lum = (c: { r: number; g: number; b: number }) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const L = lum(avg);
  const text = L > 0.42
    ? { r: Math.round(avg.r * 0.3), g: Math.round(avg.g * 0.28), b: Math.round(avg.b * 0.28) }
    : { r: Math.round(avg.r + (255 - avg.r) * 0.82), g: Math.round(avg.g + (255 - avg.g) * 0.82), b: Math.round(avg.b + (255 - avg.b) * 0.82) };
  const contrast = (Math.max(lum(text), L) + 0.05) / (Math.min(lum(text), L) + 0.05);
  const halo = (L > 0.35 && L < 0.55) || contrast < 2.2
    ? (L > 0.42 ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.5)')
    : null;
  return { color: `rgb(${text.r},${text.g},${text.b})`, halo };
}

/** 融入式五档配色：只有 blend/blend-vertical 用采样色，其余固定色。 */
export function blendInkFor(style: string, avg: { r: number; g: number; b: number }) {
  if (style === 'blend-glow') return { color: '#fffaf2', halo: 'rgba(0,0,0,0.38)', glow: 'rgba(255,246,228,0.85)', band: null as string | null };
  if (style === 'blend-ink') return { color: '#2a2320', halo: 'rgba(255,255,255,0.92)', glow: null, band: null as string | null };
  if (style === 'blend-subtitle') return { color: '#f7f4ef', halo: 'rgba(0,0,0,0.45)', glow: null, band: 'rgba(18,16,15,0.55)' as string | null };
  const { color, halo } = deriveTextColor(avg);
  return { color, halo, glow: null, band: null as string | null };
}

export function boxInkFor(style: string) {
  const variant = bubbleVariantOf(style as Parameters<typeof bubbleVariantOf>[0]);
  if (variant === 'glow') return { color: '#fffaf2', glow: 'rgba(255,244,214,0.9)' as string | null };
  if (variant === 'ink') return { color: '#2a2320', glow: null as string | null };
  return { color: '#111111', glow: null as string | null };
}

// ============================================================
// 放置：候选打分（避脸 / 防重叠 / 贴边）
// ============================================================

interface Point { x: number; y: number }

function overlapArea(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** 以中心点定位并夹到画面内。 */
function atCenter(rect: BubbleRect, cx: number, cy: number, page: { width: number; height: number }, margin: number): Point {
  return {
    x: Math.min(Math.max(margin, cx - rect.width / 2), Math.max(margin, page.width - rect.width - margin)),
    y: Math.min(Math.max(margin, cy - rect.height / 2), Math.max(margin, page.height - rect.height - margin)),
  };
}

/** 候选：12 个网格落点 + 模型指定锚点（若有，给偏好分而不是硬约束）。 */
function candidatesFor(
  rect: BubbleRect,
  item: PanelDialogueItem,
  page: { width: number; height: number },
  margin: number,
): Point[] {
  const out: Point[] = [];
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
/** 面积归一化后的罚分权重。气泡互相压 > 压脸 > 压身体 > 跨中轴。 */
const W_PLACED = 240;
const W_FACE = 130;
const W_CROSS = 14;
const W_EDGE = 26;

function scoreAt(
  rect: BubbleRect,
  point: Point,
  item: PanelDialogueItem,
  page: { width: number; height: number },
  placed: BubbleRect[],
  zones: readonly AvoidZone[],
): number {
  const probe = { ...rect, x: point.x, y: point.y };
  const area = Math.max(THUMB, rect.width * rect.height);
  let score = 0;

  for (const zone of zones) {
    const box = {
      x: zone.x * page.width,
      y: zone.y * page.height,
      width: zone.width * page.width,
      height: zone.height * page.height,
    };
    const ratio = overlapArea(probe, box) / area;
    if (ratio <= 0) continue;
    score += ratio * W_FACE * (zone.weight ?? 1);
  }

  for (const other of placed) {
    const ratio = overlapArea(probe, other) / area;
    if (ratio > 0) score += ratio * W_PLACED;
  }

  // 跨中轴：一条完整气泡被人物劈成两半，读起来最难受
  const mid = page.width * 0.5;
  if (probe.x < mid && probe.x + probe.width > mid) score += W_CROSS;

  // 贴边优先：离最近的画面边越近，越像正经排版而不是「浮在人物身上」
  const edge = Math.min(
    probe.x,
    probe.y,
    page.width - probe.x - probe.width,
    page.height - probe.y - probe.height,
  );
  score += (Math.max(0, edge) / Math.max(1, page.width)) * W_EDGE;

  // 模型给了锚点：小幅偏好，压脸时仍会被更高分的位置盖过去
  if (item.area && BUBBLE_ANCHORS[item.area]) {
    const a = BUBBLE_ANCHORS[item.area];
    const ax = a.x * page.width;
    const ay = a.y * page.height;
    const dist = Math.hypot(probe.x + probe.width / 2 - ax, probe.y + probe.height / 2 - ay);
    score += (dist / Math.max(1, page.width)) * 6;
  }
  return score;
}

/** 在候选里挑最低分的落点。 */
function bestPoint(
  rect: BubbleRect,
  item: PanelDialogueItem,
  page: { width: number; height: number },
  margin: number,
  placed: BubbleRect[],
  zones: readonly AvoidZone[],
): { point: Point; score: number } {
  let best: { point: Point; score: number } | null = null;
  for (const point of candidatesFor(rect, item, page, margin)) {
    const score = scoreAt(rect, point, item, page, placed, zones);
    if (!best || score < best.score) best = { point, score };
  }
  return best ?? { point: { x: margin, y: margin }, score: 0 };
}

/** 该矩形最坏情况下压掉主体的比例（0~1），用于判断要不要缩字号。 */
export function faceCoverRatio(
  rect: BubbleRect,
  page: { width: number; height: number },
  zones: readonly AvoidZone[] = FACE_AVOID_ZONES,
): number {
  const face = zones[0];
  if (!face) return 0;
  const box = {
    x: face.x * page.width,
    y: face.y * page.height,
    width: face.width * page.width,
    height: face.height * page.height,
  };
  const area = Math.max(1, rect.width * rect.height);
  return overlapArea(rect, box) / area;
}

/**
 * 放置一条气泡。
 *
 * 手动 x/y 原地钉死（用户/模型明确指定了位置，尊重它）；
 * 否则走候选打分：避开主体 > 不互相压 > 不跨中轴 > 贴边。
 */
function placeRect(
  rect: BubbleRect,
  item: PanelDialogueItem,
  index: number,
  page: { width: number; height: number },
  margin: number,
  zones: readonly AvoidZone[],
  placed: BubbleRect[],
  withTail: boolean,
): void {
  if (typeof item.x === 'number' && typeof item.y === 'number') {
    rect.x = Math.min(Math.max(margin, item.x * page.width - rect.width / 2), page.width - rect.width - margin);
    rect.y = Math.min(Math.max(margin, item.y * page.height - rect.height / 2), page.height - rect.height - margin);
    if (withTail) rect.tail = item.y < 0.5 ? 'down' : 'up';
    placed.push(rect);
    return;
  }

  const { point } = bestPoint(rect, item, page, margin, placed, zones);
  rect.x = point.x;
  rect.y = point.y;

  if (withTail) {
    // 气泡在上半 → 尾巴朝下指向人物；靠下 → 朝上
    rect.tail = rect.y + rect.height / 2 < page.height / 2 ? 'down' : 'up';
  }
  placed.push(rect);
  void index;
}

// ============================================================
// 格内排版：气泡不许离开自己那一格
// ============================================================

interface Inner { x: number; y: number; width: number; height: number }

function pageBox(zone: AvoidZone, page: { width: number; height: number }) {
  return {
    x: zone.x * page.width,
    y: zone.y * page.height,
    width: zone.width * page.width,
    height: zone.height * page.height,
  };
}

/** 格内可用区域（扣掉内边距）。 */
function innerOf(slot: PanelSlot, page: { width: number; height: number }, pad: number): Inner {
  return {
    x: slot.x * page.width + pad,
    y: slot.y * page.height + pad,
    width: Math.max(24, slot.width * page.width - pad * 2),
    height: Math.max(24, slot.height * page.height - pad * 2),
  };
}

/**
 * 一格里的脸区：横向中间 44%、纵向靠上 40%。
 *
 * 之所以按格算而不是按整页算：一格里的人基本是「头在上半」，两格页的两个人
 * 脸分别在自己那格的上方；用整页的那个框去避让，只会把两张脸都算错。
 */
function faceZoneInSlot(slot: PanelSlot, page: { width: number; height: number }): Inner {
  return {
    x: (slot.x + slot.width * 0.30) * page.width,
    y: (slot.y + slot.height * 0.14) * page.height,
    width: slot.width * 0.40 * page.width,
    height: slot.height * 0.32 * page.height,
  };
}

/** 出界面积占比。格内排版不允许出格，这是硬约束（打分只是兜底）。 */
function outsideRatio(rect: BubbleRect, inner: Inner): number {
  const area = Math.max(1, rect.width * rect.height);
  const inside = overlapArea(rect, inner);
  return Math.max(0, area - inside) / area;
}

/** 候选点：格内网格 + 已放气泡的上/下方（自然形成竖排串）。 */
function candidatesInSlot(rect: BubbleRect, inner: Inner, placed: BubbleRect[]): Point[] {
  const freeW = Math.max(0, inner.width - rect.width);
  const freeH = Math.max(0, inner.height - rect.height);
  const out: Point[] = [];
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

function scoreInSlot(
  rect: BubbleRect,
  point: Point,
  inner: Inner,
  slot: PanelSlot,
  item: PanelDialogueItem,
  page: { width: number; height: number },
  placed: BubbleRect[],
  noGo: readonly AvoidZone[],
): number {
  const probe: BubbleRect = { ...rect, x: point.x, y: point.y };
  const area = Math.max(1, rect.width * rect.height);
  let score = 0;

  // 压别的气泡最难看，权最高
  for (const other of placed) {
    score += (overlapArea(probe, other) / area) * 400;
    // 阅读顺序：已经放过一颗之后，新的不许跑到它**上方**——
    // 否则读者先看到后面那句（真实表现就是「位置错乱」）。
    if (probe.y + probe.height <= other.y + 1) score += 34;
  }
  // 压本格的脸
  score += (overlapArea(probe, faceZoneInSlot(slot, page)) / area) * 95;
  // 压特写格/顶部脸条（页面级禁区）
  for (const zone of noGo) {
    score += (overlapArea(probe, pageBox(zone, page)) / area) * 120 * (zone.weight ?? 1);
  }
  // 漫画从上往下读：越靠本格顶部越自然（允许一点余量，不是硬贴边）
  score += ((probe.y - inner.y) / Math.max(1, inner.height)) * 7;
  // 出格兜底
  score += outsideRatio(probe, inner) * 300;

  // 模型给的 area：只当横向偏好（它不知道格线，纵向交给「靠上」这条）
  if (item.area) {
    const left = item.area.endsWith('l');
    const right = item.area.endsWith('r');
    const centerX = probe.x + probe.width / 2;
    const slotMid = (slot.x + slot.width / 2) * page.width;
    if (left && centerX > slotMid) score += 5;
    if (right && centerX < slotMid) score += 5;
  }
  return score;
}

/** 先把台词分到格：显式 panel > area 反查 > 均分（没有任何线索时）。 */
/** 名字比对用：去空白/标点、忽略大小写（与别处的 normalizeName 同口径）。 */
function nameKey(v: string): string {
  return String(v ?? '').replace(/[\s（）()「」『』【】·.,，。:：!！?？~～\-—_]/g, '').toLowerCase();
}

/**
 * 说话人 → 格号。
 *
 * 只在「这个人只出现在一格里」时才认：两人同框的多格页里，说话人本身
 * 不足以区分是哪一格，硬猜会把对白放到别人脸上。
 */
function slotBySpeaker(
  item: PanelDialogueItem,
  casts: readonly (readonly string[])[] | undefined,
): number {
  const speaker = nameKey(item.speaker ?? '');
  if (!speaker || !casts?.length) return -1;
  const hits: number[] = [];
  casts.forEach((names, i) => {
    if ((names ?? []).some(name => {
      const key = nameKey(name);
      return key.length > 0 && (key === speaker || key.includes(speaker) || speaker.includes(key));
    })) hits.push(i);
  });
  return hits.length === 1 ? hits[0] : -1;
}

export function assignDialogueToSlots(
  items: readonly PanelDialogueItem[],
  slots: readonly PanelSlot[],
  casts?: readonly (readonly string[])[],
): number[] {
  const n = slots.length;
  if (!n) return items.map(() => 0);
  // 模型看到 panels[].index 是 0 起，常把 panel 也写成 0 起。
  // 出现过 0 就按 0 起解释整份，避免整体错一格（最典型的「台词跑到上一格」）。
  const zeroBased = items.some(item => Number(item.panel) === 0);
  const explicit = (item: PanelDialogueItem): number => {
    const raw = Number(item.panel);
    if (!Number.isFinite(raw)) return -1;
    const p = Math.round(zeroBased ? raw + 1 : raw);
    return p >= 1 && p <= n ? p - 1 : -1;
  };
  const hasHint = items.some(item => explicit(item) >= 0 || !!item.area || slotBySpeaker(item, casts) >= 0);
  if (!hasHint) {
    // 一条线索都没有：按阅读顺序均分，别把四句全塞进第一格
    return items.map((_, i) => Math.min(n - 1, Math.floor((i * n) / Math.max(1, items.length))));
  }
  let prev = 0;
  return items.map(item => {
    const p = explicit(item);
    if (p >= 0) {
      prev = p;
      return p;
    }
    const bySpeaker = slotBySpeaker(item, casts);
    if (bySpeaker >= 0) {
      prev = bySpeaker;
      return bySpeaker;
    }
    if (item.area && BUBBLE_ANCHORS[item.area]) {
      const a = BUBBLE_ANCHORS[item.area];
      prev = slotIndexAt(slots, a.x, a.y);
      return prev;
    }
    return prev; // 没写的跟着上一句，免得同一段对话被拆到两格
  });
}

function setTailInSlot(rect: BubbleRect, slot: PanelSlot, page: { width: number; height: number }): void {
  const midY = (slot.y + slot.height / 2) * page.height;
  const midX = (slot.x + slot.width / 2) * page.width;
  rect.tail = rect.y + rect.height / 2 < midY ? 'down' : 'up';
  // 尾巴朝本格中轴：气泡偏左就把尾巴放右下，偏右就放左下
  rect.tailX = rect.x + rect.width / 2 < midX ? rect.x + rect.width * 0.74 : rect.x + rect.width * 0.26;
}

// ============================================================
// 入口
// ============================================================

/** 分发器：有框 → planBubbleBox，融入式 → planBlend。 */
export function planBubbles(
  items: PanelDialogueItem[],
  page: { width: number; height: number },
  measure: (s: string) => number,
  opts: PlanOptions = {},
): BubbleRect[] {
  if (!page.width || !page.height) return [];
  const style = normalizeBubbleStyle(opts.style);
  const slots = opts.panels && opts.panels.length ? opts.panels : [];
  // 格内排版时，页面级 zones 只留给“特写格 / 顶部脸条”这类禁区；
  // 脸区改由每格自己算，不能再套整页那个框。
  const zones = opts.avoidFace === false
    ? []
    : (opts.avoid ?? (slots.length ? [] : FACE_AVOID_ZONES));
  if (isBlendStyle(style)) {
    return planBlend(items, page, measure, style, zones, slots, opts.panelPadding, opts.panelCast);
  }
  return planBubbleBox(items, page, measure, style, zones, slots, opts.panelPadding, opts.panelCast);
}

/** 有框气泡的正文最大宽度：0.34 页宽。再宽就会伸到中轴的人脸上。 */
const MAX_BUBBLE_RATIO = 0.34;

interface BoxMetrics {
  lines: string[];
  width: number;
  height: number;
  vertical: boolean;
}

function measureBox(
  item: PanelDialogueItem,
  page: { width: number; height: number },
  measure: (s: string) => number,
  fontSize: number,
  variant: string,
  maxWidth?: number,
  maxHeight?: number,
): BoxMetrics | null {
  const padX = fontSize * 0.7;
  const padY = fontSize * 0.55;
  if (variant === 'vertical') {
    const step = fontSize * 1.15;
    const perCol = Math.max(3, Math.floor((maxHeight ?? page.height * 0.5) / step));
    const chars = [...item.text];
    const cols: string[] = [];
    for (let i = 0; i < chars.length; i += perCol) cols.push(chars.slice(i, i + perCol).join(''));
    return {
      lines: cols,
      width: Math.ceil(cols.length * fontSize + (cols.length - 1) * fontSize * 0.26 + padX * 2),
      height: Math.ceil(Math.min(perCol, cols[0]?.length ?? 0) * step + padY * 2),
      vertical: true,
    };
  }
  const wrapWidth = Math.max(fontSize * 2, (maxWidth ?? page.width * MAX_BUBBLE_RATIO) - padX * 2);
  const lines = wrapText(item.text, wrapWidth, measure);
  if (!lines.length) return null;
  return {
    lines,
    width: Math.ceil(Math.max(...lines.map(measure)) + padX * 2),
    height: Math.ceil(lines.length * fontSize * 1.4 + padY * 2),
    vertical: false,
  };
}

/** 格内画字的最大宽度（占格内可用宽度的比例）：留出气泡自身的边距。 */
const PANEL_TEXT_RATIO = 0.88;

/**
 * 格内排版。
 *
 * 三条硬约束（真漫画的排版语法，不是审美偏好）：
 * 1. 气泡**完整落在自己那一格里**——不出格、不骑 gutter。放不下就缩字号，不是溢出；
 * 2. 每句跟着自己那一格排，同一格里的几句从上往下叠；
 * 3. 尾巴朝本格中轴，不朝整页中轴（朝整页会指向别的格）。
 */
function planBubbleBoxPanel(
  items: PanelDialogueItem[],
  page: { width: number; height: number },
  measure: (s: string) => number,
  variant: string,
  slots: readonly PanelSlot[],
  noGo: readonly AvoidZone[],
  paddingRatio?: number,
  casts?: readonly (readonly string[])[],
): BubbleRect[] {
  const baseFont = bubbleFontSize(page);
  const pad = Math.max(3, Math.round(page.width * (paddingRatio ?? 0.012)));
  const capped = items.slice(0, PANEL_DIALOGUE_MAX).filter(item => item.text.trim());
  const groups = assignDialogueToSlots(capped, slots, casts);
  const out: Array<BubbleRect | null> = capped.map(() => null);
  const placedAll: BubbleRect[] = [];

  slots.forEach((slot, si) => {
    const inner = innerOf(slot, page, pad);
    const placedHere: BubbleRect[] = [];
    // 小格里字号必须跟着格走，否则两行的气泡就顶满整格
    const fontCap = Math.max(12, Math.round(Math.min(inner.width, inner.height) * 0.13));
    const startFont = Math.min(baseFont, fontCap);

    capped.forEach((item, idx) => {
      if (groups[idx] !== si) return;

      let best: { rect: BubbleRect; score: number } | null = null;
      for (const scale of [1, 0.88, 0.76, 0.64]) {
        const fontSize = Math.max(11, Math.round(startFont * scale));
        const metrics = measureBox(
          item, page, measure, fontSize, variant,
          inner.width * PANEL_TEXT_RATIO,
          inner.height * 0.8,
        );
        if (!metrics) continue;
        if (metrics.width > inner.width || metrics.height > inner.height * 0.85) continue;
        const rect: BubbleRect = {
          x: 0, y: 0, width: metrics.width, height: metrics.height, lines: metrics.lines,
          ...(metrics.vertical ? { vertical: true } : {}),
        };
        let point: Point = { x: inner.x, y: inner.y };
        let score = Infinity;
        for (const candidate of candidatesInSlot(rect, inner, placedHere)) {
          const s = scoreInSlot(rect, candidate, inner, slot, item, page, placedHere, noGo);
          if (s < score) {
            score = s;
            point = candidate;
          }
        }
        // 缩字号本身有代价：能大字就大字，差不太多才缩
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

  return out.filter((r): r is BubbleRect => !!r);
}

function planBubbleBox(
  items: PanelDialogueItem[],
  page: { width: number; height: number },
  measure: (s: string) => number,
  style: string,
  zones: readonly AvoidZone[],
  slots: readonly PanelSlot[] = [],
  panelPadding?: number,
  panelCasts?: readonly (readonly string[])[],
): BubbleRect[] {
  const variant = bubbleVariantOf(style as Parameters<typeof bubbleVariantOf>[0]);
  const baseFont = bubbleFontSize(page);
  const margin = Math.round(page.width * 0.02);
  const placed: BubbleRect[] = [];
  const capped = items.slice(0, PANEL_DIALOGUE_MAX).filter(item => item.text.trim());

  // 漫画页（多格）：除字幕条外一律进格内排版
  if (slots.length && variant !== 'subtitle') {
    const casts = panelCasts;
    const pinned = capped.filter(item => typeof item.x === 'number' && typeof item.y === 'number');
    const flowed = capped.filter(item => !(typeof item.x === 'number' && typeof item.y === 'number'));
    const byPanel = planBubbleBoxPanel(flowed, page, measure, variant, slots, zones, panelPadding, casts);
    // 手动钉的位置照旧原地不动（用户说放哪就放哪），只是画在最上层
    const manual: BubbleRect[] = [];
    for (const item of pinned) {
      const metrics = measureBox(item, page, measure, baseFont, variant);
      if (!metrics) continue;
      const rect: BubbleRect = { x: 0, y: 0, width: metrics.width, height: metrics.height, lines: metrics.lines, ...(metrics.vertical ? { vertical: true } : {}) };
      rect.x = Math.min(Math.max(margin, (item.x as number) * page.width - rect.width / 2), page.width - rect.width - margin);
      rect.y = Math.min(Math.max(margin, (item.y as number) * page.height - rect.height / 2), page.height - rect.height - margin);
      rect.tail = (item.y as number) < 0.5 ? 'down' : 'up';
      rect.itemIndex = capped.indexOf(item);
      manual.push(rect);
    }
    // 恢复原始顺序：融入式按 index 取 item，顺序错了会张冠李戴
    const merged: Array<BubbleRect | null> = capped.map(() => null);
    let i = 0;
    let j = 0;
    capped.forEach((item, idx) => {
      const isPinned = typeof item.x === 'number' && typeof item.y === 'number';
      merged[idx] = isPinned ? (manual[j++] ?? null) : (byPanel[i++] ?? null);
    });
    return merged.filter((r): r is BubbleRect => !!r);
  }

  capped.forEach(item => {
    // 手动坐标：原地钉死，不参与打分（用户/模型明确指定了位置）
    if (typeof item.x === 'number' && typeof item.y === 'number') {
      const metrics = measureBox(item, page, measure, baseFont, variant === 'subtitle' ? 'normal' : variant);
      if (!metrics) return;
      const rect: BubbleRect = {
        x: 0, y: 0, width: metrics.width, height: metrics.height, lines: metrics.lines,
        ...(metrics.vertical ? { vertical: true } : {}),
      };
      rect.x = Math.min(Math.max(margin, item.x * page.width - rect.width / 2), page.width - rect.width - margin);
      rect.y = Math.min(Math.max(margin, item.y * page.height - rect.height / 2), page.height - rect.height - margin);
      rect.tail = item.y < 0.5 ? 'down' : 'up';
      placed.push(rect);
      return;
    }

    if (variant === 'subtitle') {
      // 字幕条本来就落在底部，天然避开脸；只做防重叠
      const fontSize = baseFont;
      const metrics = measureBox(item, page, measure, fontSize, 'normal');
      if (!metrics) return;
      const rect: BubbleRect = { x: 0, y: 0, width: metrics.width, height: metrics.height, lines: metrics.lines };
      rect.x = Math.min(Math.max(margin, page.width * 0.5 - rect.width / 2), page.width - rect.width - margin);
      rect.y = page.height - rect.height - Math.max(margin, Math.round(page.height * 0.04));
      for (let guard = 0; guard < 8; guard += 1) {
        const hit = placed.find(o => overlapArea(rect, o) > 0);
        if (!hit) break;
        rect.y = Math.max(margin, hit.y - rect.height - fontSize * 0.3);
      }
      placed.push(rect);
      return;
    }

    // 先按基础字号排；若最好位置仍明显压脸，缩一档字号重排（多折一行，也要让开）
    let chosen: { rect: BubbleRect; score: number } | null = null;
    for (const scale of [1, 0.86, 0.74]) {
      const fontSize = Math.max(12, Math.round(baseFont * scale));
      const metrics = measureBox(item, page, measure, fontSize, variant);
      if (!metrics) continue;
      const rect: BubbleRect = { x: 0, y: 0, width: metrics.width, height: metrics.height, lines: metrics.lines, ...(metrics.vertical ? { vertical: true } : {}) };
      const { point, score } = bestPoint(rect, item, page, margin, placed, zones);
      rect.x = point.x;
      rect.y = point.y;
      rect.fontSize = fontSize;
      const cover = faceCoverRatio(rect, page, zones);
      if (!chosen || cover < 0.02 || score < chosen.score) {
        chosen = { rect, score };
        // 完全不压脸且没有别的气泡冲突 → 不用再缩
        if (cover <= 0.001 && score < W_PLACED) break;
      }
    }
    if (!chosen) return;
    chosen.rect.tail = chosen.rect.y + chosen.rect.height / 2 < page.height / 2 ? 'down' : 'up';
    placed.push(chosen.rect);
  });

  return placed;
}

function planBlend(
  items: PanelDialogueItem[],
  page: { width: number; height: number },
  measure: (s: string) => number,
  style: string,
  zones: readonly AvoidZone[],
  slots: readonly PanelSlot[] = [],
  panelPadding?: number,
  casts?: readonly (readonly string[])[],
): BubbleRect[] {
  const baseFont = blendFontSize(page);
  const margin = Math.round(page.width * 0.02);
  const forceVertical = style === 'blend-vertical';
  const subtitle = style === 'blend-subtitle';
  const capped = items.slice(0, PANEL_DIALOGUE_MAX).filter(item => item.text.trim());

  // 漫画页：融入式文字同样按格排——字压在两格之间的 gutter 上比压脸更明显
  if (slots.length && !subtitle) {
    const pad = Math.max(3, Math.round(page.width * (panelPadding ?? 0.012)));
    const groups = assignDialogueToSlots(capped, slots, casts);
    const out: Array<BubbleRect | null> = capped.map(() => null);
    const placedAll: BubbleRect[] = [];
    slots.forEach((slot, si) => {
      const inner = innerOf(slot, page, pad);
      const placedHere: BubbleRect[] = [];
      const fontSize = Math.max(11, Math.min(baseFont, Math.round(Math.min(inner.width, inner.height) * 0.09)));
      capped.forEach((item, idx) => {
        if (groups[idx] !== si) return;
        if (typeof item.x === 'number' && typeof item.y === 'number') return; // 钉死的走下面整页路径
        const vertical = forceVertical || item.dir === 'v';
        let rect: BubbleRect;
        if (vertical) {
          const { cols, width, height } = layoutBlendV(item.text, inner.height * 0.85, fontSize);
          rect = { x: 0, y: 0, width, height, lines: cols, vertical: true };
        } else {
          const { lines, width, height } = layoutBlendH(item.text, inner.width * 0.9, fontSize, measure);
          if (!lines.length) return;
          rect = { x: 0, y: 0, width, height, lines };
        }
        if (rect.width > inner.width || rect.height > inner.height * 0.9) return;
        let point: Point = { x: inner.x, y: inner.y };
        let score = Infinity;
        for (const candidate of candidatesInSlot(rect, inner, placedHere)) {
          const s = scoreInSlot(rect, candidate, inner, slot, item, page, placedAll, zones);
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
    // 手动钉的位置退回整页路径单独处理
    const pinned = capped.filter(item => typeof item.x === 'number' && typeof item.y === 'number');
    if (pinned.length) {
      const manual: BubbleRect[] = [];
      for (const item of pinned) {
        const vertical = forceVertical || item.dir === 'v';
        let rect: BubbleRect;
        if (vertical) {
          const { cols, width, height } = layoutBlendV(item.text, page.height * 0.42, baseFont);
          rect = { x: 0, y: 0, width, height, lines: cols, vertical: true };
        } else {
          const { lines, width, height } = layoutBlendH(item.text, page.width * 0.42, baseFont, measure);
          if (!lines.length) continue;
          rect = { x: 0, y: 0, width, height, lines };
        }
        rect.x = Math.min(Math.max(margin, (item.x as number) * page.width - rect.width / 2), page.width - rect.width - margin);
        rect.y = Math.min(Math.max(margin, (item.y as number) * page.height - rect.height / 2), page.height - rect.height - margin);
        manual.push(rect);
      }
      let j = 0;
      capped.forEach((item, idx) => {
        if (typeof item.x === 'number' && typeof item.y === 'number') out[idx] = manual[j++] ?? null;
      });
    }
    return out.filter((r): r is BubbleRect => !!r);
  }

  const maxW = page.width * (subtitle ? 0.86 : 0.42);
  const maxH = page.height * 0.42;
  const placed: BubbleRect[] = [];

  items.slice(0, PANEL_DIALOGUE_MAX).forEach((item, index) => {
    if (!item.text.trim()) return;
    const vertical = forceVertical || (!subtitle && item.dir === 'v');
    let rect: BubbleRect;
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
        const hit = placed.find(o => overlapArea(rect, o) > 0);
        if (!hit) break;
        rect.y = Math.max(margin, hit.y - rect.height - baseFont * 0.25);
      }
      placed.push(rect);
      return;
    }
    placeRect(rect, item, index, page, margin, zones, placed, false);
  });
  return placed;
}
