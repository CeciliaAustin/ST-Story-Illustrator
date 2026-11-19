/**
 * Base 与「角色块」的拆分（对应柏宝绘 NAI 4.5/V5 的 Base + Character Prompts）
 *
 * 为什么必须拆：
 * - 柏宝绘的规范写死了分工——Base 只写人数、场景、构图、光线、共享互动；
 *   **某个人的外貌、服装、表情、动作只能写进他自己那一块**（`<characters>`）。
 * - 我们之前把所有段拼成一串塞进 Base，于是 NAI 拿到的是
 *   「1girl, 1boy, medium shoulder-length wavy brown hair, ... white blouse, white shirt, khaki cargo pants ...」
 *   ——两套衣服、两套头发全糊在一个提示词里，模型只能随机分配给两个人。用户看到的
 *   「人物/服装不像」有一半来自这里。
 * - 拆开之后外貌走 NAI 原生 char_captions 通道，Base 干净，才谈得上一致性。
 */

import type { BaiBaiCharacter, ComicPagePlan, TagSegment } from '../types';
import { composeEnglishPrompt } from '../prompt/compose';
import type { BbiTagCharacter } from '../baibai/bbiTag';

export interface SplitPrompt {
  /** Base：只放全局内容 */
  base: string;
  /** 每个可见角色自己的提示词 */
  characters: BbiTagCharacter[];
  /** 模型只写了角色段、Base 为空：调用方应退回「全并进 Base」的老口径 */
  fallback: boolean;
}

/** 是否像英文 tag（含拉丁字母、不含中日韩字符）。中文外貌句不能直接进 NAI 提示词。 */
function looksEnglish(text: string): boolean {
  return /[A-Za-z]/.test(text) && !/[\u3040-\u30ff\u3400-\u9fff]/.test(text);
}

/** 角色库条目 → 一条 character tag（分字段优先，字段全空才用整串）。 */
export function characterTagOf(entry: BaiBaiCharacter): string {
  const fields = entry.fields ?? {};
  const order: Array<keyof typeof fields> = ['sex', 'hair', 'eyes', 'skin', 'body', 'extra', 'outfit'];
  const parts = order
    .map(key => String(fields[key] ?? '').trim())
    .filter(Boolean);
  if (parts.length) return parts.join(', ');

  const raw = String(entry.tag ?? '').trim();
  if (raw) return raw;

  // 库里有条目但字段全空——这是最常见的情况（条目是柏宝书/手动加的，还没填外貌）。
  // 以前这里直接 return ''，等于把这个人从画面里删掉。现在回落到条目描述，
  // 只要是英文就还能当外貌用；中文描述留给模型自己翻（它看得到库块里的原文）。
  for (const candidate of [String(entry.desc ?? '').trim(), String(entry.nl ?? '').trim()]) {
    if (candidate && looksEnglish(candidate)) return candidate;
  }
  return '';
}

/**
 * 名字 → character 提示词。
 *
 * 顺序按传入的 names（调用方按画面里的出现顺序给），重复名字合并；
 * 名字必须是**逐字**匹配（柏宝绘的角色库就是这么认人的）。
 */
export function characterPromptsFromLibrary(
  names: readonly string[],
  library: readonly BaiBaiCharacter[],
  /** 名字 → 这个人在本图里的动作（English danbooru 短语），拼在外貌后面 */
  acts?: ReadonlyMap<string, readonly string[]>,
): BbiTagCharacter[] {
  const byName = new Map(library.map(entry => [entry.name, entry]));
  const seen = new Set<string>();
  const out: BbiTagCharacter[] = [];
  for (const raw of names) {
    const name = String(raw ?? '').trim();
    if (!name || seen.has(name)) continue;
    const entry = byName.get(name);
    if (!entry) continue;
    const appearance = characterTagOf(entry);
    if (!appearance) continue;
    // 动作也归这个人的角色块：Base 只留共享互动，个人动作不能写进 Base
    const extra = (acts?.get(name) ?? []).map(a => String(a ?? '').trim()).filter(Boolean);
    const tag = [appearance, ...extra].join(', ');
    seen.add(name);
    const nl = String(entry.nl ?? '').trim();
    out.push({ name, tag, ...(nl ? { nl } : {}) });
    if (out.length >= 32) break;
  }
  return out;
}

/**
 * 漫画页的「谁在这张图上」——模型漏写 `panels[].characters` 时的确定性兜底。
 *
 * 为什么必须有：`composePagePrompt` 只从 `panels[].characters[].name` 取名字，
 * 模型那次只写了 page.tags（「1girl, 1boy, sitting across from each other」）
 * 而没写 characters 时，角色块就是空的 → 退回「外貌全并进 Base」的老口径，
 * 用户看到的正是「两个人两套衣服糊在一个提示词里 + 角色（柏宝绘角色库）没带上外貌」。
 *
 * 判据与插画的 ensureCharacterSegments 同一套：
 * 1. 模型写了的名字照用（能对上库的优先，上限 2 人，与协议一致）；
 * 2. 不够就补：先补「本页 tag / 各格 tag / 选段正文」里出现过名字的人；
 * 3. 还空且库里只有 ≤2 人（这种库基本就是单人/双人固定阵容）→ 全补。
 * 补进来的人 act 为空即可——外貌照样能从库里取到，缺的只是这一格的动作。
 */
export function ensurePageCast(
  page: ComicPagePlan,
  library: readonly BaiBaiCharacter[],
  selectedText = '',
): string[] {
  const usable = library.filter(c => String(c.name ?? '').trim() && characterTagOf(c));
  if (!usable.length) return [];

  const usableByName = new Map(usable.map(c => [String(c.name).trim(), c]));
  const picked: string[] = [];
  const add = (name: string): void => {
    const clean = String(name ?? '').trim();
    if (!clean || picked.includes(clean) || picked.length >= 2) return;
    if (!usableByName.has(clean)) return;
    picked.push(clean);
  };

  // 模型写的名字：先照抄（顺序就是画面里的主次）
  for (const panel of page.panels ?? []) {
    for (const c of panel.characters ?? []) add(c?.name ?? '');
  }

  if (picked.length >= 2) return picked;

  // 本页文本：page.tags + 各格 tags/标题 + 选段正文，按出现位置判在场
  const pageText = [
    page.tags ?? '',
    ...(page.panels ?? []).map(p => `${p.tags ?? ''} ${p.title ?? ''} ${p.nl ?? ''}`),
    selectedText,
  ].join(' ');
  const mentioned = usable
    .map(c => String(c.name).trim())
    .filter(name => !picked.includes(name) && pageText.includes(name));
  mentioned.forEach(add);
  if (picked.length || usable.length > 2) return picked;

  // 库里只有一两个人（固定阵容）→ 全补，否则这页一个人都没有外貌
  usable.forEach(c => add(String(c.name)));
  return picked;
}

/**
 * 插画的段 → Base + characters。
 *
 * `native` = 这台后端支持原生 Character Prompts（NAI 4.5/V5）。
 * 不支持时（NAI4 / ComfyUI）保持老口径：全并进 Base，否则外貌会整个丢失。
 */
export function splitSegments(segments: readonly TagSegment[], native: boolean): SplitPrompt {
  const all = [...segments];
  if (!native) {
    return { base: composeEnglishPrompt(all), characters: [], fallback: false };
  }

  const characterSegs = all.filter(seg => seg.source === 'character' && !!String(seg.characterName ?? '').trim());
  const baseSegs = all.filter(seg => !characterSegs.includes(seg));
  const base = composeEnglishPrompt(baseSegs);

  const byName = new Map<string, string[]>();
  for (const seg of characterSegs) {
    const name = String(seg.characterName ?? '').trim();
    const list = byName.get(name) ?? [];
    list.push(...seg.english);
    byName.set(name, list);
  }
  const characters: BbiTagCharacter[] = [];
  for (const [name, tags] of byName) {
    // 同一个人的多个 character 段合并成一条，裸词去重（权重写法保留）
    const seen = new Set<string>();
    const kept: string[] = [];
    for (const raw of tags) {
      const piece = raw.trim();
      if (!piece) continue;
      const bare = piece
        .replace(/^\s*[\d.]+\s*::/, '')
        .replace(/^\s*::/, '')
        .replace(/::\s*$/, '')
        .trim()
        .toLowerCase();
      if (bare && seen.has(bare)) continue;
      if (bare) seen.add(bare);
      kept.push(piece);
    }
    if (kept.length) characters.push({ name, tag: kept.join(', ') });
  }

  // 模型把动作/场景全写进了角色段、Base 空着：这时候拆开等于没有 Base，
  // 退回合并不丢内容（外貌会重复，但比空 Base 出图强）。
  if (!base.trim() || characters.length === 0) {
    return { base: composeEnglishPrompt(all), characters: [], fallback: true };
  }
  return { base, characters, fallback: false };
}
