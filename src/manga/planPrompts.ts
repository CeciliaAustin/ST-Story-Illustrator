/**
 * ST-Story-Illustrator — LLM 分镜/Tag 计划：提示词构建与响应解析（纯函数）
 *
 * 职责（任务 #6 前半）：
 * - 为「插画 Tag 生成」和「漫画分镜计划生成」组装 system / user prompt
 * - 把 LLM 返回的（可能是代码围栏、夹带解释的）文本容错解析为结构化数据
 *
 * LLM 请求由 generateQuietPrompt 发出（ST 自身 API），本文件只管字符串进出，
 * 不读 DOM、不发请求——所有函数可直接单测。
 *
 * 依文档纪律：
 * - 中文只作辅助，绝不进入英文生图 prompt（SPEC §7.5）
 * - 规则/示例/nl 兜底三处同档，统一从 buildPanelRule 取（panelPlan.ts）
 */

import type {
  PromptSegment,
  GeneratePromptResponse,
  BaiBaiCharacter,
  PanelLayout,
  PanelPageType,
  DialoguePolicy,
} from '../types';
import { stripThinkingBlocks } from '../prompt/think';
import { renderPromptDoc, type PromptOverrideMap } from '../prompt/presets';
import {
  buildPanelRule,
  normalizePanelLayout,
  normalizePanelPageType,
  normalizeDialoguePolicy,
  resolvePanelsPerPage,
  type PanelRuleOptions,
} from './panelPlan';

// ============================================================
// 通用：从 LLM 输出里提取 JSON
// ============================================================

/**
 * 从模型回复中提取第一个完整 JSON 对象或数组。
 * 容忍 markdown 代码围栏、前后解释文字、首尾逗号等常见脏输出。
 */
export function extractJson(text: string): string | null {
  // 先剥思考块：我们把柏宝绘的「思维链」也压进了 system，模型会先输出
  // <thinking>…</thinking>。那里面随手一个花括号就会把下面的括号配对扫描带偏。
  const raw = stripThinkingBlocks(String(text ?? ''));
  if (!raw.trim()) return null;

  // 1) 代码围栏优先
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const inner = fenced[1].trim();
    if (inner) return inner;
  }

  // 2) 扫描第一个 { 或 [ 到匹配的收尾符（考虑字符串内的括号与转义）
  const start = raw.search(/[\[{]/);
  if (start < 0) return null;
  const open = raw[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1).trim();
    }
  }
  return null;
}

/** JSON.parse 的安全包装，失败返回 null，不抛异常。 */
export function safeParseJson<T = unknown>(text: string): T | null {
  const json = extractJson(text);
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

// ============================================================
// 角色快照 → Tag 段（纯函数）
// ============================================================

/** 把柏宝绘角色快照转成 character 段（外貌固定，黑色显示）。 */
export function characterToSegment(
  character: BaiBaiCharacter,
  order: number,
  includeChinese: boolean,
): PromptSegment | null {
  const englishTags = String(character.tag ?? '').split(',').map(t => t.trim()).filter(Boolean);
  if (englishTags.length === 0) return null;
  const cn = includeChinese && character.nl
    ? [character.nl.trim()]
    : includeChinese && character.desc
      ? [character.desc.trim()]
      : [];
  const name = String(character.name ?? '').trim() || '角色';
  return {
    id: `char-${order}-${name}`,
    source: 'character',
    characterName: name,
    english: englishTags,
    ...(cn.length ? { chinese: cn } : {}),
    enabled: true,
    order,
  };
}

// ============================================================
// 插画 Tag 生成：system / user prompt
// ============================================================

export interface IllustrationPromptOptions {
  includeChinese: boolean;
  includeNl: boolean;
  includeNegative: boolean;
  size?: 'portrait' | 'landscape' | string;
}

/**
 * 正文插画的 system。
 *
 * 正文本身在 prompt/presets.ts 里（用户可改）；这里只负责把「这次要不要
 * chinese / nl / negative、画幅倾向」翻成模板变量。
 */
export function buildIllustrationSystemPrompt(
  options: IllustrationPromptOptions,
  overrides?: PromptOverrideMap,
): string {
  // nl 不再是「插件偏好」，而是**这套出图方案的能力**：方案开了自然语言才写。
  // 以前 noNl 与模板第 10 条各说一套，模型只能猜，4.5 关掉 nl 也照写。
  const hasFlags = !options.includeChinese || !options.includeNegative || !!options.size;
  return renderPromptDoc('illustration', 'single', {
    nl: options.includeNl,
    hasFlags,
    noChinese: !options.includeChinese,
    noNl: !options.includeNl,
    noNegative: !options.includeNegative,
    sizeClause: options.size ?? '',
  }, overrides);
}

export interface SceneInput {
  selectedText: string;
  floorText?: string;
  previousText?: string;
  nextText?: string;
}

export interface IllustrationContextBlocks {
  /** 柏宝绘角色库全文（按字段渲染，含发色/瞳色/体型/固定着装） */
  libraryBlock?: string;
  /** 「谁是谁」：用户扮演谁、角色卡是谁 */
  castBlock?: string;
}

/**
 * 模型一个 character 段都没写时，由代码补上在场角色的固定外貌。
 *
 * 「人物都没填」有一半不是模型懒得写，而是它把外貌散落进 scene 段、
 * 或者干脆只写 1boy/1girl。外貌是**可确定**的东西（柏宝绘角色库里就有），
 * 不该靠模型记性——柏宝绘自己在多角色时走的也是独立的 character 通道。
 *
 * 只在「一个 character 段都没有」时补，且只补选段里真的提到的人；
 * 一个都没提到时，库里只有 1~2 个人才全补（避免把无关的人画进来）。
 */
export function ensureCharacterSegments(
  response: GeneratePromptResponse,
  characters: BaiBaiCharacter[],
  selectedText: string,
  includeChinese: boolean,
): GeneratePromptResponse {
  if (response.segments.some(seg => seg.source === 'character')) return response;
  const usable = characters.filter(c => String(c.name ?? '').trim() && String(c.tag ?? '').trim());
  if (!usable.length) return response;
  const text = String(selectedText ?? '');
  const mentioned = usable.filter(c => text.includes(String(c.name).trim()));
  const picked = mentioned.length ? mentioned : usable.length <= 2 ? usable : [];
  if (!picked.length) return response;
  const segs: PromptSegment[] = [];
  picked.forEach((character, i) => {
    const seg = characterToSegment(character, i - picked.length, includeChinese);
    if (seg) segs.push(seg);
  });
  if (!segs.length) return response;
  return { ...response, segments: [...segs, ...response.segments] };
}

export function buildIllustrationUserPrompt(
  scene: SceneInput,
  characters: BaiBaiCharacter[],
  blocks: IllustrationContextBlocks = {},
): string {
  const parts: string[] = [];
  parts.push('【本次画面主体（选段，必须以此为准）】\n' + scene.selectedText);
  if (scene.floorText) parts.push('【所在楼层全文（情境参考）】\n' + scene.floorText);
  if (scene.previousText) parts.push('【前文（仅补充，勿当成本画面正在发生的动作）】\n' + scene.previousText);
  if (scene.nextText) parts.push('【后文（仅补充）】\n' + scene.nextText);
  if (blocks.castBlock) parts.push(blocks.castBlock);
  // 角色库优先：它按字段渲染（头发/眼睛/体型…），比 `tag` 一整串更抗「条目只有字段没有 tag」。
  // 以前只发 `- 名字: tag`，tag 为空的人就只剩一个名字——模型只能自己编一张脸。
  if (blocks.libraryBlock) {
    parts.push(blocks.libraryBlock);
  } else if (characters.length > 0) {
    const lines = characters
      .filter(c => !!String(c.name ?? '').trim())
      .map(c => `- ${c.name}: ${c.tag || '（没有外貌数据，请按正文写具体）'}${c.nl ? ` (${c.nl})` : ''}`);
    if (lines.length) {
      parts.push('【角色固定外貌（character 段须原样保留其 tag；标注「没有外貌数据」的按正文补）】\n'
        + lines.join('\n'));
    }
  }
  parts.push('请只输出一个 JSON 对象。');
  return parts.join('\n\n');
}

// ============================================================
// 插画 Tag 响应解析
// ============================================================

function normalizePromptSegment(raw: unknown, index: number): PromptSegment | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const source = o.source === 'character' || o.source === 'global' ? o.source : 'scene';
  const english = Array.isArray(o.english)
    ? o.english.filter((t): t is string => typeof t === 'string').map(t => t.trim()).filter(Boolean).slice(0, 60)
    : [];
  if (english.length === 0) return null;
  const chinese = Array.isArray(o.chinese)
    ? o.chinese.filter((t): t is string => typeof t === 'string').map(t => t.trim()).filter(Boolean).slice(0, 60)
    : [];
  return {
    id: typeof o.id === 'string' && o.id.trim() ? o.id.trim().slice(0, 80) : `${source}-${index}`,
    source,
    ...(source === 'character' && typeof o.characterName === 'string'
      ? { characterName: o.characterName.trim().slice(0, 32) } : {}),
    english,
    chinese,
    enabled: o.enabled !== false,
    order: typeof o.order === 'number' && Number.isFinite(o.order) ? Math.floor(o.order) : index,
  };
}

/** 容错解析插画 Tag 生成的 LLM 响应。 */
export function parseIllustrationResponse(text: string): GeneratePromptResponse | null {
  const data = safeParseJson<Record<string, unknown>>(text);
  if (!data || typeof data !== 'object') return null;
  const rawSegments = Array.isArray(data.segments) ? data.segments : [];
  const segments: PromptSegment[] = [];
  for (let i = 0; i < Math.min(rawSegments.length, 40); i += 1) {
    const seg = normalizePromptSegment(rawSegments[i], i);
    if (seg) segments.push(seg);
  }
  if (segments.length === 0) return null;

  const result: GeneratePromptResponse = { segments };
  if (typeof data.nl === 'string' && data.nl.trim()) result.nl = data.nl.trim().slice(0, 2000);
  if (typeof data.negative === 'string' && data.negative.trim()) result.negative = data.negative.trim().slice(0, 2000);
  if (typeof data.size === 'string' && data.size.trim()) result.size = data.size.trim().slice(0, 40);
  return result;
}

// ============================================================
// 漫画分镜计划：system / user prompt
// ============================================================

export interface ComicPlanOptions {
  panelMode: boolean;
  /** 每页固定格数（0 = 跟随版面档位） */
  panelsPerPage?: number;
  panelLayout: PanelLayout;
  pageType: PanelPageType;
  dialogue: boolean;
  dialoguePolicy: DialoguePolicy;
  dialogueMode: 'json' | 'tag';
  nl: boolean;
  backend: 'nai' | 'comfyui' | 'other';
  charPrompts: boolean;
  lockedSize?: string;
  includeChinese: boolean;
  maxPages: number;
  /** 追加到 user prompt 末尾的一次性要求（用于「上一次 tags 太空」的重试）。 */
  extraInstruction?: string;
}

export function buildComicSystemPrompt(
  options: ComicPlanOptions,
  overrides?: PromptOverrideMap,
): string {
  const ruleOptions: PanelRuleOptions = {
    panelsPerPage: options.panelsPerPage ?? 0,
    backend: options.backend,
    charPrompts: options.charPrompts,
    nl: options.nl,
    lockedSize: options.lockedSize,
    layout: normalizePanelLayout(options.panelLayout),
    pageType: normalizePanelPageType(options.pageType),
    dialogue: options.dialogue,
    dialogueMode: options.dialogueMode,
    dialoguePolicy: normalizeDialoguePolicy(options.dialoguePolicy),
  };
  const rule = buildPanelRule(options.panelMode, ruleOptions);
  const fixedPanels = resolvePanelsPerPage(normalizePanelLayout(options.panelLayout), options.panelsPerPage);
  return renderPromptDoc('comic', 'single', {
    // 方案没有自然语言通道时，整页 nl 分区描述就无从谈起
    nl: options.nl !== false,
    // 不启用分镜时别谈「每页几格」——那一页根本不是漫画页
    fixedPanels: options.panelMode && fixedPanels >= 2,
    panelsPerPage: fixedPanels >= 2 ? fixedPanels : '',
    hasRule: !!rule,
    panelRule: rule,
    maxPages: Math.max(1, Math.min(8, options.maxPages)),
    dialogue: options.dialogue,
    noChinese: !options.includeChinese,
  }, overrides);
}

export function buildComicUserPrompt(
  scene: SceneInput,
  characters: BaiBaiCharacter[],
  extraInstruction?: string,
): string {
  const parts: string[] = [];
  parts.push('【剧情（据此排分镜）】\n' + scene.selectedText);
  if (scene.floorText) parts.push('【所在楼层全文】\n' + scene.floorText);
  if (scene.previousText) parts.push('【前文（仅补充）】\n' + scene.previousText);
  if (scene.nextText) parts.push('【后文（仅补充）】\n' + scene.nextText);
  if (characters.length > 0) {
    const lines = characters.map(c => `- ${c.name}: ${c.tag ?? ''}${c.nl ? ` (${c.nl})` : ''}`);
    parts.push('【在场角色（保持外貌一致）】\n' + lines.join('\n'));
  }
  if (extraInstruction) parts.push('【本次特别要求】\n' + extraInstruction);
  parts.push('请只输出一个 JSON 对象（pages 数组）；一页一张图，tag 写在 page.tags 上，nl 逐格分区写。');
  return parts.join('\n\n');
}
