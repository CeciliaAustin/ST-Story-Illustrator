/**
 * 自动出图：这一层该跑哪些模式
 *
 * 回归点：以前 `maybeAutoTrigger` 开头有一道
 * `if (settings.enabled === false) return;`，而 `enabled` 默认 false 且**没有任何 UI**
 * 能把它改成 true —— 勾了「自动出图」也永远不会触发。
 * 现在只认各模式自己的 autoTrigger。
 */

import { describe, it, expect } from 'vitest';
import { pickAutoModes, isFreshGeneratedFloor } from '../src/tasks/autoTrigger';
import { DEFAULT_SETTINGS } from '../src/types';
import type { StoryIllustratorSettings } from '../src/types';

function settingsWith(modes: Partial<Record<string, { autoTrigger?: boolean }>>): StoryIllustratorSettings {
  const s: StoryIllustratorSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  for (const [mode, patch] of Object.entries(modes)) {
    (s.modes as Record<string, Record<string, unknown>>)[mode] = {
      ...(s.modes as Record<string, Record<string, unknown>>)[mode],
      ...patch,
    };
  }
  return s;
}

const empty = {
  hasStory: () => false,
  hasArtifact: () => false,
  busy: () => false,
  random: () => 0,
};

describe('pickAutoModes', () => {
  it('没勾任何模式 → 什么都不跑', () => {
    expect(pickAutoModes(DEFAULT_SETTINGS, 3, empty)).toEqual([]);
  });

  it('勾了正文插图 → 会跑（不再被那个永远为 false 的全局开关挡掉）', () => {
    const s = settingsWith({ illustration: { autoTrigger: true } });
    expect(pickAutoModes(s, 3, empty)).toEqual(['illustration']);
  });

  it('全局 enabled=false 不影响自动出图（这正是以前的 bug）', () => {
    const s = settingsWith({ illustration: { autoTrigger: true } });
    expect(s.enabled).toBe(false);
    expect(pickAutoModes(s, 3, empty)).toEqual(['illustration']);
  });

  it('顺序固定：正文两套在前，小剧场在后', () => {
    const s = settingsWith({
      'bw-manga': { autoTrigger: true },
      illustration: { autoTrigger: true },
      'chibi-status': { autoTrigger: true },
    });
    expect(pickAutoModes(s, 1, empty)).toEqual(['illustration', 'chibi-status', 'bw-manga']);
  });

  it('本楼已有作品/已出过小剧场 → 跳过，避免重渲重复出图', () => {
    const s = settingsWith({
      illustration: { autoTrigger: true },
      comic: { autoTrigger: true },
      'chibi-status': { autoTrigger: true },
    });
    const picks = pickAutoModes(s, 1, {
      ...empty,
      hasArtifact: mode => mode === 'illustration',
      hasStory: kind => kind === 'status',
    });
    expect(picks).toEqual(['comic']);
  });

  it('正在跑的模式不会被重复排', () => {
    const s = settingsWith({ illustration: { autoTrigger: true } });
    expect(pickAutoModes(s, 7, { ...empty, busy: key => key === '7:illustration' })).toEqual([]);
  });

  it('新聊天/刷新重渲历史：不在生成窗口内 → 不算新层（不会一进聊天就自动出图）', () => {
    expect(isFreshGeneratedFloor({ generationActive: false, isAiStoryMessage: true })).toBe(false);
    expect(isFreshGeneratedFloor({ generationActive: false, isAiStoryMessage: false })).toBe(false);
  });

  it('真实生成一层：在窗口内且是 AI 剧情层 → 算新层', () => {
    expect(isFreshGeneratedFloor({ generationActive: true, isAiStoryMessage: true })).toBe(true);
  });

  it('生成窗口内到达的用户层/非剧情层 → 不算', () => {
    expect(isFreshGeneratedFloor({ generationActive: true, isAiStoryMessage: false })).toBe(false);
  });

  it('彩蛋按概率：0 = 永不，100 = 必出，随机值落在区间内才出', () => {
    const s = settingsWith({ 'chibi-bonus': { autoTrigger: true } });
    /** random 与 Math.random 同口径：0..1 */
    const bonus = (chance: number, r: number) => {
      const conf = s.modes['chibi-bonus'];
      conf.chibiBonusChance = chance;
      return pickAutoModes(s, 1, { ...empty, random: () => r });
    };
    expect(bonus(0, 0)).toEqual([]);
    expect(bonus(100, 0.99)).toEqual(['chibi-bonus']);
    expect(bonus(25, 0.1)).toEqual(['chibi-bonus']);
    expect(bonus(25, 0.9)).toEqual([]);
  });
});
