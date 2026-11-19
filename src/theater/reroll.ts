/**
 * 小剧场卡片的「重画」链路
 *
 * - rerollPanel：单格重画，沿用那一格当时真正发出去的正/负面词，只换种子
 * - rerollSet：整条重出，用存下来的选段原文重新读剧情、重新分镜、重新出图
 *
 * 两者都先落盘再让 UI 重挂，刷新后仍然是新图。
 */

import type { StoryKind } from '../types';
import { DEFAULT_SETTINGS } from '../types';
import { getCurrentChatId, getSettings, getSwipeId, saveChatSafe } from '../host/sillytavern';
import { baiBaiAdapter } from '../baibai/imageAdapter';
import { ensureModeOutPlan } from '../tasks/modePlan';
import { fallbackProfile, modeOfKind, pickProfile, runTheaterTask } from '../tasks/theaterRun';
import { getSets, replaceSet, updatePanel } from './store';
import { recordImageLog } from '../log/imageLog';

export interface RerollResult {
  ok: boolean;
  message?: string;
}

/** NAI 的种子上限；超了会被服务端拒。 */
function randomSeed(): number {
  return Math.floor(Math.random() * 4294967295);
}

/** 重画某一格。 */
export async function rerollPanel(
  floor: number,
  kind: StoryKind,
  setId: string,
  index: number,
): Promise<RerollResult> {
  const settings = getSettings(DEFAULT_SETTINGS);
  const set = getSets(floor, kind).find(s => s.setId === setId);
  const panel = set?.panels.find(p => p.index === index);
  if (!panel) return { ok: false, message: '找不到这一格。' };
  if (!panel.prompt) {
    return { ok: false, message: '这一格没存下当时的出图词，请用「整条重出」。' };
  }

  const mode = modeOfKind(kind);
  await ensureModeOutPlan(mode, settings);

  const seed = randomSeed();
  const startedAt = Date.now();
  try {
    const result = await baiBaiAdapter.generate(
      {
        prompt: panel.prompt,
        ...(panel.negative ? { negative: panel.negative } : {}),
        seed,
        size: 'portrait',
        save: true,
      },
      pickProfile(settings.profiles ?? [], mode) ?? fallbackProfile(mode),
    );
    const path = result.path ?? result.dataUrl;
    if (!path) return { ok: false, message: '出图没有返回图片。' };

    recordImageLog({
      mode, floor, source: 'api',
      prompt: panel.prompt,
      ...(panel.negative ? { negative: panel.negative } : {}),
      size: 'portrait',
      ...(typeof result.seed === 'number' ? { seed: result.seed } : { seed }),
      status: 'ok',
      durationMs: Date.now() - startedAt,
    });

    updatePanel(floor, kind, setId, index, {
      imagePath: path,
      seed: result.seed ?? seed,
      storyAt: Date.now(),
    });
    await saveChatSafe();
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordImageLog({
      mode, floor, source: 'api',
      prompt: panel.prompt ?? '',
      size: 'portrait',
      status: 'error',
      error: message,
      durationMs: Date.now() - startedAt,
    });
    return { ok: false, message };
  }
}

/** 整条重出：重新读剧情 → 重新分镜 → 重新出图，原位替换整张卡片。 */
export async function rerollSet(
  floor: number,
  kind: StoryKind,
  setId: string,
): Promise<RerollResult> {
  const settings = getSettings(DEFAULT_SETTINGS);
  const set = getSets(floor, kind).find(s => s.setId === setId);
  if (!set) return { ok: false, message: '找不到这张卡片。' };

  const body = (set.sourceText ?? '').trim();
  if (!body) {
    return { ok: false, message: '这张卡片没存下当时的选段，请重新选段生成。' };
  }

  const mode = modeOfKind(kind);
  await ensureModeOutPlan(mode, settings);

  const result = await runTheaterTask({
    mode,
    settings,
    floor,
    chatId: getCurrentChatId(),
    swipe: getSwipeId(floor),
    body,
    characterName: set.characterName,
  });
  if (!result.ok) return { ok: false, message: result.error ?? '整条重出失败。' };

  const total = result.stories.length;
  const stories = result.stories.map(story => ({
    ...story,
    setId,
    setTitle: story.title ?? set.title,
    setSize: total,
    sourceText: body,
    characterName: set.characterName,
  }));

  replaceSet(floor, kind, setId, stories);
  await saveChatSafe();
  return { ok: true };
}
