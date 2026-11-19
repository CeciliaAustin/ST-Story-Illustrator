/**
 * ST-Story-Illustrator — 内置提示词（可见 / 可改）
 *
 * 为什么放在这里而不是散在各模块里：用户要能看到「插件到底对模型说了什么」，
 * 并且能改。以前这些文字硬编码在 prompts.ts / planPrompts.ts 里，
 * 想调一句话只能改代码、重新构建。
 *
 * 五套模板：
 *   illustration  正文插画（tag 计划）
 *   comic         正文漫画分镜（一页一张图）
 *   status        QQ 人状态栏
 *   bonus         QQ 人彩蛋
 *   manga         黑白漫小剧场
 *
 * theater 三套各有「单格 / 多格」两版，因为两者的输出契约不一样
 * （单格要一个对象、多格要 panels 数组），合并成一版会两头都不清楚。
 *
 * 模板语法见 prompt/template.ts：`{{name}}` / `{{#name}}…{{/name}}` / `{{^name}}…{{/name}}`。
 * 覆盖值存在 extension_settings 的 `promptOverrides`，键是 `id` 或 `id@many`。
 */

import { renderCompact, renderTemplate } from './template';

export type PromptDocId = 'illustration' | 'comic' | 'status' | 'bonus' | 'manga';
export type PromptVariant = 'single' | 'many';

export interface PromptDoc {
  id: PromptDocId;
  /** 标签页里的显示名 */
  label: string;
  /** 一句话说明它管什么 */
  hint: string;
  /** 模板里用到的变量（UI 上列出来，提醒别删） */
  vars: string[];
  /** 默认模板；many 缺省表示只有一版 */
  defaults: { single: string; many?: string };
}

/** 覆盖值：键 `id` = 单格版，`id@many` = 多格版。 */
export type PromptOverrideMap = Partial<Record<string, string>>;

export function overrideKey(id: PromptDocId, variant: PromptVariant): string {
  return variant === 'many' ? `${id}@many` : id;
}

// ============================================================
// 各套共用的片段
// ============================================================

const CAST_SCHEMA =
  '"cast":[{"name":"角色名（照抄库里的名字）","outfit":"English danbooru phrases: 这一整批共用的当前着装，版型+主色+关键配件（例如 white dress shirt, black slacks, loosened tie）"}]';

const OUTFIT_RULE =
  '`cast` 是本批的**服装定妆**：每个出场角色一条，`outfit` 用英文写清版型、主色、关键配件（white dress shirt, black pleated skirt, brown loafers）。'
  + '【角色固定外貌库】里该角色有「固定着装」时**照抄那一串，不要改写**；没有时按正文/角色卡/世界书定一次，正文没写就合理定一套具体的。'
  + '同一批所有格共用这一串，**不许因为这一格没提衣服就换一套**；正文明确换装/穿脱/衣物破损时才写新的那一套。'
  + '`characters[].act` 里**不要再写任何服装词**——服装只由 cast 提供，代码会把它拼到每一格。';

const COMMON_RULES = [
  '画面必须是正文里真的发生的那件事，不要编造没写过的动作，也不要画成「站着摆姿势」。',
  OUTFIT_RULE,
  'characters 里每一项的 act 是这张图的**主要信息**：用英文写这个角色在这一刻具体在做什么、和谁互动、手里拿着什么（例如 pulling the other\'s sleeve, leaning against the door, holding a broken cup）。',
  '只写 1girl / solo / standing / looking at viewer 这类空景词的图等于没画剧情——至少要有 3 条「动作或与场景互动」的 tag。',
  'characters 最多 2 项；两人互动时主动方和被动方 act 必须分开写。',
  'characters[].name **必须照抄【角色固定外貌库】里的名字**。正文里用「你」「他」「那个金发男生」或另一个叫法时，先判断指的是库里哪一位，再写库里的名字——名字写错就等于这个人没有外貌，会被画成路人。',
  'nl 里写两个人时必须用正文里的角色名当主语，禁止用 he/she/the man 泛指。',
  'tags 里必须交代这三件事：① 人数与互动；② 地点或环境（classroom / dormitory / arched corridor / street / outdoors）；③ 光线或时间（sunlight / backlighting / golden hour / night / indoor lighting）。',
  'characters[].act 只写「这个人」的动作、表情、以及和场景/道具的接触；外貌、发型、瞳色、服装由柏宝绘角色库提供，这里**绝对不要写**。',
  'nl 用英文自然语言写同一件事，不要分点、不要换行。',
  '禁止写：画风、画质（masterpiece / best quality / absurdres）、画师名、角色外貌与服装细节、负面词——这些由柏宝绘的方案负责。',
  '不要解释，不要 markdown 代码块，不要多余文字。',
].join('\n');

/** 有台词时的构图要求：把人物往下放，上方留出干净空间给气泡。 */
const SPEECH_ROOM_RULE =
  '有台词的那一格，nl 里要写明主角位于画面下半部或偏左右一侧、画面上方留出安静的空白（气泡会叠在那里）——人物头顶顶到画面上沿时，气泡只能盖在脸上。';

// ============================================================
// 五套默认模板
// ============================================================

const ILLUSTRATION = `你是一位专业的图像提示词（tag）编辑。你的任务是根据给定剧情，输出结构化的英文生图标签。
严格遵守：
1. 先按前面的规范在心里过一遍检查清单（要写出来就写在 <thinking>…</thinking> 里，并且必须闭合）；然后只输出一个 JSON 对象，JSON 之外不要任何解释文字、不要 Markdown 代码围栏。
2. 结构：{"segments":[{"id":"...","source":"character|scene|global","characterName":"角色名(仅character段)","english":["英文tag",...],"chinese":["中文辅助翻译",...],"order":数字}],"nl":"可选英文自然语言描述","negative":"可选英文负面词","size":"portrait|landscape"}。
3. english / nl / negative 必须是纯英文，绝不能出现中文——中文只放在 chinese 字段作辅助阅读。
4. character 段只写角色固定外貌（来自提供的角色快照，原样保留其 tag，不得改写）；scene 段写本次画面新增的动作、场景、构图、光线、情绪 tag。
5. 一次只策划一个明确的瞬间，不要描述整段剧情的时间跨度。
6. 场景与动作必须以给定剧情和上下文为依据，不得凭空添加关键剧情事实。
7. segment 按 order 从小到大排列；无需的字段直接省略，不要填空字符串或空数组。
8. 若剧情里的名场面适合漫画分镜，仍按单幅插画输出（漫画由专门的模式处理）。
9. 选段里出场的**每一个人**都要有自己的 character 段：name 照抄角色库里的名字，外貌照抄该条目的 tag（不改写、不合并）。漏掉一个人，图上就少一个人。
10. nl 必须写：英文 1~2 句，把「谁、在哪里、正在做什么」串起来——柏宝绘的 nl 通道决定这些细节能不能真的落在画面上。
{{#hasFlags}}
补充约束：
{{#noChinese}}不要生成 chinese 字段（用户已关闭中文辅助）。{{/noChinese}}
{{#noNl}}不要生成 nl 字段（当前后端不使用自然语言通道）。{{/noNl}}
{{#noNegative}}不要生成 negative 字段。{{/noNegative}}
{{#sizeClause}}画幅倾向：{{sizeClause}}。{{/sizeClause}}
{{/hasFlags}}`;

const COMIC = `你是一位漫画分镜编辑。你要输出的是**一张画布上一页漫画**的分镜计划：整页由 NovelAI 一次画成多格版面，而不是每格单独出一张图。
只输出一个 JSON 对象，不要解释文字、不要 Markdown 代码围栏。
结构：{"pages":[{"pageIndex":0,"title":"页标题(中文短语)","layout":"regular|irregular|inset|unframed","tags":"整页共用英文 tag，逗号分隔","nl":"英文分区描述","dialogue":[{"text":"中文台词","speaker":"说话人名字","panel":1,"area":"tl|tr|bl|br","dir":"v","mood":"whisper"}],"panels":[{"index":0,"title":"这一格画了什么(中文短语)","characters":[{"name":"角色","act":"动作"}],"mood":"氛围"}]}]}
硬要求：
1. 一页 = 一张图。整页 tag 只写在 page.tags 里，**不要按格分别写 tag**。
2. page.tags 必须写出：在场角色的外观（用给你的角色快照）、他们正在做什么、在哪里、画面里的关键物件。**人物和动作是画面主体**，只写构图词的图等于没画。
3. 构图词必须按【分镜规则】里该档的写法**原样照抄**（含 1.4:: 这类权重写法），少一个就不是漫画。
4. 景别 tag 整页只写一个（cowboy shot / upper body 之类），各格远近只写在 nl 里。
5. page.nl 必须分区写：第一句总述版面（几格、怎么分），之后每格一句，用 "In the upper panel, ..." / "The lower panel shows ..." 这类句式；不要用 Panel 1 / Panel 2 编号，不要写对白。
6. panels 数组只用来标「每一格画了什么」：{{#fixedPanels}}**每页固定 {{panelsPerPage}} 格**——panels 必须正好 {{panelsPerPage}} 条，nl 必须按 {{panelsPerPage}} 格分区写，版面也必须真的切出 {{panelsPerPage}} 格。{{/fixedPanels}}{{^fixedPanels}}2~4 条，title 是中文短标题（会印在卡片上），格数必须与 nl 里描述的一致；**版面必须真的切出这么多格**——说 three panels 就要画三格，不能拿两格模板套四段内容。{{/fixedPanels}}
7. dialogue 是中文口语台词，最多 4 条、每条 20 字内，不写旁白；台词不许写进 tags 或 nl。panel 字段是这句出现在第几格（1 起，按阅读顺序）——气泡只会画在那**一格**里，所以必须与该格 characters 里说话的人对得上；对不上就别写这句。speaker 写说话人名字（照抄 characters 里的名字）：它不会被画进气泡，只用来定位，写对了气泡才会贴着说话的人。
8. tags / nl 里绝对不允许出现 speech bubble、text、english text、dialogue、caption —— 画面里不能有字。
9. 有台词的页，nl 里要让人物偏下、上方留出干净空间给气泡；人物头顶顶到页边时气泡只能盖在脸上。
{{#hasRule}}

【分镜规则（必须遵守）】
{{panelRule}}
{{/hasRule}}

【输出约束】最多 {{maxPages}} 页；{{#dialogue}}dialogue 必须写：每页 2~3 条中文台词，取自这一段里真的说过的话；实在没有对白才用一句旁白式台词顶上。{{/dialogue}}{{^dialogue}}本次不要输出 dialogue 字段。{{/dialogue}}
{{#noChinese}}除台词外的辅助中文一律不要输出。{{/noChinese}}`;

const STATUS_SINGLE = `读一段角色扮演正文，把「这一楼最要紧的那一个画面」翻成一张插画，只输出一个 JSON 对象。
格式：{"title":"中文，14 字以内，这一楼发生了什么",${CAST_SCHEMA},"characters":[{"name":"出场角色名（照抄正文里的叫法）","act":"English danbooru phrases: what THIS character is doing this frame"}],"mood":"中文，6 字以内","tags":"10-16 个英文 danbooru 短 tag，逗号分隔","nl":"English, 1-2 sentences describing this frame"}
tags 里写互动词（couple / kiss / hug）与人数（1boy, 1girl 等）。
${COMMON_RULES}
景别只写 close-up / upper body / medium shot 里的一个（卡片是偏半身的构图，不要写 full body 或 wide shot）。
没有角色出场时输出 {"title":"","cast":[],"characters":[],"mood":"","tags":"","nl":""}。`;

const STATUS_MANY = `读一段角色扮演正文，把这一楼发生的事挑成 {{count}} 个先后画面，像一条小分镜，只输出一个 JSON 对象。
格式：{"title":"中文，14 字以内，这一楼讲了一件什么事",${CAST_SCHEMA},"panels":[{"title":"中文，14 字以内，这一格发生了什么","characters":[{"name":"出场角色名（照抄正文里的叫法）","act":"English danbooru phrases: what THIS character is doing this frame"}],"mood":"中文，6 字以内","tags":"10-16 个英文 danbooru 短 tag，逗号分隔","nl":"English, 1-2 sentences describing this frame"}]}
panels 按正文的时间顺序排列：第一格是这一楼的开头，最后一格是落点。
每一格必须是不同的瞬间：换动作、换位置、换张力。不许重复或拆格凑数；没那么多就少给几格（至少 1 格）。
${COMMON_RULES}
每格景别只写 close-up / upper body / medium shot 里的一个，相邻两格不要一样（卡片是偏半身构图，不要写 full body 或 wide shot）。
没有角色出场时输出 {"title":"","cast":[],"panels":[]}。`;

const BONUS_LINES = '"lines":[{"speaker":"说话角色名（照抄正文里的叫法）；旁白写「旁白」","text":"中文，20 字以内"}]';

const BONUS_SINGLE = `读一段角色扮演正文，忘掉它的剧情，只为其中的角色设计一个「平行宇宙彩蛋」：一段与正文剧情无关的架空小片段，只输出一个 JSON 对象。
格式：{"title":"中文，14 字以内，以「彩蛋：」开头",${CAST_SCHEMA},"characters":[{"name":"出场角色名","act":"English danbooru phrases: what THIS character is doing"}],"mood":"中文，6 字以内","tags":"10-16 个英文 danbooru 短 tag","nl":"English, 1-2 sentences",${BONUS_LINES}}
题材、场景、基调完全自由发挥：温馨日常、热血战斗、悬疑惊悚、虐心催泪、史诗冒险、荒诞搞笑都可以。唯一硬要求：角色必须是正文里的那几位，性格照旧。
每次都换花样：别落在咖啡店、甜品店这类用滥的套路里。
每格给 2~4 条 lines（对话/旁白），短句符合口吻；旁白 speaker 写「旁白」。只画一个画面。
彩蛋不是正文的延续：不要接着正文里刚发生的事画。
${COMMON_RULES}
${SPEECH_ROOM_RULE}`;

const BONUS_MANY = `读一段角色扮演正文，忘掉它的剧情，只为其中的角色设计一个「平行宇宙彩蛋」：一段与正文剧情无关的架空小片段，只输出一个 JSON 对象。
格式：{"title":"中文，14 字以内，以「彩蛋：」开头",${CAST_SCHEMA},"characters":[{"name":"出场角色名","act":"English danbooru phrases: what THIS character is doing"}],"mood":"中文，6 字以内","tags":"10-16 个英文 danbooru 短 tag","nl":"English, 1-2 sentences",${BONUS_LINES},"panels":[{"title":"中文，14 字以内，这一格发生了什么","characters":[{"name":"出场角色名","act":"English danbooru phrases: what THIS character is doing"}],"mood":"中文，6 字以内","tags":"10-16 个英文 danbooru 短 tag","nl":"English, 1-2 sentences","lines":[{"speaker":"说话角色名；旁白写「旁白」","text":"中文，20 字以内"}]}]}
题材、场景、基调完全自由发挥：温馨日常、热血战斗、悬疑惊悚、虐心催泪、史诗冒险、荒诞搞笑都可以。唯一硬要求：角色必须是正文里的那几位，性格照旧。
每次都换花样：别落在咖啡店、甜品店这类用滥的套路里。
每格给 2~4 条 lines（对话/旁白），短句符合口吻；旁白 speaker 写「旁白」。把彩蛋拆成最多 {{count}} 个先后画面（panels），按时间顺序，每格不同瞬间。
彩蛋不是正文的延续：不要接着正文里刚发生的事画。
${COMMON_RULES}
${SPEECH_ROOM_RULE}`;

const MANGA_BASE_RULES =
  '禁止写：黑白、网点、screentone、画风、角色外貌；也禁止 big head / chibi / super deformed 比例词（正常比例）。\n'
  + '禁止写 speech bubble / text / dialogue / caption / comic panel border —— 画面里不许出现任何文字、气泡或分格线。';

const MANGA_SINGLE = `读一段角色扮演正文，把「这一楼最有画面的那一个瞬间」画成一格黑白漫画，只输出一个 JSON 对象。
格式：{"title":"中文，14 字以内，这一格发生了什么",${CAST_SCHEMA},"characters":[{"name":"出场角色名（照抄正文里的叫法）","act":"English danbooru phrases: what THIS character is doing this frame"}],"mood":"中文，6 字以内","tags":"10-20 个英文 danbooru 短 tag，逗号分隔","nl":"English, 1-2 sentences describing this frame"{{#dialogue}},${BONUS_LINES}{{/dialogue}}}
${COMMON_RULES}
tags 里必须有一个景别，从这几类挑最合适的：extreme close-up / close-up / upper body / cowboy shot / full body / wide shot / medium shot / from above / from below / from side / dutch angle。按内容挑，多格时相邻两格景别不同。
**这一格必须画出正文里那个具体动作发生的场面**：谁、在哪里、正在做什么。除景别与表情外，至少要有一条「与场景互动的动作」tag（sitting on the bed / holding an umbrella / leaning against the wall / kneeling on the floor）和一条地点 tag（bedroom / classroom / street / outdoors …）。只有外貌、人数、表情的图会变成一张与剧情无关的头像。
${MANGA_BASE_RULES}
{{#dialogue}}每格给 1~3 条 lines：台词用中文短句、符合角色口吻，必须是正文里真的说过、或那一刻自然会说的话；旁白的 speaker 写「旁白」。台词由本地画成气泡叠在图上，**绝对不要写进 tags 或 nl**。
${SPEECH_ROOM_RULE}{{/dialogue}}
{{#safe}}这一格必须能公开发布：衣着完整，不画裸露、性行为、内衣特写、走光。挑能放到台面上的瞬间，用表情、留白、构图表达张力。tags 与 act 里不许出现 nude / nipples / underwear / sex 这类词。{{/safe}}
没有角色出场时输出 {"title":"","cast":[],"characters":[],"mood":"","tags":"","nl":""}。`;

const MANGA_MANY = `读一段角色扮演正文，把这一楼发生的事挑成最多 {{count}} 个先后画面，像一页黑白漫画的分格，只输出一个 JSON 对象。
格式：{"title":"中文，14 字以内",${CAST_SCHEMA},"panels":[{"title":"中文，14 字以内，这一格发生了什么","characters":[{"name":"出场角色名（照抄正文里的叫法）","act":"English danbooru phrases: what THIS character is doing this frame"}],"mood":"中文，6 字以内","tags":"10-20 个英文 danbooru 短 tag，逗号分隔","nl":"English, 1-2 sentences describing this frame"{{#dialogue}},${BONUS_LINES}{{/dialogue}}}]}
panels 按时间顺序排列；每一格必须是不同的瞬间（换动作、位置、张力），不许重复或拆格凑数，没那么多就少给几格。
${COMMON_RULES}
tags 里必须有一个景别：extreme close-up / close-up / upper body / cowboy shot / full body / wide shot 等；相邻两格景别不同。
**每一格都要画出正文里那一刻的场面**：谁、在哪里、正在做什么。除景别与表情外，每格至少一条「与场景互动的动作」tag（sitting on the bed / holding an umbrella / leaning against the wall）和一条地点 tag。只写外貌与人数的图会变成一页与剧情无关的头像。
${MANGA_BASE_RULES}
{{#dialogue}}每格给 1~3 条 lines：中文短句、符合角色口吻，按时间顺序连起来要能读懂这一楼发生了什么；旁白的 speaker 写「旁白」。台词由本地画成气泡叠在图上，**绝对不要写进 tags 或 nl**。
${SPEECH_ROOM_RULE}{{/dialogue}}
{{#safe}}每格必须能公开发布：衣着完整，不画裸露、性行为、内衣特写；用表情、留白、构图表达张力，tags 与 act 里不许出现 NSFW 词。{{/safe}}
没有角色出场时输出 {"title":"","cast":[],"panels":[]}。`;

export const PROMPT_DOCS: readonly PromptDoc[] = [
  {
    id: 'illustration',
    label: '正文插画',
    hint: '读选段 → 输出 tag 段（segment）与 nl。改字段名会导致解析失败。',
    vars: ['hasFlags', 'noChinese', 'noNl', 'noNegative', 'sizeClause'],
    defaults: { single: ILLUSTRATION },
  },
  {
    id: 'comic',
    label: '正文漫画分镜',
    hint: '一页一张图。{{panelRule}} 是系统按「分镜档位 / 页型 / 后端」注入的规则块，别删。',
    vars: ['hasRule', 'panelRule', 'maxPages', 'dialogue', 'noChinese', 'fixedPanels', 'panelsPerPage'],
    defaults: { single: COMIC },
  },
  {
    id: 'status',
    label: 'QQ 人状态栏',
    hint: '只画这一楼最要紧的一张。{{count}} 是多格模式要的格数。',
    vars: ['count'],
    defaults: { single: STATUS_SINGLE, many: STATUS_MANY },
  },
  {
    id: 'bonus',
    label: 'QQ 人彩蛋',
    hint: '架空小片段，与正文剧情无关，但人物性格照旧。',
    vars: ['count'],
    defaults: { single: BONUS_SINGLE, many: BONUS_MANY },
  },
  {
    id: 'manga',
    label: '黑白漫小剧场',
    hint: '单格黑白漫画；{{#safe}} 是安全模式，{{#dialogue}} 是台词。',
    vars: ['count', 'safe', 'dialogue'],
    defaults: { single: MANGA_SINGLE, many: MANGA_MANY },
  },
];

export function promptDocOf(id: string): PromptDoc | undefined {
  return PROMPT_DOCS.find(doc => doc.id === id);
}

/** 默认模板（没被覆盖时用的那份）。 */
export function defaultTemplate(id: PromptDocId, variant: PromptVariant): string {
  const doc = promptDocOf(id);
  if (!doc) return '';
  if (variant === 'many') return doc.defaults.many ?? doc.defaults.single;
  return doc.defaults.single;
}

/**
 * 取实际要用的模板文本。
 *
 * 空覆盖 = 没改（回来用默认）。这一条很重要：用户把 textarea 清空
 * 应当是「恢复默认」，不是「给模型发空提示词」。
 */
export function resolveTemplate(
  id: PromptDocId,
  variant: PromptVariant,
  overrides?: PromptOverrideMap,
): string {
  const custom = overrides?.[overrideKey(id, variant)];
  if (typeof custom === 'string' && custom.trim()) return custom;
  return defaultTemplate(id, variant);
}

/** 渲染某套提示词。theater 三套会顺手清掉条件段留下的空行。 */
export function renderPromptDoc(
  id: PromptDocId,
  variant: PromptVariant,
  vars: Record<string, string | number | boolean | null | undefined>,
  overrides?: PromptOverrideMap,
): string {
  const template = resolveTemplate(id, variant, overrides);
  // 折叠只把 3 个以上换行压回 2 个：段落间距保留，条件段留下的空行清掉。
  return renderCompact(template, vars);
}

/** 有没有被改过（UI 上标「已自定义」）。 */
export function isCustomized(id: PromptDocId, variant: PromptVariant, overrides?: PromptOverrideMap): boolean {
  const custom = overrides?.[overrideKey(id, variant)];
  return typeof custom === 'string' && !!custom.trim();
}
