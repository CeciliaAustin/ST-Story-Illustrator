/**
 * ST-Story-Illustrator — 新风格 → 出图词（确定性，纯函数）
 *
 * 为什么需要这一层：
 * 版面系统有「新风格（comicStyle）/格数（comicPanelCount）/留白（comicWhitespace）」
 * 三个独立维度，但旧出图链路把它们经 layoutStyleToLegacy 拍回旧四档，再取
 * PANEL_TAGS_BY_LAYOUT 的词表。结果是：
 * - 用户选「开放拼版」→ 旧档 irregular → 注入 `1.5::split screen::`（把不等大拼版
 *   压成竖切屏）—— 这正是实测 A；
 * - 用户选「主图+特写固定三格」→ 旧档 inset → NL 写「one or two small panels」
 *   + tag 里没有数字 → 模型只画一格 —— 实测 B/C；
 * - 无条件 `3koma / multiple views / white background` 与留白要求互相打架。
 *
 * 这一层让「用户选了什么」直接决定「发给图像 API 的词」，只做三件事：
 * 1. 按风格挑一组不冲突的构图词；
 * 2. 用户钉死格数时，用明确的英文数字句表达 N 个独立 panel（不是靠 koma 猜）；
 * 3. 把留白意图写成几何描述，而不是让模型自由发挥。
 *
 * 纯函数：不读 DOM、不发请求，可直接单测。旧的 panelEnforce 逻辑保持不动，
 * 由调用方（workflow）决定走新链路还是旧链路——老 artifact 的重画不受影响。
 */

import type {
  ComicLayoutStyle,
  ComicPanelCount,
  ComicWhitespacePreference,
  ComicWhitespaceIntent,
} from '../types';
import { defaultWhitespaceForStyle, normalizeLayoutStyle, normalizePanelCount } from './layoutStyle';

/** 归一化留白偏好 → 具体意图（auto 时按风格默认）。 */
export function resolveWhitespaceIntent(
  pref: ComicWhitespacePreference | undefined,
  style: ComicLayoutStyle,
): ComicWhitespaceIntent {
  return pref && pref !== 'auto' ? pref : defaultWhitespaceForStyle(style);
}

/**
 * 每种风格的构图 tag —— 只放「真正需要、且不与其他词冲突」的少量词。
 * 关键纪律（任务书 §6.3）：
 * - 不放 split screen（会把开放拼版压成竖切屏）；
 * - 不放无条件 multiple views / 3koma（不是几何约束，还会和白底档打架）；
 * - 不放 white background 当布局（它会盖掉留白几何）；
 * - 固定格数的数字句由 buildPanelCountTag 单独给，不混在里面。
 */
const STYLE_TAGS: Record<ComicLayoutStyle, readonly string[]> = {
  classic_grid: ['comic page layout', 'panel layout'],
  open_montage: ['comic page layout', 'asymmetric layout'],
  diagonal_panels: ['comic page layout', 'dynamic diagonal composition'],
  hero_insets: ['comic page layout'],
  freeform: ['comic page layout'],
};

/**
 * 固定格数时明确注入的构图词。
 * 用 koma 只是「辅助提醒」，真正保证靠 NL 的数字句 + 存档 slots（见报告限制说明）。
 * hero_insets 固定三格 = one main + two insets，绝不写 "one or two"。
 */
export function buildPanelCountTag(count: ComicPanelCount): string[] {
  const n = normalizePanelCount(count);
  if (n === 'auto') return [];
  return [`${n}koma`];
}

/** 风格 + 格数 → 构图 tag（去重、顺序稳定）。 */
export function styleCompositionTags(
  style: ComicLayoutStyle,
  count: ComicPanelCount,
): string[] {
  const s = normalizeLayoutStyle(style);
  const out = [...STYLE_TAGS[s], ...buildPanelCountTag(count)];
  return [...new Set(out)];
}

const COUNT_WORD: Record<number, string> = { 2: 'two', 3: 'three', 4: 'four' };

/** 数字词的英文（NL 用），auto 返回空串。 */
function countWord(count: ComicPanelCount | number): string {
  const n = typeof count === 'number' ? count : normalizePanelCount(count);
  return n === 'auto' ? '' : (COUNT_WORD[n] ?? String(n));
}

/**
 * 每种风格的版面骨架句（英文，明确几何）。
 * 全部用 "exactly N separate panels" 钉死格数——这是图像模型相对最能听懂的说法；
 * 每格的角色/镜头由各格 nl 分区描述，这里只管版面和留白。
 */
function layoutSentence(style: ComicLayoutStyle, count: ComicPanelCount): string {
  const s = normalizeLayoutStyle(style);
  const n = normalizePanelCount(count);
  const num = countWord(count);

  if (n === 'auto') {
    switch (s) {
      case 'classic_grid':
        return 'A comic page divided into a clear grid of separate panels with thin gutters between them, read from top to bottom.';
      case 'open_montage':
        return 'An asymmetric comic page of unequally sized separate panels with a clear main panel and smaller ones, generous empty negative space between them.';
      case 'diagonal_panels':
        return 'A comic page of separately bordered panels cut with diagonal edges, arranged so the reading path stays clear, with empty negative space around them.';
      case 'hero_insets':
        return 'A comic page with one large main panel and a few smaller bordered inset panels floating apart from it on wide empty negative space; the insets are separate framed areas, never details drawn inside the main panel.';
      case 'freeform':
      default:
        return 'A comic page with a clear main panel and a few smaller secondary panels separated by empty negative space, read in an obvious order.';
    }
  }

  const exactly = `Exactly ${num} separate panels on this comic page, each in its own clearly bounded area.`;
  switch (s) {
    case 'classic_grid':
      return `${exactly} The ${num} panels are arranged in a tidy regular grid and separated by thin black gutters.`;
    case 'open_montage':
      return `${exactly} The panels are unequal in size with one dominant main panel; the smaller panels are different sizes and do not line up in a simple vertical column. Thin black gutters separate them.`;
    case 'diagonal_panels':
      return `${exactly} The panels have slanted / diagonal edges (parallelograms or trapezoids), not all upright rectangles, separated by clear gutters, with an obvious reading order.`;
    case 'hero_insets':
      return `${exactly} One large main panel plus ${countWord(n - 1)} smaller bordered inset panels (exactly ${num} panels in total). The inset panels float on the empty space around the main panel with a wide clean gap; they are separate framed panels, never small details inside the main picture.`;
    case 'freeform':
    default:
      return `${exactly} One panel is the clear visual focus and the others are smaller, separated by empty negative space and read in an obvious order.`;
  }
}

const WHITESPACE_SENTENCE: Record<ComicWhitespaceIntent, string> = {
  compact: 'Keep gutters narrow and use only slim outer margins; the panels fill most of the page.',
  balanced: 'Use moderate gutters and moderate outer margins so the panels breathe without floating too far apart.',
  airy: 'Leave wide gutters and large clean outer margins; keep obvious empty negative space between the panels and around the page edges — do not push every panel to the border.',
  dramatic: 'Reserve a large area of completely empty negative space around the main panel as a dramatic pause; keep that area clean and do not fill it with any panel or character.',
};

/**
 * 生成整页版面 NL 骨架句（风格 + 格数 + 留白）。
 * 这就是发给图像 API 的 nl 第一句：先钉版面与格数，再钉留白，其余画面细节由各格 nl 补充。
 */
export function styleLayoutNl(
  style: ComicLayoutStyle,
  count: ComicPanelCount,
  whitespace: ComicWhitespacePreference,
): string {
  const s = normalizeLayoutStyle(style);
  const intent = resolveWhitespaceIntent(whitespace, s);
  return `${layoutSentence(s, count)} ${WHITESPACE_SENTENCE[intent]}`;
}

export interface StyleGenerationInput {
  style: ComicLayoutStyle;
  panelCount: ComicPanelCount;
  whitespace: ComicWhitespacePreference;
}

/**
 * 一次性产出某风格下这页应追加的构图词与版面 NL。
 * 调用方把它们与「画面内容 tag / 各格 nl / 角色块」拼起来即可，无需再走旧四档词表。
 */
export function buildStyleGeneration(input: StyleGenerationInput): {
  tags: string[];
  nl: string;
} {
  return {
    tags: styleCompositionTags(input.style, input.panelCount),
    nl: styleLayoutNl(input.style, input.panelCount, input.whitespace),
  };
}

/**
 * 从一段 prompt 里剥掉旧四档的冲突构图词，避免新旧两套词并存时模型取到错的那个。
 * 只认独立逗号段（带权重写法的整段一起删），不碰人物/场景/动作词。
 */
const CONFLICT_TAGS: readonly string[] = [
  'multiple views', 'split screen', '2koma', '3koma', '4koma',
  'comic page', 'comic panel', 'panel layout', 'manga', 'comic',
  'white background', 'asymmetric layout', 'dynamic diagonal composition',
];

function bareTagOf(segment: string): string {
  return segment.replace(/^\s*[\d.]+::/, '').replace(/^\s*::/, '')
    .replace(/::\s*$/, '').trim().toLowerCase();
}

export function stripLegacyLayoutTags(prompt: string): string {
  const kept: string[] = [];
  for (const raw of String(prompt ?? '').split(',')) {
    const text = raw.trim();
    if (!text) continue;
    if (CONFLICT_TAGS.includes(bareTagOf(text))) continue;
    kept.push(text);
  }
  return kept.join(', ');
}
