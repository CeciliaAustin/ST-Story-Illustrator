/**
 * ST-Story-Illustrator — 小剧场运行时主链路
 *
 * 一次 run：读剧情（LLM）→ 解析 → 安全洗 → 拼出图词 → 逐格出图 → 落盘。
 * 依赖全部通过注入（LLM caller / image generator / look reader），便于测试。
 *
 * 三套（status/bonus/manga）共用一份运行时，差异在 kinds.ts 的参数表。
 */

import type { StoryKind, StatusReading, BbiStatusInfo, VisualProfile } from '../types';
import { buildTheaterPrompt, buildTheaterImagePrompt } from './prompts';
import { parseStatusReply, clampMangaShots } from './parseReply';
import { scrubMangaReading, MANGA_SAFE_NEGATIVE } from './safeFilter';
import { statusSeedFor, decideSeed } from './seed';
import { speakersOf } from './store';

// ============================================================
// 注入的依赖
// ============================================================

export type TheaterLlmCaller = (prompt: string) => Promise<string>;

export interface TheaterImageInput {
  prompt: string;
  negative?: string;
  seed: number;
  size?: 'portrait' | 'landscape';
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
  backend: 'nai' | 'comfyui' | 'webui';
  profile?: VisualProfile;
  /** 依赖注入 */
  llm: TheaterLlmCaller;
  generate: TheaterImageGenerator;
  readLooks: LookReader;
}

export interface RunOneResult {
  ok: boolean;
  stories: BbiStatusInfo[];
  error?: string;
  hits: string[];
}

// ============================================================
// 主链路
// ============================================================

/** 读剧情并容错解析（纯装配 + 一次 LLM 调用）。 */
export async function readTheater(input: RunOneInput): Promise<{ reading: StatusReading; hits: string[] }> {
  const { system, user } = buildTheaterPrompt({
    kind: input.kind,
    characterName: input.characterName,
    body: input.body,
    shots: clampMangaShots(input.shots),
    mangaSafe: input.mangaSafe,
  });
  const raw = await input.llm(`${system}\n\n---\n\n${user}`);
  let reading = parseStatusReply(raw);

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
    const { reading, hits } = await readTheater(input);
    if (reading.panels.length === 0) {
      return { ok: false, stories: [], error: '读剧情未返回可解析的分镜。', hits };
    }

    // 拼出图词所需的角色外貌：从格里的说话人/角色名读取
    const names = new Set<string>();
    for (const panel of reading.panels) {
      for (const n of panel.characters) if (n) names.add(n);
      for (const l of panel.lines ?? []) if (l.speaker && l.speaker !== '旁白') names.add(l.speaker);
    }
    const looks = input.readLooks([...names]);
    const appearances = looks.map(l => l.tag).filter(Boolean);
    const fixedSeed = statusSeedFor([...names]);

    const stories: BbiStatusInfo[] = [];
    for (let i = 0; i < reading.panels.length; i += 1) {
      const panel = reading.panels[i];
      const prompt = buildTheaterImagePrompt(
        input.kind,
        appearances,
        panel.tags,
        input.chibi,
      );
      const negative = input.kind === 'manga' && input.mangaSafe ? MANGA_SAFE_NEGATIVE : undefined;
      const seed = decideSeed(input.backend, undefined, fixedSeed);
      const result = await input.generate(
        {
          prompt,
          ...(negative ? { negative } : {}),
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
      });
    }

    if (stories.length === 0) {
      return { ok: false, stories, error: '所有分格出图均失败。', hits };
    }
    return { ok: true, stories, hits };
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
