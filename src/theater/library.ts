/**
 * 柏宝绘「角色固定外貌库」的读取与投影。
 *
 * 为什么要有这一层：柏宝绘自己出图时，外貌不是从名字查表来的，而是
 * **把整份角色库文本发进读剧情的 prompt**，让模型照抄字段、写进它自己的
 * characters[].tag（见 ST-BaiBai-Image/src/autoTag/charAnchors.ts 文件头）。
 * 我们之前只把「名字名单」发过去，模型看不到发色瞳色，于是：
 * - 正文写「Cecilia」、库里条目叫「Sissy」时，模型照抄正文叫法 → 查不到 → 没有外貌；
 * - 没有外貌时模型就自己编一个（白毛、棕发、随便谁），用户看到的就是「这人是谁」。
 *
 * 所以这里做两件事：
 * 1. 把角色库条目按柏宝绘同一套字段渲染成文本，塞进 system；
 * 2. 把「谁是谁」讲清楚（用户扮演谁 / 角色卡是谁 / 人设摘要），
 *    模型才有可能把正文里的称呼映射到库里的条目。
 */

import type { BaiBaiCharacter } from '../types';
import { getContext } from '../host/sillytavern';

type Fields = NonNullable<BaiBaiCharacter['fields']>;

/** 字段顺序与柏宝绘 CHAR_TAG_FIELDS / 标签一致，保证模型看到的形态和它自己一样。 */
const FIELD_LABELS: Array<[keyof Fields, string]> = [
  ['fandom', '同人身份'],
  ['sex', '性别'],
  ['hair', '头发'],
  ['eyes', '眼睛'],
  ['skin', '肤色'],
  ['body', '体型'],
  ['extra', '标志特征'],
  ['outfit', '固定着装'],
];

/** 单条角色 → 一行「名字: 字段=值, …」。字段全空时回落到 tag 整串。 */
export function formatLibraryEntry(entry: BaiBaiCharacter, locked = entry.scope === 'global'): string {
  const parts: string[] = [];
  const fields = entry.fields ?? {};
  for (const [key, label] of FIELD_LABELS) {
    const value = String(fields[key] ?? '').trim();
    if (value) parts.push(`${label}=${value}`);
  }
  if (!parts.length) {
    const tag = String(entry.tag ?? '').trim();
    if (tag) parts.push(`外貌=${tag}`);
  }
  const nl = String(entry.nl ?? '').trim();
  if (nl) parts.push(`外观句=${nl}`);
  return `- ${entry.name}${locked ? '［全局］' : ''}: ${parts.join(', ') || '(本条目没有数据，请到柏宝绘补全)'}`;
}

/**
 * 角色库文本（发给模型的那一段）。
 *
 * 空库返回空串——调用方据此不加任何「照抄库里的名字」要求，
 * 否则模型会被告知一个不存在的库、然后把名字改成别的。
 */
export function buildLibraryBlock(entries: BaiBaiCharacter[]): string {
  const usable = entries.filter(entry => String(entry.name ?? '').trim());
  if (!usable.length) return '';
  const lines = usable.map(entry => formatLibraryEntry(entry, entry.scope === 'global'));
  return [
    '【角色固定外貌库 · 来自柏宝绘，只读】',
    '以下名字是**唯一合法**的 characters[].name。正文里的称呼与这里不同（「你」「Cecilia」「那个金发男生」）时，',
    '先判断指的是库里哪一位，再照抄库里的名字；判不出来才用正文叫法。',
    '外貌（发色/瞳色/体型/标志特征/固定着装）由本库提供，**不要自己编**，也不要把外貌写进 tags。',
    ...lines,
  ].join('\n');
}

export interface CastContext {
  /** 用户扮演的人（ST 的 name1） */
  personaName: string;
  /** 角色卡名（ST 的 name2） */
  cardName: string;
  personaText: string;
  cardText: string;
}

function clip(text: string, limit: number): string {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/** 「谁是谁」：把用户人设与角色卡摘要给模型，正文里的「你」才不会丢。 */
export function buildCastBlock(ctx: CastContext): string {
  const lines: string[] = [];
  if (ctx.personaName) {
    lines.push(`- 用户扮演：${ctx.personaName}（正文里的「你」指的就是这一位，出图必须画成这个人）`);
  }
  if (ctx.cardName) {
    lines.push(`- 角色卡主角：${ctx.cardName}（正文里与他对话/互动的一方）`);
  }
  const persona = clip(ctx.personaText, 600);
  const card = clip(ctx.cardText, 600);
  if (persona) lines.push(`- 用户人设摘要：${persona}`);
  if (card) lines.push(`- 角色卡摘要：${card}`);
  if (!lines.length) return '';
  return ['【本聊天的人物对应】', ...lines].join('\n');
}

/** 读 ST 上下文里能用的人设/角色卡文本（取不到就是空串，不影响主流程）。 */
export function readCastContext(fallbackCardName = ''): CastContext {
  const ctx = getContext() as unknown as Record<string, unknown>;
  const personaName = String(ctx.name1 ?? '').trim();
  const cardName = String(ctx.name2 ?? fallbackCardName ?? '').trim();

  let personaText = '';
  try {
    const substitute = ctx.substituteParams;
    if (typeof substitute === 'function') {
      personaText = String((substitute as (v: string) => unknown).call(ctx, '{{persona}}') ?? '');
    }
  } catch {
    personaText = '';
  }
  if (!personaText) {
    const powerUser = (globalThis as Record<string, unknown>).power_user as
      | { persona_description?: unknown }
      | undefined;
    if (powerUser && typeof powerUser.persona_description === 'string') {
      personaText = powerUser.persona_description;
    }
  }

  let cardText = '';
  const characters = ctx.characters as Array<{ name?: string; data?: Record<string, unknown> }> | undefined;
  const characterId = typeof ctx.characterId === 'number' ? ctx.characterId : -1;
  const card = characters && characterId >= 0 ? characters[characterId] : undefined;
  const data = card?.data;
  if (data) {
    cardText = [data.description, data.personality]
      .filter((v): v is string => typeof v === 'string' && !!v.trim())
      .join(' / ');
  }

  return { personaName, cardName, personaText, cardText };
}

/** 名字归一：去空白/括号/标点，忽略大小写（与原 makeLookReader 同一把尺子）。 */
export function normalizeName(name: string): string {
  return String(name ?? '')
    .replace(/[\s（）()「」『』【】·.,，。:：!！?？~～]/g, '')
    .toLowerCase();
}
