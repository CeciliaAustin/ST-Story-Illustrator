/**
 * ST-Story-Illustrator — 气泡类型定义
 * 移植自文档 §6.4。
 */

import type { BubbleStyleId, BubbleFontId, ComicDialogue } from '../types';

export type BubbleShell = 'bubble' | 'blend';
export type BubbleVariant = 'normal' | 'vertical' | 'glow' | 'ink' | 'subtitle';

export const ALL_BUBBLE_STYLES: readonly BubbleStyleId[] = [
  'classic', 'bubble-vertical', 'bubble-glow', 'bubble-ink', 'bubble-subtitle',
  'blend', 'blend-vertical', 'blend-glow', 'blend-ink', 'blend-subtitle',
];

export function normalizeBubbleStyle(v: unknown): BubbleStyleId {
  return ALL_BUBBLE_STYLES.includes(v as BubbleStyleId) ? (v as BubbleStyleId) : 'classic';
}

export function bubbleShellOf(s: BubbleStyleId): BubbleShell {
  return String(s).startsWith('blend') ? 'blend' : 'bubble';
}

export function isBlendStyle(s: BubbleStyleId): boolean {
  return bubbleShellOf(s) === 'blend';
}

export function bubbleVariantOf(s: BubbleStyleId): BubbleVariant {
  const n = normalizeBubbleStyle(s);
  if (n === 'classic' || n === 'blend') return 'normal';
  return n.slice(n.indexOf('-') + 1) as BubbleVariant;
}

export function normalizeBubbleFont(v: unknown): BubbleFontId {
  return v === 'serif' || v === 'kai' || v === 'round' ? v : 'sans';
}

export const BUBBLE_FONT_STACKS: Record<BubbleFontId, string> = {
  sans: 'sans-serif',
  serif: '"Noto Serif SC", "SimSun", "Songti SC", "MS Song", serif',
  kai: '"KaiTi", "STKaiti", "Kaiti SC", "DFKai-SB", serif',
  round: '"Yuanti SC", "HYQiHei", "Microsoft YaHei", "PingFang SC", sans-serif',
};

/** 气泡项：以 ComicDialogue 为基础（含可选 x/y 手动位置）。 */
export type PanelDialogueItem = ComicDialogue & { x?: number; y?: number; panel?: number };

/** 排版结果。 */
export interface BubbleRect {
  x: number;
  y: number;
  width: number;
  height: number;
  lines: string[];
  vertical?: boolean;
  tail?: 'down' | 'up';
  /** 尾巴根部的绝对 x。缺省时按「朝画面中轴」算；格内排版时朝本格中轴。 */
  tailX?: number;
  /**
   * 这颗气泡对应第几条台词（原始下标）。
   * 格内排版会按格重排绘制顺序，绘制层不能再按数组下标猜配对，否则会张冠李戴。
   */
  itemIndex?: number;
  /** 这颗气泡排版时实际用的字号（小格里会缩）。绘制层必须用同一个数，否则字会挤出气泡。 */
  fontSize?: number;
}

/** 主体避让区（归一化矩形 0~1）：放置气泡时按重叠面积罚分。 */
export interface AvoidZone {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 相对权重：脸比身体重要得多 */
  weight?: number;
}

export interface PlanOptions {
  style?: BubbleStyleId;
  font?: BubbleFontId;
  /**
   * 主体避让区。缺省用 bubblePlan 的 `FACE_AVOID_ZONES`（脸 + 上半身）；
   * `avoidFace: false` 可关掉，退回旧的九宫格行为。
   *
   * 进「格内排版」（`panels` 有值）时，这里应传**页面级的禁区**（特写格、
   * 顶部脸条这类），脸区改由每格自己的相对位置推算。
   */
  avoid?: readonly AvoidZone[];
  avoidFace?: boolean;
  /**
   * 这一页的格位（归一化，阅读顺序）。给了就进格内排版：
   * 每句台词落在**自己那一格**里，不出格、不骑 gutter，尾巴朝本格中轴。
   */
  panels?: readonly import('./panelSlots').PanelSlot[];
  /** 格内留白（页宽比例）。默认 0.012——约等于细 gutter 的一半。 */
  panelPadding?: number;
  /**
   * 每一格出场的人（名字数组，阅读顺序）。
   * 用来做「说话人只出现在某一格」的反查——比 area 可靠，比均分准确。
   */
  panelCast?: readonly (readonly string[])[];
}

export interface BubbleCompositeResult {
  url: string;
  filename: string;
  revoke: () => void;
}
