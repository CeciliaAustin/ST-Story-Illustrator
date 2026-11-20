/**
 * ST-Story-Illustrator — 正文插画「重画 / 改词重画」
 *
 * 正文插图不再写 `<bbi_image>`（那条 tag 是柏宝绘的，写进去就会跟它的
 * 自动分析、整楼重生成互相踩），所以卡片上那张图的所有操作也得自己接手：
 * 换种子重画、改词重画、删除。
 *
 * 这里只做「重画」这一件事：**用当时真正发出去的那套词**（prompt + nl + 角色块）
 * 再调一次柏宝绘的公开 API，换一个种子。不重读剧情——重画的语义是
 * 「同一张，换个手感」，不是「重新理解这一段」。
 */

import type { StoryIllustratorSettings } from '../types';
import { DEFAULT_SETTINGS } from '../types';
import { getSettings, saveChatSafe } from '../host/sillytavern';
import { baiBaiAdapter } from '../baibai/imageAdapter';
import { getArtifacts, updateArtifact } from '../storage/repository';
import { pickProfile, fallbackProfile } from './theaterRun';
import { recordImageLog } from '../log/imageLog';
import { readOutConfig } from '../baibai/planConfig';

export interface IllustrationRerollResult {
  ok: boolean;
  message?: string;
}

/** 改词重画：给了就用新的，没给就沿用当时存下的那套词。 */
export interface IllustrationRerollOptions {
  prompt?: string;
  /** 传空串表示「这次不要 nl」；不传 = 沿用原值。 */
  nl?: string;
  /** 角色词（每人一条）。给了就整套替换并写回 artifact。 */
  characters?: Array<{ name: string; tag: string; nl?: string }>;
}

/** NAI 种子上限；超了会被服务端拒。 */
function randomSeed(): number {
  return Math.floor(Math.random() * 4294967295);
}

export async function rerollIllustration(
  floor: number,
  artifactId: string,
  options: IllustrationRerollOptions = {},
  settings?: StoryIllustratorSettings,
): Promise<IllustrationRerollResult> {
  const artifact = getArtifacts(floor).find(a => a.id === artifactId);
  if (!artifact) return { ok: false, message: '这张图的数据已经不在了（可能已被删除）。' };
  if (artifact.mode !== 'illustration') return { ok: false, message: '这张不是正文插画，不能这样重画。' };

  const prompt = (options.prompt ?? artifact.prompt ?? '').trim();
  if (!prompt) return { ok: false, message: '这一张没有可用的正向词，无法重画。' };

  // 空串 = 明确「这次不要 nl」；undefined = 沿用原值。两者语义必须分开，
  // 否则用户清空 nl 框会变成「悄悄保留旧 nl」。
  const nl = options.nl !== undefined ? options.nl.trim() : (artifact.nl ?? '').trim();
  const storedCharacters = Array.isArray(artifact.metadata?.characters)
    ? (artifact.metadata.characters as Array<{ name: string; tag: string; nl?: string }>)
      .filter(c => c && typeof c.name === 'string' && typeof c.tag === 'string')
    : [];
  const characters = options.characters ?? storedCharacters;
  const full = settings ?? getSettings(DEFAULT_SETTINGS);

  const seed = randomSeed();
  const startedAt = Date.now();
  try {
    const result = await baiBaiAdapter.generate(
      {
        prompt,
        ...(nl ? { nl } : {}),
        ...(artifact.negative ? { negative: artifact.negative } : {}),
        ...(characters.length ? { characters } : {}),
        ...(typeof artifact.metadata?.galleryCharacter === 'string'
          ? { character: artifact.metadata.galleryCharacter }
          : {}),
        seed,
        size: artifact.metadata?.size === 'landscape' ? 'landscape' : 'portrait',
        save: true,
      },
      pickProfile(full.profiles ?? [], 'illustration') ?? fallbackProfile('illustration'),
    );
    const path = result.path ?? result.dataUrl ?? '';
    recordImageLog({
      mode: 'illustration',
      floor,
      source: 'api',
      plan: readOutConfig().activePlanName,
      prompt,
      ...(nl ? { nl } : {}),
      ...(characters.length ? { characters } : {}),
      size: artifact.metadata?.size === 'landscape' ? 'landscape' : 'portrait',
      seed,
      ...(typeof result.seed === 'number' ? { seed: result.seed } : {}),
      status: path ? 'ok' : 'error',
      ...(path ? {} : { error: '出图没有返回图片。' }),
      durationMs: Date.now() - startedAt,
    });
    if (!path) return { ok: false, message: '柏宝绘没有返回图片。' };

    updateArtifact(floor, artifactId, {
      imagePath: path,
      prompt,
      // 写回时统一成「明确值」，避免清空 nl 后旧值又被带出来
      nl: nl || undefined,
      ...(artifact.negative ? { negative: artifact.negative } : {}),
      ...(typeof result.seed === 'number' ? { seed: result.seed } : {}),
      metadata: {
        ...(artifact.metadata ?? {}),
        ...(characters.length ? { characters } : {}),
        ...(typeof result.seed === 'number' ? { seed: result.seed } : {}),
        promptEditedAt: Date.now(),
      },
    });
    await saveChatSafe();
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordImageLog({
      mode: 'illustration',
      floor,
      source: 'api',
      plan: readOutConfig().activePlanName,
      prompt,
      size: artifact.metadata?.size === 'landscape' ? 'landscape' : 'portrait',
      seed,
      status: 'error',
      error: message,
      durationMs: Date.now() - startedAt,
    });
    return { ok: false, message: `柏宝绘出图失败：${message}` };
  }
}
