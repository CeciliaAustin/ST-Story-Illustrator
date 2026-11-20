/**
 * 漫画页提示词组装（纯函数）
 *
 * 关键口径：**一张图 = 一页漫画**。整页共用一套 tag，各格只通过 nl 分区描述 —
 * 这是《漫画分镜与对白气泡》文档里唯一被验证过的做法（构图词 + multiple views/split screen
 * 让 NAI 一次画出多格版面）。按格各出一张图，出来永远是一堆单幅插画，不是漫画。
 */

import type { BaiBaiCharacter, ComicDialogue, ComicPagePlan, ComicPanelPlan, PanelLayout } from '../types';
import { mergeCharacterTags } from './panelRelevance';
import { characterPromptsFromLibrary, ensurePageCast, resolveCastNames } from './tagSplit';
import { declaredPeople } from './peopleCount';
import { appendOutfit, outfitOf, resolveOutfits } from '../baibai/outfit';
import type { BbiTagCharacter } from '../baibai/bbiTag';
import {
  boardAreaLeads,
  boardNlHead,
  reconcileHeadcount,
  UNFRAMED_CLOSER,
  type BoardLayout,
  type BoardPageType,
} from './boardPrompt';

/** 四档版面的总述句（与 boardPrompt 的档位同义，供旧路径兜底用）。 */
export const LAYOUT_NL_HEAD: Record<PanelLayout, string> = {
  regular:
    'A two-panel comic page: one canvas split horizontally by a thin black border, read from top to bottom.',
  irregular:
    'An irregular comic page: unequally sized panels separated by thin black gutters, read from top to bottom.',
  // 白底档的留白是"四周大量留白"，不是 narrow margins——写反了模型就把人物撑满整页
  inset:
    'A manga page on a white background: a single unframed character illustration in the center with generous empty white space around it, plus small close-up panels with thin black borders.',
  unframed:
    'A manga page on a white background: the main unframed illustration fills the page, plus narrow close-up panels with thin black borders.',
};

/**
 * 「留白长什么样」的收束句。
 *
 * 用户点名过的问题：「原来的分镜还有那种空白的地方，为什么现在没有了」。
 * 版面首句只说了「有白底」，模型可以把它理解成一整张白底大图就完事；
 * 必须把**格间 gutter / 小格与主画之间的宽白边**写成一句具体的画面要求，
 * 它才会真的把空白留在那里。
 */
export const LAYOUT_GAP_NOTE: Record<PanelLayout, string> = {
  regular:
    'One panel is the main hero image and the others are smaller; leave at least one area of clean empty negative space (white or black per the page tone), and do not force every panel to the same size or push them all to the page edges.',
  irregular:
    'One large hero panel dominates and the smaller panels are unequal in size and float around it; keep generous empty negative space between the hero and the small panels and along the page margins — let the composition breathe instead of filling every corner.',
  inset:
    'The bordered close-up panels float on the page with a wide, completely empty gap between them and the main illustration (at least 5% of the page height); they never touch the characters or each other, and the empty space stays empty.',
  unframed:
    'Only the small inset panels have thin black borders, each floating on clean negative space with a wide empty margin; the main illustration has no frame at all, and its surrounding empty space stays clean and uncluttered.',
};

/** 单格的画面内容：模型给了 nl 就用它，没有就用 shot + 动作拼一句。 */
export function panelNlBody(panel: ComicPanelPlan): string {
  const nl = String(panel.nl ?? '').trim();
  const shot = String(panel.shot ?? '').trim();
  // 只拼英文：nl 是直接进 NAI 的自然语言通道，中文写进去等于噪声。
  // subject / title 是中文辅助信息（给模型自己组织 nl 用），不能进 nl。
  const acts = (panel.characters ?? [])
    .map(c => [String(c.name ?? '').trim(), String(c.act ?? '').trim()].filter(Boolean).join(' '))
    .filter(Boolean)
    .join('; ');
  if (nl) {
    // 模型写的 nl 里常忘了镜头距离（写一句「两人在桌边」，两个格就长得一样）。
    // shot 是独立字段，补在最前面不会重复。
    if (shot && !nl.toLowerCase().includes(shot.toLowerCase())) return `${shot}: ${nl}`;
    return nl;
  }
  if (acts) return shot ? `${shot}: ${acts}` : acts;
  // 连动作都没有：至少把景别写出来，别让空格和上一格共用一套描述
  return shot;
}


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
    const body = panelNlBody(panel);
    if (!body) return;
    const lead = leads[Math.min(index, leads.length - 1)];
    parts.push(lead.endsWith('shows') ? `${lead} ${body}` : `${lead}, ${body}`);
    wrote = true;
  });

  // 留白/格间必须单独成句：只靠版面首句，模型会画成「一整张大图」
  parts.push(LAYOUT_GAP_NOTE[page.layout] ?? LAYOUT_GAP_NOTE.regular);

  if (!wrote) {
    // 一格都没写出内容：给一句中性的提示。必须是「同一瞬间的不同镜头」，
    // 绝不能像旧句那样写 different moment——那直接违任务书 §1，模型据此跳时拼盘。
    parts.push('All panels capture the same continuous instant from different camera angles and shot distances — a main view plus close details of the same moment — with generous empty negative space left on the page.');
  }
  return parts.length ? `${parts.join('. ')}.` : '';
}

/**
 * 只取「各格画面内容」的 nl，不带旧四档的版面首句与留白收束句。
 *
 * 新版面系统出图时，版面骨架句由 stylePrompt.styleLayoutNl 统一生成
 * （风格/格数/留白直接驱动），这里只负责把每一格自己的镜头内容按阅读顺序拼出来。
 * 若沿用 buildPageNl，旧档的 "one or two small panels" / "narrow margins"
 * 会和新骨架句并存、互相打架——这正是实测 B/C 只出一格的词层根因之一。
 */
export function panelNlContentOnly(
  page: ComicPagePlan,
  board?: { layout: BoardLayout; pageType: BoardPageType; panelCount: number },
): string {
  const leads = board
    ? boardAreaLeads(board.layout, board.pageType, page.panels?.length || board.panelCount)
    : (AREA_LEAD[page.layout] ?? AREA_LEAD.regular);
  const parts: string[] = [];
  page.panels?.forEach((panel, index) => {
    const body = panelNlBody(panel);
    if (!body) return;
    const lead = leads[Math.min(index, leads.length - 1)];
    parts.push(lead.endsWith('shows') ? `${lead} ${body}` : `${lead}, ${body}`);
  });
  // 各格之间要有句号：整段是"一句话到底"时，模型容易只挑其中一格画。
  return parts.length ? `${parts.join('. ')}.` : '';
}

/** 一页必须是「同一个连续瞬间」：这是本插件与"拼盘式多格"的分界线。 */
export const CONTINUOUS_INSTANT_NOTE =
  'All panels capture the same continuous instant from different camera angles and shot distances.';

/**
 * 整页 nl：版面首句（代码定，柏宝绘原版措辞）+ 各格画面内容 + 连续性收束。
 *
 * 出图链路的唯一入口——版面完全由 board 决定，模型只负责"每一格画什么"。
 * 这样"选了主图+特写却出来三条横带"在结构上就不可能发生：
 * 该档的构图词里根本没有 koma。
 */
export function buildBoardNl(
  board: { layout: BoardLayout; pageType: BoardPageType; panelCount: number; whitespace?: 'compact' | 'balanced' | 'airy' | 'dramatic'; diagonal?: boolean },
  page: ComicPagePlan,
): string {
  const head = boardNlHead({
    layout: board.layout,
    pageType: board.pageType,
    panelCount: page.panels?.length || board.panelCount,
    ...(board.whitespace ? { whitespace: board.whitespace } : {}),
    ...(board.diagonal ? { diagonal: true } : {}),
  });
  const body = panelNlContentOnly(page, board);
  return [head, body, CONTINUOUS_INSTANT_NOTE].filter(Boolean).join(' ');
}

const NL_COUNT_WORD: Record<number, string> = {
  1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six',
};

/** 各档的「格位怎么排」一句。只说结构，不说底色（底色由代码画）。 */
function panelArrangementClause(layout: BoardLayout, count: number): string {
  const n = NL_COUNT_WORD[count] ?? String(count);
  switch (layout) {
    case 'regular':
      return `arranged as ${n} stacked panels of equal width, read from top to bottom`;
    case 'irregular': {
      if (count <= 1) return 'arranged as a single main panel';
      const rest = NL_COUNT_WORD[count - 1] ?? String(count - 1);
      return count === 2
        ? 'arranged in an asymmetrical open composition — one large main panel plus one smaller panel'
        : `arranged in an asymmetrical open composition — one large main panel plus ${rest} smaller panels of different sizes`;
    }
    case 'unframed':
      return 'arranged as one main panel that fills the page plus small separately framed close-up panels floating over its margins';
    case 'inset':
    default: {
      if (count <= 1) return 'arranged as a single main panel with generous space around it';
      const rest = NL_COUNT_WORD[count - 1] ?? String(count - 1);
      return count === 2
        ? 'arranged in an open composition — one large main panel in the upper area plus one small close-up panel placed in the free space around it'
        : `arranged in an open composition — one large main panel in the upper area plus ${rest} small close-up panels placed in the free space around it`;
    }
  }
}

/**
 * 声明式整页 nl：**说「这一页由 N 个独立画格组成」，而不是「一张白底插画」**。
 *
 * 为什么必须单独有一份（用户实地指出过语义偏差）：
 * - `white background` 表达的是**画面底色**，不是格与格之间的留白。写进去，
 *   模型会把整张画布（连格子内部）一起抹成纯白，人物飘在纸上没有场景。
 * - “an unframed character illustration + one or two small panels” 把主画面
 *   降级成「独立插画 + 装饰细节」，格数也就无从谈起。
 *
 * 这份 nl 把三个概念分开写死：页面底色 = 格间与页边的空隙；格内背景 = 每格自己的场景；
 * 主画面 = 一个完整的漫画格。只在「整页一次出图」的兜底路径使用——
 * 正常路径是逐格出图 + 代码排版，根本不需要模型画分格。
 */
export function buildDeclarativePageNl(
  board: {
    layout: BoardLayout;
    pageType: BoardPageType;
    panelCount: number;
    whitespace?: 'compact' | 'balanced' | 'airy' | 'dramatic';
    diagonal?: boolean;
  },
  page: ComicPagePlan,
): string {
  const count = page.panels?.length || board.panelCount || 1;
  const n = NL_COUNT_WORD[count] ?? String(count);
  const head = count <= 1
    ? 'A one-panel manga page: a single framed comic panel on the page.'
    : `A ${n}-panel manga page built from ${n} separate, individually framed comic panels, ${panelArrangementClause(board.layout, count)}.`;
  const structure = count <= 1
    ? 'The panel keeps its own scene background.'
    : 'Each panel has its own visible panel border and its own full scene background. The panels are independent comic panels, not a single illustration with decorative details or inset objects. The only empty area is the gap between panels and the page margin, and that gap is the page background — it is not a request to remove the background inside any panel.';
  const body = panelNlContentOnly(page, board);
  return [head, structure, body, CONTINUOUS_INSTANT_NOTE].filter(Boolean).join(' ');
}

/** 整页台词：页级优先，没有就从各格合并（上限 4 条由解析层保证）。 */export function collectPageDialogue(page: ComicPagePlan): ComicDialogue[] {
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

export interface CastShortfall {
  pageIndex: number;
  title: string;
  /** 明确同框入镜、却缺外貌约束的人数 */
  declared: number;
  /** 实际能建出几个角色块 */
  blocks: number;
}

/**
 * 「某一格明确要两人同框，但其中一人没有外貌约束」的体检（任务书 §3.3 重写）。
 *
 * 旧版拿页级人数词（1girl,1boy）和整页角色块数强制对齐，逼模型把同一批人塞进每一格，
 * 直接挡住了单人局部/双人局部/道具格。新口径：**只看真正写了 ≥2 人同框的那一格**——
 * - 一格只写一个人 / 只有手脸 / 物件格 → 完全合法，不报；
 * - 一格写了两个人，且这两人都能从库或 look 建出块 → 不报；
 * - 一格写了两个人，但其中一人查不到库、又没有 look → 只报这一格，提示补资料。
 *
 * 用 resolveCastNames 按页/人设归一后再数，避免「你 / User / 人设名」被算成两个人。
 */
export function findCastShortfall(
  pages: readonly ComicPagePlan[],
  characters: readonly BaiBaiCharacter[],
  options: { nativeCharacters?: boolean; selectedText?: string; personaName?: string } = {},
): CastShortfall | null {
  if (options.nativeCharacters === false) return null;
  for (const page of pages) {
    // 这一页能建出的角色块名字（归一后），只用来判断「某格的人有没有外貌」
    const composed = composePagePrompt(page, [...characters], options);
    const covered = new Set(composed.characters.map(c => c.name.trim().toLowerCase()));
    for (const panel of page.panels ?? []) {
      const names = (panel.characters ?? [])
        .map(c => String(c.name ?? '').trim())
        .filter(Boolean);
      // 单人格 / 局部格 / 物件格：不看人数词，直接跳过（任务书 §3.2）
      if (names.length < 2) continue;
      // 归一到「你 = 人设名」等别名后去重（不传 declared → 不会自动补齐人数）。
      const resolved = resolveCastNames(
        names,
        [...characters],
        { ...(options.personaName ? { personaName: options.personaName } : {}) },
      ).cast;
      const wanted = resolved.length;
      if (wanted < 2) continue;
      const have = resolved.filter(name => covered.has(name.trim().toLowerCase())).length;
      // 只有「同框 ≥2 人却建不出 ≥2 块」才报；全无库（covered 空）交给 NAI 自由分配
      if (covered.size > 0 && have < wanted) {
        return { pageIndex: page.pageIndex, title: page.title, declared: wanted, blocks: have };
      }
    }
  }
  return null;
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
  options: {
    nativeCharacters?: boolean;
    selectedText?: string;
    /** ST 人设名（`name1`）：用来把「你 / User」这类写法对回角色库里那一条 */
    personaName?: string;
    /** Base 声称的人数（不给就自己从 tags 里数） */
    declared?: number;
  } = {},
): ComposedPage {
  const base = String(page.tags ?? '').trim() || mergePanelTags(page);
  const names: string[] = [];
  // 各格写了「这个人在做什么」：它属于这个人自己的角色块，不能丢，也不能进 Base
  const acts = new Map<string, string[]>();
  // 模型给「角色库里没有的人」补的外貌（例如用户扮演的「你」）。
  // 没有它，这个人就只有名字、没有提示词块，Base 上写着 "2 people" 却只画一个人。
  const looks = new Map<string, string>();
  for (const panel of page.panels ?? []) {
    for (const c of panel.characters ?? []) {
      if (!c?.name) continue;
      if (!names.includes(c.name)) names.push(c.name);
      const look = String(c.look ?? '').trim();
      if (look && !looks.has(c.name)) looks.set(c.name, look);
      const act = String(c.act ?? '').trim();
      if (act) {
        const list = acts.get(c.name) ?? [];
        if (!list.includes(act)) list.push(act);
        acts.set(c.name, list);
      }
    }
  }

  // Base 声称几个人：人数词是模型写的，也是它承诺「画面里该有几个人」的唯一凭据。
  // 之前只按 clauses 里的名字建块，模型漏写一个人 → 块少一个 → 那一格只剩一个确定的人。
  const declared = options.declared ?? declaredPeople(base);

  // 模型漏写 panels[].characters 时补人：否则角色块空着，外貌只能并回 Base
  //（= 「两套衣服糊在一个提示词里」的老毛病）
  //
  // 模型写了的名字**不裁**：裁掉的那个人会连外貌一起消失，比多一块提示词糟得多。
  // 只有「代码自己补」时才按协议上限（2 人）收着补，免得把库里的路人甲乙也塞进画面。
  const rawCast = names.length
    ? names.slice(0, 6)
    : ensurePageCast(page, characters, options.selectedText ?? '', looks);
  // 名字归一（你/User → 人设名）+ 按人数补齐：这一步才是「两个人却只画一个」的正解
  const resolved = resolveCastNames(rawCast, characters, {
    ...(options.personaName ? { personaName: options.personaName } : {}),
    declared,
    max: 3,
    looks,
    acts,
  });
  const cast = resolved.cast;
  const native = options.nativeCharacters !== false;
  /**
   * 多格页**不把各格动作塞进角色块**。
   *
   * 这是「两格动作差不多」的机械原因：NAI 的 character prompt 是**整页共用**的，
   * 把第 1 格的「前倾递餐巾」和第 2 格的「拿餐巾擦嘴」一起并进同一个人的块里，
   * 两格拿到的是同一串动作 → 画出来必然长得一样。
   * 各格的动作归各格的 nl（buildPageNl 会按格写）；角色块只留固定外貌，
   * 单格页没有这个问题，动作照旧并进块里。
   */
  const multiPanel = (page.panels ?? []).length > 1;
  const characterPrompts = native
    ? characterPromptsFromLibrary(cast, characters, multiPanel ? undefined : resolved.acts, resolved.looks)
    : [];

  // ★ 服装一致性（与柏宝绘同一条链路）：把本批定妆逐字拼进每个角色块。
  // 以前这里完全没碰服装：角色库 outfit 字段全空、模板又禁止模型写服装，
  // 于是角色块里只有发色/眼睛/痣——NAI 只能自己编衣服，才跟柏宝绘的图对不上。
  // 定妆来源：模型据柏宝书翻出的英文 cast[].outfit → 回落角色库 fields.outfit。
  // 同一批（多页 / 多格）用同一串，按名字冻结，谁都不会在某一格换衣服。
  const outfitMap = resolveOutfits(page.outfits, options.personaName);
  const dressCharacter = (block: BbiTagCharacter): BbiTagCharacter => {
    const outfit = outfitOf(block.name, outfitMap, characters, options.personaName);
    if (!outfit) return block;
    const tag = appendOutfit(block.tag, outfit);
    return tag === block.tag ? block : { ...block, tag };
  };
  const dressed = characterPrompts.map(dressCharacter);

  // 拆得出来就拆；拆不出来（角色库空 / 名字对不上）退回老口径。
  // 退回时服装只能并进 Base——但每个角色的串都带名字前缀，仍是确定的同一套。
  const merged = dressed.length ? base : mergeCharacterTags(base, cast, characters);
  // 没有原生角色块时，定妆也要落到 Base，否则 NAI 依旧自己编衣服
  const fallbackOutfits = dressed.length
    ? []
    : [...outfitMap.values()].map(item => item.outfit);
  const bareBase = merged.toLowerCase().replace(/\s+/g, ' ');
  const extraTags = fallbackOutfits.filter(o => !bareBase.includes(o.toLowerCase()));
  const withOutfits = extraTags.length ? `${merged}, ${extraTags.join(', ')}` : merged;
  // ★ 人数词纠偏：人数词是模型写的，它经常把性别数错（实测：1boy + 1girl 写成 2girls）。
  // 角色块是确定信息（每个人自己带 1girl / 1boy），以它为准重算 Base 的人数词。
  // 没有角色块时不动——那时候人数词是唯一线索。
  const prompt = dressed.length
    ? reconcileHeadcount(withOutfits, dressed.map(block => block.tag))
    : withOutfits;
  // 各格 nl 是分镜的全部信息量（哪一格是什么镜头、谁在哪里、留白在哪）：
  // 只要有一格真的写了 nl / shot / subject，就用「按格拼出来的」，
  // 而不是模型那句笼统的 page.nl（它经常只是版面首句的复述）。
  const panelHasDetail = (page.panels ?? []).some(panel =>
    !!String(panel.nl ?? '').trim() || !!String(panel.shot ?? '').trim() || !!String(panel.subject ?? '').trim(),
  );
  const pageNl = String(page.nl ?? '').trim();
  let nl = panelHasDetail || !pageNl ? buildPageNl(page) : pageNl;
  // 模型自己那版 nl 常只写「白底 + 有特写格」，没提格间留白 → 画面就会填满。
  // 缺 gutter / white space 的说法时补一句，不改写它原有的描述。
  if (nl === pageNl && !/gutter|white space|white gap/i.test(nl)) {
    nl = `${nl} ${LAYOUT_GAP_NOTE[page.layout] ?? LAYOUT_GAP_NOTE.regular}`;
  }

  return {
    prompt,
    nl,
    dialogue: collectPageDialogue(page),
    panelTitles: (page.panels ?? []).map(p => p.title).filter(Boolean),
    characters: dressed,
  };
}
