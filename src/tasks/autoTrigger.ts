/**
 * 自动出图：这一层该跑哪些模式（纯函数）
 *
 * 抽出来是为了能被测试盯住。这里曾经有一个**永远为真**的提前返回：
 * `if (settings.enabled === false) return;` —— 而 `enabled` 默认 false，
 * 全插件又没有第二个地方把它置 true，于是「勾了自动出图但从来不出」。
 * 现在是否自动出图**只由各模式自己的 autoTrigger 决定**。
 */

import { resolveModeSettings } from '../types';
import type { CreationMode, StoryIllustratorSettings } from '../types';

/** 小剧场的三个 bucket（与 theater/store 的 Bucket 对齐）。 */
export type TheaterBucket = 'status' | 'bonus' | 'manga';

export interface AutoTriggerContext {
  /** 这一层是否已经有该 bucket 的小剧场作品 */
  hasStory: (kind: TheaterBucket) => boolean;
  /** 这一层是否已经有该模式的作品（正文两套用） */
  hasArtifact: (mode: CreationMode) => boolean;
  /** 这个 `${floor}:${mode}` 是否正在跑/刚跑过 */
  busy: (key: string) => boolean;
  /** 0..100 的随机数（彩蛋按概率出；注入便于测试） */
  random?: () => number;
}

/**
 * 出图顺序。
 * 正文两套排前面：它们是「正文的图」，出完正文就完整了；
 * 小剧场是附加物，后出不影响阅读。
 */
export const AUTO_ORDER: ReadonlyArray<{ mode: CreationMode; kind?: TheaterBucket }> = [
  { mode: 'illustration' },
  { mode: 'comic' },
  { mode: 'chibi-status', kind: 'status' },
  { mode: 'chibi-bonus', kind: 'bonus' },
  { mode: 'bw-manga', kind: 'manga' },
];

/** 按设置挑出这一层要自动生成的模式（顺序即出图顺序）。 */
export function pickAutoModes(
  settings: Partial<StoryIllustratorSettings> | undefined | null,
  floor: number,
  ctx: AutoTriggerContext,
): CreationMode[] {
  const random = ctx.random ?? Math.random;
  const picks: CreationMode[] = [];

  for (const { mode, kind } of AUTO_ORDER) {
    const conf = resolveModeSettings(settings as StoryIllustratorSettings, mode);
    if (!conf.autoTrigger) continue;
    if (kind && ctx.hasStory(kind)) continue;
    // 正文两套：本楼已经有作品就不再自动插（刷新/重渲会重复触发）
    if (!kind && ctx.hasArtifact(mode)) continue;
    if (kind === 'bonus') {
      const chance = Number(conf.chibiBonusChance ?? settings?.chibiBonusChance ?? 25);
      if (!Number.isFinite(chance) || chance <= 0) continue;
      if (chance < 100 && random() * 100 >= chance) continue;
    }
    if (ctx.busy(`${floor}:${mode}`)) continue;
    picks.push(mode);
  }
  return picks;
}
