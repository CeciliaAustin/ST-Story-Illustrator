/**
 * ST-Story-Illustrator — 小剧场运行时主链路
 *
 * 一次 run：读剧情（LLM）→ 解析 → 安全洗 → 拼出图词 → 逐格出图 → 落盘。
 * 依赖全部通过注入（LLM caller / image generator / look reader），便于测试。
 *
 * 三套（status/bonus/manga）共用一份运行时，差异在 kinds.ts 的参数表。
 */

import type { StoryKind, StatusReading, StatusFrame, BbiStatusInfo, VisualProfile } from '../types';
import { buildTheaterPrompt, buildTheaterImagePrompt, buildMangaNl } from './prompts';
import { parseStatusReply, clampMangaShots } from './parseReply';
import { scrubMangaReading, MANGA_SAFE_NEGATIVE } from './safeFilter';
import { statusSeedFor, decideSeed } from './seed';
import { speakersOf } from './store';

// ============================================================
// 注入的依赖
// ============================================================

/**
 * 读剧情用的模型调用。
 *
 * system 与 user **必须分开传**：以前它们被拼成一条塞进 user，system 是空串。
 * 后果是模型把「JSON 格式要求」当成正文的一部分，输出稳定性明显更差；日志里也只剩
 * 一坨看不出哪段是规则、哪段是正文。
 */
export type TheaterLlmCaller = (system: string, user: string) => Promise<string>;

export interface TheaterImageInput {
  prompt: string;
  /** 自然语言描述：柏宝绘的 nl 通道，剧情细节主要靠它落到画面上 */
  nl?: string;
  negative?: string;
  seed: number;
  size?: 'portrait' | 'landscape';
  /**
   * 角色外貌：走柏宝绘原生的 character prompt 通道（NAI4.5/V5 的 v4_prompt.char_captions）。
   * 这是它自己画多角色时用的同一条通道——不再把外貌串拼进正向词。
   */
  characters?: CharacterLook[];
}

export interface TheaterImageResult {
  path?: string;
  dataUrl?: string;
  seed?: number;
}

export type TheaterImageGenerator = (input: TheaterImageInput, profile?: VisualProfile) => Promise<TheaterImageResult>;

export interface CharacterLook {
  name: string;
  tag: string;
  nl?: string;
}

export type LookReader = (names: string[]) => CharacterLook[];

export interface RunOneInput {
  kind: StoryKind;
  chatId: string;
  floor: number;
  swipe: number;
  characterName: string;
  body: string;
  shots: number;
  chibi: boolean;
  mangaSafe: boolean;
  /** 黑白漫：要不要台词（要了才在 system 里问模型，并叠气泡） */
  dialogue?: boolean;
  /**
   * 柏宝绘角色库里的名字。**读剧情时就把名单给模型**，让它照抄这些名字，
   * 否则模型会写「Elias（他）」这类变体，出图时匹配不上角色库 → 没有外貌 tag。
   */
  roster?: string[];
  /**
   * 后端是否支持原生多角色提示（NAI4.5/V5）。true = 外貌走 characters 通道；
   * false（NAI3/ComfyUI）= 只能回落成把外貌拼进正向词。
   */
  supportsCharacters?: boolean;
  backend: 'nai' | 'comfyui' | 'webui';
  profile?: VisualProfile;
  /** 依赖注入 */
  llm: TheaterLlmCaller;
  generate: TheaterImageGenerator;
  readLooks: LookReader;
  /** 逐格进度（画「生成中 2/3」用） */
  onPanel?: (index: number, total: number) => void;
}

export interface RunOneResult {
  ok: boolean;
  stories: BbiStatusInfo[];
  error?: string;
  hits: string[];
  /** 模型写了、但柏宝绘角色库里没有的名字（外貌会缺，必须让用户知道） */
  missingLooks?: string[];
}

// ============================================================
// 主链路
// ============================================================

/**
 * 把「这一格真正在发生什么」拼成出图 tag。
 *
 * 模型的 JSON 里，动作写在 characters[].act（英文 danbooru 短语），tags 只是补充。
 * 上一版只取了 tags、把 act 整段丢掉——最具体的画面信息（谁在做什么）就这么没了，
 * 出图自然只能靠几个泛词瞎猜。这里把 act 合进 tags（去重、保留原顺序）。
 */
export function combinedPanelTags(panel: StatusFrame): string {
  const pieces: string[] = [];
  for (const role of panel.roles ?? []) {
    if (role.act) pieces.push(role.act);
  }
  pieces.push(panel.tags);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of pieces.join(',').split(',')) {
    const tag = piece.trim();
    if (!tag) continue;
    // act 是模型自由写的，可能混中文；NAI 只认英文 tag，带中文的整条丢掉
    if (/[\u3400-\u9fff\uf900-\ufaff]/.test(tag)) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out.join(', ');
}

export interface ReadingCheck {
  ok: boolean;
  reason?: string;
}

/**
 * 出图前的「对得上剧情吗」体检。
 *
 * 不合格就别出图：一张与剧情无关的 NAI5 图比一次重问贵得多，而且用户看不出来
 * 那是模型偷懒还是插件坏了。检查三条：
 * 1. 至少一格有足够的 tag（太少必然是空景）；
 * 2. 非彩蛋：格子里要有出场角色；
 * 3. 非彩蛋：这些角色至少有一个真的在正文里出现过（防止模型自己编人）。
 *
 * 彩蛋按设计就是架空，所以只查第 1 条。
 */
export function checkReading(reading: StatusReading, body: string, kind: StoryKind): ReadingCheck {
  if (!reading.panels.length) return { ok: false, reason: '没有解析出任何分格' };

  // 数的是「合进 act 之后」的 tag：模型常把动作全写在 act 里、tags 只留几个泛词
  const rich = reading.panels.some(
    panel => combinedPanelTags(panel).split(',').filter(t => t.trim()).length >= 5,
  );
  if (!rich) return { ok: false, reason: '每格的 tag 都太少，画面信息不足' };

  if (kind === 'bonus') return { ok: true };

  const names = new Set<string>();
  for (const panel of reading.panels) {
    for (const name of panel.characters) if (name) names.add(name.trim());
  }
  if (names.size === 0) return { ok: false, reason: '格子里没有任何出场角色' };

  const text = String(body ?? '');
  const hit = [...names].some(name => name.length >= 2 && text.includes(name));
  if (!hit) {
    return {
      ok: false,
      reason: `格子里写的角色（${[...names].slice(0, 3).join('、')}）在正文里没有出现`,
    };
  }
  return { ok: true };
}

/** 读剧情并容错解析（纯装配 + 一次 LLM 调用）。 */
export async function readTheater(
  input: RunOneInput,
  extraInstruction = '',
): Promise<{ reading: StatusReading; hits: string[] }> {
  const { system, user } = buildTheaterPrompt({
    kind: input.kind,
    characterName: input.characterName,
    body: input.body,
    shots: clampMangaShots(input.shots),
    mangaSafe: input.mangaSafe,
    dialogue: input.dialogue === true,
    ...(input.roster?.length ? { roster: input.roster } : {}),
  });
  const finalSystem = extraInstruction ? `${system}\n\n【追加要求】${extraInstruction}` : system;
  const raw = await input.llm(finalSystem, user);
  let reading = parseStatusReply(raw, input.kind);

  const hits: string[] = [];
  if (input.kind === 'manga' && input.mangaSafe) {
    const scrubbed = scrubMangaReading(reading);
    reading = scrubbed.reading;
    hits.push(...scrubbed.hits);
  }
  return { reading, hits };
}

/** 一次完整运行：读剧情 → 逐格出图 → 返回故事条目（落盘由调用方做）。 */
export async function runTheaterOne(input: RunOneInput): Promise<RunOneResult> {
  try {
    let { reading, hits } = await readTheater(input);
    let check = checkReading(reading, input.body, input.kind);

    // 不合格就重问一次：读剧情是文本调用，便宜；出图贵，而且废图看不出是坏在哪。
    if (!check.ok) {
      console.warn(`[ST-Story-Illustrator] ${input.kind} 读剧情不合格（${check.reason}），重问一次。`);
      const rosterHint = input.roster?.length
        ? `角色名只能从这几个里选：${input.roster.join('、')}（照抄，不要改写）。`
        : '';
      const retried = await readTheater(
        input,
        `上一次的输出不合格：${check.reason}。` +
          '这次必须做到：tags 与 characters[].act 写的都是**正文里真的发生的事**，' +
          '动作具体到能画出来（例如 holding sword, sitting on bed, crying, looking away），' +
          '不许只给 1girl / solo / standing 这类空景词；角色名照抄正文里的叫法。' +
          rosterHint,
      );
      reading = retried.reading;
      hits = [...hits, ...retried.hits];
      check = checkReading(reading, input.body, input.kind);
    }

    if (!check.ok) {
      return {
        ok: false,
        stories: [],
        error: `读剧情这一步没通过（${check.reason}），已放弃出图以免白花钱。请换一个更会写 tag 的副 API 模型。`,
        hits,
      };
    }
    if (reading.panels.length === 0) {
      return { ok: false, stories: [], error: '读剧情未返回可解析的分镜。', hits };
    }

    // 拼出图词所需的角色外貌：从格里的说话人/角色名读取
    const names = new Set<string>();
    for (const panel of reading.panels) {
      for (const n of panel.characters) if (n) names.add(n);
      for (const l of panel.lines ?? []) if (l.speaker && l.speaker !== '旁白') names.add(l.speaker);
    }
    const fixedSeed = statusSeedFor([...names]);

    const stories: BbiStatusInfo[] = [];
    const missingLooks = new Set<string>();
    // 支持原生多角色（NAI4.5/V5）时，外貌走 characters 通道；不支持的才回落到拼进正向词
    const nativeCharacters = input.supportsCharacters !== false;
    for (let i = 0; i < reading.panels.length; i += 1) {
      const panel = reading.panels[i];
      input.onPanel?.(i, reading.panels.length);
      // 外貌**按格取**：以前是把整段剧情里所有角色的外貌串拼一次、套给每一格，
      // 于是只有一个人在的格子里也塞进了另一个人的「1boy / 1girl + 全身外貌」，
      // 模型只能把两个人都画进来或折中成一张头像。
      //
      // 这一格没点名任何人时也不能无脑回落到全体：那正是「画到第四格忽然冒出两个
      // 无关小人」的来源（第四格只是在讲阳光，模型没写角色，我们却把全场都塞了进去）。
      // 只认 nl/title 里真的提到的人；全场只有一个人时才兜底。
      const panelNames = panel.characters.length
        ? panel.characters
        : [...names].filter(n => `${panel.nl ?? ''} ${panel.title ?? ''}`.includes(n));
      const resolvedNames = panelNames.length ? panelNames : names.size === 1 ? [...names] : [];
      const looks = input.readLooks(resolvedNames);
      for (const look of looks) if (!look.tag) missingLooks.add(look.name);
      // 柏宝绘自己画多角色走的就是 v4_prompt.char_captions（公开接口的 characters）。
      // 它的注释写得很清楚：不要把多份完整外貌拼进正向词，否则会重叠躯干 / 互相污染。
      // 之前我们正是拼进正向词的——「人物不像我的人」有一半是这么来的。
      const characters = nativeCharacters
        ? looks
            .filter(look => look.tag)
            .map(look => ({ name: look.name, tag: look.tag, ...(look.nl ? { nl: look.nl } : {}) }))
        : [];
      const appearances = nativeCharacters ? [] : looks.map(look => look.tag).filter(Boolean);
      // tags + characters[].act 一起拼：act 才是「这个人在做什么」，上一版丢掉了它
      const prompt = buildTheaterImagePrompt(
        input.kind,
        appearances,
        combinedPanelTags(panel),
        input.chibi,
      );
      // nl 以前**整段丢掉**了：模型写的那句「谁在哪里做了什么」只有 nl 里有，
      // 而柏宝绘的公开接口本来支持 nl 通道。不带它，画面只能靠十几个 tag 猜。
      const nl = input.kind === 'manga' ? buildMangaNl(panel.nl) : panel.nl;
      const negative = input.kind === 'manga' && input.mangaSafe ? MANGA_SAFE_NEGATIVE : undefined;
      const seed = decideSeed(input.backend, undefined, fixedSeed);
      const result = await input.generate(
        {
          prompt,
          ...(nl ? { nl } : {}),
          ...(negative ? { negative } : {}),
          ...(characters.length ? { characters } : {}),
          seed,
          size: 'portrait',
        },
        input.profile,
      );
      const path = result.path ?? result.dataUrl ?? '';
      if (!path) continue;
      stories.push({
        storyId: `s${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 5)}`,
        index: i,
        storyAt: Date.now(),
        title: panel.title || reading.title,
        story: panel.nl || undefined,
        mood: panel.mood || undefined,
        cast: panel.characters.length ? panel.characters : undefined,
        lines: panel.lines,
        imagePath: path,
        bonus: input.kind === 'bonus',
        manga: input.kind === 'manga',
        kind: input.kind,
        // 重画这张要用的原始参数：不存就只能「整条重出」，单格没法还原
        prompt,
        ...(negative ? { negative } : {}),
        ...(characters.length ? { characters } : {}),
        seed: result.seed ?? seed,
        ...(input.profile?.id ? { profileId: input.profile.id } : {}),
      });
    }

    if (stories.length === 0) {
      return { ok: false, stories, error: '所有分格出图均失败。', hits, ...(missingLooks.size ? { missingLooks: [...missingLooks] } : {}) };
    }
    return {
      ok: true,
      stories,
      hits,
      ...(missingLooks.size ? { missingLooks: [...missingLooks] } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      stories: [],
      error: err instanceof Error ? err.message : String(err),
      hits: [],
    };
  }
}

export { speakersOf };
