/**
 * 小剧场三套的生成入口（一次生成 N 格）
 *
 * 首次生成（workflow）和「整条重出」（theater/reroll）走的是同一条链路，
 * 所以这里把依赖装配集中一次，避免两处各写一套、行为悄悄分叉。
 */

import type {
  BbiStatusInfo,
  CreationMode,
  StoryIllustratorSettings,
  StoryKind,
  VisualProfile,
} from '../types';
import { getCharacters } from '../baibai/bridge';
import { baiBaiAdapter } from '../baibai/imageAdapter';
import { makeModeLlmCaller } from '../manga/planGenerator';
import { runTheaterOne } from '../theater/runtime';
import { recordImageLog, recordLlmError } from '../log/imageLog';

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

export interface TheaterTaskInput {
  mode: CreationMode;
  settings: StoryIllustratorSettings;
  floor: number;
  chatId: string;
  swipe: number;
  body: string;
  characterName: string;
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
  const modeSettings = settings.modes[mode];
  const characters = await getCharacters(floor);
  const profile = pickProfile(settings.profiles ?? [], mode);

  const result = await runTheaterOne({
    kind,
    chatId: input.chatId,
    floor,
    swipe: input.swipe,
    characterName: input.characterName,
    body: input.body,
    shots: modeSettings?.shots,
    chibi: kind !== 'manga' && (modeSettings?.chibiStyle !== 'thumb'),
    mangaSafe: modeSettings?.bwMangaSafeMode ?? true,
    backend: 'nai',
    ...(profile ? { profile } : {}),
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
        const r = await baiBaiAdapter.generate({
          prompt: genInput.prompt,
          ...(genInput.negative ? { negative: genInput.negative } : {}),
          seed: genInput.seed,
          size: genInput.size,
          save: true,
        }, genProfile ?? fallbackProfile(mode));
        recordImageLog({
          mode, floor, source: 'api',
          prompt: genInput.prompt,
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
          prompt: genInput.prompt,
          ...(genInput.negative ? { negative: genInput.negative } : {}),
          ...(genInput.size ? { size: genInput.size } : {}),
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - startedAt,
        });
        throw err;
      }
    },
    readLooks: (names) => {
      const lookup = new Map(characters.characters.map(c => [c.name, c]));
      return names.map(name => {
        const c = lookup.get(name);
        return c ? { name, tag: c.tag, ...(c.nl ? { nl: c.nl } : {}) } : { name, tag: '' };
      });
    },
  });

  return { ok: result.ok, stories: result.stories, ...(result.error ? { error: result.error } : {}) };
}
