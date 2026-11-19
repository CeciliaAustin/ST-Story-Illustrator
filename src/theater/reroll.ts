/**
 * 小剧场卡片的「重画」链路
 *
 * - rerollPanel：单格重画，沿用那一格当时真正发出去的正/负面词，只换种子
 * - rerollSet：整条重出，用存下来的选段原文重新读剧情、重新分镜、重新出图
 *
 * 两者都先落盘再让 UI 重挂，刷新后仍然是新图。
 */

import type { BbiStatusInfo, StoryKind } from '../types';
import { DEFAULT_SETTINGS } from '../types';
import { getCurrentChatId, getSettings, getSwipeId, saveChatSafe } from '../host/sillytavern';
import { baiBaiAdapter } from '../baibai/imageAdapter';
import { ensureModeOutPlan, acquirePlanGuard, releasePlanGuard } from '../tasks/modePlan';
import { bakeTheaterLines, fallbackProfile, modeOfKind, pickProfile, runTheaterTask } from '../tasks/theaterRun';
import { getSets, replaceSet, updatePanel } from './store';
import { recordImageLog } from '../log/imageLog';
import { readOutConfig } from '../baibai/planConfig';
import { buildMangaNl } from './prompts';

export interface RerollResult {
  ok: boolean;
  message?: string;
}

/** NAI 的种子上限；超了会被服务端拒。 */
function randomSeed(): number {
  return Math.floor(Math.random() * 4294967295);
}

export interface PanelPromptEdit {
  prompt: string;
  nl: string;
}

/** 重画某一格。edit 存在时用用户改过的词，并把它写回这一格（下次重画沿用）。 */
export async function rerollPanel(
  floor: number,
  kind: StoryKind,
  setId: string,
  index: number,
  edit?: PanelPromptEdit,
): Promise<RerollResult> {
  const settings = getSettings(DEFAULT_SETTINGS);
  const set = getSets(floor, kind).find(s => s.setId === setId);
  const panel = set?.panels.find(p => p.index === index);
  if (!panel) return { ok: false, message: '找不到这一格。' };
  const promptText = (edit?.prompt ?? panel.prompt ?? '').trim();
  if (!promptText) {
    return { ok: false, message: '这一格没存下当时的出图词，请用「整条重出」。' };
  }

  const mode = modeOfKind(kind);
  // 重画也可能插在队列任务中间跑：先占位，最后一个交还的负责把方案还原
  acquirePlanGuard();

  const rawNl = edit ? edit.nl : (panel.story ?? '');
  const seed = randomSeed();
  const startedAt = Date.now();
  try {
    await ensureModeOutPlan(mode, settings);
    // 这张图当时是靠 nl 把剧情落下去的，重画也必须带同一段 nl，
    // 否则重画出来的图会忽然和第一版不是同一件事。
    const nl = kind === 'manga' ? buildMangaNl(rawNl) : rawNl;
    const result = await baiBaiAdapter.generate(
      {
        prompt: promptText,
        ...(nl ? { nl } : {}),
        ...(panel.negative ? { negative: panel.negative } : {}),
        // 外貌不再拼在 prompt 里，重画时必须把当时那几个人一起带上，
        // 否则重画出来的脸会换人（用户看到的就是「重画一次变了个角色」）。
        ...(panel.characters?.length ? { characters: panel.characters } : {}),
        seed,
        size: 'portrait',
        save: true,
      },
      pickProfile(settings.profiles ?? [], mode) ?? fallbackProfile(mode),
    );
    const raw = result.path ?? result.dataUrl;
    if (!raw) return { ok: false, message: '出图没有返回图片。' };

    recordImageLog({
      mode, floor, source: 'api',
      plan: readOutConfig().activePlanName,
      prompt: promptText,
      ...(nl ? { nl } : {}),
      ...(panel.negative ? { negative: panel.negative } : {}),
      ...(panel.characters?.length ? { characters: panel.characters } : {}),
      size: 'portrait',
      ...(typeof result.seed === 'number' ? { seed: result.seed } : { seed }),
      status: 'ok',
      durationMs: Date.now() - startedAt,
    });

    // 黑白漫带台词：单格重画也要重新叠气泡，否则这一格会突然变成无字版
    let path = raw;
    let originalPath: string | undefined;
    if (kind === 'manga' && panel.lines?.length) {
      const baked = await bakeTheaterLines(raw, panel.lines, settings, kind);
      if (baked.baked) {
        originalPath = raw;
        path = baked.path;
      }
    }

    updatePanel(floor, kind, setId, index, {
      imagePath: path,
      ...(originalPath ? { originalPath } : {}),
      seed: result.seed ?? seed,
      storyAt: Date.now(),
      // 改过的词写回这一格：不改的话下次 ↻ 又把旧词画一遍，用户会以为改词没生效
      ...(edit ? { prompt: promptText, story: edit.nl } : {}),
    });
    await saveChatSafe();
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordImageLog({
      mode, floor, source: 'api',
      prompt: promptText,
      size: 'portrait',
      status: 'error',
      error: message,
      durationMs: Date.now() - startedAt,
    });
    return { ok: false, message };
  } finally {
    await releasePlanGuard(settings);
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
  acquirePlanGuard();

  let result: Awaited<ReturnType<typeof runTheaterTask>> | null = null;
  try {
    await ensureModeOutPlan(mode, settings);
    result = await runTheaterTask({
      mode,
      settings,
      floor,
      chatId: getCurrentChatId(),
      swipe: getSwipeId(floor),
      body,
      characterName: set.characterName,
    });
  } finally {
    await releasePlanGuard(settings);
  }
  if (!result) return { ok: false, message: '整条重出失败。' };
  if (!result.ok) return { ok: false, message: result.error ?? '整条重出失败。' };

  const total = result.stories.length;
  const stories: BbiStatusInfo[] = [];
  for (const story of result.stories) {
    let imagePath = story.imagePath;
    let originalPath: string | undefined;
    if (kind === 'manga' && story.lines?.length && imagePath) {
      const baked = await bakeTheaterLines(imagePath, story.lines, settings, kind);
      if (baked.baked) {
        originalPath = imagePath;
        imagePath = baked.path;
      }
    }
    stories.push({
      ...story,
      imagePath,
      ...(originalPath ? { originalPath } : {}),
      setId,
      setTitle: story.title ?? set.title,
      setSize: total,
      sourceText: body,
      characterName: set.characterName,
    });
  }

  replaceSet(floor, kind, setId, stories);
  await saveChatSafe();
  return { ok: true };
}
