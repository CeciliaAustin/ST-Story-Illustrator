/**
 * ST-Story-Illustrator — 小剧场读剧情提示词构建（纯函数）
 *
 * 移植自文档 §2.2–2.9 + §5B.4 拼词层。
 * 生成的是「读剧情」用的 system/user 文本，与「出图」拼词分开。
 *
 * 2026-11 起，system 不再是硬编码字符串：五套模板统一放在 prompt/presets.ts，
 * 用户可以在「提示词」标签页里看到原文并改。本文件只负责
 * 「选哪一套 + 填哪些变量 + 拼角色库/谁是谁」。
 */

import type { StoryKind } from '../types';
import { STATUS_MAX_PANELS } from './parseReply';
import { renderPromptDoc, type PromptDocId, type PromptOverrideMap } from '../prompt/presets';

const BODY_LIMIT = 2400;
const BODY_LIMIT_STORY = 3600;
const FRAMING_RE = /\b(?:upper body|cowboy shot|close[- ]?up|portrait|headshot)\b/i;

/** 正文过长只取尾部；多格要看整楼走向，取更长。 */
export function clampBody(body: string, many: boolean): string {
  const text = String(body ?? '');
  const limit = many ? BODY_LIMIT_STORY : BODY_LIMIT;
  return text.length > limit ? text.slice(-limit) : text;
}

export interface TheaterPromptInput {
  kind: StoryKind;
  characterName: string;
  body: string;
  shots: number;
  mangaSafe?: boolean;
  /** 黑白漫是否要台词（可关；关掉就完全不问模型要 lines） */
  dialogue?: boolean;
  /**
   * 柏宝绘角色库里的名字。给了就把名单写进 prompt，让模型照抄——
   * 名字对不上角色库，出图时就取不到那个人的外貌 tag（这是「人物不像」的常见来源）。
   */
  roster?: string[];
  /** 角色固定外貌库全文（见 theater/library.ts）；有它时模型能看见发色瞳色，不再靠猜。 */
  libraryBlock?: string;
  /** 「谁是谁」：用户扮演谁、角色卡是谁（正文里的「你」才不会丢）。 */
  castBlock?: string;
  /** 用户在「提示词」标签页里改过的模板 */
  promptOverrides?: PromptOverrideMap;
}

const DOC_OF_KIND: Record<StoryKind, PromptDocId> = {
  status: 'status',
  bonus: 'bonus',
  manga: 'manga',
};

/** 构建读剧情的 system + user 文本（合成一条给 generateQuietPrompt）。 */
export function buildTheaterPrompt(input: TheaterPromptInput): { system: string; user: string } {
  const count = Math.min(Math.max(Math.round(Number(input.shots) || 1), 1), STATUS_MAX_PANELS);
  const many = count > 1;
  const body = clampBody(input.body, many || input.kind === 'bonus');
  const name = input.characterName || '（未命名）';

  const docId = DOC_OF_KIND[input.kind] ?? 'status';
  const systemVars: Record<string, string | number | boolean> = { count };
  if (input.kind === 'manga') {
    systemVars.safe = input.mangaSafe !== false;
    systemVars.dialogue = input.dialogue === true;
  }
  let system = renderPromptDoc(docId, many ? 'many' : 'single', systemVars, input.promptOverrides);

  const bodyLabel = input.kind === 'bonus'
    ? '正文（只用来认人，不用来取材）：'
    : '正文：';

  const roster = (input.roster ?? []).map(n => String(n ?? '').trim()).filter(Boolean).slice(0, 12);
  const rosterLine = roster.length
    ? `可用角色（柏宝绘角色库；characters[].name 必须照抄其中一项，不要自己造人）：${roster.join('、')}\n`
    : '';

  // 角色库与「谁是谁」放进 system：它们是规则与参照，不是剧情正文。
  // 以前只给名字名单，模型看不到发色瞳色 → 名字对不上时它干脆自己编一个人，
  // 用户看到的就是「这人是谁」。柏宝绘自己的做法就是把整份库发进去照抄。
  const reference = [input.castBlock, input.libraryBlock].filter(Boolean).join('\n\n');
  if (reference) system = `${system}\n\n${reference}`;

  return {
    system,
    user: `${rosterLine}角色：${name}\n${bodyLabel}\n${body}`,
  };
}

// ============================================================
// 出图拼词层（§5B.4）
// ============================================================

/** Q版强档画风串（NAI 带权重写法）。正向绝对不写 chibi 这个词。 */
export const CHIBI_STYLE_STRONG =
  '2.3::super deformed, big head, small body::, 2.2::oversized eyes, round face, simplified facial features::, ' +
  '2.0::tiny hands, short limbs::, 1.9::soft rounded shading, pastel highlights::, ' +
  '1.8::glossy eyes, sparkles, bokeh background, warm rim light::, ' +
  '1.7::exaggerated head-to-body ratio, rounded silhouette, simplified anatomy, stylized proportions, simple background::';

const MANGA_FRAMING = ['extreme close-up', 'close-up', 'upper body', 'cowboy shot', 'full body',
  'wide shot', 'medium shot', 'from above', 'from below', 'from side', 'dutch angle'];
const MANGA_FRAMING_RE = new RegExp(
  `\\b(?:${MANGA_FRAMING.map(w => w.replace(/-/g, '[- ]?')).join('|')})\\b`, 'i');

/** 状态栏/彩蛋出图词：Q版串 + 外貌 + 画面 tag + 景别兜底。 */
export function buildStatusPrompt(appearances: string[], tags: string, chibi = true): string {
  const looks = appearances.map(t => t.trim()).filter(Boolean).join(', ');
  const body = tags.trim();
  const framing = body && !FRAMING_RE.test(body) ? 'upper body' : '';
  return [chibi ? CHIBI_STYLE_STRONG : '', looks, body, framing].filter(Boolean).join(', ');
}

/** 黑白漫出图词：正常比例，景别兜底 cowboy shot。 */
export function buildMangaPrompt(appearances: string[], tags: string): string {
  const looks = appearances.map(t => t.trim()).filter(Boolean).join(', ');
  const body = tags.trim();
  const framing = body && !MANGA_FRAMING_RE.test(body) ? 'cowboy shot' : '';
  return [looks, body, framing].filter(Boolean).join(', ');
}

/**
 * 黑白漫的 nl 前置一句「单格」。
 *
 * 每张卡片只画**一格**，但很多黑白漫方案的画师串是照「一页多格」写的
 * （multiple views / 4koma / comic page），公共接口又只能整套方案照用，
 * 结果一张卡片出一页四格、四张卡片全是重复的大头。nl 是我们能改的那一段，
 * 用自然语言把它压回单格。
 */
export function buildMangaNl(nl: string): string {
  const text = String(nl ?? '').trim();
  if (!text) return '';
  return `One single comic panel filling the whole frame, no panel borders. ${text}`;
}

/** 按 kind 分派出图 prompt。 */
export function buildTheaterImagePrompt(
  kind: StoryKind,
  appearances: string[],
  tags: string,
  chibi: boolean,
): string {
  return kind === 'manga'
    ? buildMangaPrompt(appearances, tags)
    : buildStatusPrompt(appearances, tags, chibi);
}
