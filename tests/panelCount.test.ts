/**
 * 漫画「切页」：每页几格必须是一个数，不能模型说几格就几格。
 *
 * 三条链路要同时对齐，缺一条就回到「纸上写四格、图上只有两格」：
 *   提示词（每页固定 N 格）→ 构图词（3koma/4koma，删掉 2koma）→ nl 首句（three/four-panel）
 */

import { describe, it, expect } from 'vitest';
import { resolvePanelsPerPage, panelTagsForCount, buildPanelRule } from '../src/manga/panelPlan';
import { enforcePanelPrompt } from '../src/manga/panelEnforce';
import { buildPageNl } from '../src/manga/pageCompose';
import type { ComicPagePlan } from '../src/types';

function page(panelCount: number, layout: ComicPagePlan['layout'] = 'regular'): ComicPagePlan {
  return {
    pageIndex: 0,
    title: '测试页',
    layout,
    tags: '1girl, classroom',
    panels: Array.from({ length: panelCount }, (_v, i) => ({
      index: i,
      title: `第 ${i + 1} 格`,
      characters: [],
      mood: '',
      tags: '',
      nl: `Panel ${i + 1} action`,
    })),
    dialogue: [],
  };
}

describe('resolvePanelsPerPage', () => {
  it('用户指定 2~4 就照用', () => {
    expect(resolvePanelsPerPage('regular', 3)).toBe(3);
    expect(resolvePanelsPerPage('irregular', 4)).toBe(4);
  });

  it('自动时只有规整档能确定是 2 格', () => {
    expect(resolvePanelsPerPage('regular', 0)).toBe(2);
    expect(resolvePanelsPerPage('irregular', 0)).toBe(0);
    expect(resolvePanelsPerPage('inset', 0)).toBe(0);
  });

  it('越界值当没填', () => {
    expect(resolvePanelsPerPage('regular', 9)).toBe(2);
    expect(resolvePanelsPerPage('regular', 1)).toBe(2);
  });
});

describe('panelTagsForCount', () => {
  it('2 格用 2koma', () => {
    expect(panelTagsForCount('regular', 2).join(',')).toContain('2koma');
  });

  it('3/4 格换成对应的 koma 词，不再带 2koma', () => {
    expect(panelTagsForCount('regular', 3).join(',')).toContain('3koma');
    expect(panelTagsForCount('regular', 4).join(',')).toContain('4koma');
    expect(panelTagsForCount('regular', 4).join(',')).not.toContain('2koma');
  });

  it('所有档位钉格数时都注入对应 koma（选 3 只画 2 的根因：旧版只认 regular）', () => {
    expect(panelTagsForCount('irregular', 4).join(',')).toContain('4koma');
    expect(panelTagsForCount('irregular', 2).join(',')).toContain('2koma');
    expect(panelTagsForCount('inset', 3).join(',')).toContain('3koma');
    expect(panelTagsForCount('unframed', 3).join(',')).toContain('3koma');
    // 未钉格数（0）时仍不带任何 koma 词，保持自由出图
    expect(panelTagsForCount('irregular', 0).join(',')).not.toMatch(/\dkoma/);
  });
});

describe('enforcePanelPrompt 按格数纠正', () => {
  it('4 格时补 4koma，并把模型写的 2koma 删掉', () => {
    const r = enforcePanelPrompt('1girl, 1.4::multiple views::, 1.4::2koma::, classroom', 'regular', 4);
    expect(r.prompt).toContain('4koma');
    expect(r.prompt).not.toContain('2koma');
    expect(r.removed.some(t => t.includes('2koma'))).toBe(true);
  });

  it('没指定格数时维持原行为（2koma 保留）', () => {
    const r = enforcePanelPrompt('1girl, 1.4::2koma::', 'regular');
    expect(r.prompt).toContain('2koma');
  });
});

describe('buildPanelRule 按格数换规则', () => {
  it('4 格时标题、构图词、版面句一致', () => {
    const rule = buildPanelRule(true, { layout: 'regular', panelsPerPage: 4, nl: true });
    expect(rule).toContain('一张画布切4格');
    expect(rule).toContain('4koma');
    expect(rule).toContain('2×2');
    expect(rule).not.toContain('2koma');
  });

  it('3 格时说清「上宽 + 下二」', () => {
    const rule = buildPanelRule(true, { layout: 'regular', panelsPerPage: 3, nl: true });
    expect(rule).toContain('3koma');
    expect(rule).toContain('下方左右两个等宽格');
  });

  it('2 格仍是原来那套', () => {
    const rule = buildPanelRule(true, { layout: 'regular' });
    expect(rule).toContain('一张画布切两格');
    expect(rule).toContain('2koma');
  });
});

describe('buildPageNl 首句跟随格数', () => {
  it('两格说 two-panel', () => {
    expect(buildPageNl(page(2))).toContain('two-panel');
  });

  it('三格说 three-panel', () => {
    expect(buildPageNl(page(3))).toContain('three-panel');
  });

  it('四格说 four-panel 2×2', () => {
    const nl = buildPageNl(page(4));
    expect(nl).toContain('four-panel');
    expect(nl).toContain('two-by-two');
  });
});
