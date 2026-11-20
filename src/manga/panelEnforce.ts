/**
 * ST-Story-Illustrator — 发送侧确定性纠正纯函数
 *
 * 职责（任务 #16 配套）：在把 prompt/nl 发给出图后端之前做最后一道确定性过滤。
 * LLM 写了规则 ≠ 出图时照做，模型常留冲突词、漏必需词、白底页写满场景词。
 *
 * 移植自《漫画分镜与对白气泡 · 代码与提示词实现说明》§6.3（含 §6.11 常量）。
 * 全部为纯函数，不读 DOM、不发请求。
 *
 * 串联调用顺序（在出图函数里）：
 *   const panel = decidePanelInjection({...});
 *   if (panel.enabled) {
 *     prompt = enforcePanelPrompt(prompt, panel.layout).prompt;
 *     nl = applyPanelToNl(nl, panel.layout, orientation, pageType);
 *   }
 */

import type { PanelLayout, PanelPageType } from '../types';
import {
  PANEL_NL_SENTENCE,
  unframedNlSentence,
  normalizePanelLayout,
  normalizePanelPageType,
  panelTagsForCount,
  resolvePanelsPerPage,
} from './panelPlan';

// ============================================================
// 裸词 / 段判定
// ============================================================

/** 逗号段的裸 tag：2::2koma:: 与 2koma 视为同一个词。 */
function bareTagOf(segment: string): string {
  return segment.replace(/^\s*[\d.]+::/, '').replace(/^\s*::/, '')
    .replace(/::\s*$/, '').trim().toLowerCase();
}

/** 是否独立一段（不是跨逗号权重块的一部分）——权重块一律保留，不撕坏提示词。 */
function isPlainSegment(segment: string): boolean {
  const text = segment.trim();
  if (!text) return false;
  if (!text.includes('::')) return true;
  return /^[\d.]+\s*::.*::\s*$/.test(text);
}

// ============================================================
// 词族 / 禁词 / 场景词表
// ============================================================

const PANEL_FAMILY = [
  'multiple views', '2koma', '3koma', '4koma', 'split screen',
  '3格漫画', '三场景漫画构图', '非对称漫画页面布局', '开放分镜漫画构图', '无边框中央插画',
  '第二场景周围没有长方形画框', '主场景周围没有长方形包围', '人物自然融入白色空间',
];

const PANEL_FORBIDDEN_BY_LAYOUT: Record<PanelLayout, readonly string[]> = {
  regular: ['3koma', '4koma'],
  irregular: ['2koma', '3koma', '4koma'],
  inset: ['2koma', '3koma', '4koma', 'split screen'],
  unframed: ['multiple views', '2koma', '3koma', '4koma', 'split screen'],
};

/** 定性锚：定室内外，氛围非物件。无框档放行。 */
const SCENE_ANCHOR_TAGS: readonly string[] = ['indoors', 'outdoors', 'interior', 'exterior'];

/** 地点类：无框档只留前 2 个。 */
const SCENE_LOCATION_TAGS: readonly string[] = [
  'dorm room', 'bedroom', 'classroom', 'street', 'city', 'bathroom', 'kitchen',
  'office', 'living room', 'study', 'corridor', 'rooftop',
];

/** 白底两档硬禁的场景词：家具/光照/时段/照片感。刻意不含 white background。 */
const INSET_SCENE_TAGS: readonly string[] = [
  'indoors', 'outdoors', 'dorm room', 'bedroom', 'classroom', 'street', 'city', 'scenery',
  'bed', 'single bed', 'bedsheets', 'rumpled bedsheets', 'blanket', 'pillow', 'desk', 'wooden desk',
  'table', 'bookshelf', 'shelf', 'window', 'curtain', 'glass jar', 'paper cranes',
  'wooden floor', 'floor', 'sunlight from window', 'side lighting', 'warm colors', 'backlighting',
  'afternoon', 'morning', 'evening', 'night', 'sunset', 'sunrise',
  'depth of field', 'shallow depth of field',
];

// ============================================================
// enforcePanelPrompt（§6.3）
// ============================================================

export interface EnforceResult {
  prompt: string;
  removed: string[];
  added: string[];
}

/**
 * 出图前删冲突词 + 补缺词 + 白底档管场景词，只改本次发送的字符串。
 * 空提示词不造词（避免无中生有）。
 */
export function enforcePanelPrompt(
  prompt: string,
  layout: PanelLayout,
  panelsPerPage = 0,
): EnforceResult {
  const kind = normalizePanelLayout(layout);
  const source = String(prompt ?? '').trim();
  if (!source) return { prompt: source, removed: [], added: [] };

  const count = resolvePanelsPerPage(kind, panelsPerPage);
  const forbidden = new Set(PANEL_FORBIDDEN_BY_LAYOUT[kind]);
  // 用户钉死格数时：只有「与目标格数不同的 koma」才是冲突词，目标 koma 必须放行。
  // 旧版对 irregular 等档禁掉全部 koma，连模型写对的 3koma 都删了 → 玄学漏格。
  if (count >= 2 && count <= 4) {
    const wanted = `${count}koma`;
    for (const k of ['2koma', '3koma', '4koma']) {
      if (k === wanted) forbidden.delete(k);
      else forbidden.add(k);
    }
  } else if (kind === 'regular' && count >= 3) {
    forbidden.add('2koma');
  }
  // 场景词兜底只发生在白底两档：inset 全删；unframed 放行室内外锚 + 地点词限流 2 个。
  // 场景词全删会让模型连室内外都没锚，室内戏被画到室外（坑 6）。
  const stripScene = kind === 'inset' || kind === 'unframed';
  const sceneLimit = kind === 'unframed';
  let locationKept = 0;
  const kept: string[] = [];
  const removed: string[] = [];
  const present = new Set<string>();

  for (const segment of source.split(',')) {
    const text = segment.trim();
    if (!text) continue;
    const bare = bareTagOf(text);
    // 记所有裸词，不只分格词族：white background 不在词族里，
    // 只记词族会漏判、重复注入。
    present.add(bare);

    if (!PANEL_FAMILY.includes(bare)) {
      // 无框档：定性锚放行 → 地点词限流 2 个 → 其余场景词删
      if (sceneLimit && isPlainSegment(text)) {
        if (SCENE_ANCHOR_TAGS.includes(bare)) { kept.push(text); continue; }
        if (SCENE_LOCATION_TAGS.includes(bare)) {
          if (locationKept < 2) { locationKept += 1; kept.push(text); continue; }
          removed.push(text); continue;
        }
        if (INSET_SCENE_TAGS.includes(bare)) { removed.push(text); continue; }
        kept.push(text); continue;
      }
      if (stripScene && isPlainSegment(text) && INSET_SCENE_TAGS.includes(bare)) {
        removed.push(text); continue;
      }
      kept.push(text);
      continue;
    }
    if (isPlainSegment(text) && forbidden.has(bare)) { removed.push(text); continue; }
    kept.push(text);
  }

  const missing = panelTagsForCount(kind, count).filter(tag => !present.has(bareTagOf(tag)));
  return { prompt: [...missing, ...kept].join(', '), removed, added: missing };
}

// ============================================================
// decidePanelInjection（§6.3）
// ============================================================

export interface PanelInjectionInput {
  panelMode: boolean;
  panelLayout: PanelLayout;
  chibiOn: boolean;
  storyImage: boolean;
}

export interface PanelInjectionDecision {
  enabled: boolean;
  layout: PanelLayout;
}

/**
 * 判据只在这一处：小剧场图不注入；Q 版生效时恒压回 regular；档位先归一化。
 */
export function decidePanelInjection(input: PanelInjectionInput): PanelInjectionDecision {
  const layout = input.chibiOn ? 'regular' : normalizePanelLayout(input.panelLayout);
  return { enabled: input.panelMode && !input.storyImage, layout };
}

// ============================================================
// applyPanelToNl（§6.3）
// ============================================================

/** 中文为主体不补；含中文角色名的英文 nl 照补（用字符数比而非"含中文"）。 */
function isMostlyChinese(text: string): boolean {
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  if (!cjk) return false;
  return cjk > (text.match(/[a-zA-Z]/g) ?? []).length;
}

/** nl 里已经说过版面就放过；命中这些词即算说清。 */
const PANEL_NL_MARK =
  /\b(?:panels?|gutters?|inset|main image|main illustration|split screen|two-panel|comic page)\b/i;

/** 给 nl 兜底补版面句（幂等），放最前面。 */
export function applyPanelToNl(
  nl: string,
  layout: PanelLayout,
  orientation: 'portrait' | 'landscape' | 'square' = 'portrait',
  pageType: PanelPageType = 'auto',
): string {
  const kind = normalizePanelLayout(layout);
  const text = String(nl ?? '').trim();
  if (!text) return text;
  if (isMostlyChinese(text) || PANEL_NL_MARK.test(text)) return nl;
  const sentence = kind === 'unframed'
    ? unframedNlSentence(normalizePanelPageType(pageType))
    : PANEL_NL_SENTENCE[kind][orientation === 'landscape' ? 'landscape' : 'portrait'];
  return `${sentence} ${text}`;
}

// ============================================================
// 出图侧串联（供后续 Step 直接调用的组合函数）
// ============================================================

export interface EnforceForGenerationInput {
  prompt: string;
  nl: string;
  panelMode: boolean;
  panelLayout: PanelLayout;
  chibiOn: boolean;
  storyImage: boolean;
  orientation?: 'portrait' | 'landscape' | 'square';
  pageType?: PanelPageType;
  /** 每页固定格数（0 = 跟随档位） */
  panelsPerPage?: number;
}

export interface EnforcedGenerationText {
  prompt: string;
  nl: string;
  applied: boolean;
  layout: PanelLayout;
  removed: string[];
  added: string[];
}

/**
 * decidePanelInjection → enforcePanelPrompt → applyPanelToNl 的组合纯函数。
 * 不注入时原文返回（applied=false）。
 */
export function enforceForGeneration(input: EnforceForGenerationInput): EnforcedGenerationText {
  const decision = decidePanelInjection({
    panelMode: input.panelMode,
    panelLayout: input.panelLayout,
    chibiOn: input.chibiOn,
    storyImage: input.storyImage,
  });
  if (!decision.enabled) {
    return {
      prompt: input.prompt, nl: input.nl, applied: false,
      layout: decision.layout, removed: [], added: [],
    };
  }
  const enforced = enforcePanelPrompt(input.prompt, decision.layout, input.panelsPerPage ?? 0);
  return {
    prompt: enforced.prompt,
    nl: applyPanelToNl(input.nl, decision.layout, input.orientation, input.pageType),
    applied: true,
    layout: decision.layout,
    removed: enforced.removed,
    added: enforced.added,
  };
}
