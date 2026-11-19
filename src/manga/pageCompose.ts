/**
 * 漫画页提示词组装（纯函数）
 *
 * 关键口径：**一张图 = 一页漫画**。整页共用一套 tag，各格只通过 nl 分区描述 —
 * 这是《漫画分镜与对白气泡》文档里唯一被验证过的做法（构图词 + multiple views/split screen
 * 让 NAI 一次画出多格版面）。按格各出一张图，出来永远是一堆单幅插画，不是漫画。
 */

import type { BaiBaiCharacter, ComicDialogue, ComicPagePlan, PanelLayout } from '../types';
import { mergeCharacterTags } from './panelRelevance';
import { characterPromptsFromLibrary, ensurePageCast } from './tagSplit';
import type { BbiTagCharacter } from '../baibai/bbiTag';

/** 四档版面的总述句（与 enforcePanelPrompt 的档位同义，供 nl 兜底用）。 */
export const LAYOUT_NL_HEAD: Record<PanelLayout, string> = {
  regular:
    'A two-panel comic page: one canvas split horizontally by a thin black border, read from top to bottom.',
  irregular:
    'An irregular comic page: unequally sized panels separated by thin black gutters, read from top to bottom.',
  inset:
    'A manga page on a white background: an unframed character illustration in the center with narrow white margins, plus one or two small close-up panels with thin black borders.',
  unframed:
    'A manga page on a white background: the main unframed illustration fills the page with narrow white margins, plus narrow close-up panels with thin black borders.',
};

/**
 * 规整档按实际格数换首句。
 *
 * 旧版不管模型给几格，都写死 "A two-panel comic page"——三格四格的内容
 * 被这句话按回两格，第三、四段就只能挤进第二格。这就是「切页乱了」。
 */
export function layoutNlHead(layout: PanelLayout, count: number): string {
  if (layout !== 'regular' || count < 3) return LAYOUT_NL_HEAD[layout] ?? LAYOUT_NL_HEAD.regular;
  if (count >= 4) {
    return 'A four-panel comic page in a two-by-two grid, separated by thin black gutters, read from top to bottom, left to right.';
  }
  return 'A three-panel comic page: one wide panel across the top and two smaller panels side by side below, separated by thin black gutters, read from top to bottom.';
}

/** 各档的「在哪一格」引导词，按顺序取，超出就沿用最后一种。 */
const AREA_LEAD: Record<PanelLayout, string[]> = {
  regular: ['In the upper panel', 'The lower panel shows', 'In the third panel', 'The bottom panel shows'],
  irregular: ['In the large panel', 'In the narrow panel', 'In the small panel', 'In the bottom strip'],
  inset: ['In the main illustration', 'In the top strip', 'In the small framed panel', 'In the side panel'],
  unframed: ['In the main illustration', 'In the top strip', 'In the small framed panel', 'In the side panel'],
};

/** 去掉权重写法后的裸词，用于判重。 */
function bareTag(segment: string): string {
  return segment.replace(/^\s*[\d.]+::/, '').replace(/^\s*::/, '').replace(/::\s*$/, '').trim().toLowerCase();
}

/** 把各格 tag 合并成整页一套（裸词判重，保留第一次出现的写法）。 */
export function mergePanelTags(page: ComicPagePlan): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const panel of page.panels ?? []) {
    for (const raw of String(panel.tags ?? '').split(',')) {
      const piece = raw.trim();
      if (!piece) continue;
      const key = bareTag(piece);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(piece);
    }
  }
  return out.join(', ');
}

/** 用各格的 nl 拼出整页的分区描述（模型没写 page.nl 时兜底）。 */
export function buildPageNl(page: ComicPagePlan): string {
  const head = layoutNlHead(page.layout, page.panels?.length ?? 0);
  const leads = AREA_LEAD[page.layout] ?? AREA_LEAD.regular;
  const parts: string[] = [head];

  let wrote = false;
  page.panels?.forEach((panel, index) => {
    const body = String(panel.nl ?? '').trim();
    if (!body) return;
    const lead = leads[Math.min(index, leads.length - 1)];
    parts.push(lead.endsWith('shows') ? `${lead} ${body}` : `${lead}, ${body}`);
    wrote = true;
  });

  if (!wrote) {
    const titles = (page.panels ?? []).map(p => p.title).filter(Boolean);
    if (titles.length > 0) parts.push(`The panels in reading order: ${titles.join(' / ')}.`);
  }
  return parts.join(' ');
}

/** 整页台词：页级优先，没有就从各格合并（上限 4 条由解析层保证）。 */
export function collectPageDialogue(page: ComicPagePlan): ComicDialogue[] {
  if (page.dialogue && page.dialogue.length > 0) return page.dialogue;
  const out: ComicDialogue[] = [];
  const panels = page.panels ?? [];
  for (let i = 0; i < panels.length; i += 1) {
    for (const item of panels[i].dialogue ?? []) {
      if (out.length >= 4) return out;
      // 从某一格自己的 dialogue 里捞出来的台词，天然知道自己在第几格——
      // 这是合成气泡时最可靠的位置线索，模型漏写 panel 时靠它补齐。
      out.push(item.panel ? item : { ...item, panel: i + 1 });
    }
  }
  return out;
}

export interface ComposedPage {
  prompt: string;
  nl: string;
  dialogue: ComicDialogue[];
  /** 各格短标题，印在卡片上（不是出图词） */
  panelTitles: string[];
  /** 每个可见角色自己的提示词（NAI 原生 Character Prompts 通道） */
  characters: BbiTagCharacter[];
}

/**
 * 一页 → 一次出图请求。
 *
 * - prompt：页级 tags（没有就合并各格），**不再往里塞角色外貌**
 * - characters：画面里出现过的角色，各自一条（外貌/固定着装来自角色库）
 * - nl：页级 nl（没有就按档位 + 各格 nl 拼）
 * - dialogue：页级台词（没有就取各格的）
 *
 * 为什么外貌要拆出去：柏宝绘的规范里 Base 只写人数、场景、构图、光线、共享互动，
 * 「某个人的头发/衣服」必须写进他自己那一块。以前 mergeCharacterTags 把两个人
 * 的发色、两套衣服全并进 Base —— 漫画页上人物越多越糊，正是用户看到的
 * 「角色（柏宝绘角色库）这次没有带上任何角色外貌」+ Base 里却全是外貌词。
 */
export function composePagePrompt(
  page: ComicPagePlan,
  characters: BaiBaiCharacter[] = [],
  options: { nativeCharacters?: boolean; selectedText?: string } = {},
): ComposedPage {
  const base = String(page.tags ?? '').trim() || mergePanelTags(page);
  const names: string[] = [];
  // 各格写了「这个人在做什么」：它属于这个人自己的角色块，不能丢，也不能进 Base
  const acts = new Map<string, string[]>();
  for (const panel of page.panels ?? []) {
    for (const c of panel.characters ?? []) {
      if (!c?.name) continue;
      if (!names.includes(c.name)) names.push(c.name);
      const act = String(c.act ?? '').trim();
      if (act) {
        const list = acts.get(c.name) ?? [];
        if (!list.includes(act)) list.push(act);
        acts.set(c.name, list);
      }
    }
  }

  // 模型漏写 panels[].characters 时补人：否则角色块空着，外貌只能并回 Base
  //（= 「两套衣服糊在一个提示词里」的老毛病）
  //
  // 模型写了的名字**不裁**：裁掉的那个人会连外貌一起消失，比多一块提示词糟得多。
  // 只有「代码自己补」时才按协议上限（2 人）收着补，免得把库里的路人甲乙也塞进画面。
  const cast = names.length
    ? names.slice(0, 6)
    : ensurePageCast(page, characters, options.selectedText ?? '');
  const native = options.nativeCharacters !== false;
  const characterPrompts = native
    ? characterPromptsFromLibrary(cast, characters, acts)
    : [];
  // 拆得出来就拆；拆不出来（角色库空 / 名字对不上）退回老口径，至少别丢外貌词
  const prompt = characterPrompts.length ? base : mergeCharacterTags(base, cast, characters);
  const nl = String(page.nl ?? '').trim() || buildPageNl(page);

  return {
    prompt,
    nl,
    dialogue: collectPageDialogue(page),
    panelTitles: (page.panels ?? []).map(p => p.title).filter(Boolean),
    characters: characterPrompts,
  };
}
