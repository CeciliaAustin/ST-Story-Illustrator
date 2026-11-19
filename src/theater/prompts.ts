/**
 * ST-Story-Illustrator — 小剧场读剧情提示词构建（纯函数）
 *
 * 移植自文档 §2.2–2.9 + §5B.4 拼词层。
 * 生成的是「读剧情」用的 system/user 文本，与「出图」拼词分开。
 */

import type { StoryKind } from '../types';
import { clampMangaShots, STATUS_MAX_PANELS } from './parseReply';

const BODY_LIMIT = 2400;
const BODY_LIMIT_STORY = 3600;
const FRAMING_RE = /\b(?:upper body|cowboy shot|close[- ]?up|portrait|headshot)\b/i;

/** 正文过长只取尾部；多格要看整楼走向，取更长。 */
export function clampBody(body: string, many: boolean): string {
  const text = String(body ?? '');
  const limit = many ? BODY_LIMIT_STORY : BODY_LIMIT;
  return text.length > limit ? text.slice(-limit) : text;
}

const JSON_FIELDS =
  '{"title":"中文，14 字以内，这一楼发生了什么","characters":[{"name":"出场角色名（照抄正文里的叫法）","act":"English danbooru phrases: what THIS character is doing this frame"}],"mood":"中文，6 字以内","tags":"10-16 个英文 danbooru 短 tag，逗号分隔","nl":"English, 1-2 sentences describing this frame"}';

const LINES_SCHEMA = '"lines":[{"speaker":"说话角色名（照抄正文里的叫法）；旁白写「旁白」","text":"中文，20 字以内"}]';

const COMMON_RULES = [
  '画面必须是正文里真的发生的那件事，不要编造没写过的动作，也不要画成「站着摆姿势」。',
  'characters 里每一项的 act 是这张图的**主要信息**：用英文写这个角色在这一刻具体在做什么、和谁互动、手里拿着什么（例如 pulling the other\'s sleeve, leaning against the door, holding a broken cup）。',
  '只写 1girl / solo / standing / looking at viewer 这类空景词的图等于没画剧情——至少要有 3 条「动作或与场景互动」的 tag。',
  'characters 最多 2 项；两人互动时主动方和被动方 act 必须分开写。',
  'nl 里写两个人时必须用正文里的角色名当主语，禁止用 he/she/the man 泛指。',
  // 这一条是照柏宝绘自己的规范写的：它要求模型补全「怎么拍」（景别/光线/色调），
  // 因为正文是散文，从来不会写机位。我们之前反过来禁止模型写景别与光线，
  // 结果是每格都成了同一张平光半身像——画面里看不出「在哪、什么时候、什么气氛」。
  'tags 里必须交代这三件事：① 人数与互动；② 地点或环境（classroom / dormitory / arched corridor / street / outdoors）；③ 光线或时间（sunlight / backlighting / golden hour / night / indoor lighting）。',
  'characters[].act 只写「这个人」的动作、表情、以及和场景/道具的接触；外貌、发型、瞳色、服装由柏宝绘角色库提供，这里**绝对不要写**。',
  'nl 用英文自然语言写同一件事，不要分点、不要换行。',
  '禁止写：画风、画质（masterpiece / best quality / absurdres）、画师名、角色外貌与服装细节、负面词——这些由柏宝绘的方案负责。',
  '不要解释，不要 markdown 代码块，不要多余文字。',
];

function statusSingleSystem(): string {
  return [
    '读一段角色扮演正文，把「这一楼最要紧的那一个画面」翻成一张插画，只输出一个 JSON 对象。',
    `格式：${JSON_FIELDS}`,
    'tags 里写互动词（couple / kiss / hug）与人数（1boy, 1girl 等）。',
    ...COMMON_RULES,
    '景别只写 close-up / upper body / medium shot 里的一个（卡片是偏半身的构图，不要写 full body 或 wide shot）。',
    '没有角色出场时输出 {"title":"","characters":[],"mood":"","tags":"","nl":""}。',
  ].join('\n');
}

function statusManySystem(count: number): string {
  return [
    `读一段角色扮演正文，把这一楼发生的事挑成 ${count} 个先后画面，像一条小分镜，只输出一个 JSON 对象。`,
    `格式：{"title":"中文，14 字以内，这一楼讲了一件什么事","panels":[${JSON_FIELDS}]}`,
    'panels 按正文的时间顺序排列：第一格是这一楼的开头，最后一格是落点。',
    '每一格必须是不同的瞬间：换动作、换位置、换张力。不许重复或拆格凑数；没那么多就少给几格（至少 1 格）。',
    ...COMMON_RULES,
    '每格景别只写 close-up / upper body / medium shot 里的一个，相邻两格不要一样（卡片是偏半身构图，不要写 full body 或 wide shot）。',
    '没有角色出场时输出 {"title":"","panels":[]}。',
  ].join('\n');
}

function bonusSystem(count: number): string {
  const linesSchema = '"lines":[{"speaker":"说话角色名（照抄正文里的叫法）；旁白写「旁白」","text":"中文，20 字以内"}]';
  const many = count > 1;
  const panelsSchema = many
    ? `,"panels":[{"title":"中文，14 字以内，这一格发生了什么","characters":[{"name":"出场角色名","act":"English danbooru phrases: what THIS character is doing"}],"mood":"中文，6 字以内","tags":"10-16 个英文 danbooru 短 tag","nl":"English, 1-2 sentences","lines":[{"speaker":"说话角色名；旁白写「旁白」","text":"中文，20 字以内"}]}]`
    : '';
  return [
    '读一段角色扮演正文，忘掉它的剧情，只为其中的角色设计一个「平行宇宙彩蛋」：一段与正文剧情无关的架空小片段，只输出一个 JSON 对象。',
    `格式：{"title":"中文，14 字以内，以「彩蛋：」开头","characters":[{"name":"出场角色名","act":"English danbooru phrases: what THIS character is doing"}],"mood":"中文，6 字以内","tags":"10-16 个英文 danbooru 短 tag","nl":"English, 1-2 sentences",${linesSchema}${panelsSchema}}`,
    '题材、场景、基调完全自由发挥：温馨日常、热血战斗、悬疑惊悚、虐心催泪、史诗冒险、荒诞搞笑都可以。唯一硬要求：角色必须是正文里的那几位，性格照旧。',
    '每次都换花样：别落在咖啡店、甜品店这类用滥的套路里。',
    `每格给 2~4 条 lines（对话/旁白），短句符合口吻；旁白 speaker 写「旁白」。${many ? `把彩蛋拆成最多 ${count} 个先后画面（panels），按时间顺序，每格不同瞬间。` : '只画一个画面。'}`,
    '彩蛋不是正文的延续：不要接着正文里刚发生的事画。',
    ...COMMON_RULES,
  ].join('\n');
}

function mangaSingleSystem(safe: boolean, dialogue = false): string {
  const rules = [
    '读一段角色扮演正文，把「这一楼最有画面的那一个瞬间」画成一格黑白漫画，只输出一个 JSON 对象。',
    `格式：{"title":"中文，14 字以内，这一格发生了什么","characters":[{"name":"出场角色名（照抄正文里的叫法）","act":"English danbooru phrases: what THIS character is doing this frame"}],"mood":"中文，6 字以内","tags":"10-20 个英文 danbooru 短 tag，逗号分隔","nl":"English, 1-2 sentences describing this frame"${dialogue ? `,${LINES_SCHEMA}` : ''}}`,
    ...COMMON_RULES,
    'tags 里必须有一个景别，从这几类挑最合适的：extreme close-up / close-up / upper body / cowboy shot / full body / wide shot / medium shot / from above / from below / from side / dutch angle。按内容挑，多格时相邻两格景别不同。',
    '**这一格必须画出正文里那个具体动作发生的场面**：谁、在哪里、正在做什么。除景别与表情外，至少要有一条「与场景互动的动作」tag（sitting on the bed / holding an umbrella / leaning against the wall / kneeling on the floor）和一条地点 tag（bedroom / classroom / street / outdoors …）。只有外貌、人数、表情的图会变成一张与剧情无关的头像。',
    '禁止写：黑白、网点、screentone、画风、角色外貌；也禁止 big head / chibi / super deformed 比例词（正常比例）。',
    '禁止写 speech bubble / text / dialogue / caption / comic panel border —— 画面里不许出现任何文字、气泡或分格线。',
  ];
  if (dialogue) {
    rules.push('每格给 1~3 条 lines：台词用中文短句、符合角色口吻，必须是正文里真的说过、或那一刻自然会说的话；旁白的 speaker 写「旁白」。台词由本地画成气泡叠在图上，**绝对不要写进 tags 或 nl**。');
  }
  if (safe) {
    rules.push('这一格必须能公开发布：衣着完整，不画裸露、性行为、内衣特写、走光。挑能放到台面上的瞬间，用表情、留白、构图表达张力。tags 与 act 里不许出现 nude / nipples / underwear / sex 这类词。');
  }
  rules.push('没有角色出场时输出 {"title":"","characters":[],"mood":"","tags":"","nl":""}。');
  return rules.join('\n');
}

function mangaManySystem(count: number, safe: boolean, dialogue = false): string {
  const rules = [
    `读一段角色扮演正文，把这一楼发生的事挑成最多 ${count} 个先后画面，像一页黑白漫画的分格，只输出一个 JSON 对象。`,
    `格式：{"title":"中文，14 字以内","panels":[{"title":"中文，14 字以内，这一格发生了什么","characters":[{"name":"出场角色名（照抄正文里的叫法）","act":"English danbooru phrases: what THIS character is doing this frame"}],"mood":"中文，6 字以内","tags":"10-20 个英文 danbooru 短 tag，逗号分隔","nl":"English, 1-2 sentences describing this frame"${dialogue ? `,${LINES_SCHEMA}` : ''}}]}`,
    'panels 按时间顺序排列；每一格必须是不同的瞬间（换动作、位置、张力），不许重复或拆格凑数，没那么多就少给几格。',
    ...COMMON_RULES,
    'tags 里必须有一个景别：extreme close-up / close-up / upper body / cowboy shot / full body / wide shot 等；相邻两格景别不同。',
    '**每一格都要画出正文里那一刻的场面**：谁、在哪里、正在做什么。除景别与表情外，每格至少一条「与场景互动的动作」tag（sitting on the bed / holding an umbrella / leaning against the wall）和一条地点 tag。只写外貌与人数的图会变成一页与剧情无关的头像。',
    '禁止写：黑白、网点、screentone、画风、角色外貌、chibi 比例词；禁止 speech bubble / text / dialogue / caption / comic panel border。',
  ];
  if (dialogue) {
    rules.push('每格给 1~3 条 lines：中文短句、符合角色口吻，按时间顺序连起来要能读懂这一楼发生了什么；旁白的 speaker 写「旁白」。台词由本地画成气泡叠在图上，**绝对不要写进 tags 或 nl**。');
  }
  if (safe) rules.push('每格必须能公开发布：衣着完整，不画裸露、性行为、内衣特写；用表情、留白、构图表达张力，tags 与 act 里不许出现 NSFW 词。');
  rules.push('没有角色出场时输出 {"title":"","panels":[]}。');
  return rules.join('\n');
}

export interface TheaterPromptInput {
  kind: StoryKind;
  characterName: string;
  body: string;
  shots: number;
  mangaSafe?: boolean;
  /** 黑白漫是否要台词（可关；关掉就完全不问模型要 lines） */
  dialogue?: boolean;
  /**
   * 柏宝绘角色库里的名字。给了就把名单写进 prompt，让模型照抄——
   * 名字对不上角色库，出图时就取不到那个人的外貌 tag（这是「人物不像」的常见来源）。
   */
  roster?: string[];
}

/** 构建读剧情的 system + user 文本（合成一条给 generateQuietPrompt）。 */
export function buildTheaterPrompt(input: TheaterPromptInput): { system: string; user: string } {
  const count = Math.min(Math.max(Math.round(Number(input.shots) || 1), 1), STATUS_MAX_PANELS);
  const many = count > 1;
  const body = clampBody(input.body, many || input.kind === 'bonus');
  const name = input.characterName || '（未命名）';

  let system: string;
  let bodyLabel = '正文：';
  switch (input.kind) {
    case 'bonus':
      system = bonusSystem(count);
      bodyLabel = '正文（只用来认人，不用来取材）：';
      break;
    case 'manga':
      system = many
        ? mangaManySystem(count, input.mangaSafe !== false, input.dialogue === true)
        : mangaSingleSystem(input.mangaSafe !== false, input.dialogue === true);
      break;
    case 'status':
    default:
      system = many ? statusManySystem(count) : statusSingleSystem();
      break;
  }

  const roster = (input.roster ?? []).map(n => String(n ?? '').trim()).filter(Boolean).slice(0, 12);
  const rosterLine = roster.length
    ? `可用角色（柏宝绘角色库；characters[].name 必须照抄其中一项，不要自己造人）：${roster.join('、')}\n`
    : '';

  return {
    system,
    user: `${rosterLine}角色：${name}\n${bodyLabel}\n${body}`,
  };
}

// ============================================================
// 出图拼词层（§5B.4）
// ============================================================

/** Q版强档画风串（NAI 带权重写法）。正向绝对不写 chibi 这个词。 */
export const CHIBI_STYLE_STRONG =
  '2.3::super deformed, big head, small body::, 2.2::oversized eyes, round face, simplified facial features::, ' +
  '2.0::tiny hands, short limbs::, 1.9::soft rounded shading, pastel highlights::, ' +
  '1.8::glossy eyes, sparkles, bokeh background, warm rim light::, ' +
  '1.7::exaggerated head-to-body ratio, rounded silhouette, simplified anatomy, stylized proportions, simple background::';

const MANGA_FRAMING = ['extreme close-up', 'close-up', 'upper body', 'cowboy shot', 'full body',
  'wide shot', 'medium shot', 'from above', 'from below', 'from side', 'dutch angle'];
const MANGA_FRAMING_RE = new RegExp(
  `\\b(?:${MANGA_FRAMING.map(w => w.replace(/-/g, '[- ]?')).join('|')})\\b`, 'i');

/** 状态栏/彩蛋出图词：Q版串 + 外貌 + 画面 tag + 景别兜底。 */
export function buildStatusPrompt(appearances: string[], tags: string, chibi = true): string {
  const looks = appearances.map(t => t.trim()).filter(Boolean).join(', ');
  const body = tags.trim();
  const framing = body && !FRAMING_RE.test(body) ? 'upper body' : '';
  return [chibi ? CHIBI_STYLE_STRONG : '', looks, body, framing].filter(Boolean).join(', ');
}

/** 黑白漫出图词：正常比例，景别兜底 cowboy shot。 */
export function buildMangaPrompt(appearances: string[], tags: string): string {
  const looks = appearances.map(t => t.trim()).filter(Boolean).join(', ');
  const body = tags.trim();
  const framing = body && !MANGA_FRAMING_RE.test(body) ? 'cowboy shot' : '';
  return [looks, body, framing].filter(Boolean).join(', ');
}

/**
 * 黑白漫的 nl 前置一句「单格」。
 *
 * 每张卡片只画**一格**，但很多黑白漫方案的画师串是照「一页多格」写的
 * （multiple views / 4koma / comic page），公共接口又只能整套方案照用，
 * 结果一张卡片出一页四格、四张卡片全是重复的大头。nl 是我们能改的那一段，
 * 用自然语言把它压回单格。
 */
export function buildMangaNl(nl: string): string {
  const text = String(nl ?? '').trim();
  if (!text) return '';
  return `One single comic panel filling the whole frame, no panel borders. ${text}`;
}

/** 按 kind 分派出图 prompt。 */
export function buildTheaterImagePrompt(
  kind: StoryKind,
  appearances: string[],
  tags: string,
  chibi: boolean,
): string {
  return kind === 'manga'
    ? buildMangaPrompt(appearances, tags)
    : buildStatusPrompt(appearances, tags, chibi);
}
