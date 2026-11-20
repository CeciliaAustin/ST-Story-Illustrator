/**
 * 服装一致性的「定妆」链路（与柏宝绘 / 柏宝书同名机制对齐）
 *
 * 为什么单独一层：服装漂移的根因不是模型记性差，而是**没人把「此刻穿什么」交到
 * NAI 手上**。柏宝绘的做法是三段式：
 *   1) 柏宝书给当前着装（中文原文，随剧情换衣）；
 *   2) 写 tag 的模型把它翻成**英文 danbooru 短语**，一批里每人定一次；
 *   3) 代码把这串词**逐字**拼进每个角色块 —— 每格每页都是同一串，漂不了。
 * 小剧场（theater）早就有第 2/3 步（cast[].outfit），所以小剧场一直是准的；
 * 正文插画和漫画以前只有第 1 步（把角色参考当文本发给模型看），模板还禁止写服装，
 * 于是角色块里一件衣服都没有 —— 用户看到的就是「跟柏宝绘穿的不一样」。
 *
 * 本模块提供这三步里的纯函数，供三条出图链路共用：
 * - buildOutfitBlock：把「当前着装」原文 + 角色库固定着装拼成给模型的定妆指令块；
 * - resolveOutfits：模型交回的 cast[].outfit → 按名字归一化的英文定妆表
 *   （别名「你 / 他 / 人设名」都并到同一人；中文串丢弃，绝不进 NAI）；
 * - outfitOf：按名字取定妆，取不到回落角色库 fields.outfit，仍取不到返回空。
 */

import type { BaiBaiCharacter } from '../types';

/** 中文 / 日韩字符：英文 tag 里出现这些就说明模型没翻译，整条丢弃。 */
const HAS_CJK = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/;
const MAX_OUTFIT_CHARS = 200;

export interface CurrentOutfit {
  name: string;
  outfit: string;
}

function normalizeName(value: string): string {
  return String(value ?? '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[（(【\[].*?[)）】\]]/g, '')
    .toLowerCase();
}

function firstLine(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 人设别名 → 同一个键：正文里「你 / User / 人设名」指的是同一个人，
 * 定妆只允许一套。这里把常见别名并到人设名上；没有明确人设名时，
 * 用「主角」这个占位键把别名串在一起，仍比两套衣服强。
 */
export function outfitNameKey(name: string, personaName = ''): string {
  const clean = normalizeName(name);
  const persona = normalizeName(personaName);
  if (persona && (clean === persona || /^(你|您|我|你们|我们|you|i|me|us|user|主角|protagonist)$/i.test(clean))) {
    return persona;
  }
  return clean;
}

/**
 * 服装串里混进来的人数词一律剥掉。
 *
 * 模型写 `cast[].outfit` 时常把主语也带上（`1girl, white shearling coat, ...`），
 * 拼进角色块后就是「角色块说自己 1girl、Base 也说自己 1girl」；若这条落到
 * Base 的兜底路径，更会变成「1girl 后面跟着一整串衣服、另一个 1boy 跟在后面」——
 * 用户看到的正向词就长这样，一个外貌都没有。
 * 人数与性别由人数词负责，不属于服装。
 */
const PEOPLE_TAG = /^(?:\d+\s*(?:girl|boy|other)s?|\d+\s*people|couple|solo|multiple girls|multiple boys)$/i;

function cleanOutfit(raw: string): string {
  return String(raw ?? '')
    .split(',')
    .map(x => x.trim())
    .filter(x => x && !PEOPLE_TAG.test(x))
    .join(', ');
}

/** 从角色库取某人的固定着装（英文 tag；中文固定着装不进 NAI）。 */
export function libraryOutfitOf(name: string, library: readonly BaiBaiCharacter[]): string {
  const key = normalizeName(name);
  const hit = library.find(c => {
    const n = normalizeName(c.name);
    return n === key || (key.length >= 2 && (n.includes(key) || key.includes(n)));
  });
  const outfit = cleanOutfit(firstLine(hit?.fields?.outfit ?? ''));
  return outfit && !HAS_CJK.test(outfit) ? outfit.slice(0, MAX_OUTFIT_CHARS) : '';
}

/**
 * 把写 tag 模型交回的 `cast[].outfit` / `outfits` 解析成英文定妆表。
 * 兼容三种常见写法：数组 [{name,outfit}]、对象 {name: outfit}、单条 {name,outfit}。
 * 中文串整条丢掉（让调用方回落到角色库固定着装），绝不送进 NAI。
 */
export function resolveOutfits(raw: unknown, personaName = ''): Map<string, CurrentOutfit> {
  const out = new Map<string, CurrentOutfit>();
  if (!raw) return out;
  const push = (rawName: unknown, rawOutfit: unknown): void => {
    const name = firstLine(typeof rawName === 'string' ? rawName : '');
    let outfit = cleanOutfit(firstLine(typeof rawOutfit === 'string' ? rawOutfit : ''));
    if (!name || !outfit || HAS_CJK.test(outfit)) return;
    if (outfit.length > MAX_OUTFIT_CHARS) outfit = outfit.slice(0, MAX_OUTFIT_CHARS);
    const key = outfitNameKey(name, personaName);
    if (!key || out.has(key)) return;
    out.set(key, { name, outfit });
  };

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      push(rec.name, rec.outfit ?? rec.current ?? rec.clothing);
    }
  } else if (typeof raw === 'object') {
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const rec = value as Record<string, unknown>;
        push(rec.name ?? name, rec.outfit ?? rec.current ?? rec.clothing);
      } else {
        push(name, value);
      }
    }
  }
  return out;
}

function bareTag(value: string): string {
  return String(value ?? '')
    .replace(/^\s*[\d.]+\s*::/, '')
    .replace(/^\s*::/, '')
    .replace(/::\s*$/, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * 把一套定妆逐条拼进角色 tag，已存在的条不重复。
 *
 * 为什么按逗号逐条比：库里固定着装和模型定妆经常是同一串，只是被拆成
 * `light apricot dress` + `beige cardigan` 两个 tag；整串比较会误判成「没写过」，
 * 再拼一遍就成两套。按裸词逐条比才不会重复。
 */
export function appendOutfit(tag: string, outfit: string): string {
  const base = String(tag ?? '').trim();
  const pieces = cleanOutfit(outfit)
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
  if (!base) return pieces.join(', ');
  if (!pieces.length) return base;
  const seen = new Set(base.split(',').map(bareTag).filter(Boolean));
  const fresh = pieces.filter(piece => {
    const key = bareTag(piece);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return fresh.length ? `${base}, ${fresh.join(', ')}` : base;
}

/** 按名字取定妆：先查模型定妆表，再回落角色库固定着装。取不到返回空串。 */
export function outfitOf(
  name: string,
  resolved: ReadonlyMap<string, CurrentOutfit>,
  library: readonly BaiBaiCharacter[] = [],
  personaName = '',
): string {
  const key = outfitNameKey(name, personaName);
  return resolved.get(key)?.outfit ?? libraryOutfitOf(name, library);
}

export interface OutfitBlockInput {
  /** 柏宝书的当前着装原文（可能中文） */
  bookOutfits?: ReadonlyArray<{ name: string; outfit: string }>;
  /** 柏宝绘角色库（固定着装兜底） */
  library?: readonly BaiBaiCharacter[];
  /** 本批出场角色名；只在书里没有时用库里固定着装补 */
  cast?: readonly string[];
  personaName?: string;
}

/**
 * 给写 tag 模型的「定妆指令块」。放在 user 消息最前面（与柏宝绘角色参考同位置），
 * 要求模型：把这套衣服翻成英文 tag，每人**一批只定一次**，逐字复用到每一格 / 每一页。
 * 这样模型不必靠记性，代码再兜一层硬约束（resolveOutfits + outfitOf）。
 */
export function buildOutfitBlock(input: OutfitBlockInput): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  const push = (name: string, value: string): void => {
    const n = firstLine(name);
    const v = firstLine(value);
    if (!n || !v) return;
    const key = normalizeName(n);
    if (seen.has(key)) return;
    seen.add(key);
    lines.push(`- ${n}: ${v}`);
  };

  for (const item of input.bookOutfits ?? []) push(item.name, item.outfit);
  // 书里没记的人，用角色库「固定着装」补（也是当前最可靠的英文出处）
  for (const name of input.cast ?? []) {
    const fixed = libraryOutfitOf(name, input.library ?? []);
    if (fixed && !seen.has(normalizeName(name))) push(name, fixed);
  }

  if (!lines.length) return '';
  return [
    '【本批定妆（柏宝书当前着装 / 角色库固定着装，必须遵守）】',
    '下面这些人这一批里穿的就是这些衣服。把它们逐字翻成英文 danbooru 短语（版型 + 主色 + 关键部件），',
    '写进 cast[].outfit；同一批的每一格 / 每一页必须用**完全相同**的那一串，不许改写、不许缺、不许按格子再换一套。',
    '固定外貌（发色 / 瞳色 / 体型）仍然只由角色库提供，不要写进 outfit。',
    lines.join('\n'),
  ].join('\n');
}
