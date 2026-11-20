/**
 * ST-Story-Illustrator — 柏宝绘原版漫画版面词表与发送侧纠偏（纯函数）
 *
 * 这一层是《漫画分镜与对白气泡》文档第 3 / 6.2 / 6.3 / 6.11 节的移植：
 *
 * - **构图词必须带权重**（`1.5::multiple views::` 这种）。裸词会被画师串里
 *   2.5 权重的写实词淹没——"开了漫画分镜却还是一张普通插画"就是这么来的。
 * - **四档互斥**：regular（等分）/ irregular（不等分拼版）/ inset（白底居中 + 特写格）/
 *   unframed（白底 + 主画铺满 + 特写格）。档位之间禁词不同，混用必崩。
 * - **`2koma`/`3koma`/`4koma` 是"等分 N 格"的语义**，只在 regular 档合法。
 *   在白底/拼版档写它，NAI 会画成 N 条等宽横带——用户实测的"三条横条"就是它。
 * - **禁词**：panel layout / comic panel / manga 是 danbooru 0 帖空 tag；
 *   comic 是"整本漫画"语义，会把画面拉成黑白网点。
 * - **发送侧确定性纠偏**：LLM 写不写对不可靠，出图前必须删冲突词、补必需词、
 *   按档管场景词，并在 nl 前面补一句版面描述（模型很少主动说清白边和边框归属）。
 *
 * 全部纯函数，不读 DOM、不发请求，可直接单测。
 */

import type { PanelLayout } from '../types';

// ============================================================
// 档位 / 页型
// ============================================================

export type BoardLayout = 'regular' | 'irregular' | 'inset' | 'unframed';
/** 无框档的四种页型；auto = 由代码按格数挑 */
export type BoardPageType = 'auto' | 'a' | 'b' | 'c' | 'd';

export const BOARD_LAYOUTS: readonly BoardLayout[] = ['regular', 'irregular', 'inset', 'unframed'];

/** 脏设置归一到白名单。 */
export function normalizeBoardLayout(value: unknown): BoardLayout {
  return value === 'irregular' || value === 'inset' || value === 'unframed' ? value : 'regular';
}

export function normalizeBoardPageType(value: unknown): BoardPageType {
  return value === 'a' || value === 'b' || value === 'c' || value === 'd' ? value : 'auto';
}

/** 旧类型 `PanelLayout` 与 `BoardLayout` 是同一套语义，这里显式互转，避免两处漂移。 */
export function boardLayoutOf(layout: PanelLayout | BoardLayout): BoardLayout {
  return normalizeBoardLayout(layout);
}

// ============================================================
// 构图词（带权重，原样照抄 —— 这是效果的命门）
// ============================================================

/**
 * 四档构图词。
 *
 * **权重不是越大越好**：`1.4 / 1.5 / 2 / 3` 是原版实测的平衡点。太高会让画面只剩
 * 分格没有内容；太低会被画师串淹没。改成裸词等于把这一层关掉。
 */
export const PANEL_TAGS_BY_LAYOUT: Record<BoardLayout, readonly string[]> = {
  regular: ['1.4::multiple views::', '1.4::2koma::', '1.5::split screen::'],
  irregular: ['1.4::multiple views::', '1.5::split screen::'],
  inset: ['1.5::multiple views::', '1.4::white background::'],
  unframed: [
    '3格漫画', '三场景漫画构图', '3::非对称漫画页面布局::', '2::开放分镜漫画构图::',
    '2::无边框中央插画::', '3::第二场景周围没有长方形画框::',
    '2::主场景周围没有长方形包围::', '2::人物自然融入白色空间::', '1.4::white background::',
  ],
};

/**
 * 「白底 / 无框插画」语义的词。
 *
 * 这些是柏宝绘原版**白底档**专用词：它假定「整页就是一张白纸上的无框插画」。
 * 一旦走「一页多格、页面由代码排版」的路线，这些词就是**语义错误**——
 * `white background` 在 NAI 里是「整张画布不要背景」，模型会连格内背景一起抹掉；
 * `无边框中央插画` 会把主画面降级成独立插画而不是一个漫画格。
 * 所以逐格/声明式路线要整组剥掉（见 enforcePanelPrompt 的 declarative 选项）。
 */
export const WHITE_GROUND_TAGS: readonly string[] = [
  'white background',
  '无边框中央插画',
  '主场景周围没有长方形包围',
  '第二场景周围没有长方形画框',
  '人物自然融入白色空间',
];

/** 等分 N 格的 koma 词：**只对 regular 档成立**。 */
export function regularKomaTag(count: 2 | 3 | 4): string {
  return `1.4::${count}koma::`;
}

/** 各档禁用的分格词：档位之间互斥，留着就会打架。 */
export const PANEL_FORBIDDEN_BY_LAYOUT: Record<BoardLayout, readonly string[]> = {
  regular: ['3koma', '4koma'],
  irregular: ['2koma', '3koma', '4koma'],
  inset: ['2koma', '3koma', '4koma', 'split screen'],
  unframed: ['multiple views', '2koma', '3koma', '4koma', 'split screen'],
};

/** 分格词族：判"这一段是不是版面词"用，跨档统一识别。 */
const PANEL_FAMILY: readonly string[] = [
  'multiple views', '2koma', '3koma', '4koma', 'split screen',
  '3格漫画', '三场景漫画构图', '非对称漫画页面布局', '开放分镜漫画构图', '无边框中央插画',
  '第二场景周围没有长方形画框', '主场景周围没有长方形包围', '人物自然融入白色空间',
  // 自造词/空 tag 也归进词族：它们等效于"没写分格"，必须能被剥掉重填
  'comic page layout', 'panel layout', 'comic panel', 'comic page', 'manga', 'comic',
  'asymmetric layout', 'dynamic diagonal composition',
];

/**
 * 无条件删的"空 tag"：这些词在原版文档里被点名过——
 * `panel layout` / `comic panel` / `manga` 是 danbooru 0 帖空 tag（写了等于没写），
 * `comic` 是"整本漫画"语义（会把画面拉成黑白网点）。
 * 另外几个是上一版插件自己造的词，同样没有语义，一并清掉。
 */
const JUNK_TAGS: readonly string[] = [
  'comic page layout', 'panel layout', 'comic panel', 'comic page', 'manga', 'comic',
  'asymmetric layout', 'dynamic diagonal composition',
];

/**
 * 定"室内还是室外"的锚点。
 * 白底档全删场景词会让室内戏被画到街上，所以这两个必须放行。
 */
const SCENE_ANCHOR_TAGS: readonly string[] = ['indoors', 'outdoors', 'interior', 'exterior'];

/** 地点词：一个就够暗示"在哪"，多了会把白底页拖回场景图。无框档只留前 2 个。 */
const SCENE_LOCATION_TAGS: readonly string[] = [
  'dorm room', 'bedroom', 'classroom', 'street', 'city', 'bathroom', 'kitchen',
  'office', 'living room', 'study', 'corridor', 'rooftop',
];

/**
 * 白底档硬禁的场景词：家具 / 光照 / 时段 / 照片感。
 * 刻意不含 white background —— 那是这一档自己要的词。
 */
const INSET_SCENE_TAGS: readonly string[] = [
  'indoors', 'outdoors', 'dorm room', 'bedroom', 'classroom', 'street', 'city', 'scenery',
  'bed', 'single bed', 'bedsheets', 'rumpled bedsheets', 'blanket', 'pillow', 'desk', 'wooden desk',
  'table', 'bookshelf', 'shelf', 'window', 'curtain', 'glass jar', 'paper cranes',
  'wooden floor', 'floor', 'sunlight from window', 'side lighting', 'warm colors', 'backlighting',
  'soft lighting', 'rim lighting', 'cinematic lighting', 'dramatic lighting',
  'depth of field', 'shallow depth of field',
  'afternoon', 'morning', 'evening', 'night', 'sunset', 'sunrise',
  'depth of field', 'shallow depth of field',
];

// ============================================================
// 裸词工具
// ============================================================

/** 逗号段的裸 tag：`2::2koma::` 与 `2koma` 视为同一个词。 */
export function bareTagOf(segment: string): string {
  return segment.replace(/^\s*[\d.]+::/, '').replace(/^\s*::/, '')
    .replace(/::\s*$/, '').trim().toLowerCase();
}

/** 是不是独立一段（不是跨逗号权重块的一部分）——权重块一律保留，不撕坏提示词。 */
function isPlainSegment(segment: string): boolean {
  const text = segment.trim();
  if (!text) return false;
  if (!text.includes('::')) return true;
  return /^[\d.]+\s*::.*::\s*$/.test(text);
}

// ============================================================
// 发送侧纠正
// ============================================================

export interface EnforceResult {
  prompt: string;
  removed: string[];
  added: string[];
}

/**
 * 出图前删冲突词 + 补缺词 + 白底档管场景词。只改本次发送的字符串，不动存档。
 *
 * 顺序：必需词放最前面（越靠前权重越高），然后是模型写的内容词。
 */
export function enforcePanelPrompt(
  prompt: string,
  layout: BoardLayout,
  options: { koma?: 2 | 3 | 4; declarative?: boolean } = {},
): EnforceResult {
  const kind = normalizeBoardLayout(layout);
  const source = String(prompt ?? '').trim();
  if (!source) return { prompt: source, removed: [], added: [] };

  // regular 档的等分格数由格数决定：用户选三格就补 3koma，删掉 2koma / 4koma。
  // 这是"固定格数"在 NAI 上唯一真正生效的写法（koma 词是格数的语义本身）。
  const koma = kind === 'regular' ? options.koma : undefined;
  let required = koma
    ? ['1.4::multiple views::', regularKomaTag(koma), '1.5::split screen::']
    : [...PANEL_TAGS_BY_LAYOUT[kind]];
  const forbidden = new Set<string>(
    koma
      ? ([2, 3, 4] as const).filter(n => n !== koma).map(n => `${n}koma`)
      : PANEL_FORBIDDEN_BY_LAYOUT[kind],
  );
  // declarative：一页多格由「结构描述 + 代码排版」表达，不再用白底词。
  // 白底词会被当成"整张画布没背景"，正好抹掉每一格自己的场景。
  if (options.declarative === true) {
    required = required.filter(tag => !WHITE_GROUND_TAGS.includes(bareTagOf(tag)));
    for (const tag of WHITE_GROUND_TAGS) forbidden.add(tag);
    // 仍需一个"多格"信号：白底档原本靠 white background 暗示多格，剥掉后要补回来
    if (!koma && kind === 'inset' && !required.some(t => bareTagOf(t) === 'multiple views')) {
      required = ['1.4::multiple views::', ...required];
    }
  }
  // 场景词兜底只发生在白底两档：inset 全删；unframed 放行室内外锚 + 地点词限流 2 个。
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
    // "已写过"要记所有裸词，不只分格词族：white background 不在词族里，
    // 只记词族会漏判 → 重复注入。
    present.add(bare);
    if (JUNK_TAGS.includes(bare) && isPlainSegment(text)) { removed.push(text); continue; }
    // 禁用词先于「是否分格词族」判定：白底词不在词族里，
    // 放在词族之后会被 kept 原样留下（等于没禁）。
    if (isPlainSegment(text) && forbidden.has(bare)) { removed.push(text); continue; }
    if (!PANEL_FAMILY.includes(bare)) {
      if (sceneLimit && isPlainSegment(text)) {
        if (SCENE_ANCHOR_TAGS.includes(bare)) { kept.push(text); continue; }
        if (SCENE_LOCATION_TAGS.includes(bare)) {
          if (locationKept < 2) { locationKept += 1; kept.push(text); continue; }
          removed.push(text); continue;
        }
        if (INSET_SCENE_TAGS.includes(bare)) { removed.push(text); continue; }
        kept.push(text); continue;
      }
      if (stripScene && isPlainSegment(text) && INSET_SCENE_TAGS.includes(bare)) { removed.push(text); continue; }
      kept.push(text); continue;
    }
    if (isPlainSegment(text) && forbidden.has(bare)) { removed.push(text); continue; }
    kept.push(text);
  }

  const missing = required.filter(tag => !present.has(bareTagOf(tag)));
  return { prompt: [...missing, ...kept].join(', '), removed, added: missing };
}

export interface PanelInjection {
  enabled: boolean;
  layout: BoardLayout;
}

/**
 * 判定这一楼注入不注入、用哪一档。判据只写在这一处，避免多处不一致。
 * - 小剧场图（storyImage）不注入；
 * - Q 版生效时恒压回 regular（Q 版比例下多格必崩）。
 */
export function decidePanelInjection(input: {
  panelMode: boolean;
  panelLayout: BoardLayout;
  chibiOn: boolean;
  storyImage: boolean;
}): PanelInjection {
  const layout = input.chibiOn ? 'regular' : normalizeBoardLayout(input.panelLayout);
  return { enabled: input.panelMode && !input.storyImage, layout };
}

// ============================================================
// nl 版面句（规则 / 示例 / 兜底三处同档，靠这一份表）
// ============================================================

/** 无框档 auto 页型的默认句（A 型，最经典）。横竖同句，与原版一致。 */
export const UNFRAMED_NL_PORTRAIT =
  'An asymmetric three-scene manga page on a white background: the top 20% of the page is a narrow horizontal panel with a thin black border showing a simple close-up of one face, below the top strip, the main illustration fills the rest of the page with no border and no frame — the characters are drawn large, filling most of the illustration area with only narrow white margins around them, directly on the white page, blending into the white space, with one arm extending past the page edge — and the bottom right area has a floating panel with a thin black border, about 65% of the page width and 27% of the page height, showing a close-up detail of the same moment. Only the top and bottom-right scenes have panel borders, and no rectangular border surrounds the characters.';

/** 无框档四种页型的第一句（照抄句式，换内容不换句式）。 */
export const UNFRAMED_NL_HEAD: Record<'a' | 'b' | 'c' | 'd', string> = {
  a: 'An asymmetric three-scene manga page on a white background: a narrow bordered panel across the top 20% shows a simple close-up of one face, the main illustration fills the rest of the page, and a floating bordered panel sits in the bottom right area.',
  b: 'A two-part manga page on a white background: a narrow bordered panel across the top 20% shows a simple close-up of one face, and the main illustration fills the remaining 80% of the page.',
  c: 'A two-part manga page on a white background: a tall narrow bordered panel runs along the right edge (about 30% of the page width), and the main illustration fills the remaining area.',
  d: 'A manga page on a white background where the main illustration fills the whole page, and a small bordered panel sits in the bottom right corner (about 30% of the page width).',
};

/** 无框档收束句：只交代边框归属，主画绝不许出现 border / frame。 */
export const UNFRAMED_CLOSER =
  'Only the inset panel(s) have thin black borders, and no rectangular border surrounds the characters, and the main illustration has absolutely no panel border.';

export interface BoardNlInput {
  layout: BoardLayout;
  pageType: BoardPageType;
  /** 这一页实际几格（用于把"两个特写格"之类说清） */
  panelCount: number;
  /** 用户选的留白意图 */
  whitespace?: 'compact' | 'balanced' | 'airy' | 'dramatic';
  /** 斜切风格：没有专属档，靠 nl 补一句**
   *  （NAI 没有"斜切分格"的 tag，只能描述） */
  diagonal?: boolean;
}

/**
 * 生成整页版面首句。这是发给图像 API 的 nl 第一句：
 * 先说"这张图怎么读"，再说内容。
 *
 * 全部按柏宝绘原版的措辞：
 * - inset 是"白底 + 居中主图 + 四周大量留白 + 带框特写"（不是 narrow margins）；
 * - unframed 是"白底 + 主画铺到底 + 特写格"，并要求"人物画大、白边窄"。
 */
export function boardNlHead(input: BoardNlInput): string {
  const layout = normalizeBoardLayout(input.layout);
  const pageType = normalizeBoardPageType(input.pageType);
  const count = Math.max(1, Math.round(input.panelCount || 1));
  const whitespace = input.whitespace ?? 'balanced';

  if (layout === 'regular') {
    if (count >= 4) {
      return 'A four-panel comic page in a two-by-two grid, separated by thin black gutters, read from top to bottom, left to right.';
    }
    if (count === 3) {
      return 'A three-panel comic page: one wide panel across the top and two smaller panels side by side below, separated by thin black gutters, read from top to bottom.';
    }
    return 'A two-panel comic page: one canvas split horizontally by a thin black gutter, the upper panel above the lower one, read from top to bottom.';
  }

  if (layout === 'irregular') {
    const base = count >= 4
      ? 'An irregular comic page of four panels of unequal size: one large main panel and three smaller panels arranged around it, separated by thin black gutters, read from top to bottom and left to right.'
      : count === 3
        ? 'An irregular comic page of three panels of unequal size: one large main panel plus two narrow smaller panels, separated by thin black gutters, read from top to bottom.'
        : 'An irregular comic page of two panels of unequal size: one large main panel and one narrow smaller panel, separated by a thin black gutter.';
    return input.diagonal
      ? `${base} The panels are cut with slanted diagonal edges, not all upright rectangles, and the reading order stays obvious.`
      : base;
  }

  if (layout === 'inset') {
    // 1 主 + (N-1) 特写：两个特写格要分别说清位置，否则模型只画一个
    const detail = count >= 3
      ? 'a narrow wide panel with a thin black border across the top shows a close-up of one face, and a small framed panel in the bottom right corner shows one close-up detail of the same moment'
      : 'a small framed panel in the bottom right corner with a thin black border shows one close-up detail of the same moment';
    const gap = whitespace === 'compact'
      ? 'the white space around it kept narrow'
      : 'generous empty white space around it';
    return `A manga page on a white background: a single unframed character illustration occupies the center, drawn large, with ${gap}; ${detail}. Only the small close-up panel(s) have thin black borders, and no rectangular border surrounds the main illustration.`;
  }

  // unframed：按页型
  if (pageType === 'auto') return UNFRAMED_NL_PORTRAIT;
  return `${UNFRAMED_NL_HEAD[pageType]} ${UNFRAMED_CLOSER}`;
}

/** 各档的区域引导词：把每格的画面内容按阅读顺序装进对应区域。 */
export function boardAreaLeads(layout: BoardLayout, pageType: BoardPageType, count: number): string[] {
  const kind = normalizeBoardLayout(layout);
  if (kind === 'regular') {
    if (count >= 4) return ['In the top-left panel', 'In the top-right panel', 'In the bottom-left panel', 'The bottom-right panel shows'];
    if (count === 3) return ['In the wide top panel', 'In the bottom-left panel', 'The bottom-right panel shows'];
    return ['In the upper panel', 'The lower panel shows'];
  }
  if (kind === 'irregular') {
    return ['In the large main panel', 'In the narrow panel', 'In the small panel', 'In the bottom strip'];
  }
  if (kind === 'inset') {
    // 主画面是一个**漫画格**，不是一张无框插画 —— 措辞会影响模型怎么理解它
    return ['In the large main panel', 'In the narrow panel across the top', 'In the small framed panel in the bottom right corner', 'In the small framed panel'];
  }
  // unframed
  const pt = normalizeBoardPageType(pageType);
  if (pt === 'c') return ['In the large main panel', 'In the tall narrow panel along the right edge'];
  if (pt === 'd') return ['In the large main panel', 'In the small framed panel in the bottom right corner'];
  if (pt === 'b') return ['In the large main panel', 'In the narrow panel across the top'];
  return ['In the large main panel', 'In the narrow panel across the top', 'In the floating panel in the bottom right area'];
}

const MOSTLY_CJK = /[\u3400-\u9fff\uf900-\ufaff]/g;
const ASCII_LETTER = /[a-zA-Z]/g;

/** 判"中文为主体"必须用字数比较，不能用"含中文"——英文 nl 里一个中文人名会误伤整轮兜底。 */
export function isMostlyChinese(text: string): boolean {
  const cjk = (String(text ?? '').match(MOSTLY_CJK) ?? []).length;
  if (!cjk) return false;
  return cjk > (String(text ?? '').match(ASCII_LETTER) ?? []).length;
}

/** nl 里已经说过版面就放过。 */
const PANEL_NL_MARK = /\b(?:panels?|gutters?|inset|main illustration|main image|comic page|manga page)\b/i;

/**
 * 给 nl 兜底补版面句（幂等，放最前面）。
 * 三种情况不碰：nl 为空、nl 以中文为主体、模型已经写过版面标记。
 */
export function applyPanelToNl(nl: string, head: string): string {
  const text = String(nl ?? '').trim();
  if (!text) return text;
  if (isMostlyChinese(text) || PANEL_NL_MARK.test(text)) return nl;
  const cleanHead = String(head ?? '').trim();
  if (!cleanHead) return nl;
  return `${cleanHead} ${text}`;
}

// ============================================================
// 人数词纠正（确定性）
// ============================================================

const PERSON_TAG = /^(?:\d+\s*(?:girl|boy|other)s?|\d+\s*people|couple|solo)$/i;

/** Base 里声称的总人数（`2girls`/`couple`/`2people` 都算）。数不出来返回 0。 */
function declaredPersonsOf(base: string): number {
  let total = 0;
  for (const raw of String(base ?? '').split(',')) {
    const bare = bareTagOf(raw);
    if (!bare) continue;
    if (bare === 'couple') { total += 2; continue; }
    if (bare === 'solo') { total += 1; continue; }
    const m = bare.match(/^(\d+)\s*(?:girl|boy|other|people)s?$/);
    if (m) total += Math.max(1, parseInt(m[1], 10) || 1);
  }
  return total;
}

/**
 * 按角色块里的人数词重算 Base 的人数词。
 *
 * 实测事故：两个角色是 `1boy`（叶均）+ `1girl`（陆子慕），Base 却写着 `2girls`。
 * 人数词是模型写的，它经常把性别数错；而人数词直接决定画面里有几个人、什么性别。
 * 角色块是确定信息（每个人自己带 `1girl` / `1boy`），以它为准纠正 Base。
 *
 * **只在角色块覆盖得住 Base 声称的人数时才纠正**：库里查不到第二个人时
 * （例如用户扮演的「你」还没建块），Base 的 `2boys` 是"画面里该有两个人"的唯一线索，
 * 按 1 个块改成 `1boy` 会让画面真的少一个人。
 */
export function reconcileHeadcount(base: string, castTags: readonly string[]): string {
  const genders: string[] = [];
  for (const tag of castTags) {
    const m = String(tag ?? '').match(/\b(\d+)\s*(girl|boy|other)\b/i);
    if (m) {
      const n = Math.max(1, parseInt(m[1], 10) || 1);
      for (let i = 0; i < n; i += 1) genders.push(m[2].toLowerCase());
    }
  }
  if (!genders.length) return base;

  const declared = declaredPersonsOf(base);
  if (declared > genders.length) return base; // 块不够，人数词是更可信的那一条

  const girls = genders.filter(g => g === 'girl').length;
  const boys = genders.filter(g => g === 'boy').length;
  const others = genders.length - girls - boys;
  const wanted: string[] = [];
  if (girls) wanted.push(`${girls}girl${girls > 1 ? 's' : ''}`);
  if (boys) wanted.push(`${boys}boy${boys > 1 ? 's' : ''}`);
  if (others) wanted.push(`${others}other${others > 1 ? 's' : ''}`);

  const segments = String(base ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const personIdx = segments.filter(s => PERSON_TAG.test(bareTagOf(s)));
  if (!personIdx.length) return [...wanted, ...segments].join(', ');
  const out: string[] = [];
  let injected = false;
  for (const segment of segments) {
    if (!PERSON_TAG.test(bareTagOf(segment))) { out.push(segment); continue; }
    if (injected) continue; // 多个人数词只保留一个位置
    injected = true;
    out.push(...wanted);
  }
  return out.join(', ');
}
