/**
 * 方案定位与导航定位（纯函数部分）
 *
 * 这段逻辑决定了「切方案」会不会切错地方：
 * - 精确匹配优先（方案名互相包含时不能瞎猜）
 * - 有歧义就报错，让用户改名，而不是点第一个
 * - 导航/页签也只认唯一命中，找不到就报错（宁可失败，不可切错）
 * 真实点击那部分依赖柏宝绘 DOM，跑不了单测；这里锁住的是选择规则。
 */

import { describe, it, expect } from 'vitest';
import {
  pickPlanRadio,
  pickNavButton,
  pickTab,
  navLabelOf,
  tabLabelOf,
} from '../src/baibai/planSwitch';

/** 造一个只够 pickPlanRadio 用的假按钮（它只读 .item-name / textContent）。 */
function fakeRadio(name: string): HTMLElement {
  return {
    querySelector: () => ({ textContent: name }),
    textContent: name,
  } as unknown as HTMLElement;
}

/** 造一个导航按钮：柏宝绘用 title/aria-label 标页名，窄屏下才渲染 .bbi-nav-label。 */
function fakeNav(title: string | null, label?: string): HTMLElement {
  return {
    querySelector: (sel: string) => (sel === '.bbi-nav-label' && label ? { textContent: label } : null),
    getAttribute: (name: string) => (name === 'title' ? title : null),
    textContent: label ?? '',
  } as unknown as HTMLElement;
}

const fakeTab = (text: string) => ({ textContent: text }) as unknown as HTMLElement;

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

describe('pickNavButton', () => {
  it('按 title 精确命中「渠道」', () => {
    const target = fakeNav('渠道');
    const navs = [fakeNav('图库'), target, fakeNav('设置')];
    expect(pickNavButton(navs, '渠道')).toBe(target);
  });

  it('没有 title 时退回 .bbi-nav-label 的文字（窄屏布局）', () => {
    const target = fakeNav(null, '渠道');
    expect(pickNavButton([fakeNav(null, '角色管理'), target], '渠道')).toBe(target);
  });

  it('找不到就返回 null，不点第一个凑数', () => {
    expect(pickNavButton([fakeNav('图库'), fakeNav('设置')], '渠道')).toBeNull();
  });

  it('重名 → 不猜', () => {
    expect(pickNavButton([fakeNav('渠道'), fakeNav('渠道')], '渠道')).toBeNull();
  });
});

describe('pickTab', () => {
  it('精确命中 NAI，不会被 ComfyUI 干扰', () => {
    const nai = fakeTab('NAI');
    const tabs = [fakeTab('ComfyUI'), nai];
    expect(pickTab(tabs, 'NAI')).toBe(nai);
    expect(tabLabelOf(nai)).toBe('NAI');
  });

  it('带后缀也能唯一命中', () => {
    const nai = fakeTab('NAI 图像');
    expect(pickTab([fakeTab('ComfyUI'), nai], 'NAI')).toBe(nai);
  });

  it('前缀撞车 → 不猜', () => {
    expect(pickTab([fakeTab('NAI 4.5'), fakeTab('NAI 5')], 'NAI')).toBeNull();
  });

  it('没有页签时返回 null', () => {
    expect(pickTab([], 'NAI')).toBeNull();
  });
});

describe('navLabelOf', () => {
  it('title 优先，空白被压平', () => {
    expect(navLabelOf(fakeNav(' 角色 管理 '))).toBe('角色 管理');
  });
});
