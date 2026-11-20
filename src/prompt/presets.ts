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
  '"cast":[{"name":"角色名（照抄库里的名字；用户扮演的「你」写人设名）",'
  + '"outfit":"English danbooru phrases: 这一整批共用的当前着装，版型+主色+关键配件（例如 white dress shirt, black slacks, loosened tie）",'
  + '"look":"English danbooru phrases: 这个人的外貌（发色/瞳色/体型/特征）。**固定外貌库里有这个人的条目时留空**，库是权威、不要改写；库里没有的（例如用户扮演的「你」）必须按正文/角色参考补全"}]';

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
  'characters 最多 2 项（同框超过两人时，只保留主角与核心互动对象；宁可裁人，也不要让人残缺）。两人互动时主动方和被动方 act 必须分开写。',
  'characters[].name **必须照抄【角色固定外貌库】里的名字**。正文里用「你」「他」「那个金发男生」或另一个叫法时，先判断指的是库里哪一位，再写库里的名字——名字写错就等于这个人没有外貌，会被画成路人。',
  '{{#nl}}nl 里写两个人时必须用正文里的角色名当主语，禁止用 he/she/the man 泛指。{{/nl}}',
  'tags 里必须交代这三件事：① 人数与互动；② 地点或环境（classroom / dormitory / arched corridor / street / outdoors）；③ 光线或时间（sunlight / backlighting / golden hour / night / indoor lighting）。',
  'characters[].act 只写「这个人」的动作、表情、以及和场景/道具的接触；外貌、发型、瞳色、服装由柏宝绘角色库提供，这里**绝对不要写**。',
  '{{#nl}}nl 用英文自然语言写同一件事，不要分点、不要换行。{{/nl}}',
  '{{^nl}}这套出图方案没有自然语言通道：不要输出 nl 字段（写了也不会被用，只会稀释 tag 权重）。{{/nl}}',
  '禁止写：画风、画质（masterpiece / best quality / absurdres）、画师名、角色外貌与服装细节、负面词——这些由柏宝绘的方案负责。',
  '不要解释，不要 markdown 代码块，不要多余文字。',
].join('\n');

/** 有台词时的构图要求：把人物往下放，上方留出干净空间给气泡。 */
const SPEECH_ROOM_RULE =
  '{{#nl}}有台词的那一格，nl 里要写明主角位于画面下半部或偏左右一侧、画面上方留出安静的空白（气泡会叠在那里）——人物头顶顶到画面上沿时，气泡只能盖在脸上。{{/nl}}';

// ============================================================
// 五套默认模板
// ============================================================

const ILLUSTRATION = `你是一位专业的图像提示词（tag）编辑。你的任务是根据给定剧情，输出结构化的英文生图标签。
严格遵守：
1. 先按前面的规范在心里过一遍检查清单（要写出来就写在 <thinking>…</thinking> 里，并且必须闭合）；然后只输出一个 JSON 对象，JSON 之外不要任何解释文字、不要 Markdown 代码围栏。
2. 结构：{"segments":[{"id":"...","source":"character|scene|global","characterName":"角色名(仅character段)","english":["英文tag",...],"chinese":["中文辅助翻译",...],"order":数字}]{{#nl}},"nl":"可选英文自然语言描述"{{/nl}},"negative":"可选英文负面词","size":"portrait|landscape","cast":[{"name":"角色名","outfit":"英文danbooru短语：这一批的当前着装"}]}。
3. english / nl / negative 必须是纯英文，绝不能出现中文——中文只放在 chinese 字段作辅助阅读。
4. character 段只写角色固定外貌（来自提供的角色快照，原样保留其 tag，不得改写）；scene 段写本次画面新增的动作、场景、构图、光线、情绪 tag。
4a. **Base 与角色块是硬边界**：scene / global 段里绝对不要出现任何单个角色的外貌、服装、发色、瞳色、体型——这些只属于该角色的 character 段。两边都写，等于把两套头发两套衣服摊给同框所有人，模型只能随机分配。
4c. **服装必须写进 cast[].outfit**：若给了【本批定妆】，把里面每个人那套原样翻成英文 danbooru 短语（版型+主色+关键部件），每人一条写进 cast；没有定妆块就按正文/角色设定定一套具体的。这一批只有这一张图，一件不漏；代码会把它逐字拼进对应角色的 character 段，所以 character 段里不要重复写衣服。outfit 必须是纯英文，出现中文会被整条丢弃。
4b. scene 段至少 5 个 tag，必须包含：一个景别（close-up / upper body / medium shot / full body / wide shot）、地点、光线或时间、以及人与人之间的共享互动。
5. 一次只策划一个明确的瞬间，不要描述整段剧情的时间跨度。
6. 场景与动作必须以给定剧情和上下文为依据，不得凭空添加关键剧情事实。
7. segment 按 order 从小到大排列；无需的字段直接省略，不要填空字符串或空数组。
8. 若剧情里的名场面适合漫画分镜，仍按单幅插画输出（漫画由专门的模式处理）。
9. **画进这张图的每一个人**都要有自己的 character 段：name 照抄角色库里的名字，外貌照抄该条目的 tag（不改写、不合并）。漏掉一个人，图上就少一个人；不打算画进来的人不要写。
10. {{#nl}}nl 必须写：英文 1~2 句，把「谁、在哪里、正在做什么」串起来——柏宝绘的 nl 通道决定这些细节能不能真的落在画面上。{{/nl}}{{^nl}}不要生成 nl 字段：这套出图方案不需要自然语言通道，写了反而会稀释 tag 权重。{{/nl}}
{{#hasFlags}}
补充约束：
{{#noChinese}}不要生成 chinese 字段（用户已关闭中文辅助）。{{/noChinese}}
{{#noNegative}}不要生成 negative 字段。{{/noNegative}}
{{#sizeClause}}画幅倾向：{{sizeClause}}。{{/sizeClause}}
{{/hasFlags}}`;

const COMIC = `你是一位漫画分镜编辑。你要输出的是**一页漫画**的分镜计划：一页多格，每一格由代码**单独出一张图**，再由代码把这N张图拼成一页。
你只负责「每一格画什么」；格位、留白、主次、边框全部由代码排版，你不需要也不允许描述版面。
只输出一个 JSON 对象，不要解释文字、不要 Markdown 代码围栏。
结构：{"pages":[{"pageIndex":0,"title":"页标题(中文短语)","beat":{"timeScope":"这一瞬间的定格时间(同一时刻/紧邻动作)","location":"地点","event":"正在发生的一件事","continuityNote":"一句说明为什么这几格属于同一瞬间"},"layout":"regular|irregular|inset|unframed","tags":"整页共用英文 tag，逗号分隔"{{#nl}},"nl":"整页 nl（可省略：各格 nl 优先）"{{/nl}},"dialogue":[{"sourceIndex":"【本页可选台词原文】里的序号(整数)","text":"可省略，仅定位用","speaker":"说话人名字","panel":1,"area":"tl|tr|bl|br","dir":"v","mood":"whisper"}],"panels":[{"index":0,"title":"这一格画了什么(中文短语)","composition":"single|single_detail|duo|duo_detail|object|environment_detail|split_scene","shot":"wide shot|medium shot|close-up|extreme close-up","subject":"这一格的信息点(一句中文：读者要看到什么)","characters":[{"name":"角色","act":"English danbooru phrases: 这一格在做什么","look":"English 外貌短语，仅角色库里没有的人填"}],"mood":"氛围"{{#nl}},"nl":"English，一句 20~35 词：镜头距离 + 谁在画面哪一侧 + 在做什么 + 空白留在哪"{{/nl}}}]}],"cast":[{"name":"角色名","outfit":"English danbooru phrases: 这一批的当前着装，版型+主色+关键配件"}]}
硬要求：
1. **一页 = 一个连续的瞬间（one continuous beat）**：先在 beat 里定格选段中一个时刻/一件事，整页所有格只从这一个瞬间里取镜头切面（全景/某人眼睛/交叠的手/关键物件），连起来像镜头在同一件事上移动。**严禁**从选段里挑几个互不相连的时刻拼成剧情摘要（早上→晚上、房间→街道、争吵→和好都不许）；前后文只用来理解人物和代词，不得扩成本页事件。
1a. **台词也必须连续**：只取本页这一瞬间里、按原文顺序说过的话，可只截一句/半句/关键短语，允许某格无台词；不编对白、不把旁白改成角色台词、不把相隔很远的台词凑一页。
1b. **每格镜头自由**：composition 按这一格的叙事需要选——单人、单人局部、双人、双人局部、纯物件、环境细节、同步分屏（电话两端）都合法；一格只有一只手/一张脸/一个道具完全正确。**角色只在实际入镜的格出现**，不要把全页人物复制进每一格。
1c. **版面不用你操心**：格位、主次、留白、边框由代码排版。你只要保证每一格本身是一张成立的单幅画（有场景、有镜头、有人物动作）。
2. 整页共用 tag 只写在 page.tags 里，**不要按格分别写 tag**；它会被带进每一格的图。
2. page.tags 必须写出：在场的人**在做什么**（共享动作与互动）、在哪里、光线/时间、画面里的关键物件。**地点与光线必写**——每一格都是一张独立插画，缺了场景词那一格就会变成纯白底。**人物和动作是画面主体**，只写构图词的图等于没画。**单个角色的外貌、发色、瞳色、服装一律不写进 page.tags**——它们由 panels[].characters[].name 对应的角色库条目提供，代码会拼成每个角色自己的提示词；两边都写会把两套衣服糊给同框所有人。tag 写足 15~25 个没关系（构图、地点、道具、共享动作、光线都算），但每一个都必须是画面里真的有的东西。
2b. **服装只写一次，写在顶层 cast[].outfit**：给了【本批定妆】就照着把每人那套翻成英文 danbooru 短语（版型+主色+关键部件），一个角色一条；所有页所有格穿的都是这同一串，绝不换。代码把它逐字拼进该角色的每个角色块，所以 tags / nl / act 里都不要再写衣服。outfit 必须是纯英文，带中文会被整条丢弃。
3. **绝对不要写任何版面/分格词**：koma、multiple views、split screen、white background、simple background、comic page、manga、panel layout、asymmetric layout、panel、gutter。每一格都是独立一张插画：写了这些词，单张图会变成"格中格"，或者整格失去背景变成大白底。
4. 景别 tag 整页只写一个（cowboy shot / upper body 之类），{{#nl}}各格远近只写在 nl 里{{/nl}}{{^nl}}各格远近只能用构图 tag 区分{{/nl}}。
5. {{#nl}}**每一格都必须写 nl**（page.nl 可以省略）：一句英文，20~35 词，写清「地点 + 光线 + 镜头距离 + 谁在画面哪一侧 + 正在做什么」。只写「两人在桌边」这种没有镜头和场景的句子，两格就会长得一模一样、或者某一格变成白底。{{/nl}}{{^nl}}这套方案没有自然语言通道，不要生成 nl：每一格画了什么只能靠 tags 与 panels 表达，因此 tags 必须把各格的人物与动作都写进去。{{/nl}}
5b. **每格镜头要有变化，但事件不许变**：给每格写 shot（wide/medium/close-up/extreme close-up）与 subject（这一格的信息点）。同一页要同时有「交代空间」的大景与「推近」的特写；变化只体现在景别/机位/局部，不是跳时间换动作——静止的同一瞬间从三个角度拍也完全成立。
5c. **每格人物数量由该格镜头决定**：单人、双人、双人局部、纯物件都对；绝不要把「本页所有出场人物」复制进每一格。只有某一格**明确写了两人同框**时，这两人才都要有外貌：角色库里没有的那位（常是「你」）要给 look 字段（英文外貌短语，从角色参考/人设摘要取）；只出现一个人的格不需要给第二个人补词。
5d. **page.tags 写主画面的人数**：描述主视觉格里实际有几个人（1girl / 1boy / 2girls / couple），不要把全页各格出现过的人都数进去；单人局部格、物件格的 tags 不要硬塞两人。
6. panels 数组只用来标「每一格画了什么」：{{#fixedPanels}}**每页固定 {{panelsPerPage}} 格**——panels 必须正好 {{panelsPerPage}} 条，nl 必须按 {{panelsPerPage}} 格分区写，版面也必须真的切出 {{panelsPerPage}} 格。{{/fixedPanels}}{{^fixedPanels}}2~4 条，title 是中文短标题（会印在卡片上），格数必须与 nl 里描述的一致；**版面必须真的切出这么多格**——说 three panels 就要画三格，不能拿两格模板套四段内容。{{/fixedPanels}}
7. dialogue 台词**必须从【本页可选台词原文】里引用，逐字 100% 复刻，禁止改写/纠错/缩写/合并/翻译/补标点**：每条用 sourceIndex 填原文序号，text 字段可省略（写了也只作定位，最终画的是原文那一句）。本页最多 4 条；引用不到的就少写或留空，绝不自编台词。panel 字段是这句出现在第几格（1 起，按阅读顺序）——气泡只会画在那**一格**里，必须与该格 characters 里说话的人对得上；对不上就别引用这句。speaker 写说话人名字（照抄 characters 里的名字）：它不会被画进气泡，只用来定位。台词不许写进 tags 或 nl。
8. tags / nl 里绝对不允许出现 speech bubble、text、english text、dialogue、caption —— 画面里不能有字。
9. 有台词的页，nl 里要让人物偏下、格内上方留出干净空间给气泡；人物头顶顶到页边时气泡只能盖在脸上。**但不要为了留白把有地点、有道具、有互动的页改成白底档**——那等于把剧情发生的世界删掉，只让人偏下就够了。
{{#hasRule}}

【分镜规则（必须遵守）】
{{panelRule}}
{{/hasRule}}

【输出约束】最多 {{maxPages}} 页；每页只取选段里一个连续瞬间，不连续的内容拆到不同页。{{#dialogue}}dialogue 只写这一瞬间里真的说过的话，按原文顺序，可只留一两句关键的、允许某格没有台词；宁可少写也不要编对白或拼凑相隔很远的台词。{{/dialogue}}{{^dialogue}}本次不要输出 dialogue 字段。{{/dialogue}}
{{#noChinese}}除台词外的辅助中文一律不要输出。{{/noChinese}}`;

const STATUS_SINGLE = `读一段角色扮演正文，把「这一楼最要紧的那一个画面」翻成一张插画，只输出一个 JSON 对象。
格式：{"title":"中文，14 字以内，这一楼发生了什么",${CAST_SCHEMA},"characters":[{"name":"出场角色名（照抄正文里的叫法）","act":"English danbooru phrases: what THIS character is doing this frame"}],"mood":"中文，6 字以内","tags":"10-16 个英文 danbooru 短 tag，逗号分隔"{{#nl}},"nl":"English, 1-2 sentences describing this frame"{{/nl}}}
tags 里写互动词（couple / kiss / hug）与人数（1boy, 1girl 等）。
${COMMON_RULES}
景别只写 close-up / upper body / medium shot 里的一个（卡片是偏半身的构图，不要写 full body 或 wide shot）。
没有角色出场时输出 {"title":"","cast":[],"characters":[],"mood":"","tags":"","nl":""}。`;

const STATUS_MANY = `读一段角色扮演正文，把这一楼发生的事挑成 {{count}} 个先后画面，像一条小分镜，只输出一个 JSON 对象。
格式：{"title":"中文，14 字以内，这一楼讲了一件什么事",${CAST_SCHEMA},"panels":[{"title":"中文，14 字以内，这一格发生了什么","characters":[{"name":"出场角色名（照抄正文里的叫法）","act":"English danbooru phrases: what THIS character is doing this frame"}],"mood":"中文，6 字以内","tags":"10-16 个英文 danbooru 短 tag，逗号分隔"{{#nl}},"nl":"English, 1-2 sentences describing this frame"{{/nl}}}]}
panels 按正文的时间顺序排列：第一格是这一楼的开头，最后一格是落点。
每一格必须是不同的瞬间：换动作、换位置、换张力。不许重复或拆格凑数；没那么多就少给几格（至少 1 格）。
${COMMON_RULES}
每格景别只写 close-up / upper body / medium shot 里的一个，相邻两格不要一样（卡片是偏半身构图，不要写 full body 或 wide shot）。
没有角色出场时输出 {"title":"","cast":[],"panels":[]}。`;

const BONUS_LINES = '"lines":[{"speaker":"说话角色名（照抄正文里的叫法）；旁白写「旁白」","text":"中文，20 字以内"}]';

const BONUS_SINGLE = `读一段角色扮演正文，忘掉它的剧情，只为其中的角色设计一个「平行宇宙彩蛋」：一段与正文剧情无关的架空小片段，只输出一个 JSON 对象。
格式：{"title":"中文，14 字以内，以「彩蛋：」开头",${CAST_SCHEMA},"characters":[{"name":"出场角色名","act":"English danbooru phrases: what THIS character is doing"}],"mood":"中文，6 字以内","tags":"10-16 个英文 danbooru 短 tag"{{#nl}},"nl":"English, 1-2 sentences"{{/nl}},${BONUS_LINES}}
题材、场景、基调完全自由发挥：温馨日常、热血战斗、悬疑惊悚、虐心催泪、史诗冒险、荒诞搞笑都可以。唯一硬要求：角色必须是正文里的那几位，性格照旧。
每次都换花样：别落在咖啡店、甜品店这类用滥的套路里。
每格给 2~4 条 lines（对话/旁白），短句符合口吻；旁白 speaker 写「旁白」。只画一个画面。
彩蛋不是正文的延续：不要接着正文里刚发生的事画。
${COMMON_RULES}
${SPEECH_ROOM_RULE}`;

const BONUS_MANY = `读一段角色扮演正文，忘掉它的剧情，只为其中的角色设计一个「平行宇宙彩蛋」：一段与正文剧情无关的架空小片段，只输出一个 JSON 对象。
格式：{"title":"中文，14 字以内，以「彩蛋：」开头",${CAST_SCHEMA},"characters":[{"name":"出场角色名","act":"English danbooru phrases: what THIS character is doing"}],"mood":"中文，6 字以内","tags":"10-16 个英文 danbooru 短 tag"{{#nl}},"nl":"English, 1-2 sentences"{{/nl}},${BONUS_LINES},"panels":[{"title":"中文，14 字以内，这一格发生了什么","characters":[{"name":"出场角色名","act":"English danbooru phrases: what THIS character is doing"}],"mood":"中文，6 字以内","tags":"10-16 个英文 danbooru 短 tag"{{#nl}},"nl":"English, 1-2 sentences"{{/nl}},"lines":[{"speaker":"说话角色名；旁白写「旁白」","text":"中文，20 字以内"}]}]}
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
格式：{"title":"中文，14 字以内，这一格发生了什么",${CAST_SCHEMA},"characters":[{"name":"出场角色名（照抄正文里的叫法）","act":"English danbooru phrases: what THIS character is doing this frame"}],"mood":"中文，6 字以内","tags":"10-20 个英文 danbooru 短 tag，逗号分隔"{{#nl}},"nl":"English, 1-2 sentences describing this frame"{{/nl}}{{#dialogue}},${BONUS_LINES}{{/dialogue}}}
${COMMON_RULES}
tags 里必须有一个景别，从这几类挑最合适的：extreme close-up / close-up / upper body / cowboy shot / full body / wide shot / medium shot / from above / from below / from side / dutch angle。按内容挑，多格时相邻两格景别不同。
**这一格必须画出正文里那个具体动作发生的场面**：谁、在哪里、正在做什么。除景别与表情外，至少要有一条「与场景互动的动作」tag（sitting on the bed / holding an umbrella / leaning against the wall / kneeling on the floor）和一条地点 tag（bedroom / classroom / street / outdoors …）。只有外貌、人数、表情的图会变成一张与剧情无关的头像。
${MANGA_BASE_RULES}
{{#dialogue}}每格给 1~3 条 lines：台词用中文短句、符合角色口吻，必须是正文里真的说过、或那一刻自然会说的话；旁白的 speaker 写「旁白」。台词由本地画成气泡叠在图上，**绝对不要写进 tags 或 nl**。
${SPEECH_ROOM_RULE}{{/dialogue}}
{{#safe}}这一格必须能公开发布：衣着完整，不画裸露、性行为、内衣特写、走光。挑能放到台面上的瞬间，用表情、留白、构图表达张力。tags 与 act 里不许出现 nude / nipples / underwear / sex 这类词。{{/safe}}
没有角色出场时输出 {"title":"","cast":[],"characters":[],"mood":"","tags":"","nl":""}。`;

const MANGA_MANY = `读一段角色扮演正文，把这一楼发生的事挑成最多 {{count}} 个先后画面，像一页黑白漫画的分格，只输出一个 JSON 对象。
格式：{"title":"中文，14 字以内",${CAST_SCHEMA},"panels":[{"title":"中文，14 字以内，这一格发生了什么","characters":[{"name":"出场角色名（照抄正文里的叫法）","act":"English danbooru phrases: what THIS character is doing this frame"}],"mood":"中文，6 字以内","tags":"10-20 个英文 danbooru 短 tag，逗号分隔"{{#nl}},"nl":"English, 1-2 sentences describing this frame"{{/nl}}{{#dialogue}},${BONUS_LINES}{{/dialogue}}}]}
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
    vars: ['nl', 'hasFlags', 'noChinese', 'noNegative', 'sizeClause'],
    defaults: { single: ILLUSTRATION },
  },
  {
    id: 'comic',
    label: '正文漫画分镜',
    hint: '一页一张图。{{panelRule}} 是系统按「分镜档位 / 页型 / 后端」注入的规则块，别删。',
    vars: ['nl', 'hasRule', 'panelRule', 'maxPages', 'dialogue', 'noChinese', 'fixedPanels', 'panelsPerPage'],
    defaults: { single: COMIC },
  },
  {
    id: 'status',
    label: 'QQ 人状态栏',
    hint: '只画这一楼最要紧的一张。{{count}} 是多格模式要的格数。',
    vars: ['nl', 'count'],
    defaults: { single: STATUS_SINGLE, many: STATUS_MANY },
  },
  {
    id: 'bonus',
    label: 'QQ 人彩蛋',
    hint: '架空小片段，与正文剧情无关，但人物性格照旧。',
    vars: ['nl', 'count'],
    defaults: { single: BONUS_SINGLE, many: BONUS_MANY },
  },
  {
    id: 'manga',
    label: '黑白漫小剧场',
    hint: '单格黑白漫画；{{#safe}} 是安全模式，{{#dialogue}} 是台词，{{#nl}} 是方案是否要自然语言。',
    vars: ['nl', 'count', 'safe', 'dialogue'],
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
