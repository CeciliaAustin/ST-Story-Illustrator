/**
 * 「要不要生成自然语言」必须由**出图方案**决定
 *
 * 这一条以前被写死成 true，于是方案面板上关掉「生成自然语言」的 4.5 方案
 * 照样收到一句「你必须写 nl」——用户看到的就是「为什么 4.5 还在写自然语言」。
 *
 * 判据与柏宝绘一致：`naiSupportsCharacterPrompts(model) && plan.naturalLanguage`
 * → 只有 4.5 / 5 才可能有 nl，且必须方案开关为真。
 */

import { describe, it, expect } from 'vitest';
import {
  parseOutConfig,
  planNlEnabled,
  planForMode,
  nlOfMode,
} from '../src/baibai/planConfig';

function snap(plans: Array<{ id: string; model: string; naturalLanguage?: boolean }>, activeId: string) {
  return parseOutConfig({
    nai: {
      plans: plans.map(p => ({ name: p.id, ...p })),
      activePlanId: activeId,
    },
  });
}

describe('planNlEnabled', () => {
  it('4.5 方案开了开关 → 要写 nl', () => {
    const s = snap([{ id: 'p1', model: 'nai-diffusion-4-5-full', naturalLanguage: true }], 'p1');
    expect(planNlEnabled(planForMode(s, 'illustration'))).toBe(true);
  });

  it('4.5 方案关了开关 → 不写 nl（就是用户说的那种情况）', () => {
    const s = snap([{ id: 'p1', model: 'nai-diffusion-4-5-full', naturalLanguage: false }], 'p1');
    expect(planNlEnabled(planForMode(s, 'illustration'))).toBe(false);
  });

  it('字段缺省按关处理（老配置没存过这个字段时不能替用户打开）', () => {
    const s = snap([{ id: 'p1', model: 'nai-diffusion-4-5-full' }], 'p1');
    expect(planNlEnabled(planForMode(s, 'illustration'))).toBe(false);
  });

  it('NAI4 本来就不吃自然语言：勾了也不写', () => {
    const s = snap([{ id: 'p1', model: 'nai-diffusion-4-full', naturalLanguage: true }], 'p1');
    expect(planNlEnabled(planForMode(s, 'illustration'))).toBe(false);
  });

  it('没有方案（柏宝绘未安装/没配）→ 不写 nl', () => {
    expect(planNlEnabled(undefined)).toBe(false);
    expect(nlOfMode(parseOutConfig({}), 'illustration')).toBe(false);
  });
});

describe('planForMode：模式指派了方案时按将要用的那套判断', () => {
  const s = snap([
    { id: 'p45', model: 'nai-diffusion-4-5-full', naturalLanguage: false },
    { id: 'p5', model: 'nai-diffusion-5-full', naturalLanguage: true },
  ], 'p45');

  it('没指派 → 跟随当前方案', () => {
    expect(nlOfMode(s, 'illustration')).toBe(false);
  });

  it('指派了另一套 → 按指派的那套（插画不切方案，所以它永远跟随当前方案）', () => {
    expect(nlOfMode(s, 'bw-manga', { 'bw-manga': 'p5' })).toBe(true);
    // 插图明确不切方案：即使别的模式指派了 p5，它也还是当前这套
    expect(nlOfMode(s, 'illustration', { illustration: 'p5' })).toBe(false);
  });

  it('指派了一个已删除的方案 → 退回当前方案，不崩也不误判成 true', () => {
    expect(nlOfMode(s, 'comic', { comic: 'ghost' })).toBe(false);
  });
});
