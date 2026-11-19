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
import { baiBaiAdapter } from '../baibai/imageAdapter';
import { makeModeLlmCaller } from '../manga/planGenerator';
import { runTheaterOne, type LookReader } from '../theater/runtime';
import { recordImageLog, recordLlmError } from '../log/imageLog';
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
 * 「随便哪个人」——用户看到的就是「跟剧情毫无关系」。所以退让两级：
 * 归一后比对 → 场上只有唯一角色时直接用它。
 */
export function makeLookReader(
  characters: BaiBaiCharacter[],
  primaryName = '',
): LookReader {
  const byNorm = new Map<string, BaiBaiCharacter>();
  for (const c of characters) {
    byNorm.set(normalizeName(c.name), c);
    // 库里的条目常写成「小红（我）」「Alice (AI)」：把括号前的主名也登记一份，
    // 否则正文里的「小红」永远匹配不上，等于没有外貌 tag。
    const base = normalizeName(String(c.name ?? '').split(/[（(【\[]/)[0]);
    if (base && !byNorm.has(base)) byNorm.set(base, c);
  }
  const primary = primaryName ? byNorm.get(normalizeName(primaryName)) : undefined;
  const onlyOne = characters.length === 1 ? characters[0] : undefined;

  return names =>
    names.map(name => {
      const key = normalizeName(name);
      const base = normalizeName(String(name ?? '').split(/[（(【\[]/)[0]);
      const hit = byNorm.get(key) ?? (base ? byNorm.get(base) : undefined) ?? primary ?? onlyOne;
      return hit ? { name, tag: hit.tag, ...(hit.nl ? { nl: hit.nl } : {}) } : { name, tag: '' };
    });
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
}

/** 读剧情 → 逐格出图，返回未落盘的格数据。 */
export async function runTheaterTask(input: TheaterTaskInput): Promise<TheaterTaskResult> {
  const { mode, settings, floor } = input;
  const kind = kindOfMode(mode);
  const modeSettings = resolveModeSettings(settings, mode);
  const characters = await getCharacters(floor);
  const profile = pickProfile(settings.profiles ?? [], mode);

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
    backend: 'nai',
    ...(profile ? { profile } : {}),
    ...(input.onPanel ? { onPanel: input.onPanel } : {}),
    // 副 API 报错即停，不回退主 API（并把原文记进日志）
    llm: async (prompt) => {
      try {
        return await makeModeLlmCaller(settings, mode)('', prompt);
      } catch (err) {
        recordLlmError({ mode, floor, error: err instanceof Error ? err.message : String(err), prompt });
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
          ...(genInput.size ? { size: genInput.size } : {}),
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - startedAt,
        });
        throw err;
      }
    },
    readLooks: makeLookReader(characters.characters, input.characterName),
  });

  return { ok: result.ok, stories: result.stories, ...(result.error ? { error: result.error } : {}) };
}
