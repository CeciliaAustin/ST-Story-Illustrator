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
export type PanelDialogueItem = ComicDialogue & { x?: number; y?: number };

/** 排版结果。 */
export interface BubbleRect {
  x: number;
  y: number;
  width: number;
  height: number;
  lines: string[];
  vertical?: boolean;
  tail?: 'down' | 'up';
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
   */
  avoid?: readonly AvoidZone[];
  avoidFace?: boolean;
}

export interface BubbleCompositeResult {
  url: string;
  filename: string;
  revoke: () => void;
}
