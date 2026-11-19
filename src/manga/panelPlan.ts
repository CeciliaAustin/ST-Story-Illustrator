/**
 * ST-Story-Illustrator — 漫画分镜计划纯函数
 *
 * 职责（任务 #16）：
 * - 四档分镜规则文本构建（buildPanelRule）与构图词 / nl 版面句常量
 * - LLM 结构化 JSON → ComicPagePlan 的容错解析与归一化
 * - 台词条目归一化
 *
 * 移植自《漫画分镜与对白气泡 · 代码与提示词实现说明》§6.1 / §6.2 / §6.11。
 * 全部为纯函数：不读 DOM、不发请求、不产生副作用，便于 Vitest 直接测试。
 *
 * 关键纪律（坑 2）：规则、示例、nl 兜底三处必须同档同页型——
 * 本文件是这三类文本的**唯一来源**，其它模块一律从这里取，不得另写常量。
 */

import type {
  PanelLayout,
  PanelPageType,
  DialoguePolicy,
  PanelBubbleArea,
  ComicDialogue,
  ComicPanelPlan,
  ComicPagePlan,
} from '../types';

// ============================================================
// 常量（唯一来源）
// ============================================================

export const PANEL_BUBBLE_AREAS: readonly PanelBubbleArea[] = [
  'tl', 'tc', 'tr', 'ml', 'mr', 'bl', 'bc', 'br',
];
export const PANEL_DIALOGUE_MAX = 4;
export const PANEL_DIALOGUE_TEXT_MAX = 60;
export const PANEL_DIALOGUE_SPEAKER_MAX = 16;

/** 带权重的构图词——必须原样照抄，裸词会被画师串淹没（坑 3）。 */
export const PANEL_TAGS_BY_LAYOUT: Record<PanelLayout, readonly string[]> = {
  regular: ['1.4::multiple views::', '1.4::2koma::', '1.5::split screen::'],
  irregular: ['1.4::multiple views::', '1.5::split screen::'],
  inset: ['1.5::multiple views::', '1.4::white background::'],
  unframed: [
    '3格漫画', '三场景漫画构图', '3::非对称漫画页面布局::', '2::开放分镜漫画构图::',
    '2::无边框中央插画::', '3::第二场景周围没有长方形画框::',
    '2::主场景周围没有长方形包围::', '2::人物自然融入白色空间::', '1.4::white background::',
  ],
};

/** 禁字通用条款（四档共用，§3.2 第 8 条）。 */
const PANEL_FORBIDDEN_CLAUSE =
  '8. 不要写 speech bubble、text、english text、dialogue、caption —— 这些词会让画面出现气泡或对白条，而生成的字全是乱码，比留白难看得多。分镜靠画面说话。';

/** 输出前自检通用条款（§3.2）。 */
const PANEL_SELF_CHECK =
  '【输出前自检，逐条核对后再输出】\n' +
  '- tag 里是否原样包含了本档要求的构图词（含权重写法）？漏了必须补上。\n' +
  '- nl 的第一句是否说清了版面？只描述画面内容而不提版面，等于没写。\n' +
  '- 景别 tag 是否只有一个？\n' +
  '- 这是漫画分镜图，不是一张普通插画。任何一条不满足，就重写再输出。';

/** 分格图不写角色坐标（仅 NAI + 角色块时追加，双保险）。 */
const PANEL_NO_POS_CLAUSE =
  '分格图不需要 pos：NAI 的坐标是整张图的坐标系，一格里的角色会被拉到整图某个位置、也就是被拉出格子。这个字段整个省略。';

function compositionTags(layout: PanelLayout): string {
  return PANEL_TAGS_BY_LAYOUT[layout].join(', ');
}

// ============================================================
// 归一化入口（脏设置 / 模型输出 → 白名单）
// ============================================================

export function normalizePanelLayout(v: unknown): PanelLayout {
  return v === 'irregular' || v === 'inset' || v === 'unframed' ? v : 'regular';
}

export function normalizePanelPageType(v: unknown): PanelPageType {
  return v === 'a' || v === 'b' || v === 'c' || v === 'd' ? v : 'auto';
}

export function normalizeDialoguePolicy(v: unknown): DialoguePolicy {
  return v === 'always' || v === 'eager' ? v : 'auto';
}

function clamp01(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000
    : undefined;
}

/**
 * 归一化台词条目（§6.1）：坏条目丢弃、超长截断、area 乱码回落自动分配。
 * 返回结构兼容 ComicDialogue，并保留可选手动坐标 x/y（页面相对 0~1）。
 */
export interface NormalizedDialogue extends ComicDialogue {
  x?: number;
  y?: number;
}

export function normalizeDialogueItems(value: unknown): NormalizedDialogue[] {
  if (!Array.isArray(value)) return [];
  const items: NormalizedDialogue[] = [];
  // 注：文档原版写 value.slice(0, MAX) 后再过滤，坏条目会挤占有效名额。
  // 这里改为「先过滤、凑够 MAX 就停」，与"一图最多 4 条有效台词"的意图一致。
  for (const raw of value) {
    if (items.length >= PANEL_DIALOGUE_MAX) break;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;

    const text = typeof item.text === 'string'
      ? item.text.trim().replace(/[\r\n]+/g, ' ').slice(0, PANEL_DIALOGUE_TEXT_MAX)
      : '';
    if (!text) continue;

    const speaker = typeof item.speaker === 'string'
      ? item.speaker.trim().replace(/[\r\n]+/g, ' ').slice(0, PANEL_DIALOGUE_SPEAKER_MAX)
      : '';
    const areaRaw = typeof item.area === 'string' ? item.area.trim().toLowerCase() : '';
    const area = PANEL_BUBBLE_AREAS.includes(areaRaw as PanelBubbleArea)
      ? (areaRaw as PanelBubbleArea)
      : undefined;

    const x = clamp01(item.x);
    const y = clamp01(item.y);

    const dirRaw = typeof item.dir === 'string' ? item.dir.trim().toLowerCase() : '';
    const dir = dirRaw === 'v' || dirRaw === 'h' ? (dirRaw as 'h' | 'v') : undefined;
    const moodRaw = typeof item.mood === 'string' ? item.mood.trim().toLowerCase() : '';
    const mood = moodRaw === 'shout' || moodRaw === 'whisper' || moodRaw === 'calm'
      ? (moodRaw as 'calm' | 'shout' | 'whisper')
      : undefined;

    items.push({
      ...(speaker ? { speaker } : {}),
      ...(area ? { area } : {}),
      ...(x !== undefined ? { x } : {}),
      ...(y !== undefined ? { y } : {}),
      ...(dir ? { dir } : {}),
      ...(mood ? { mood } : {}),
      text,
    });
  }
  return items;
}

// ============================================================
// nl 版面句常量（§6.11）—— enforce 与规则构建共用同一份表
// ============================================================

const UNFRAMED_NL_PORTRAIT =
  'An asymmetric three-scene manga page on a white background: the top 20% of the page is a narrow horizontal panel with a thin black border showing a simple close-up of one face, below the top strip, the main illustration fills the rest of the page with no border and no frame — the characters are drawn large, filling most of the illustration area with only narrow white margins around them, directly on the white page, blending into the white space, with one arm extending past the page edge — and the bottom right area has a floating panel with a thin black border, about 65% of the page width and 27% of the page height, showing a close-up detail of the same moment. Only the top and bottom-right scenes have panel borders, and no rectangular border surrounds the characters.';

export const PANEL_NL_SENTENCE: Record<PanelLayout, { portrait: string; landscape: string }> = {
  regular: {
    portrait: 'The canvas is divided into two equal panels, one above the other, separated by a thin black gutter.',
    landscape: 'The canvas is split into two panels side by side, separated by a thin black gutter.',
  },
  irregular: {
    portrait: 'The canvas is divided into panels of unequal size — one large main panel with smaller panels below it — separated by thin black gutters.',
    landscape: 'The canvas is divided into panels of unequal size — one large main panel with narrower panels beside it — separated by thin black gutters.',
  },
  inset: {
    portrait: 'A manga page on a white background: an unframed character illustration occupies the center with generous white space around it, and small panels framed by thin black borders — one across the top, one in the bottom right corner — show close-up details of the same moment.',
    landscape: 'A manga page on a white background: an unframed character illustration occupies the center with generous white space around it, and small panels framed by thin black borders — one across the top, one along the right edge — show close-up details of the same moment.',
  },
  unframed: {
    portrait: UNFRAMED_NL_PORTRAIT,
    landscape: UNFRAMED_NL_PORTRAIT,
  },
};

/** 无框档四页型结构表（§3.6 / §6.11）。nlHeadline 必须与规则首句一致。 */
export const UNFRAMED_PAGE_SPECS: Record<
  Exclude<PanelPageType, 'auto'>,
  { nlHeadline: string; areas: string[]; framed: string[]; overlapMax: number }
> = {
  a: {
    nlHeadline: 'An asymmetric three-scene manga page on a white background: a narrow bordered panel across the top 20% shows a simple close-up of one face, the main illustration fills the rest of the page, and a floating bordered panel sits in the bottom right area.',
    areas: ['top 20% strip', 'main illustration', 'bottom-right floating panel'],
    framed: ['top strip', 'bottom-right panel'],
    overlapMax: 0.25,
  },
  b: {
    nlHeadline: 'A two-part manga page on a white background: a narrow bordered panel across the top 20% shows a simple close-up of one face, and the main illustration fills the remaining 80% of the page.',
    areas: ['top 20% strip', 'main illustration'],
    framed: ['top strip'],
    overlapMax: 0.25,
  },
  c: {
    nlHeadline: 'A two-part manga page on a white background: a tall narrow bordered panel runs along the right edge (about 30% of the page width), and the main illustration fills the remaining area.',
    areas: ['right-edge vertical strip', 'main illustration'],
    framed: ['right-edge strip'],
    overlapMax: 0.25,
  },
  d: {
    nlHeadline: 'A manga page on a white background where the main illustration fills the whole page, and a small bordered panel sits in the bottom right corner (about 30% of the page width).',
    areas: ['main illustration', 'bottom-right floating panel'],
    framed: ['bottom-right panel'],
    overlapMax: 0.25,
  },
};

/** 无框档钉死页型时的 nl 兜底句。 */
export function unframedNlSentence(pageType: PanelPageType): string {
  if (pageType === 'auto') return PANEL_NL_SENTENCE.unframed.portrait;
  const spec = UNFRAMED_PAGE_SPECS[pageType];
  return `${spec.nlHeadline} The characters are drawn large, filling most of the illustration area, ` +
    'directly on the white page, blending into the white space, with one arm extending past the page edge. ' +
    'Only the inset panel(s) have thin black borders, and no rectangular border surrounds the characters.';
}

// ============================================================
// 台词条款（§6.2）
// ============================================================

const DIALOGUE_POLICY_TEXT: Record<DialoguePolicy, string> = {
  auto: '只挑最关键的话；没有值得说的就整个字段省略，不要硬凑',
  always: '每张图必须至少写 1 条：安静镜头用拟声词顶上（「咚！」「……」都算），不许省略',
  eager: '有对话、呼喊、惊讶时必须写；只有独处、风景镜头才允许省略',
};

/** 台词条款：四档通用，追加在整段规则之后。 */
export function panelDialogueClause(
  mode: 'json' | 'tag',
  policy: DialoguePolicy = 'auto',
): string {
  const format = mode === 'json'
    ? 'images 数组对应元素加 `dialogue` 字段，形如 `[{"text":"放学一起走吗？","area":"tl"}]`'
    : '在该条生图标签里写子标签 `<dialogue>[{"text":"放学一起走吗？","area":"tl"}]</dialogue>`';
  return `【对白气泡】这一张是漫画页，剧情里「谁说了什么」值得画进图时，${format}。
   - text：简短中文口语，一条不超过 20 个字；最多 4 条，${DIALOGUE_POLICY_TEXT[policy]}；
   - area：气泡锚点（tl/tc/tr/ml/mr/bl/bc/br），按说话人位置挑，可省略；
   - dir：排版方向——「v」竖排（独白、呢喃），缺省横排，可省略；
   - mood：语气——calm 缺省 / shout 喊叫 / whisper 轻声呢喃（带小爱心），可省略；
   - 想竖排轻声效果写成 {"text":"……","dir":"v","mood":"whisper"}，dir 与 mood 都带；
   - 台词出自本楼剧情、符合人物口吻，不写旁白；气泡里只画台词本身，不要写说话人名字。
   气泡由插件在出图后用系统字体合成（不会乱码），画面里照旧不许出现任何文字或气泡。`;
}

// ============================================================
// 四档规则文本（§3.3–3.6，忠实移植）
// ============================================================

function regularRule(nlOn: boolean): string {
  const ninth = nlOn
    ? '9. nl 必须按格写，这是唯一能分区描述两格的通道：先用一句总述场景，再用 "In the upper panel, ..." 和 "The lower panel shows ..." 各写一句。不要用 Panel 1 / Panel 2 编号，也不要写对白。'
    : '9. 本次没有 nl 通道，两格内容只能靠 tag 表达：让人物动作在两格之间发生变化。不要试图用第二个景别 tag 拉开两格。';
  return [
    '[漫画分镜｜一张画布切两格]',
    '',
    '这一张是双格漫画，不是普通插画：同一张画布被一道边框分成两格，读者从上往下读。两格讲同一件事的两层，不是两件不相干的事。',
    '',
    `1. 构图 tag 必须写全这三个，原样照抄（含权重写法），一个都不能少，紧跟人数 tag、排在外貌之前：${compositionTags('regular')}。` +
      ' 不要写 panel layout、comic panel、manga（0 帖空 tag）；也不要写 comic（整本漫画语义，会拉成黑白网点）。',
    '2. 两格讲同一件事的两层，二选一，一张图里不许混用：**递进**（上格动作前、下格结果）或 **拆解**（同瞬间，上格全身空间、下格推近脸或接触点；两格人物停在同一动作）。',
    '3. 两格之间至少要有两个肉眼可辨的差异（人在做的事、画面里的东西、远近）；只有一个差异会被当噪声抹平。',
    '4. 景别 tag 仍然只写一个，用 cowboy shot 或 full body；两格各自的远近写在 nl 里。',
    '5. 两格里出现的人必须一致，同一个人在两格保持同一套外观词。',
    '6. 画幅写 portrait：上下两格各占一半高度，从上到下读。不要写 landscape。',
    '7. focus tag 属于整张图、不分格，全图最多 1~2 个。',
    PANEL_FORBIDDEN_CLAUSE,
    ninth,
  ].join('\n');
}

function irregularRule(nlOn: boolean): string {
  const ninth = nlOn
    ? '9. nl 必须按格写，并先说清版面：先用一句总述场景与画布怎么分（例："An irregular comic page: one large panel filling the upper two-thirds, and two narrow panels side by side along the bottom, separated by thin black gutters."），再逐格写。'
    : '9. 本次没有 nl 通道，不规则分格全靠 tag：让人物动作在大小不同的格里发生变化，不要写 Panel 1 / Panel 2 编号。';
  return [
    '[漫画分镜｜不规则分格]',
    '',
    '这一张是不规则分格的单张漫画，不是等分双格：画布被边框切成大小不等的几格，从上往下、从左往右读。所有格讲同一件事的不同层。',
    '',
    `1. 构图 tag 必须写全这两个，原样照抄（含权重写法）：${compositionTags('irregular')}。` +
      ' 不要写 2koma（钉成等分两格，与本模式打架）、4koma、panel layout、comic panel、manga、comic。',
    '2. 2～4 格，大小必须不等：至少一格面积是另一格的两倍以上，或有一格细长条。禁止上下各一半 / 左右各一半等分。三种形态择一：大格+下方两条小格 / 左侧竖长条+右侧大格 / 上方宽格+下方一大一小。',
    '3. 所有格讲同一件事的不同层，相邻两格至少两个肉眼可辨的差异；同一批人出现在每一格。',
    '4. 读法必须顺：从上到下、从左到右。',
    '4a. 排版要满、白边要窄：格间只留细黑 gutter（约页宽 3%），人物画大撑到格边；所有格合计覆盖页面九成以上。',
    '5. 景别 tag 仍然只写一个；各格远近写在 nl 里。',
    '6. 画幅写 portrait：上方一大格占约三分之二高度，下方一到两条窄格；或左侧竖长条+右侧主格。不要上下各一半。',
    '7. focus tag 全图最多 1~2 个。',
    PANEL_FORBIDDEN_CLAUSE,
    ninth,
  ].join('\n');
}

function insetRule(nlOn: boolean): string {
  const ninth = nlOn
    ? '9. nl 第一句固定交代版面（例："A manga page on a white background: an unframed character illustration occupies the center with generous white space around it; a narrow wide panel with a thin black border across the top shows a close-up of their faces, and a small framed panel in the bottom right corner shows their intertwined hands."），再写人物动作、表情、姿态——不要写房间、家具、窗、街景。'
    : '9. 本次没有 nl 通道：白底人物为主，特写格内容只能靠 tag 表达，且不要写任何场景 tag。';
  return [
    '[漫画分镜｜人物漫画页（白底 + 特写框）]',
    '',
    '这一张是以人物为主的漫画页：白底为主，一张不加边框的人物插画放在页面中央、四周大量留白；只有特写小格才带细黑边框、浮在白边上。',
    '',
    `1. 构图 tag 写这两个，原样照抄：${compositionTags('inset')}。` +
      ' 不要写任何场景 tag（indoors、bed、classroom、window、street 一类全不要）；不要写 split screen、2koma/3koma/4koma、panel layout、comic panel、manga、comic。',
    '2. 版面：白底为主、以人物为主。绝不允许把画布均分成上下或左右两三块。',
    '3. 画面里只有人物，几乎没有场景：环境最多一两件小道具。tag 与 nl 都只写人物。',
    '4. 特写小格 1～2 个，带细黑边框浮在白边上：顶部横条（宽约全宽、高约 15~20%）装脸部特写；贴边小格（右侧或右下角、宽约三分之一）装手/接触点。小格来自主画面同一瞬间、同一套外观词。',
    '5. 景别 tag 仍然只写一个（cowboy shot 或 full body）；小格特写写在 nl 里。',
    '6. 画幅写 portrait：白底竖页，人物居中占主要位置；顶部横条贴上边缘，贴边小格在右下角。',
    '7. focus tag 全图最多 1~2 个。',
    PANEL_FORBIDDEN_CLAUSE,
    ninth,
    '额外自检：tag 里是否还有任何场景词？nl 里是否描述了房间、家具、窗、街景？有就删掉。',
  ].join('\n');
}

function unframedRule(nlOn: boolean, pageType: PanelPageType): string {
  const pt = normalizePanelPageType(pageType);
  const specLine = pt === 'auto'
    ? '2. 版面从 A（顶条+主画+右下格）/ B（顶条+主画）/ C（右缘竖格+主画）/ D（主画+右下浮格）四种页型里按剧情挑一种；默认 A，只需一处特写用 B 或 D，竖构图特写用 C，相邻两次出图尽量换型。不许自创第五种。'
    : `2. 版面钉死为 ${pt.toUpperCase()} 型：${UNFRAMED_PAGE_SPECS[pt].areas.join('、')}。不许自创其它版式。`;
  const ninth = nlOn
    ? `9. nl 第一句按页型照抄对应句式（${pt === 'auto' ? '见四种页型首句' : UNFRAMED_PAGE_SPECS[pt].nlHeadline}），之后逐区写；最后必须收一句："The layout covers almost the whole page with only narrow white margins; only the inset panel(s) have thin black borders, and the main illustration has absolutely no panel border, with no rectangular border around the characters."`
    : '9. 本次没有 nl 通道：白底无框主画靠 tag 表达，特写格只做安静的放大镜。';
  return [
    '[漫画分镜｜无框漫画页（白底 + 大幅无框主画 + 带框特写格）]',
    '',
    '这一张是以人物为主的漫画页：白底为主，主插画无边框、铺到页底，特写格才带细黑边框。',
    '',
    `1. 构图 tag 必须原样照抄：${compositionTags('unframed')}。`,
    specLine,
    '铁律：主插画周围绝对没有长方形画框；带细黑边框的只有特写格；人物自然融入白色空间，周围不许出现任何圈住它的线。',
    '3. 场景词最多两个，只用来定室内外：一个 indoors 或 outdoors 锚点（必须有）+ 最多一个具体地点；家具、物件、光照、时段词一个都不要。',
    '4. 所有格讲同一个瞬间的三个层：主插画管"发生了什么"，顶部条管"脸上的表情"，右下格管"放大哪一处细节"；人物在所有格同一套外观词。',
    '5. 特写格防崩：顶部条优先一个人的脸，右下格只装一个局部；格内构图简单到一句话说完；复杂动作全放主插画。',
    '5a. 人物主体句式：tag 里写 `2::大型电影式<这一楼的人物动作>构图::`，再写 `富有表现力的肢体语言`。',
    '6. 画幅写 portrait：白底竖页，按所选页型排；人物身体或手臂至少一处延伸到页面边缘之外。',
    '7. focus tag 全图最多 1~2 个。',
    PANEL_FORBIDDEN_CLAUSE,
    ninth,
    '额外自检：场景词是否最多两个？nl 是否逐区写了页面百分比？主插画人物是否写大（占面积八成以上）？nl 结尾是否有"只有特写格有边框"的收束句？页面是否太空？',
  ].join('\n');
}

// ============================================================
// buildPanelRule（§4.1 / §6.12）
// ============================================================

export interface PanelRuleOptions {
  backend?: 'nai' | 'comfyui' | 'other';
  charPrompts?: boolean;
  nl?: boolean;
  lockedSize?: 'portrait' | 'landscape' | 'square' | string;
  layout?: PanelLayout;
  pageType?: PanelPageType;
  dialogue?: boolean;
  dialogueMode?: 'json' | 'tag';
  dialoguePolicy?: DialoguePolicy;
}

/**
 * 构建分镜规则文本。关闭时立即返回空串（一字不追加）。
 * 规则 + 自检 + （可选）台词条款；仅 NAI + 角色块时追加"不写 pos"。
 */
export function buildPanelRule(enabled: boolean, options: PanelRuleOptions): string {
  if (!enabled) return '';
  const layout = normalizePanelLayout(options.layout);
  const nlOn = options.nl !== false;
  const pageType = normalizePanelPageType(options.pageType);

  let body: string;
  switch (layout) {
    case 'irregular': body = irregularRule(nlOn); break;
    case 'inset': body = insetRule(nlOn); break;
    case 'unframed': body = unframedRule(nlOn, pageType); break;
    case 'regular':
    default: body = regularRule(nlOn); break;
  }

  const parts: string[] = [body, PANEL_SELF_CHECK];
  if (options.backend === 'nai' && options.charPrompts === true) {
    parts.push(PANEL_NO_POS_CLAUSE);
  }
  if (options.dialogue === true) {
    parts.push(panelDialogueClause(options.dialogueMode ?? 'json', normalizeDialoguePolicy(options.dialoguePolicy)));
  }
  return parts.join('\n\n');
}

// ============================================================
// LLM 结构化 JSON → ComicPagePlan（纯解析）
// ============================================================

/** 解析结果：容错，坏数据不抛异常，尽量保留可用部分。 */
export interface ParseComicPagePlanResult {
  pages: ComicPagePlan[];
  warnings: string[];
}

function normalizeCharacters(raw: unknown): Array<{ name: string; act: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ name: string; act: string }> = [];
  for (const c of raw.slice(0, 12)) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
    const o = c as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim().slice(0, 32) : '';
    const act = typeof o.act === 'string' ? o.act.trim().slice(0, 80) : '';
    if (name) out.push({ name, act });
  }
  return out;
}

function normalizePanel(raw: unknown, index: number): ComicPanelPlan | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const tags = typeof o.tags === 'string' ? o.tags.trim().slice(0, 2000) : '';
  if (!tags && !Array.isArray(o.dialogue)) return null;
  return {
    index: typeof o.index === 'number' && Number.isFinite(o.index) ? Math.max(0, Math.floor(o.index)) : index,
    title: typeof o.title === 'string' ? o.title.trim().slice(0, 120) : `第 ${index + 1} 格`,
    characters: normalizeCharacters(o.characters),
    mood: typeof o.mood === 'string' ? o.mood.trim().slice(0, 120) : '',
    tags,
    ...(typeof o.nl === 'string' && o.nl.trim() ? { nl: o.nl.trim().slice(0, 2000) } : {}),
    ...(() => {
      const dialogue = normalizeDialogueItems(o.dialogue);
      return dialogue.length ? { dialogue } : {};
    })(),
  };
}

function normalizePage(raw: unknown, pageIndex: number, warnings: string[]): ComicPagePlan | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(`第 ${pageIndex + 1} 页不是对象，已跳过`);
    return null;
  }
  const o = raw as Record<string, unknown>;

  // 页级字段：一张图 = 一页，tag / nl / 台词都写在页上（格只是内容索引）
  const pageTags = typeof o.tags === 'string' ? o.tags.trim().slice(0, 4000) : '';
  const pageNl = typeof o.nl === 'string' ? o.nl.trim().slice(0, 4000) : '';
  const pageDialogue = normalizeDialogueItems(o.dialogue);

  const rawPanels = Array.isArray(o.panels) ? o.panels : [];
  const panels: ComicPanelPlan[] = [];
  for (let i = 0; i < Math.min(rawPanels.length, 12); i += 1) {
    const panel = normalizePanel(rawPanels[i], i);
    if (panel) panels.push(panel);
    else warnings.push(`第 ${pageIndex + 1} 页第 ${i + 1} 格数据无效，已跳过`);
  }

  // 有页级 tag 才算有效页；只给空格子的页仍然跳过
  if (!pageTags && panels.length === 0) {
    warnings.push(`第 ${pageIndex + 1} 页既没有 tags 也没有有效分格，已跳过`);
    return null;
  }

  return {
    pageIndex: typeof o.pageIndex === 'number' && Number.isFinite(o.pageIndex)
      ? Math.max(0, Math.floor(o.pageIndex)) : pageIndex,
    title: typeof o.title === 'string' ? o.title.trim().slice(0, 120) : `第 ${pageIndex + 1} 页`,
    layout: normalizePanelLayout(o.layout),
    ...(pageTags ? { tags: pageTags } : {}),
    ...(pageNl ? { nl: pageNl } : {}),
    ...(pageDialogue.length ? { dialogue: pageDialogue } : {}),
    panels,
  };
}

/**
 * 容错解析 LLM 结构化输出 → ComicPagePlan[]。
 * 接受：{pages:[...]} / 单页对象 / 页数组 / 带 markdown 代码围栏的 JSON 字符串。
 * 坏 JSON 返回空 pages + warning，不抛异常。
 */
export function parseComicPagePlan(input: unknown): ParseComicPagePlanResult {
  const warnings: string[] = [];
  let data: unknown = input;

  if (typeof data === 'string') {
    const trimmed = data.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1].trim() : trimmed;
    try {
      data = JSON.parse(candidate);
    } catch {
      return { pages: [], warnings: ['JSON 解析失败，台词/分镜数据已丢弃'] };
    }
  }

  let rawPages: unknown[] = [];
  if (Array.isArray(data)) {
    rawPages = data;
  } else if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>;
    if (Array.isArray(o.pages)) rawPages = o.pages;
    else if (Array.isArray(o.panels)) rawPages = [data]; // 单页对象
    else if (o.comic && typeof o.comic === 'object') {
      const inner = o.comic as Record<string, unknown>;
      if (Array.isArray(inner.pages)) rawPages = inner.pages;
    }
  }

  if (rawPages.length === 0) {
    return { pages: [], warnings: [...warnings, '未找到 pages / panels 数组'] };
  }

  const pages: ComicPagePlan[] = [];
  for (let i = 0; i < Math.min(rawPages.length, 8); i += 1) {
    const page = normalizePage(rawPages[i], i, warnings);
    if (page) pages.push(page);
  }
  return { pages, warnings };
}
