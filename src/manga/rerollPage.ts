/**
 * ST-Story-Illustrator — 漫画页「重画」
 *
 * 为什么需要：漫画页不再写 <bbi_image>，也就没有柏宝绘卡片上的「重绘/改词」按钮了。
 * 用户的「这张不满意，再画一次」不能跟着一起失去，所以卡片上补一个 ↻：
 * 用**当时真正发出去的那套词**（prompt + nl + 角色块）换一个种子重画，
 * 台词气泡重新合成，其余全部原样保留。
 *
 * 只换种子、不重读剧情：重画的语义是「同一张，换个手感」，不是「重新分镜」。
 * 想重新分镜就重新选段生成——那是另一件事。
 */

import type { PanelPageType } from '../types';
import { DEFAULT_SETTINGS, resolveModeSettings } from '../types';
import { getSettings, saveChatSafe } from '../host/sillytavern';
import { baiBaiAdapter } from '../baibai/imageAdapter';
import { getArtifacts, updateArtifact } from '../storage/repository';
import { ensureModeOutPlan, acquirePlanGuard, releasePlanGuard } from '../tasks/modePlan';
import { pickProfile, fallbackProfile } from '../tasks/theaterRun';
import { recordImageLog } from '../log/imageLog';
import { readOutConfig } from '../baibai/planConfig';

export interface ComicRerollResult {
  ok: boolean;
  message?: string;
}

/** NAI 种子上限；超了会被服务端拒。 */
function randomSeed(): number {
  return Math.floor(Math.random() * 4294967295);
}

/**
 * 重画某一页漫画。原位更新 artifact（图片路径 + 种子），
 * 调用方负责 saveChatSafe 与 mountFloor；气泡由显示层重新合成。
 */
export async function rerollComicPage(floor: number, artifactId: string): Promise<ComicRerollResult> {
  const artifact = getArtifacts(floor).find(a => a.id === artifactId);
  if (!artifact) return { ok: false, message: '找不到这一页。' };
  if (artifact.mode !== 'comic') return { ok: false, message: '这张不是漫画页。' };
  if (!artifact.prompt.trim()) return { ok: false, message: '这一页没存下当时的出图词，请重新选段生成。' };

  const settings = getSettings(DEFAULT_SETTINGS);
  const comic = resolveModeSettings(settings, 'comic');
  const meta = artifact.metadata ?? {};
  const characters = Array.isArray(meta.characters)
    ? (meta.characters as Array<{ name: string; tag: string; nl?: string }>)
    : [];
  // 页型优先用这一页自己的元数据：显示层合成按它重放，改全局设置不影响历史页
  const pageType = (meta.pageType ?? comic.comicPageType ?? 'auto') as PanelPageType;

  const seed = randomSeed();
  const startedAt = Date.now();
  // 重画可能插在队列任务中间跑：先占位，最后一个交还的负责把方案还原
  acquirePlanGuard();
  try {
    await ensureModeOutPlan('comic', settings);
    const result = await baiBaiAdapter.generate(
      {
        prompt: artifact.prompt,
        ...(artifact.nl ? { nl: artifact.nl } : {}),
        ...(characters.length ? { characters } : {}),
        ...(typeof meta.characterName === 'string' && meta.characterName
          ? { character: meta.characterName }
          : {}),
        seed,
        size: 'portrait',
        save: true,
      },
      pickProfile(settings.profiles ?? [], 'comic') ?? fallbackProfile('comic'),
    );
    const rawPath = result.path ?? result.dataUrl;
    if (!rawPath) {
      recordImageLog({
        mode: 'comic', floor, source: 'api',
        plan: readOutConfig().activePlanName,
        prompt: artifact.prompt,
        size: 'portrait', seed,
        status: 'error', error: '出图没有返回图片。',
        durationMs: Date.now() - startedAt,
      });
      return { ok: false, message: '出图没有返回图片。' };
    }

    // 台词气泡不再烧录进图：落盘的永远是无字原图，显示层按 artifact.dialogue
    // 与版面元数据重放合成（改台词 / 挪气泡不消耗额度，正是原版架构的收益）。
    // 重画也不换样式：样式在显示层生效，换形态对历史图同样有效。
    updateArtifact(floor, artifactId, {
      imagePath: rawPath,
      originalImagePath: undefined,
      metadata: {
        ...meta,
        rawImagePath: rawPath,
        bubbleBakedPath: undefined,
        ...(meta.pageType ? {} : { pageType }),
        ...(typeof result.seed === 'number' ? { seed: result.seed } : { seed }),
      },
    });
    recordImageLog({
      mode: 'comic', floor, source: 'api',
      plan: readOutConfig().activePlanName,
      prompt: artifact.prompt,
      ...(artifact.nl ? { nl: artifact.nl } : {}),
      ...(characters.length ? { characters } : {}),
      size: 'portrait',
      ...(typeof result.seed === 'number' ? { seed: result.seed } : { seed }),
      status: 'ok',
      durationMs: Date.now() - startedAt,
    });
    await saveChatSafe();
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordImageLog({
      mode: 'comic', floor, source: 'api',
      plan: readOutConfig().activePlanName,
      prompt: artifact.prompt,
      size: 'portrait', seed,
      status: 'error', error: message,
      durationMs: Date.now() - startedAt,
    });
    return { ok: false, message };
  } finally {
    await releasePlanGuard(settings);
  }
}
