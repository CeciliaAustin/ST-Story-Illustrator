/**
 * 小剧场三套的生成入口（一次生成 N 格）
 *
 * 首次生成（workflow）和「整条重出」（theater/reroll）走的是同一条链路，
 * 所以这里把依赖装配集中一次，避免两处各写一套、行为悄悄分叉。
 */

import type {
  BaiBaiCharacter,
  BbiStatusInfo,
  CreationMode,
  StoryIllustratorSettings,
  StoryKind,
  VisualProfile,
} from '../types';
import { resolveModeSettings } from '../types';
import { readOutConfig } from '../baibai/planConfig';
import { getCharacters } from '../baibai/bridge';
import { baiBaiAdapter, readBackendState } from '../baibai/imageAdapter';
import { makeModeLlmCaller } from '../manga/planGenerator';
import { runTheaterOne, type LookReader } from '../theater/runtime';
import { buildCastBlock, buildLibraryBlock, readCastContext } from '../theater/library';
import { recordImageLog, recordLlmError, recordNotice } from '../log/imageLog';
import { bakeDialogueIntoImage } from '../manga/bubbleBake';
import type { StatusLine } from '../types';
import { ensureModeOutPlan } from './modePlan';

export function kindOfMode(mode: CreationMode): StoryKind {
  if (mode === 'chibi-status') return 'status';
  if (mode === 'chibi-bonus') return 'bonus';
  return 'manga';
}

export function modeOfKind(kind: StoryKind): CreationMode {
  if (kind === 'status') return 'chibi-status';
  if (kind === 'bonus') return 'chibi-bonus';
  return 'bw-manga';
}

export function pickProfile(profiles: VisualProfile[], mode: CreationMode): VisualProfile | undefined {
  return profiles.find(p => p.mode === mode);
}

export function fallbackProfile(mode: CreationMode): VisualProfile {
  return {
    id: `default-${mode}`, name: '默认', mode, backend: 'nai',
    promptTemplateId: 'default', options: {},
  };
}

/**
 * 台词 → 气泡叠到图上（黑白漫）。
 *
 * 文档原设计里黑白漫不带台词（"分镜靠画面说话"），但用户要的是漫画感：
 * 有对白才读得懂。台词由模型吐 JSON，字由本地 canvas 画——不能让 NAI 画字，
 * 中文必乱码。合成失败不升级成「生成失败」，原图照用。
 */
export async function bakeTheaterLines(
  imagePath: string,
  lines: StatusLine[] | undefined,
  settings: StoryIllustratorSettings,
  kind: StoryKind,
): Promise<{ path: string; baked: boolean }> {
  if (!imagePath || !lines?.length) return { path: imagePath, baked: false };
  const modeSettings = resolveModeSettings(settings, modeOfKind(kind));
  const baked = await bakeDialogueIntoImage({
    imagePath,
    dialogue: lines.map(line => ({
      text: line.text,
      ...(line.speaker && line.speaker !== '旁白' ? { speaker: line.speaker } : {}),
    })),
    ...(modeSettings.bwMangaBubbleStyle ? { style: modeSettings.bwMangaBubbleStyle } : {}),
    ...(settings.bubbleFont ? { font: settings.bubbleFont } : {}),
  });
  return baked ? { path: baked, baked: true } : { path: imagePath, baked: false };
}

/** 名字比对用的归一：去掉空白、括号、标点，忽略大小写。 */
function normalizeName(name: string): string {
  return String(name ?? '')
    .replace(/[\s（）()「」『』【】·.,，。:：!！?？~～]/g, '')
    .toLowerCase();
}

/**
 * 角色外貌读取器。
 *
 * 为什么不能只做 name 精确匹配：正文里的称呼与柏宝绘角色库里的条目名经常差一点
 * （带括号注、繁简、昵称）。匹配不上就等于**没有外貌 tag**，出图会变成一张
 * 「随便哪个人」——用户看到的就是「跟剧情毫无关系」。
 *
 * 但也不能瞎兜底：以前任何没匹配上的名字都会套上「主角」的外貌，
 * 于是模型写了 Julian（角色库里没有），画出来却是 Elias 的样子——比没外貌更糟。
 * 现在只对**代词**（他/她/the man…）且**角色库里只有一个条目**时兜底，
 * 其余一律留空，并把名字冒泡到日志里，让用户去柏宝绘补角色。
 */
export function makeLookReader(
  characters: BaiBaiCharacter[],
  primary: string | { cardName?: string; personaName?: string } = '',
): LookReader {
  const cardName = typeof primary === 'string' ? primary : primary.cardName ?? '';
  const personaName = typeof primary === 'string' ? '' : primary.personaName ?? '';
  const byNorm = new Map<string, BaiBaiCharacter>();
  for (const c of characters) {
    byNorm.set(normalizeName(c.name), c);
    // 库里的条目常写成「小红（我）」「Alice (AI)」：把括号前的主名也登记一份，
    // 否则正文里的「小红」永远匹配不上，等于没有外貌 tag。
    const base = normalizeName(String(c.name ?? '').split(/[（(【\[]/)[0]);
    if (base && !byNorm.has(base)) byNorm.set(base, c);
  }
  const card = cardName ? byNorm.get(normalizeName(cardName)) : undefined;
  const persona = personaName ? byNorm.get(normalizeName(personaName)) : undefined;
  const onlyOne = characters.length === 1 ? characters[0] : undefined;
  // 「你/我」= 用户扮演的那个人；「他/她」= 角色卡那一方。两者不能混：
  // 以前统一落到主角，用户说「你」时反而拿到了对方的金发外貌。
  const userWord = /^(你|我|你们|我们|you|i|me|us)$/i;
  const otherWord = /^(他|她|它|他们|她们|对方|那人|那个人|男子|男人|少年|少女|女孩|男孩|he|she|they|him|her|the man|the woman)$/i;

  return names => {
    // 角色库里的「固定着装」：模型没在 cast 里给服装时，这是唯一能保证同一批里
    // 穿同一套的依据。空库/没填就是空串，不影响主流程。
    const toLook = (name: string, entry: BaiBaiCharacter) => {
      const outfit = String(entry.fields?.outfit ?? '').trim();
      return {
        name,
        tag: entry.tag,
        ...(entry.nl ? { nl: entry.nl } : {}),
        ...(outfit ? { outfit } : {}),
      };
    };
    const out = names.map(name => {
      const key = normalizeName(name);
      const base = normalizeName(String(name ?? '').split(/[（(【\[]/)[0]);
      const hit = byNorm.get(key) ?? (base ? byNorm.get(base) : undefined);
      if (hit) return toLook(name, hit);
      const word = String(name ?? '').trim();
      const fallback = userWord.test(word)
        ? (persona ?? onlyOne)
        : otherWord.test(word)
          ? (card ?? onlyOne)
          : undefined;
      return fallback ? toLook(name, fallback) : { name, tag: '' };
    });

    // 一对一补位：一格里只有一个名字对不上、而库里正好只剩一条没被用掉，
    // 那它只能是这个人（例如正文叫 Cecilia、库里叫 Sissy）。
    // 只在「唯一解」时才补——两个都对不上就宁可不补，免得把两张脸画反。
    const unresolved = out.filter(item => !item.tag);
    if (unresolved.length === 1) {
      const usedNames = new Set(out.filter(item => item.tag).map(item => item.name));
      const free = characters.filter(entry => !usedNames.has(entry.name));
      if (free.length === 1 && free[0].tag) {
        const picked = toLook(unresolved[0].name, free[0]);
        unresolved[0].tag = picked.tag;
        if (picked.nl) unresolved[0].nl = picked.nl;
        if (picked.outfit) unresolved[0].outfit = picked.outfit;
      }
    }
    return out;
  };
}

export interface TheaterTaskInput {
  mode: CreationMode;
  settings: StoryIllustratorSettings;
  floor: number;
  chatId: string;
  swipe: number;
  body: string;
  characterName: string;
  /** 逐格进度（画「生成中 2/3」用） */
  onPanel?: (index: number, total: number) => void;
}

export interface TheaterTaskResult {
  ok: boolean;
  stories: BbiStatusInfo[];
  error?: string;
  /** 角色库里找不到的名字（外貌缺失，要明确告诉用户） */
  missingLooks?: string[];
}

/** 读剧情 → 逐格出图，返回未落盘的格数据。 */
export async function runTheaterTask(input: TheaterTaskInput): Promise<TheaterTaskResult> {
  const { mode, settings, floor } = input;
  const kind = kindOfMode(mode);
  const modeSettings = resolveModeSettings(settings, mode);
  const characters = await getCharacters(floor);
  const profile = pickProfile(settings.profiles ?? [], mode);
  // NAI4.5/V5 支持原生多角色提示 → 外貌走 characters 通道（柏宝绘自己也是这么画的）；
  // NAI3/ComfyUI 不支持，只能回落成拼进正向词。
  const backendState = await readBackendState().catch(() => null);
  const supportsCharacters = backendState?.supportsCharacters !== false;

  // 柏宝绘自己读剧情时，会把整份角色库（发色/瞳色/体型/固定着装）与人设一起发进去，
  // 让模型照抄——不是靠名字查表。我们照同一套做：名字与外貌都从这份文本里来，
  // 「正文叫她 Cecilia、库里叫 Sissy」这类差异才可能被模型自己接上。
  const cast = readCastContext(input.characterName);
  const libraryBlock = buildLibraryBlock(characters.characters);
  const castBlock = buildCastBlock(cast);

  // 空库不是「小事」：读剧情时模型没有任何外貌可抄，出图只能自己编一个人，
  // 用户看到的就是「这人是谁」。必须明说，别让它看起来像随机的 bug。
  if (!libraryBlock) {
    recordNotice({
      mode,
      floor,
      text: '柏宝绘角色库是空的（或这一楼之前还没有档案）：这次出图没有任何外貌可抄，'
        + '画出来的人不会是故事里的角色。请到柏宝绘 →「角色」里确认条目存在，'
        + '或先用它的自动打标跑一楼建档。',
    });
  }

  const result = await runTheaterOne({
    kind,
    chatId: input.chatId,
    floor,
    swipe: input.swipe,
    characterName: input.characterName,
    body: input.body,
    shots: modeSettings.shots,
    chibi: kind !== 'manga' && modeSettings.chibiStyle !== 'thumb',
    mangaSafe: modeSettings.bwMangaSafeMode ?? true,
    dialogue: kind === 'manga' && modeSettings.bwMangaDialogue !== false,
    roster: characters.characters.map(c => c.name),
    ...(libraryBlock ? { libraryBlock } : {}),
    ...(castBlock ? { castBlock } : {}),
    ...(settings.promptOverrides ? { promptOverrides: settings.promptOverrides } : {}),
    supportsCharacters,
    backend: 'nai',
    ...(profile ? { profile } : {}),
    ...(input.onPanel ? { onPanel: input.onPanel } : {}),
    // 副 API 报错即停，不回退主 API（并把原文记进日志）
    llm: async (system, user) => {
      try {
        return await makeModeLlmCaller(settings, mode)(system, user);
      } catch (err) {
        recordLlmError({
          mode,
          floor,
          error: err instanceof Error ? err.message : String(err),
          prompt: `【system】\n${system}\n\n【user】\n${user}`,
        });
        throw err;
      }
    },
    generate: async (genInput, genProfile) => {
      const startedAt = Date.now();
      try {
        // 每张图前复核一次方案：读剧情那几十秒里用户可能手动切了方案，
        // 不一致就重新切；切不动会抛错中止，绝不用错方案出图。
        await ensureModeOutPlan(mode, settings);
        const r = await baiBaiAdapter.generate({
          prompt: genInput.prompt,
          ...(genInput.nl ? { nl: genInput.nl } : {}),
          ...(genInput.negative ? { negative: genInput.negative } : {}),
          ...(genInput.characters?.length ? { characters: genInput.characters } : {}),
          seed: genInput.seed,
          size: genInput.size,
          save: true,
        }, genProfile ?? fallbackProfile(mode));
        recordImageLog({
          mode, floor, source: 'api',
          plan: readOutConfig().activePlanName,
          prompt: genInput.prompt,
          ...(genInput.nl ? { nl: genInput.nl } : {}),
          ...(genInput.negative ? { negative: genInput.negative } : {}),
          ...(genInput.characters?.length ? { characters: genInput.characters } : {}),
          ...(genInput.size ? { size: genInput.size } : {}),
          ...(typeof r.seed === 'number' ? { seed: r.seed } : typeof genInput.seed === 'number' ? { seed: genInput.seed } : {}),
          status: 'ok',
          durationMs: Date.now() - startedAt,
        });
        return { path: r.path, dataUrl: r.dataUrl, seed: r.seed };
      } catch (err) {
        recordImageLog({
          mode, floor, source: 'api',
          plan: readOutConfig().activePlanName,
          prompt: genInput.prompt,
          ...(genInput.nl ? { nl: genInput.nl } : {}),
          ...(genInput.negative ? { negative: genInput.negative } : {}),
          ...(genInput.characters?.length ? { characters: genInput.characters } : {}),
          ...(genInput.size ? { size: genInput.size } : {}),
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - startedAt,
        });
        throw err;
      }
    },
    readLooks: makeLookReader(characters.characters, {
      cardName: input.characterName,
      personaName: cast.personaName,
    }),
  });

  return {
    ok: result.ok,
    stories: result.stories,
    ...(result.error ? { error: result.error } : {}),
    ...(result.missingLooks?.length ? { missingLooks: result.missingLooks } : {}),
  };
}
