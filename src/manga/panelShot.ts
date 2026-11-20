/**
 * ST-Story-Illustrator — 逐格出图词（纯函数）
 *
 * 一页 = N 张图，每张图就是一格。所以这里的 prompt 必须是**一幅完整插画**的词：
 * 人物 + 这一格的镜头 + 这一格的场景背景 —— 绝对不能带任何「页级构图」词
 * （koma / multiple views / split screen / white background / panel layout）。
 *
 * 之前整页一次出图时写 white background 想表达「框外留白」，NAI 的理解是
 * 「整张图不要背景」，于是框内也变成大白底、人物飘在白色上（用户实测）。逐格之后
 * 白底由页面的空白区域提供，图里永远保留自己的背景。
 */

import type { BaiBaiCharacter, ComicPagePlan, ComicPanelPlan } from '../types';
import type { BbiTagCharacter } from '../baibai/bbiTag';
import { characterPromptsFromLibrary, ensurePageCast, resolveCastNames } from './tagSplit';
import { declaredPeople } from './peopleCount';
import { appendOutfit, outfitOf, resolveOutfits } from '../baibai/outfit';
import type { CurrentOutfit } from '../baibai/outfit';
import { reconcileHeadcount } from './boardPrompt';
import { panelNlBody } from './pageCompose';
import type { PageSlot } from './pageSlots';

/** 页级构图词：逐格出图时必须全部剥掉，否则每一格都会被画成「一页多格」。 */
const PAGE_COMPOSITION = [
  /^\d+\s*koma$/i,
  /^multiple views$/i,
  /^split screen$/i,
  /^white background$/i,
  /^black background$/i,
  /^simple background$/i,
  /^close-up inset$/i,
  /^inset$/i,
  /^comic page layout$/i,
  /^panel layout$/i,
  /^comic panel$/i,
  /^comic page$/i,
  /^manga page$/i,
  /^manga$/i,
  /^comic$/i,
  /^asymmetric layout$/i,
  /^dynamic diagonal composition$/i,
  /^panels?$/i,
  /^gutter$/i,
  /^white margins?$/i,
  /^negative space$/i,
];

const PERSON = /^(?:\d+\s*(?:girl|boy|other)s?|\d+\s*people|couple|solo|multiple girls|multiple boys)$/i;

/** 纯物件格 / 环境细节格：这一格本来就不该有人，不能拿页级阵容去填。 */
const OBJECT_ONLY: ReadonlySet<string> = new Set(['object', 'environment_detail']);

function bare(segment: string): string {
  return segment.replace(/^\s*[\d.]+::/, '').replace(/^\s*::/, '').replace(/::\s*$/, '').trim();
}

/** 去掉权重外壳后判断这一段是不是页级构图词。 */
function isPageComposition(segment: string): boolean {
  const word = bare(segment).toLowerCase();
  return PAGE_COMPOSITION.some(re => re.test(word));
}

/** 逗号分段、剥页级构图词、按裸词去重。 */
export function cleanSceneTags(raw: string, options: { keepPeople?: boolean } = {}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of String(raw ?? '').split(',')) {
    const segment = piece.trim();
    if (!segment) continue;
    if (isPageComposition(segment)) continue;
    const word = bare(segment).toLowerCase();
    if (!word) continue;
    if (options.keepPeople !== true && PERSON.test(word)) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    out.push(segment);
  }
  return out;
}

/** 各格 nl 里常带「In the top strip / In the main illustration」这类页级指代，单格图里是噪声。 */
const AREA_CLAUSE = /\b(?:in|on)\s+the\s+[a-z\s-]{0,24}(?:panel|illustration|strip|inset|image)\b\s*[,:]?\s*/gi;

export function cleanPanelNl(panel: ComicPanelPlan): string {
  const body = panelNlBody(panel)
    .replace(AREA_CLAUSE, '')
    .replace(/\b(?:comic page|manga page|panel|panels|gutter|gutters|white background)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .trim();
  return body.replace(/^[,:;.\s]+/, '');
}

export interface PanelShot {
  panelIndex: number;
  /** 这一格自己的出图正向词（一幅完整插画） */
  prompt: string;
  /** 这一格的自然语言描述 */
  nl: string;
  /** 只属于这一格的人物块（外貌 + 着装） */
  characters: BbiTagCharacter[];
  slot: PageSlot;
  /** 这一格画的是谁（供显示层把台词对回格子） */
  cast: string[];
}

export interface PanelShotOptions {
  nativeCharacters?: boolean;
  personaName?: string;
  /** 用户划的那段原文：整页都没点名时，用它从正文里认人（与页级兜底同一套判据） */
  selectedText?: string;
}

/** 剥掉整页 tag 里与定妆重复的服装段：衣服已经在角色块里，Base 再写一遍就是两套。 */
function stripOutfitTags(
  tags: readonly string[],
  outfits: ReadonlyMap<string, CurrentOutfit>,
): string[] {
  if (!outfits.size) return [...tags];
  const owned = new Set<string>();
  for (const item of outfits.values()) {
    for (const piece of item.outfit.split(',')) {
      const key = bare(piece).toLowerCase();
      if (key) owned.add(key);
    }
  }
  return tags.filter(tag => !owned.has(bare(tag).toLowerCase()));
}

/**
 * 整页没有一格点名时的页面级阵容（与页级出图 `composePagePrompt` 同一套判据）。
 *
 * 为什么必须有：模型经常只把「谁在格子里」写进 `subject`（中文）而漏掉
 * `characters` 数组。页级出图有 `ensurePageCast` 兜底，逐格出图却没有——
 * 一旦漏写，每一格都建不出角色块，正向词里只剩 page.tags 的场景与衣服，
 * 柏宝绘的「角色（柏宝绘角色库）」整栏空着，NAI 只能自己编一张脸。
 */
export function resolvePageCast(
  page: ComicPagePlan,
  characters: readonly BaiBaiCharacter[],
  options: PanelShotOptions = {},
): string[] {
  const looks = new Map<string, string>();
  const picked = ensurePageCast(page, characters, options.selectedText ?? '', looks);
  if (!picked.length) return [];
  return resolveCastNames(picked, [...characters], {
    ...(options.personaName ? { personaName: options.personaName } : {}),
    declared: declaredPeople(String(page.tags ?? '')),
    max: 3,
    looks,
  }).cast;
}

/**
 * 一页 → N 个逐格出图请求。
 *
 * 每格的词 = 人数词（按本格角色块重算）+ 镜头 + 场景 + 本格道具/动作。
 * 场景会**保留**：每一格都该有自己的背景，这正是「框内为什么也没背景」的解法。
 */
export function buildPanelShots(
  page: ComicPagePlan,
  slots: readonly PageSlot[],
  characters: readonly BaiBaiCharacter[] = [],
  options: PanelShotOptions = {},
): PanelShot[] {
  const pageScene = cleanSceneTags(String(page.tags ?? ''));
  const outfitMap = resolveOutfits(page.outfits, options.personaName);
  const native = options.nativeCharacters !== false;

  const panels = page.panels ?? [];
  // ★ 整页一格都没点名 = 模型漏写 characters（不是「这一页没人」）。
  // 这种情况下每格都用页面级阵容兜底；纯物件格/环境细节格仍然留空。
  const pageHasCast = panels.some(panel =>
    (panel.characters ?? []).some(c => String(c.name ?? '').trim()),
  );
  const pageCast = pageHasCast ? [] : resolvePageCast(page, characters, options);

  return panels.map((panel, index) => {
    const slot = slots.find(s => s.panelIndex === index)
      ?? slots[Math.min(index, slots.length - 1)]
      ?? { panelIndex: index, x: 0, y: 0, width: 1, height: 1, border: 'thin' as const };

    // 本格的人：只取这一格写了的人，绝不把全页的人塞进每一格
    const rawNames = (panel.characters ?? [])
      .map(c => String(c.name ?? '').trim())
      .filter(Boolean);
    const looks = new Map<string, string>();
    const acts = new Map<string, string[]>();
    for (const c of panel.characters ?? []) {
      const name = String(c.name ?? '').trim();
      if (!name) continue;
      const look = String(c.look ?? '').trim();
      if (look) looks.set(name, look);
      const act = String(c.act ?? '').trim();
      if (act) acts.set(name, [act]);
    }
    const shotNames = rawNames.length
      ? rawNames
      : (OBJECT_ONLY.has(String(panel.composition ?? '')) ? [] : pageCast);
    const resolved = shotNames.length
      ? resolveCastNames(shotNames, [...characters], {
        ...(options.personaName ? { personaName: options.personaName } : {}),
        declared: shotNames.length,
        max: 3,
        looks,
        acts,
      })
      : { cast: [] as string[], acts: new Map<string, string[]>(), looks: new Map<string, string>() };

    const blocks: BbiTagCharacter[] = native
      ? characterPromptsFromLibrary(resolved.cast, [...characters], resolved.acts, resolved.looks)
      : [];

    // 着装：同一批定妆按名字冻结，谁都不会在某一格换衣服
    const dressed = blocks.map(block => {
      const outfit = outfitOf(block.name, outfitMap, [...characters], options.personaName);
      if (!outfit) return block;
      const tag = appendOutfit(block.tag, outfit);
      return tag === block.tag ? block : { ...block, tag };
    });

    // 本格道具/动作词（模型给 panel.tags 时才用）
    const panelTags = cleanSceneTags(String(panel.tags ?? ''));
    const shot = String(panel.shot ?? '').trim();
    // 服装已在角色块里：整页 tag 里再写一遍就是「同一套衣服说两次」，
    // 两个角色时会糊成两套衣服交叉（模型偶尔会违反规则把服装写进 page.tags）。
    const scene = dressed.length ? stripOutfitTags(pageScene, outfitMap) : pageScene;

    // 本格人数词：从角色库条目的 tag / fields.sex 取性别，而不是从角色块里扒。
    // 角色块由 fields 拼装（sex/hair/eyes/... 有字段时只输出字段），
    // 直接拿块去数性别会数出 0 个人，Base 就没有人数词了。
    const genderOf = (name: string): string => {
      const entry = characters.find(c => String(c.name ?? '').trim() === name);
      const sex = String(entry?.fields?.sex ?? '').trim();
      if (/^\d*\s*(?:girl|boy|other)/i.test(sex)) return sex;
      const m = String(entry?.tag ?? '').match(/\b(\d+)\s*(girl|boy|other)\b/i);
      return m ? `${m[1]}${m[2]}` : '';
    };
    const genderTags = resolved.cast.map(genderOf).filter(Boolean);

    const segments: string[] = [];
    const seen = new Set<string>();
    const push = (value: string): void => {
      const text = String(value ?? '').trim();
      if (!text) return;
      const key = bare(text).toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      segments.push(text);
    };

    // 人数词放最前（权重最高）；没有角色块时不要凭空写人数
    if (dressed.length && genderTags.length) {
      push(reconcileHeadcount('', genderTags));
    }
    if (shot) push(shot);
    for (const tag of panelTags) push(tag);
    for (const tag of scene) push(tag);

    let prompt = segments.join(', ');
    // 没有原生角色块时，外貌与着装只能并进 Base（老后端兼容路径）
    if (!dressed.length) {
      const fallback = [...outfitMap.values()].map(item => item.outfit);
      if (fallback.length) {
        const lower = prompt.toLowerCase();
        const extra = fallback.filter(o => !lower.includes(o.toLowerCase()));
        prompt = [prompt, ...extra].filter(Boolean).join(', ');
      }
    }

    return {
      panelIndex: index,
      prompt,
      nl: cleanPanelNl(panel),
      characters: dressed,
      slot,
      cast: resolved.cast,
    };
  });
}

/** 一格都没有内容时的兜底：整页退化成单格。 */
export function fallbackShot(page: ComicPagePlan, slot: PageSlot, characters: readonly BaiBaiCharacter[] = []): PanelShot[] {
  return buildPanelShots(
    { ...page, panels: page.panels?.length ? page.panels : [{} as ComicPanelPlan] },
    [slot],
    characters,
  );
}
