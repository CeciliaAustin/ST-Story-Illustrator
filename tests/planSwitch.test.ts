/**
 * 方案按钮定位（纯函数部分）
 *
 * 这段逻辑决定了「切方案」会不会切错地方：
 * - 精确匹配优先（方案名互相包含时不能瞎猜）
 * - 有歧义就报错，让用户改名，而不是点第一个
 * 真实点击那部分依赖柏宝绘 DOM，跑不了单测；这里锁住的是选择规则。
 */

import { describe, it, expect } from 'vitest';
import { pickPlanRadio } from '../src/baibai/planSwitch';

/** 造一个只够 pickPlanRadio 用的假按钮（它只读 .item-name / textContent）。 */
function fakeRadio(name: string): HTMLElement {
  return {
    querySelector: () => ({ textContent: name }),
    textContent: name,
  } as unknown as HTMLElement;
}

describe('pickPlanRadio', () => {
  it('精确同名直接命中', () => {
    const radios = [fakeRadio('NAI5 主用'), fakeRadio('NAI4.5 省钱')];
    const picked = pickPlanRadio(radios, 'NAI4.5 省钱');
    expect(picked.radio).toBe(radios[1]);
    expect(picked.ambiguous).toBe(false);
  });

  it('只有唯一包含项时可用（名字被截断/加了后缀也能点到）', () => {
    const radios = [fakeRadio('NAI5'), fakeRadio('NAI4.5 · 便宜')];
    const picked = pickPlanRadio(radios, 'NAI4.5');
    expect(picked.radio).toBe(radios[1]);
  });

  it('多个都包含 → 判歧义，绝不猜', () => {
    const radios = [fakeRadio('NAI4.5 A'), fakeRadio('NAI4.5 B')];
    const picked = pickPlanRadio(radios, 'NAI4.5');
    expect(picked.radio).toBeNull();
    expect(picked.ambiguous).toBe(true);
  });

  it('同名重复 → 判歧义', () => {
    const radios = [fakeRadio('方案'), fakeRadio('方案')];
    expect(pickPlanRadio(radios, '方案').ambiguous).toBe(true);
  });

  it('找不到就是找不到（不做模糊到第一个的兜底）', () => {
    const radios = [fakeRadio('NAI5')];
    const picked = pickPlanRadio(radios, 'NAI4.5');
    expect(picked.radio).toBeNull();
    expect(picked.ambiguous).toBe(false);
  });

  it('列表为空时不抛错', () => {
    expect(pickPlanRadio([], '任意').radio).toBeNull();
  });
});
