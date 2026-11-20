/**
 * 漫画连续性 / 每格自由镜头 / 留白：任务书 Step 2-3 的回归测试。
 *
 * 用户实测问题：一页把几个不连续瞬间拼在一起、台词不连贯；两格动作差不多；
 * 选 3 格只画 2 格；强制每格同一批人；留白消失、所有格同尺寸铺满。
 */
import { describe, it, expect } from 'vitest';
import {
  buildPanelRule,
  parseComicPagePlan,
  validateComicContinuity,
  PANEL_TAGS_BY_LAYOUT,
} from '../src/manga/panelPlan';
import { LAYOUT_GAP_NOTE, buildPageNl } from '../src/manga/pageCompose';
import { enforcePanelPrompt } from '../src/manga/panelEnforce';
import type { ComicPagePlan, PanelLayout } from '../src/types';

const RULE_OPTS = { backend: 'nai' as const, charPrompts: true, nl: true, dialogue: true };

describe('连续瞬间是最高的分镜约束', () => {
  it('分镜规则里有「连续瞬间 / 禁止拼盘」条款，且不再出现 different moment 兜底', () => {
    const rule = buildPanelRule(true, RULE_OPTS);
    expect(rule).toMatch(/连续|continuous beat|同一瞬间/);
    expect(rule).toMatch(/禁止|不要|严禁/);
    expect(rule).not.toContain('different moment');
  });

  it('规则不再强制「同一批人出现在每格」，改成每格镜头自己决定人数', () => {
    const rule = buildPanelRule(true, RULE_OPTS);
    expect(rule).toMatch(/单人|single|局部/);
    expect(rule).not.toContain('同一批人出现在每一格');
    expect(rule).not.toContain('两格之间至少要有两个肉眼可辨的差异');
  });

  it('规则不再写「九成覆盖 / 3% 窄 gutter / filled edge to edge」', () => {
    const rule = buildPanelRule(true, RULE_OPTS);
    expect(rule).not.toMatch(/九成|edge to edge|filled edge|3% of the page width/);
  });

  it('留白收束句要求主次与负空间，不再要求铺满', () => {
    for (const note of Object.values(LAYOUT_GAP_NOTE)) {
      expect(note).toMatch(/negative space|empty|hero/i);
      expect(note).not.toMatch(/edge to edge|九成/);
    }
  });

  it('nl 兜底句写的是「同一瞬间的不同镜头」，不是「不同时刻」', () => {
    const empty: ComicPagePlan = {
      pageIndex: 0, title: '', layout: 'regular', tags: '', panels: [],
    };
    const nl = buildPageNl(empty);
    expect(nl).toMatch(/same continuous instant/i);
    expect(nl).not.toMatch(/different moment/i);
  });
});

describe('每格镜头类型 composition 与连续 beat 解析', () => {
  it('解析 composition / beat：单人局部与同步分屏都被保留', () => {
    const result = parseComicPagePlan({
      pages: [{
        pageIndex: 0, title: '电话', layout: 'irregular', tags: 'two people, phone call',
        beat: { timeScope: 'same moment', location: 'two places', event: 'one phone call', continuityNote: 'simultaneous' },
        panels: [
          { index: 0, title: '甲', composition: 'single_detail', characters: [{ name: 'Elias', act: 'speaking' }], tags: 'close-up' },
          { index: 1, title: '乙', composition: 'split_scene', characters: [{ name: 'Sissy', act: 'listening' }], tags: 'medium shot' },
        ],
      }],
    });
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].beat?.event).toBe('one phone call');
    expect(result.pages[0].panels[0].composition).toBe('single_detail');
    expect(result.pages[0].panels[1].composition).toBe('split_scene');
  });

  it('非法 composition 被丢弃，不污染类型', () => {
    const result = parseComicPagePlan({
      pages: [{ pageIndex: 0, title: '', layout: 'regular', tags: 'x',
        panels: [{ index: 0, title: '', composition: 'bananas', characters: [], tags: 'x' }] }],
    });
    expect(result.pages[0].panels[0].composition).toBeUndefined();
  });

  it('构图词仍按档位原样输出（权重写法不丢）', () => {
    expect(PANEL_TAGS_BY_LAYOUT.unframed.join(' ')).toContain('非对称漫画页面布局');
  });
});

describe('固定格数：选 N 格就必须下发 N 格构图词（选 3 只画 2 的根因）', () => {
  const layouts: PanelLayout[] = ['regular', 'irregular', 'inset', 'unframed'];
  for (const layout of layouts) {
    it(`${layout} 档固定 3 格 → prompt 含 3koma、不含 2koma/4koma`, () => {
      const before = '1girl, blue hair, cowboy shot';
      const out = enforcePanelPrompt(before, layout, 3);
      expect(out.prompt).toContain('3koma');
      expect(out.prompt).not.toMatch(/(?<!\d)[24]koma/);
    });
  }

  it('模型写错的 koma（选 3 格却写 2koma）会被纠正为 3koma', () => {
    const out = enforcePanelPrompt('2koma, 1girl', 'irregular', 3);
    expect(out.prompt).toContain('3koma');
    expect(out.prompt).not.toContain('2koma');
  });

  it('重复纠正幂等：纠正两次结果一致', () => {
    const once = enforcePanelPrompt('1girl', 'regular', 4).prompt;
    const twice = enforcePanelPrompt(once, 'regular', 4).prompt;
    expect(twice).toBe(once);
  });
});

describe('连续性体检 validator', () => {
  it('跳时词 + 空格 + 台词倒序会给出 warning', () => {
    const pages: ComicPagePlan[] = [{
      pageIndex: 0, title: '', layout: 'irregular', tags: 'x',
      nl: 'The first panel shows the argument; hours later they make up.',
      dialogue: [
        { text: '甲', panel: 2 },
        { text: '乙', panel: 1 },
      ],
      panels: [
        { index: 0, title: '', characters: [], mood: '', tags: '', nl: 'something' },
        { index: 1, title: '', characters: [], mood: '', tags: '' },
      ],
    }];
    const w = validateComicContinuity(pages);
    expect(w.some(s => s.includes('跳时词'))).toBe(true);
    expect(w.some(s => s.includes('空的'))).toBe(true);
    expect(w.some(s => s.includes('倒退'))).toBe(true);
  });

  it('同一瞬间的正常多格没有任何 warning', () => {
    const pages: ComicPagePlan[] = [{
      pageIndex: 0, title: '', layout: 'regular', tags: 'x',
      nl: 'One continuous moment, a main view and a close-up of the same instant.',
      dialogue: [{ text: '甲', panel: 1 }, { text: '乙', panel: 2 }],
      panels: [
        { index: 0, title: '', characters: [{ name: 'Elias', act: 'speaking' }], mood: '', tags: '' },
        { index: 1, title: '', characters: [{ name: 'Sissy', act: 'listening' }], mood: '', tags: '' },
      ],
    }];
    expect(validateComicContinuity(pages)).toEqual([]);
  });
});
