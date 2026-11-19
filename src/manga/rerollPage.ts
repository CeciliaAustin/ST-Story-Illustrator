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

import type { BubbleStyleId, BubbleFontId, PanelPageType, PanelLayout } from '../types';
import { DEFAULT_SETTINGS, resolveModeSettings } from '../types';
import { getSettings, saveChatSafe } from '../host/sillytavern';
import { baiBaiAdapter } from '../baibai/imageAdapter';
import { getArtifacts, updateArtifact } from '../storage/repository';
import { bakeDialogueIntoImage } from './bubbleBake';
import { panelSlots, layoutNoGoZones } from './panelSlots';
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

function asLayout(v: unknown): PanelLayout {
  return v === 'irregular' || v === 'inset' || v === 'unframed' ? v : 'regular';
}

/**
 * 重画某一页漫画。原位更新 artifact（图片路径 + 种子 + 带字版路径），
 * 调用方负责 saveChatSafe 与 mountFloor。
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
  const layout = asLayout(meta.layout);
  const panelCount = typeof meta.panelCount === 'number' ? meta.panelCount : 0;
  const pageType = (comic.comicPageType ?? 'auto') as PanelPageType;
  const style = (comic.comicBubbleStyle ?? settings.bubbleStyle) as BubbleStyleId | undefined;
  const font = (comic.comicBubbleFont ?? settings.bubbleFont) as BubbleFontId | undefined;
  const showComposite = comic.comicShowComposite !== false;

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

    // 台词跟着一起重画：否则重画出来的这一页会突然变成无字版
    let imagePath = rawPath;
    let bakedPath = '';
    if (showComposite && artifact.dialogue?.length) {
      const slots = panelSlots(layout, panelCount, pageType);
      const noGo = layoutNoGoZones(layout, pageType);
      const baked = await bakeDialogueIntoImage({
        imagePath: rawPath,
        dialogue: artifact.dialogue,
        ...(style ? { style } : {}),
        ...(font ? { font } : {}),
        ...(slots.length ? { slots } : {}),
        ...(noGo.length ? { noGo } : {}),
      });
      if (baked) {
        bakedPath = baked;
        imagePath = baked;
      }
    }

    updateArtifact(floor, artifactId, {
      imagePath,
      ...(bakedPath ? { originalImagePath: rawPath } : {}),
      metadata: {
        ...meta,
        rawImagePath: rawPath,
        ...(bakedPath ? { bubbleBakedPath: bakedPath } : {}),
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
