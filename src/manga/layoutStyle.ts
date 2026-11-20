/**
 * 版面系统 adapter（纯函数）
 *
 * 职责：让用户「选的风格 / 格数 / 留白」与既有的四档出图规则互通。
 * 设计约束（扩展指导 §4）：
 * - 老用户设置读进来自动迁移，不覆盖原有偏好；
 * - 新设置保存新枚举；
 * - PanelLayout（旧四档）与 ComicLayoutStyle（新风格）不长期混用，这里就是那层薄薄的桥。
 *
 * 谁依赖它：
 * - 设置读取：comicStyle 缺失时从 comicLayout 迁移；comicPanelCount 从 comicPanelsPerPage 迁移。
 * - 出图规则：新风格经 `layoutStyleToLegacy` 落成旧四档之一，继续复用已验证的提示词/构图词。
 * - 几何：最终 ComicLayoutPlan 由 LLM + validator 产出（Step 3），这里只提供风格默认值。
 */

import type {
  ComicLayoutStyle,
  ComicPanelCount,
  ComicWhitespaceIntent,
  ComicWhitespacePreference,
  PanelLayout,
  PanelLayoutChoice,
} from '../types';

const STYLES: readonly ComicLayoutStyle[] = [
  'classic_grid',
  'open_montage',
  'diagonal_panels',
  'hero_insets',
  'freeform',
];

/** 归一化版面风格；脏值回落到 open_montage（最通用，不丢主次）。 */
export function normalizeLayoutStyle(v: unknown): ComicLayoutStyle {
  return typeof v === 'string' && (STYLES as readonly string[]).includes(v)
    ? (v as ComicLayoutStyle)
    : 'open_montage';
}

/** 归一化格数；脏值回落到 auto。 */
export function normalizePanelCount(v: unknown): ComicPanelCount {
  return v === 2 || v === 3 || v === 4 ? v : 'auto';
}

/** 归一化留白偏好；脏值回落到 auto。 */
export function normalizeWhitespace(v: unknown): ComicWhitespacePreference {
  return v === 'compact' || v === 'airy' || v === 'dramatic' ? v : 'auto';
}

/**
 * 旧四档（含 auto）→ 新风格。
 * 注意 UI 曾把 irregular 标成「斜切分镜」，但它的真实语义是开放拼版；
 * 真正的斜切是新枚举 diagonal_panels，绝不能把老用户的 irregular 悄悄变成斜切。
 */
export function migrateLayoutChoice(v: unknown): ComicLayoutStyle {
  const x = typeof v === 'string' ? v : '';
  switch (x) {
    case 'regular':
      return 'classic_grid';
    case 'inset':
      return 'hero_insets';
    case 'unframed':
      // 无框主画面语义：归到 hero_insets 的「无框变体」由 layoutPlan 的 border:'none' 表达，
      // 不新建第五档；这里保留主画面+特写的视觉语言，不让老用户掉进 freeform 的随机。
      return 'hero_insets';
    case 'irregular':
    case 'auto':
    default:
      return 'open_montage';
  }
}

/** 新风格 → 旧四档（出图规则仍吃旧四档，这里做唯一映射点）。 */
export function layoutStyleToLegacy(style: ComicLayoutStyle): Exclude<PanelLayoutChoice, 'auto'> {
  switch (style) {
    case 'classic_grid':
      return 'regular';
    case 'diagonal_panels':
      // 斜切在旧规则里没有独立档；用开放拼版承载「不等格」语义，
      // 真正的斜边由 layoutPlan.slots[].polygon 表达，不靠这个映射。
      return 'irregular';
    case 'hero_insets':
      return 'inset';
    case 'freeform':
    case 'open_montage':
    default:
      return 'irregular';
  }
}

/**
 * 从设置解析出「用户实际选的风格」。
 * comicStyle 有值就用它（新设置优先）；否则从旧 comicLayout 迁移；再否则默认 freeform（自动）。
 */
export function resolveLayoutStyle(input: {
  comicStyle?: ComicLayoutStyle;
  comicLayout?: PanelLayoutChoice;
}): ComicLayoutStyle {
  if (input.comicStyle) return normalizeLayoutStyle(input.comicStyle);
  if (input.comicLayout) return migrateLayoutChoice(input.comicLayout);
  return 'freeform';
}

/** 从设置解析格数：新字段优先，旧字段兜底，再否则 auto。 */
export function resolvePanelCount(input: {
  comicPanelCount?: ComicPanelCount;
  comicPanelsPerPage?: number;
}): ComicPanelCount {
  if (input.comicPanelCount !== undefined) return normalizePanelCount(input.comicPanelCount);
  const old = normalizePanelCount(input.comicPanelsPerPage);
  return old;
}

/** 用户明确偏好时用它；'auto' 时返回 undefined，交给风格默认。 */
export function resolveWhitespaceIntent(
  pref: ComicWhitespacePreference | undefined,
  style: ComicLayoutStyle,
): ComicWhitespaceIntent {
  const p = normalizeWhitespace(pref);
  if (p !== 'auto') return p;
  return defaultWhitespaceForStyle(style);
}

/** 每种风格的留白倾向（§1.3，非硬约束，LLM 可按 beat 微调）。 */
export function defaultWhitespaceForStyle(style: ComicLayoutStyle): ComicWhitespaceIntent {
  switch (style) {
    case 'classic_grid':
      return 'compact';
    case 'open_montage':
      return 'airy';
    case 'diagonal_panels':
      return 'balanced';
    case 'hero_insets':
      return 'dramatic';
    case 'freeform':
    default:
      return 'balanced';
  }
}

/** 每种风格的默认格数（§1.2，默认值不是限制）。 */
export function defaultPanelCountForStyle(style: ComicLayoutStyle): Exclude<ComicPanelCount, 'auto'> {
  switch (style) {
    case 'classic_grid':
      return 4;
    case 'open_montage':
    case 'diagonal_panels':
    case 'hero_insets':
      return 3;
    case 'freeform':
    default:
      return 3;
  }
}

/** 用户是否钉死了风格（freeform 之外都算钉死，LLM 不得换）。 */
export function isStyleLocked(style: ComicLayoutStyle): boolean {
  return style !== 'freeform';
}
