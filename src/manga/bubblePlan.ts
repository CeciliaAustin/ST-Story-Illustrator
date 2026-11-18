/**
 * ST-Story-Illustrator — 气泡排版纯函数
 *
 * 移植自文档 §6.4/6.5（锚点、换行、防重叠、字色、融入式排版）。
 * 全部为纯函数：measure 由调用方注入（canvas measureText 或测试桩），不依赖 DOM。
 */

import type { PanelBubbleArea } from '../types';
import {
  normalizeBubbleStyle,
  bubbleVariantOf,
  isBlendStyle,
  type PanelDialogueItem,
  type BubbleRect,
  type PlanOptions,
} from './bubbleTypes';

export const PANEL_DIALOGUE_MAX = 4;

/** 九宫格锚点：去掉正中（人物通常在正中，盖脸最难看）。 */
const BUBBLE_ANCHORS: Record<PanelBubbleArea, { x: number; y: number }> = {
  tl: { x: 0.24, y: 0.15 }, tc: { x: 0.5, y: 0.13 }, tr: { x: 0.76, y: 0.15 },
  ml: { x: 0.17, y: 0.44 }, mr: { x: 0.83, y: 0.44 },
  bl: { x: 0.24, y: 0.79 }, bc: { x: 0.5, y: 0.84 }, br: { x: 0.76, y: 0.79 },
};

const FALLBACK_ORDER: PanelBubbleArea[] = ['tl', 'tr', 'bl', 'br', 'tc', 'bc', 'ml', 'mr'];

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

/** 锚点/手动位置/防重叠共用放置：手动 x/y 原地钉死；缺省走锚点+下压。 */
function placeRect(
  rect: BubbleRect,
  item: PanelDialogueItem,
  index: number,
  page: { width: number; height: number },
  margin: number,
  fontSize: number,
  placed: BubbleRect[],
  usedAreas: Set<PanelBubbleArea>,
  withTail: boolean,
): void {
  let area = item.area;
  if (!area) area = FALLBACK_ORDER.find(c => !usedAreas.has(c)) ?? FALLBACK_ORDER[index % FALLBACK_ORDER.length];
  if (area) usedAreas.add(area);
  const anchor = BUBBLE_ANCHORS[area ?? 'tl'];

  if (typeof item.x === 'number' && typeof item.y === 'number') {
    rect.x = Math.min(Math.max(margin, item.x * page.width - rect.width / 2), page.width - rect.width - margin);
    rect.y = Math.min(Math.max(margin, item.y * page.height - rect.height / 2), page.height - rect.height - margin);
    if (withTail) rect.tail = item.y < 0.5 ? 'down' : 'up';
    placed.push(rect);
    return;
  }

  rect.x = Math.min(Math.max(margin, anchor.x * page.width - rect.width / 2), page.width - rect.width - margin);
  rect.y = Math.min(Math.max(margin, anchor.y * page.height - rect.height / 2), page.height - rect.height - margin);
  for (let guard = 0; guard < 8; guard += 1) {
    const hit = placed.find(o => rect.x < o.x + o.width && rect.x + rect.width > o.x && rect.y < o.y + o.height && rect.y + rect.height > o.y);
    if (!hit) break;
    const down = hit.y + hit.height + fontSize * 0.3;
    if (down + rect.height <= page.height - margin) rect.y = down;
    else rect.y = Math.max(margin, hit.y - rect.height - fontSize * 0.3);
  }
  if (withTail) rect.tail = rect.y + rect.height / 2 < page.height / 2 ? 'down' : 'up';
  placed.push(rect);
}

/** 分发器：有框 → planBubbleBox，融入式 → planBlend。 */
export function planBubbles(
  items: PanelDialogueItem[],
  page: { width: number; height: number },
  measure: (s: string) => number,
  opts: PlanOptions = {},
): BubbleRect[] {
  if (!page.width || !page.height) return [];
  const style = normalizeBubbleStyle(opts.style);
  if (isBlendStyle(style)) return planBlend(items, page, measure, style);
  return planBubbleBox(items, page, measure, style);
}

function planBubbleBox(
  items: PanelDialogueItem[],
  page: { width: number; height: number },
  measure: (s: string) => number,
  style: string,
): BubbleRect[] {
  const variant = bubbleVariantOf(style as Parameters<typeof bubbleVariantOf>[0]);
  const fontSize = Math.max(15, Math.min(44, Math.round(Math.min(page.width, page.height) * 0.034)));
  const lineHeight = fontSize * 1.4;
  const padX = fontSize * 0.7;
  const padY = fontSize * 0.55;
  const maxBubbleWidth = page.width * 0.42;
  const margin = Math.round(page.width * 0.02);
  const placed: BubbleRect[] = [];
  const usedAreas = new Set<PanelBubbleArea>();

  items.slice(0, PANEL_DIALOGUE_MAX).forEach((item, index) => {
    if (!item.text.trim()) return;
    if (variant === 'vertical') {
      const step = fontSize * 1.15;
      const perCol = Math.max(3, Math.floor((page.height * 0.5) / step));
      const cols: string[] = [];
      const chars = [...item.text];
      for (let i = 0; i < chars.length; i += perCol) cols.push(chars.slice(i, i + perCol).join(''));
      const width = Math.ceil(cols.length * fontSize + (cols.length - 1) * fontSize * 0.26 + padX * 2);
      const height = Math.ceil(Math.min(perCol, cols[0]?.length ?? 0) * step + padY * 2);
      placeRect({ x: 0, y: 0, width, height, lines: cols, vertical: true }, item, index, page, margin, fontSize, placed, usedAreas, true);
      return;
    }
    const lines = wrapText(item.text, maxBubbleWidth - padX * 2, measure);
    if (!lines.length) return;
    const width = Math.ceil(Math.max(...lines.map(measure)) + padX * 2);
    const height = Math.ceil(lines.length * lineHeight + padY * 2);
    if (variant === 'subtitle') {
      const area = (['bc', 'bl', 'br'] as const)[index % 3];
      const anchor = BUBBLE_ANCHORS[area];
      const rect: BubbleRect = { x: 0, y: 0, width, height, lines };
      rect.x = Math.min(Math.max(margin, anchor.x * page.width - rect.width / 2), page.width - rect.width - margin);
      rect.y = page.height - rect.height - Math.max(margin, Math.round(page.height * 0.04));
      placed.push(rect);
      return;
    }
    placeRect({ x: 0, y: 0, width, height, lines }, item, index, page, margin, fontSize, placed, usedAreas, true);
  });
  return placed;
}

function planBlend(
  items: PanelDialogueItem[],
  page: { width: number; height: number },
  measure: (s: string) => number,
  style: string,
): BubbleRect[] {
  const fontSize = blendFontSize(page);
  const margin = Math.round(page.width * 0.02);
  const maxW = page.width * (style === 'blend-subtitle' ? 0.86 : 0.52);
  const maxH = page.height * 0.42;
  const forceVertical = style === 'blend-vertical';
  const subtitle = style === 'blend-subtitle';
  const subtitleAreas: PanelBubbleArea[] = ['bc', 'bl', 'br'];
  const placed: BubbleRect[] = [];
  const usedAreas = new Set<PanelBubbleArea>();

  items.slice(0, PANEL_DIALOGUE_MAX).forEach((item, index) => {
    if (!item.text.trim()) return;
    const vertical = forceVertical || (!subtitle && item.dir === 'v');
    let rect: BubbleRect;
    if (vertical) {
      const { cols, width, height } = layoutBlendV(item.text, maxH, fontSize);
      rect = { x: 0, y: 0, width, height, lines: cols, vertical: true };
    } else {
      const { lines, width, height } = layoutBlendH(item.text, maxW, fontSize, measure);
      if (!lines.length) return;
      rect = { x: 0, y: 0, width, height, lines };
    }
    if (subtitle) {
      const area = subtitleAreas[index % subtitleAreas.length];
      const anchor = BUBBLE_ANCHORS[area];
      rect.x = Math.min(Math.max(margin, anchor.x * page.width - rect.width / 2), page.width - rect.width - margin);
      rect.y = page.height - rect.height - Math.max(margin, Math.round(page.height * 0.04));
      for (let guard = 0; guard < 8; guard += 1) {
        const hit = placed.find(o => rect.x < o.x + o.width && rect.x + rect.width > o.x && rect.y < o.y + o.height && rect.y + rect.height > o.y);
        if (!hit) break;
        rect.y = Math.max(margin, hit.y - rect.height - fontSize * 0.25);
      }
      placed.push(rect);
      return;
    }
    placeRect(rect, item, index, page, margin, fontSize, placed, usedAreas, false);
  });
  return placed;
}
