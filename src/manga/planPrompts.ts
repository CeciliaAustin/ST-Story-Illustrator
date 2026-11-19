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
import {
  buildPanelRule,
  normalizePanelLayout,
  normalizePanelPageType,
  normalizeDialoguePolicy,
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
  const raw = String(text ?? '');
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

const ILLUSTRATION_SYSTEM = `你是一位专业的图像提示词（tag）编辑。你的任务是根据给定剧情，输出结构化的英文生图标签。
严格遵守：
1. 只输出一个 JSON 对象，不要输出任何解释文字、不要使用 Markdown 代码围栏。
2. 结构：{"segments":[{"id":"...","source":"character|scene|global","characterName":"角色名(仅character段)","english":["英文tag",...],"chinese":["中文辅助翻译",...],"order":数字}],"nl":"可选英文自然语言描述","negative":"可选英文负面词","size":"portrait|landscape"}。
3. english / nl / negative 必须是纯英文，绝不能出现中文——中文只放在 chinese 字段作辅助阅读。
4. character 段只写角色固定外貌（来自提供的角色快照，原样保留其 tag，不得改写）；scene 段写本次画面新增的动作、场景、构图、光线、情绪 tag。
5. 一次只策划一个明确的瞬间，不要描述整段剧情的时间跨度。
6. 场景与动作必须以给定剧情和上下文为依据，不得凭空添加关键剧情事实。
7. segment 按 order 从小到大排列；无需的字段直接省略，不要填空字符串或空数组。
8. 若剧情里的名场面适合漫画分镜，仍按单幅插画输出（漫画由专门的模式处理）。`;

export function buildIllustrationSystemPrompt(options: IllustrationPromptOptions): string {
  const flags: string[] = [];
  if (!options.includeChinese) flags.push('不要生成 chinese 字段（用户已关闭中文辅助）。');
  if (!options.includeNl) flags.push('不要生成 nl 字段（当前后端不使用自然语言通道）。');
  if (!options.includeNegative) flags.push('不要生成 negative 字段。');
  if (options.size) flags.push(`画幅倾向：${options.size}。`);
  return flags.length ? `${ILLUSTRATION_SYSTEM}\n\n补充约束：\n${flags.join('\n')}` : ILLUSTRATION_SYSTEM;
}

export interface SceneInput {
  selectedText: string;
  floorText?: string;
  previousText?: string;
  nextText?: string;
}

export function buildIllustrationUserPrompt(
  scene: SceneInput,
  characters: BaiBaiCharacter[],
): string {
  const parts: string[] = [];
  parts.push('【本次画面主体（选段，必须以此为准）】\n' + scene.selectedText);
  if (scene.floorText) parts.push('【所在楼层全文（情境参考）】\n' + scene.floorText);
  if (scene.previousText) parts.push('【前文（仅补充，勿当成本画面正在发生的动作）】\n' + scene.previousText);
  if (scene.nextText) parts.push('【后文（仅补充）】\n' + scene.nextText);
  if (characters.length > 0) {
    const lines = characters.map(c => `- ${c.name}: ${c.tag ?? ''}${c.nl ? ` (${c.nl})` : ''}`);
    parts.push('【角色固定外貌（character 段须原样保留其 tag）】\n' + lines.join('\n'));
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

const COMIC_SYSTEM_HEAD = `你是一位漫画分镜编辑。你要输出的是**一张画布上一页漫画**的分镜计划：整页由 NovelAI 一次画成多格版面，而不是每格单独出一张图。
只输出一个 JSON 对象，不要解释文字、不要 Markdown 代码围栏。
结构：{"pages":[{"pageIndex":0,"title":"页标题(中文短语)","layout":"regular|irregular|inset|unframed","tags":"整页共用英文 tag，逗号分隔","nl":"英文分区描述","dialogue":[{"text":"中文台词","area":"tl|tr|bl|br","dir":"v","mood":"whisper"}],"panels":[{"index":0,"title":"这一格画了什么(中文短语)","characters":[{"name":"角色","act":"动作"}],"mood":"氛围"}]}]}
硬要求：
1. 一页 = 一张图。整页 tag 只写在 page.tags 里，**不要按格分别写 tag**。
2. page.tags 必须写出：在场角色的外观（用给你的角色快照）、他们正在做什么、在哪里、画面里的关键物件。**人物和动作是画面主体**，只写构图词的图等于没画。
3. 构图词必须按【分镜规则】里该档的写法**原样照抄**（含 1.4:: 这类权重写法），少一个就不是漫画。
4. 景别 tag 整页只写一个（cowboy shot / upper body 之类），各格远近只写在 nl 里。
5. page.nl 必须分区写：第一句总述版面（几格、怎么分），之后每格一句，用 "In the upper panel, ..." / "The lower panel shows ..." 这类句式；不要用 Panel 1 / Panel 2 编号，不要写对白。
6. panels 数组只用来标「每一格画了什么」：2~4 条，title 是中文短标题（会印在卡片上），格数必须与 nl 里描述的一致。
7. dialogue 是中文口语台词，最多 4 条、每条 20 字内，不写旁白；台词不许写进 tags 或 nl。
8. tags / nl 里绝对不允许出现 speech bubble、text、english text、dialogue、caption —— 画面里不能有字。`;

export function buildComicSystemPrompt(options: ComicPlanOptions): string {
  const ruleOptions: PanelRuleOptions = {
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
  const parts = [COMIC_SYSTEM_HEAD];
  if (rule) parts.push('【分镜规则（必须遵守）】\n' + rule);
  parts.push(`【输出约束】最多 ${Math.max(1, Math.min(8, options.maxPages))} 页；${
    options.dialogue
      // 「可省略」写出来，模型十次有八次真的省略——对白气泡就白配了
      ? 'dialogue 必须写：每页 2~3 条中文台词，取自这一段里真的说过的话；实在没有对白才用一句旁白式台词顶上。'
      : '本次不要输出 dialogue 字段。'
  }`);
  if (!options.includeChinese) parts.push('除台词外的辅助中文一律不要输出。');
  return parts.join('\n\n');
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
