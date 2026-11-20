/**
 * 格数兜底：用户钉三格，出图却只有一格。
 *
 * 现场证据（聊天记录里的 metadata）：
 *   expectedPanelCount: 3, renderedPanelCount: 1, pageSlots: [1 条]
 * 原因：逐格出图的格子数 = `page.panels` 条数，而 panels 是模型写的；
 * 它把三格内容塞进了一条 subject，代码就没有第二、第三张图可出。
 */

import { describe, it, expect } from 'vitest';
import { expandPanels, detailTagsOf } from '../src/manga/panelExpand';
import { buildPanelShots } from '../src/manga/panelShot';
import { pageSlotsFor } from '../src/manga/pageSlots';
import type { BaiBaiCharacter, ComicPagePlan } from '../src/types';

const PAGE: ComicPagePlan = {
  pageIndex: 0,
  title: '耳语',
  layout: 'inset',
  tags: 'room interior, ceiling vent, warm air, blue paper bag, white rabbit plush toy, '
    + 'low lighting, winter, window light from ceiling, 1girl, 1boy',
  panels: [
    {
      index: 0,
      title: '只有一格',
      shot: 'medium shot',
      nl: 'he leans in behind her, one hand at her nape',
      characters: [{ name: '叶均', act: 'leaning in' }],
      mood: 'intimate',
      tags: '',
    },
  ],
  cast: [],
};

const YJ: BaiBaiCharacter = {
  name: '叶均',
  tag: '1boy, short silver white hair, grey eyes',
  fields: { outfit: 'charcoal striped shirt' },
};

describe('detailTagsOf', () => {
  it('只挑能推近看的道具：人物、光线、场景词都排除', () => {
    const details = detailTagsOf(PAGE.tags);
    expect(details).toContain('blue paper bag');
    expect(details).toContain('white rabbit plush toy');
    expect(details.join(',')).not.toMatch(/1girl|1boy/);
    expect(details.join(',')).not.toMatch(/low lighting|window light/);
  });
});

describe('expandPanels', () => {
  it('一格补到三格：条数对、景别各不相同、同一瞬间不跳时间', () => {
    const panels = expandPanels(PAGE, 3);
    expect(panels).toHaveLength(3);
    const shots = panels.map(p => p.shot);
    expect(new Set(shots).size).toBe(3);
    for (const panel of panels.slice(1)) {
      expect(panel.nl).toContain('he leans in behind her'); // 原 nl 被继承
      expect(panel.nl).toMatch(/same moment/);
      expect(panel.composition).toBe('single_detail');
      expect(panel.characters.map(c => c.name)).toEqual(['叶均']);
    }
  });

  it('已经够格时一个字都不动', () => {
    const three = expandPanels(PAGE, 3);
    const again = expandPanels({ ...PAGE, panels: three }, 3);
    expect(again.map(p => p.nl)).toEqual(three.map(p => p.nl));
  });

  it('给多了按目标截断', () => {
    const three = expandPanels(PAGE, 3);
    expect(expandPanels({ ...PAGE, panels: three }, 2)).toHaveLength(2);
  });

  it('补格之后每格都能建出角色块（不会只剩场景与衣服）', () => {
    const page = { ...PAGE, panels: expandPanels(PAGE, 3) };
    const shots = buildPanelShots(page, pageSlotsFor('inset', 3), [YJ]);
    expect(shots).toHaveLength(3);
    for (const shot of shots) {
      expect(shot.characters[0]?.tag).toContain('short silver white hair');
    }
  });
});
