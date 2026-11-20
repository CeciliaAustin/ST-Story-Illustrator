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
  PanelLayoutChoice,
  PanelPageType,
  DialoguePolicy,
  PanelBubbleArea,
  ComicDialogue,
  ComicPanelPlan,
  ComicPagePlan,
  ComicComposition,
  ComicBeat,
} from '../types';
import { stripThinkingBlocks } from '../prompt/think';
import { resolveOutfits } from '../baibai/outfit';
import { parseLayoutPlan, parseVisualDirection } from './layoutPlan';
import type { StatusOutfit } from '../types';

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

/**
 * 连续性优先条款（任务书 §1，最高优先级）。
 *
 * 用户反馈「一页把两三个不连续的瞬间拼在一起、台词也不连贯」。根因是旧规则
 * 只强调「相邻两格要有差异」，模型为了制造差异就跳到选段里另一件事、另一个
 * 时间。这里把**时间/事件连续**立为最高约束，差异只允许在同一瞬间内部通过
 * 镜头切面制造，绝不允许靠跳时、跳地点、换事件来制造。
 */
const CONTINUITY_CLAUSE =
  '【连续性——这是最高优先级，压过下面一切构图/差异要求】\n' +
  '一页只画**一个连续的瞬间**（one continuous beat），不是把选段里几个精彩时刻各摘一格拼成剧情摘要。\n' +
  '- 所有格属于同一时间、同一地点（或明确同步的分屏）、同一件事。**禁止**第一格在早上第二格到晚上、' +
  '第一格在房间第二格到街道、第一格争吵第二格几小时后和好。\n' +
  '- 格与格只能切换**观察角度**：同一动作的不同景别、某人的眼睛/手/嘴角局部、交叠的手、被推过来的物件。' +
  '可以静止不动只换镜头，不要求每格都发生新动作。\n' +
  '- 允许紧邻的极短动作连续（起势 → 接触 → 即时反应），但不得跨越明显的剧情阶段。\n' +
  '- 前后文只用来理解人物关系和代词，**不得**把前后文的事件画进本页。\n' +
  '- 允许只画一个片段、一个表情、一个局部或一个道具，不强制每页都要「环境—动作—反应」齐全。\n' +
  '- 判定标准：读者把几格连起来，应当觉得镜头在**同一件事上移动**，而不是剧情跳了一刀。';

/** 输出前自检通用条款（§3.2 + 任务书 §7.3，去掉「相邻差异」旧自检）。 */
const PANEL_SELF_CHECK =
  '【输出前自检，逐条核对后再输出】\n' +
  '- 本页所有格是不是**同一个连续瞬间**？有没有任何一格跳了时间、地点或事件？（有就重写那一格）\n' +
  '- 台词是不是都出自本页这一段、按原文顺序？有没有为了热闹编对白或改旁白？\n' +
  '- 每格人物数量是否符合**这一格自己的镜头**（单人局部/双人局部/物件都合法），而不是把整页名单复制进每格？\n' +
  '- 有没有一个主视觉格，其余格提供表情/手/局部/道具等补充信息？\n' +
  '- 版面有没有主次、有没有一处明确留白？是不是所有格都被画成了同样大小？\n' +
  '- 阅读顺序是否清楚？tag 里是否原样包含了本档构图词（含权重）？景别 tag 是否只有一个？\n' +
  '- 这是漫画分镜图，不是一张普通插画。任何一条不满足，就重写再输出。';

/**
 * 分镜的「艺术性」条款（任务书 §7.3 重写）：每格镜头切面不同，但**不要求事件不同**。
 * 镜头变化靠景别/构图/局部，不靠跳时换事件。
 */
const PANEL_ART_CLAUSE =
  '【分镜设计（在同一瞬间里做出镜头美感，不是换事件）】\n' +
  '- **镜头距离要有分配**：整页至少一格交代空间（wide shot / full body），至少一格推近' +
  '（close-up / extreme close-up：脸、手、接触点、关键道具）。相邻格尽量不同景别——' +
  '这是**镜头**的差异，不是时间的跳跃。\n' +
  '- **每格的信息点不同**：主画面 / 表情反应 / 手部或局部 / 关键道具，按这一瞬间里真实存在的东西挑。' +
  '一格只有一只手、一张嘴、一件物品都完全合法。\n' +
  '- **每格人物数量由这一格的镜头决定**：单人、双人、双人局部、纯物件都可以，' +
  '不要把所有出场人物都塞进每一格。某一格只出现一个人（甚至没有人）是对的。\n' +
  '- **每格都要写 nl**（一句，20~35 词），写清：镜头距离 + 谁在画面哪一侧 + 这一瞬间他在做什么 + 空白留在哪。\n' +
  '- **留白是版面的一部分**：至少留一处明确的空白/负空间，格间 gutter 可宽可窄、' +
  '主画面与小格之间可留大块空白；不要把所有格铺成同尺寸矩形填满整页。\n' +
  '- **人物大小要有主次**：主视觉格里人或脸大，特写格只放大一处；' +
  '不要每格都是同样的半身居中、同样的面积。';

/** 分格图不写角色坐标（仅 NAI + 角色块时追加，双保险）。 */
const PANEL_NO_POS_CLAUSE =
  '分格图不需要 pos：NAI 的坐标是整张图的坐标系，一格里的角色会被拉到整图某个位置、也就是被拉出格子。这个字段整个省略。';

function compositionTags(layout: PanelLayout): string {
  return PANEL_TAGS_BY_LAYOUT[layout].join(', ');
}

/**
 * 这一页到底切几格。
 *
 * 用户设了 2/3/4 就用它；设 0（自动）时只有「规整」档能确定（2 格），
 * 其余三档由页型自己决定，返回 0 表示「不要用数字去约束模型」。
 * 「自动档」同理：模型自己挑版面也自己定格数，代码不插一个数字进去。
 */
export function resolvePanelsPerPage(layout: PanelLayoutChoice, value?: number): number {
  const v = Number(value);
  if (Number.isFinite(v) && v >= 2 && v <= 4) return Math.round(v);
  if (normalizeLayoutChoice(layout) === 'auto') return 0;
  return normalizePanelLayout(layout) === 'regular' ? 2 : 0;
}

/**
 * 按格数取构图词。
 *
 * regular 档的默认是 2koma；用户选 3/4 格时还发 2koma，模型只会画两格，
 * 剩下的内容全挤在第二格里——这就是「切页乱了」的机械原因。
 */
export function panelTagsForCount(layout: PanelLayout, count: number): readonly string[] {
  const kind = normalizePanelLayout(layout);
  // 用户钉死了 2/3/4 格：把对应 koma 数词注入，否则模型经常少画格（选 3 只画 2）。
  // 旧版只给 regular 档注入，irregular/inset/unframed 钉格数时没有任何数字词 → 漏格。
  if (count >= 2 && count <= 4) {
    const base = PANEL_TAGS_BY_LAYOUT[kind];
    const koma = `1.4::${count}koma::`;
    // 保留原有构图词的顺序（multiple views 仍排第一，测试与柏宝绘原版都依赖它），
    // 只把 koma 数词替换进去或追加到末尾——位置不影响判重，却能压住实际格数。
    if (base.some(tag => /\d+koma/.test(tag))) {
      return base.map(tag => (/\d+koma/.test(tag) ? koma : tag));
    }
    return [...base, koma];
  }
  return PANEL_TAGS_BY_LAYOUT[kind];
}

// ============================================================
// 归一化入口（脏设置 / 模型输出 → 白名单）
// ============================================================

export function normalizePanelLayout(v: unknown): PanelLayout {
  return v === 'irregular' || v === 'inset' || v === 'unframed' ? v : 'regular';
}

/** 档位或「自动」。脏值一律当自动——它不会写错构图词，只是把选择权交给模型。 */
export function normalizeLayoutChoice(v: unknown): PanelLayoutChoice {
  return v === 'regular' || v === 'irregular' || v === 'inset' || v === 'unframed' ? v : 'auto';
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
  /** 原文台词候选序号（台词 100% 引用）；出图前由 sourceDialogue 回填成逐字原文。 */
  sourceIndex?: number;
  /** 模型自带的 text 只作定位，回填时用于逐字命中原文。 */
  quote?: string;
  exactText?: string;
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

    // 台词引用字段：原文回填的依据，必须原样保留。
    // quote / exactText 不 trim 内部、不截断，否则逐字命中会失败。
    const sourceIndex = typeof item.sourceIndex === 'number' && Number.isInteger(item.sourceIndex)
      && item.sourceIndex >= 0 && item.sourceIndex < 64
      ? (item.sourceIndex as number) : undefined;
    const quote = typeof item.quote === 'string' ? item.quote
      : typeof item.exactText === 'string' ? item.exactText : undefined;

    // 第几格。约定是 1 起，但模型看到 panels[].index 是 0 起，写成 0 很常见——
    // 这里把 0 也收下，由合成阶段统一判断整份是 0 起还是 1 起。
    const panelRaw = typeof item.panel === 'string' ? Number(item.panel) : item.panel;
    const panel = typeof panelRaw === 'number' && Number.isFinite(panelRaw) && panelRaw >= 0 && panelRaw <= 8
      ? Math.round(panelRaw)
      : undefined;

    const dirRaw = typeof item.dir === 'string' ? item.dir.trim().toLowerCase() : '';
    const dir = dirRaw === 'v' || dirRaw === 'h' ? (dirRaw as 'h' | 'v') : undefined;
    const moodRaw = typeof item.mood === 'string' ? item.mood.trim().toLowerCase() : '';
    const mood = moodRaw === 'shout' || moodRaw === 'whisper' || moodRaw === 'calm'
      ? (moodRaw as 'calm' | 'shout' | 'whisper')
      : undefined;

    items.push({
      ...(speaker ? { speaker } : {}),
      ...(area ? { area } : {}),
      ...(panel ? { panel } : {}),
      ...(x !== undefined ? { x } : {}),
      ...(y !== undefined ? { y } : {}),
      ...(dir ? { dir } : {}),
      ...(mood ? { mood } : {}),
      ...(sourceIndex !== undefined ? { sourceIndex } : {}),
      ...(quote ? { quote } : {}),
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
    portrait: 'A manga page on a white background: an unframed character illustration occupies the center with generous white space around it, and small panels framed by thin black borders — one across the top, one in the bottom right corner — show close-up details of the same moment, each small panel floating on the white page with a wide clean white gap between it and the main illustration, never touching the characters.',
    landscape: 'A manga page on a white background: an unframed character illustration occupies the center with generous white space around it, and small panels framed by thin black borders — one across the top, one along the right edge — show close-up details of the same moment, each small panel floating on the white page with a wide clean white gap between it and the main illustration, never touching the characters.',
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
    ? '页对象上加 `dialogue` 字段，形如 `[{"text":"放学一起走吗？","speaker":"旁白里的名字","panel":2,"area":"tl"}]`'
    : '在该条生图标签里写子标签 `<dialogue>[{"text":"放学一起走吗？","speaker":"名字","panel":2,"area":"tl"}]</dialogue>`';
  return `【对白气泡】这一张是漫画页，剧情里「谁说了什么」值得画进图时，${format}。
   - text：简短中文口语，一条不超过 20 个字；最多 4 条，${DIALOGUE_POLICY_TEXT[policy]}；
   - panel：这一句出现在**第几格**（1 起，按阅读顺序）。气泡只会画在这一格里，
     所以必须和该格 characters 里说话的人对得上；分不清就省略，省略时按顺序分配；
   - speaker：说话人的名字（照抄 characters 里的写法）。不会画进气泡，只用来定位；
   - area：气泡在本格里的粗略方位（tl/tc/tr/ml/mr/bl/bc/br），按说话人位置挑，可省略；
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
    '2. 两格是**同一个连续瞬间**的两个切面，不许拼两件事：上格交代空间与全身，下格推近脸、手、接触点或道具；也可以是同一静止瞬间的两个观察角度。',
    '3. 两格靠**镜头**拉开（远近、机位、局部），不是靠跳时间或换事件；同一动作画两遍也可，只要景别/局部不同。',
    '4. 景别 tag 仍然只写一个，用 cowboy shot 或 full body；两格各自的远近写在 nl 里。',
    '5. 每格只放这一格镜头里真正入镜的人（可以只有一只手、一张脸）；入镜的人保持同一套外观词。',
    '6. 画幅写 portrait：上下两格各占一半高度，从上到下读。不要写 landscape。',
    '7. focus tag 属于整张图、不分格，全图最多 1~2 个。',
    PANEL_FORBIDDEN_CLAUSE,
    ninth,
  ].join('\n');
}

/**
 * 规整档但用户指定了 3/4 格。
 *
 * 不是把 irregular 搬过来：规整档要的是「等分、满版、格间细 gutter」，
 * irregular 要的是「大小不等」。这里只把格数与版面说清楚，其余沿用规整档口径。
 */
function regularMultiRule(nlOn: boolean, count: number): string {
  const n = count >= 4 ? 4 : 3;
  const shape = n === 4
    ? '上方两格、下方两格（2×2 四等分，每格约占页面四分之一）'
    : '上方一条宽格（约页面 40% 高度），下方左右两个等宽格';
  const leads = n === 4
    ? '"In the top-left panel, ..." / "In the top-right panel, ..." / "In the bottom-left panel, ..." / "In the bottom-right panel, ..."'
    : '"In the upper panel, ..." / "In the lower left panel, ..." / "In the lower right panel, ..."';
  const ninth = nlOn
    ? `9. nl 必须按格写：先一句总述版面（${n} 格怎么分），之后逐格一句，用 ${leads} 这类句式。不要用 Panel 1 / Panel 2 编号，也不要写对白。`
    : '9. 本次没有 nl 通道：格内容只能靠 tag 表达，让人物动作在格与格之间发生变化。';
  return [
    `[漫画分镜｜一张画布切${n}格]`,
    '',
    `这一张是${n}格漫画，不是普通插画：同一张画布被细黑边框切成 ${n} 格，读者从上往下、从左往右读。所有格讲同一件事的不同层，不是${n}件不相干的事。`,
    '',
    `1. 构图 tag 必须写全这三个，原样照抄（含权重写法），一个都不能少，紧跟人数 tag、排在外貌之前：${compositionTags('regular').replace('2koma', `${n}koma`)}。`
      + ' 不要写 panel layout、comic panel、manga（0 帖空 tag）；也不要写 comic（整本漫画语义，会拉成黑白网点）。',
    `2. 版面：${shape}。格间留黑 gutter；允许一处宽留白、允许格子不顶到页边；不要把每格都撑满铺到边。`,
    '3. 所有格属于**同一连续瞬间**：靠镜头距离、机位、局部与道具区分，不靠跳时换事件；一格只有手/脸/物件都合法。',
    '4. 景别 tag 仍然只写一个，用 cowboy shot 或 full body；各格各自的远近写在 nl 里。',
    `5. 每格只放这一格镜头真正入镜的人；某一格只有一个人或没有人是对的，不要把全部出场者塞进每一格。`,
    `6. 画幅写 portrait：${n} 格按上面说的排法铺满整页。不要写 landscape。`,
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
    '2. 2～4 格，大小必须不等：至少一格面积是另一格的两倍以上，或有一格细长条。禁止上下各一半 / 左右各一半等分。**优先选主次骨架**：一个大主格 + 一到两个浮动特写小格（顶部横条 / 右下局部格），其余格服务主格。',
    '3. 所有格属于**同一连续瞬间**，靠镜头与局部区分，不是几件事的拼盘；每格只放这一格镜头真正入镜的人，不要把所有出场者复制进每格。',
    '4. 读法必须顺：从上到下、从左到右。',
    '4a. 留白是版面的一部分：主格与小格之间、页面边缘可以留明显空白/负空间；不要把所有格撑满铺到边、不要做成九成覆盖的满版。',
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
    '4. 特写小格 1～2 个，带细黑边框浮在白边上：顶部横条（宽约全宽、高约 15~20%）装脸部特写；贴边小格（右侧或右下角、宽约三分之一）装手/接触点。' +
      '**小格与主画之间必须留出宽白边**（至少约页高 5%、页宽 4% 的纯白），小格绝不贴着人物或主画边缘——挤在一起会糊成一坨，读者分不清哪格是哪格。' +
      '小格来自主画面同一瞬间、同一套外观词。',
    '5. 景别 tag 仍然只写一个（cowboy shot 或 full body）；小格特写写在 nl 里。',
    '6. 画幅写 portrait：白底竖页，人物居中占主要位置；顶部横条贴上边缘、与主画之间留白；贴边小格在右下角、与主画之间留白。',
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

/**
 * 自动档：版面由模型按剧情挑。
 *
 * 为什么要有这一档：四档各自的语言（等分/不等/白底/无框）对不懂分镜的人是黑话。
 * 写 tag 的模型刚读完这一段剧情，它比用户更清楚这一页该是「一问一答」还是
 * 「白底特写」。所以把选择权交给它，代码只负责在每一页上读回它选的档位，
 * 再用那一档的既定规则去纠正（enforce）与排气泡。
 *
 * 这一档最容易出的错是「四档混着写」：说了 regular 却在 nl 里写白底无框。
 * 所以规则里把四档的构图词逐字列出来，并要求 layout / panels / nl 三者一致。
 */
function autoRule(nlOn: boolean, panels: number): string {
  const table = [
    `- "regular"（规整等分）：构图词 ${compositionTags('regular')}。2 格上下等分；3 格是上方一条宽格 + 下方左右两格。适合「同一个动作的上下两拍」「一问一答」「递进（上格动作、下格结果）」，最稳、最容易画对，**有场景、有道具、有互动就用它**。`,
    `- "irregular"（大小不等拼版）：构图词 ${compositionTags('irregular')}。2～4 格，至少一格面积是另一格两倍以上。适合有主次的场面：一个大格交代全景，一到两个小格给反应或细节。禁止上下各一半这种等分。`,
    `- "inset"（白底人物页 + 带框特写格）：构图词 ${compositionTags('inset')}。白底、只有人物，**几乎没有场景**（环境最多一两件小道具）；2~3 个带细黑框的小格浮在白边上。**只有「纯情绪、纯独白、没有地点可画」的页才用它**；有餐厅/教室/街道这类明确地点时用它是错的，会把场景全删掉。`,
    `- "unframed"（白底无框大字插画 + 带框特写格）：构图词 ${compositionTags('unframed')}。主插画无边框、人物占画面八成以上、手臂伸到页外；只有特写格带框。最像日系漫画的跨页感，适合名场面、情绪爆点。`,
  ].join('\n');
  const ninth = nlOn
    ? '9. 先按你选的档位写 nl 的第一句版面句（regular/irregular 说清怎么分格、inset/unframed 说清白底主画与特写格的位置），再**逐格写一句该格自己的 nl**（镜头 + 谁在哪 + 在做什么 + 空白在哪）。不要用 Panel 1 / Panel 2 编号，不要写对白。'
    : '9. 本次没有 nl 通道：各格内容只能靠 tag 表达，让人物动作与镜头在格与格之间发生变化。';
  return [
    '[漫画分镜｜版面自选]',
    '',
    '这一张是一页漫画：一页 = 一张图，整页由 NovelAI 一次画成多格版面，不是一格一张图。',
    '',
    '1. **版面由你按剧情挑**，并在这一页的 `layout` 字段里写出你选的那一档（只能是下面四个值之一）：',
    table,
    '2. 挑法（按顺序判断）：① 这段有明确地点、道具、两人以上的互动 → **regular 或 irregular**，不要用白底档；' +
      '② 只有人、只有情绪、没有地点可画 → inset（白底为主）或 unframed（跨页感）；③ 拿不准 → regular。',
    '3. **格数跟随这一瞬间能提供的切面，不硬凑**：只有一个值得看的瞬间就用 2 格（主画面 + 一处特写），' +
      '有空间/接触/反应三个切面用 3 格，最多 4 格。素材只够两格就不要为了凑三格编出另一个瞬间——' +
      '把已有画面拆成主画面 + 局部/道具特写来补足格数。',
    '3a. 有台词的一页**不要为了留白换档位**：在 regular/irregular 里让人物偏下、格内上方留出安静空白就够了；' +
      '把有餐厅、教室、街道的页改成白底档，等于把剧情发生的世界全删了。',
    '3b. 留白是版面的一部分：让**一处主格大、其余格小**，主格与小格之间、页面边缘留明显空白/负空间；' +
      '不要把每格都做成同尺寸矩形、也不要铺满整页。版面优先「主画面 + 浮动特写格」的主次骨架。',
    panels >= 2
      ? `4. **每页固定 ${panels} 格**：不管选哪一档，版面都必须真的切出 ${panels} 格，panels 条数与 nl 分区句数也必须是 ${panels}。`
      : '4. 格数 2～4（默认 3）。**同一页的 layout、panels 条数、nl 里的分区句数必须三者一致**：说 3 格就真的画 3 格，不能拿两格模板套三段内容。',
    '5. 构图词只照抄你选的那一档那几行，原样保留 1.4:: 这类权重写法；**不要把两档的构图词混着写**（混写必然画出四不像的版面）。',
    '6. 多页时相邻两页不要用同一档，同一档也别连续画同样的格数，节奏会平。',
    '7. 景别 tag 整页只写一个；各格远近写在每格自己的 shot 与 nl 里。',
    '8. 每个入镜的人保持同一套外观词；focus tag 全图最多 1~2 个。' +
      '**人数按每格镜头实际需要写**：单人局部格就写一个人、双人互动格才写两个人、物件格不写人数；' +
      'page.tags 的人数词描述的是**主画面**，不要把全页出现过的所有人都数进去，更不要强制每格同人数。',
    PANEL_FORBIDDEN_CLAUSE,
    ninth,
  ].join('\n');
}

// ============================================================
// buildPanelRule（§4.1 / §6.12）
// ============================================================

export interface PanelRuleOptions {
  /** 每页固定格数（0/缺省 = 跟随档位） */
  panelsPerPage?: number;
  backend?: 'nai' | 'comfyui' | 'other';
  charPrompts?: boolean;
  nl?: boolean;
  lockedSize?: 'portrait' | 'landscape' | 'square' | string;
  layout?: PanelLayoutChoice;
  pageType?: PanelPageType;
  dialogue?: boolean;
  dialogueMode?: 'json' | 'tag';
  dialoguePolicy?: DialoguePolicy;
  /**
   * 新版面系统的导演指令（由 layoutDirective 生成）。给了就追加到规则末尾，
   * 让 LLM 输出 direction/layout。老调用方不传则行为完全不变。
   */
  layoutDirective?: string;
  /**
   * 逐格出图模式：一页 N 格各自单独生成一张图，页面由代码排版。
   * 这个模式下**不能**再往提示词里塞 koma / multiple views / white background 这类
   * 页级构图词——它们是"一张图画多格"的指令，用在单格图上只会画出格中格或丢掉背景。
   */
  perPanel?: boolean;
}

/**
 * 逐格出图模式的分镜规则。
 *
 * 与整页一次出图的根本区别：**每格是一张独立插画**。所以
 * - 页级构图词（koma / multiple views / split screen / white background）必须全部禁掉；
 * - 每一格都必须写出自己的场景（地点 + 光线），否则那一格会变成纯白底；
 * - 版面（主次、留白、格位）由代码排版，不需要模型操心。
 */
function perPanelRule(nlOn: boolean, panels: number): string {
  const countClause = panels >= 2
    ? `**每页固定 ${panels} 格**：panels 数组必须正好 ${panels} 条，一条就是一张图。`
    : '格数 2~4（默认 3）：panels 有几条就出几张图，不要为了凑数编出另一个瞬间。';
  return [
    '【分镜规则（逐格出图：一页多格，每格单独画一张，再由代码拼成一页）】',
    '0. **绝对不要写版面/分格词**：`koma`、`multiple views`、`split screen`、`white background`、' +
      '`simple background`、`comic page`、`manga`、`panel layout`、`asymmetric layout`。' +
      '每一格都是一张独立插画：写了这些词，单张图会变成"格中格"，或者整格失去背景变成大白底。',
    `1. ${countClause}`,
    '2. **每一格都必须自带完整场景**：每格 nl 里要写清「地点 + 光线 + 人物在做什么 + 镜头距离」。' +
      '同一页所有格是同一个地点（可以不同角度），但不许某一格只写"白底 + 人物"。',
    '3. page.tags 写这一页**共用的场景与共享动作**（地点、时间、光线、关键道具、两人之间的共享互动），' +
      '它会被代码带进每一格的图里。人物外貌、发色、瞳色、服装一律不写进 page.tags（走角色块）。',
    '4. 每格 shot 必须是 wide shot / medium shot / close-up / extreme close-up 里的一个；' +
      '同一页至少出现两种景别，让镜头真的在移动。',
    '5. 每格人物数量按这一格的镜头决定：单人、双人、双人局部、纯物件都合法，' +
      '不要把全页人物复制进每一格；一格只有一只手或一件道具完全正确。',
    '6. **留白与主次由代码排版**，你不用在 tags/nl 里描述留白、格位、页边。' +
      '你只要保证每一格本身是一张成立的单幅画。',
    nlOn ? '7. 每格 nl 用英文，一句 20~35 词；不要出现 panel / comic page / gutter 这类词。' : '',
  ].filter(Boolean).join('\n');
}

/**
 * 构建分镜规则文本。关闭时立即返回空串（一字不追加）。
 * 规则 + 自检 + （可选）台词条款；仅 NAI + 角色块时追加"不写 pos"。
 */
export function buildPanelRule(enabled: boolean, options: PanelRuleOptions): string {
  if (!enabled) return '';
  const choice = normalizeLayoutChoice(options.layout);
  const nlOn = options.nl !== false;
  const pageType = normalizePanelPageType(options.pageType);

  let body: string;
  if (options.perPanel === true) {
    body = perPanelRule(nlOn, resolvePanelsPerPage(choice, options.panelsPerPage));
  } else if (choice === 'auto') {
    // 自动档不钉版面；格数只有用户显式设了才钉（模型挑版面、用户定格数，两者不冲突）
    body = autoRule(nlOn, resolvePanelsPerPage('auto', options.panelsPerPage));
  } else {
    const layout = normalizePanelLayout(choice);
    const panels = resolvePanelsPerPage(layout, options.panelsPerPage);
    switch (layout) {
      case 'irregular': body = irregularRule(nlOn); break;
      case 'inset': body = insetRule(nlOn); break;
      case 'unframed': body = unframedRule(nlOn, pageType); break;
      case 'regular':
      default:
        body = panels >= 3 ? regularMultiRule(nlOn, panels) : regularRule(nlOn);
        break;
    }
  }

  // 连续性条款放最前：任务书 §1 要求它压过所有构图/差异/格数要求。
  const parts: string[] = [CONTINUITY_CLAUSE, body, PANEL_ART_CLAUSE, PANEL_SELF_CHECK];
  if (options.backend === 'nai' && options.charPrompts === true) {
    parts.push(PANEL_NO_POS_CLAUSE);
  }
  if (options.dialogue === true) {
    parts.push(panelDialogueClause(options.dialogueMode ?? 'json', normalizeDialoguePolicy(options.dialoguePolicy)));
  }
  // 新版面系统：导演指令放最后（它自带完整 schema 与硬边界）。
  if (options.layoutDirective) parts.push(options.layoutDirective);
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

function normalizeCharacters(raw: unknown): Array<{ name: string; act: string; look?: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ name: string; act: string; look?: string }> = [];
  for (const c of raw.slice(0, 12)) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
    const o = c as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim().slice(0, 32) : '';
    const act = typeof o.act === 'string' ? o.act.trim().slice(0, 80) : '';
    const look = typeof o.look === 'string' ? o.look.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
    if (!name) continue;
    // 外貌只收英文：中文描述进 NAI 等于没写
    out.push(act ? { name, act, ...(look && /[A-Za-z]/.test(look) && !/[\u3400-\u9fff]/.test(look) ? { look } : {}) }
                 : { name, act: '', ...(look && /[A-Za-z]/.test(look) && !/[\u3400-\u9fff]/.test(look) ? { look } : {}) });
  }
  return out;
}

/**
 * 这一页的档位。
 *
 * 模型在 `layout` 字段里给的可信就用它；没给（或写脏）时不能一律当 regular：
 * 4 段内容套 2koma 的等分几何，气泡会被排进根本不存在的格子里。
 * 用户钉死了档位就跟随用户；自动档则按格数推：≥3 格当拼版（几何未知 → 整页排气泡，
 * 交给像素空白的打分去落位），2 格当规整双格（几何确定，格内排气泡）。
 */
function normalizePageLayout(
  raw: unknown,
  panelCount: number,
  fallback?: PanelLayout,
): PanelLayout {
  if (raw === 'regular' || raw === 'irregular' || raw === 'inset' || raw === 'unframed') return raw;
  if (fallback) return fallback;
  return panelCount >= 3 ? 'irregular' : 'regular';
}

const COMPOSITIONS: readonly ComicComposition[] = [
  'single', 'single_detail', 'duo', 'duo_detail',
  'object', 'environment_detail', 'split_scene',
];

function normalizeComposition(raw: unknown): ComicComposition | undefined {
  return typeof raw === 'string' && (COMPOSITIONS as readonly string[]).includes(raw.trim())
    ? raw.trim() as ComicComposition
    : undefined;
}

function normalizeBeat(raw: unknown): ComicBeat | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown, max: number): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
  const beat: ComicBeat = {};
  const timeScope = str(o.timeScope, 80);
  const location = str(o.location, 80);
  const event = str(o.event, 200);
  const continuityNote = str(o.continuityNote, 200);
  if (timeScope) beat.timeScope = timeScope;
  if (location) beat.location = location;
  if (event) beat.event = event;
  if (continuityNote) beat.continuityNote = continuityNote;
  if (Array.isArray(o.dialogueOrder)) {
    const order = o.dialogueOrder.filter(s => typeof s === 'string').map(s => String(s).slice(0, 60)).slice(0, 8);
    if (order.length) beat.dialogueOrder = order;
  }
  return Object.keys(beat).length ? beat : undefined;
}

function normalizePanel(raw: unknown, index: number): ComicPanelPlan | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const tags = typeof o.tags === 'string' ? o.tags.trim().slice(0, 2000) : '';
  if (!tags && !Array.isArray(o.dialogue)) return null;
  return {
    index: typeof o.index === 'number' && Number.isFinite(o.index) ? Math.max(0, Math.floor(o.index)) : index,
    title: typeof o.title === 'string' ? o.title.trim().slice(0, 120) : `第 ${index + 1} 格`,
    ...(() => { const c = normalizeComposition(o.composition); return c ? { composition: c } : {}; })(),
    characters: normalizeCharacters(o.characters),
    mood: typeof o.mood === 'string' ? o.mood.trim().slice(0, 120) : '',
    ...(typeof o.shot === 'string' && o.shot.trim() ? { shot: o.shot.trim().slice(0, 60) } : {}),
    ...(typeof o.subject === 'string' && o.subject.trim() ? { subject: o.subject.trim().slice(0, 200) } : {}),
    tags,
    ...(typeof o.nl === 'string' && o.nl.trim() ? { nl: o.nl.trim().slice(0, 2000) } : {}),
    ...(() => {
      const dialogue = normalizeDialogueItems(o.dialogue);
      return dialogue.length ? { dialogue } : {};
    })(),
  };
}

function normalizePage(
  raw: unknown,
  pageIndex: number,
  warnings: string[],
  fallbackLayout?: PanelLayout,
): ComicPagePlan | null {
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
    layout: normalizePageLayout(o.layout, panels.length, fallbackLayout),
    ...(() => { const b = normalizeBeat(o.beat); return b ? { beat: b } : {}; })(),
    ...(pageTags ? { tags: pageTags } : {}),
    ...(pageNl ? { nl: pageNl } : {}),
    ...(pageDialogue.length ? { dialogue: pageDialogue } : {}),
    panels,
  };
}

/**
 * 连续性体检（任务书 §6 / §7.3）：把「跳时 / 台词乱序 / 空格凑数」变成可见 warning。
 * 不丢弃任何页（宽松），只在预览/日志里提示，让模型重问或用户改选段。
 */
export function validateComicContinuity(pages: readonly ComicPagePlan[]): string[] {
  const warnings: string[] = [];
  const JUMP_WORDS = /(later|afterwards|hours later|next (?:day|morning|night)|another (?:scene|day)|yesterday|tomorrow|第二天|几小时后|第二天早上|后来|隔天)/i;
  pages.forEach((page, pi) => {
    const prefix = `第 ${pi + 1} 页`;
    // 跳时词：出现在 nl / beat 里就要复核（"later" 出现在对话引用里也可能误报，故只提示）
    const nlText = [page.nl, ...(page.panels ?? []).map(p => p.nl ?? '')].join(' ');
    if (JUMP_WORDS.test(nlText)) {
      warnings.push(`${prefix}的画面描述里出现跳时词（later/几小时后…），请确认它仍是同一个连续瞬间。`);
    }
    // 空格凑数：一格既没有 nl / 动作 / 信息点，台词也没有
    (page.panels ?? []).forEach((panel, i) => {
      const hasContent = Boolean(
        (panel.nl ?? '').trim() || (panel.subject ?? '').trim()
        || (panel.characters ?? []).some(c => (c.act ?? '').trim())
        || (panel.dialogue ?? []).length
        || (panel.tags ?? '').trim(),
      );
      if (!hasContent) warnings.push(`${prefix}第 ${i + 1} 格是空的（没有镜头/动作/道具），可能是在凑格数。`);
    });
    // 台词 panel 归属乱序：dialogue 里的 panel 号倒退
    const dlg = page.dialogue ?? [];
    let lastPanel = 0;
    let outOfOrder = false;
    for (const d of dlg) {
      if (typeof d.panel === 'number') {
        if (d.panel < lastPanel) outOfOrder = true;
        lastPanel = d.panel;
      }
    }
    if (outOfOrder) warnings.push(`${prefix}的台词格号前后倒退，请按阅读顺序检查对白归属。`);
  });
  return warnings;
}

export interface ParseComicOptions {
  /**
   * 用户钉死的版面档位。给了就覆盖模型的 `layout` 缺失情形——
   * 用户选了「规整四格」，模型漏写 layout 时不能按格数猜成拼版。
   */
  fallbackLayout?: PanelLayout;
  /**
   * 新版面系统：用户钉死的风格/格数，作为 layout 校验的硬约束。
   * 不传表示自由模式，LLM 可自选风格与格数。
   */
  layoutConstraints?: {
    expectedPanelCount?: number;
    styleLocked?: boolean;
    expectedStyle?: import('../types').ComicLayoutStyle;
  };
}

/**
 * 容错解析 LLM 结构化输出 → ComicPagePlan[]。
 * 接受：{pages:[...]} / 单页对象 / 页数组 / 带 markdown 代码围栏的 JSON 字符串。
 * 坏 JSON 返回空 pages + warning，不抛异常。
 */
export function parseComicPagePlan(
  input: unknown,
  options: ParseComicOptions = {},
): ParseComicPagePlanResult {
  const warnings: string[] = [];
  let data: unknown = input;

  if (typeof data === 'string') {
    // 思考块先剥掉：思维链里出现花括号会让下面的取 JSON 失败
    const trimmed = stripThinkingBlocks(data).trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1].trim() : trimmed;
    try {
      data = JSON.parse(candidate);
    } catch {
      return { pages: [], warnings: ['JSON 解析失败，台词/分镜数据已丢弃'] };
    }
  }

  // 本批定妆：模型在顶层 cast / outfits 里每人定一次着装，所有页共用同一串。
  // 不在这里解析，后面角色块就一件衣服都没有——正是「跟柏宝绘穿得不一样」的根因。
  let batchOutfits: StatusOutfit[] = [];
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const root = data as Record<string, unknown>;
    const parsed = resolveOutfits(root.outfits ?? root.cast);
    if (parsed.size) batchOutfits = [...parsed.values()].slice(0, 4);
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
    const page = normalizePage(rawPages[i], i, warnings, options.fallbackLayout);
    if (!page) continue;
    // 页自己写了 outfits 就用自己的；否则整批共用顶层那一份
    const raw = rawPages[i];
    const rawRecord = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as Record<string, unknown> : {};
    const own = resolveOutfits(rawRecord.outfits ?? rawRecord.cast);
    if (own.size) page.outfits = [...own.values()].slice(0, 4);
    else if (batchOutfits.length) page.outfits = batchOutfits.map(item => ({ ...item }));

    // 新版面系统 Stage A/B：解析方向 + 几何，硬约束来自用户设置（Step 3）。
    // 顶层 direction 是整批共用，页内 direction 覆盖；layout 只认页内。
    const directionRaw = rawRecord.direction ?? (data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>).direction : undefined);
    const direction = parseVisualDirection(directionRaw);
    if (direction) page.direction = direction;

    const parsedLayout = parseLayoutPlan(rawRecord, {
      ...(options.layoutConstraints ?? {}),
      ...(page.dialogue ? { dialogue: page.dialogue } : {}),
    });
    if (parsedLayout) {
      page.layoutPlan = parsedLayout.plan;
      // 校验不合格 → 变成可见 warning；plan 已就地做过安全修复（clamp/补排序）
      for (const e of parsedLayout.validation.errors) {
        warnings.push(`第 ${i + 1} 页版面：${e}`);
      }
      for (const f of parsedLayout.validation.fixes) {
        warnings.push(`第 ${i + 1} 页版面已自动修复：${f}`);
      }
    }
    pages.push(page);
  }
  warnings.push(...validateComicContinuity(pages));
  return { pages, warnings };
}
