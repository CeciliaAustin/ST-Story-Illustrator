/**
 * 版面语义：页面底色 / 格内背景 / 格间隙 三件事必须分开。
 *
 * 用户点出过的语义偏差，这里逐条固化成断言：
 * 1. `white background` 是「画面底色」，不是「格与格之间的留白」——
 *    写进漫画提示词，模型会把整张画布连同格内背景一起抹白。
 * 2. 「an unframed character illustration + one or two small panels」把主画面
 *    降级成独立插画，格数也就无从谈起；主画面必须说成 large main panel。
 * 3. 留白（margin / gutter）与边框（border）是纯几何，应由代码调，不该进提示词。
 */
import { describe, it, expect } from 'vitest';
import { enforcePanelPrompt, boardAreaLeads, WHITE_GROUND_TAGS } from '../src/manga/boardPrompt';
import { buildDeclarativePageNl } from '../src/manga/pageCompose';
import { pageSlotsFor, DEFAULT_MARGIN, DEFAULT_GUTTER } from '../src/manga/pageSlots';
import type { ComicPagePlan } from '../src/types';

const PAGE: ComicPagePlan = {
  pageIndex: 0,
  title: '耳语',
  layout: 'inset',
  panels: [
    { index: 0, title: '主图', nl: 'in the fitting room, he leans down to her ear' },
    { index: 1, title: '脸', nl: 'close-up of her blushing face' },
    { index: 2, title: '手', nl: 'close-up of his hand on her sleeve' },
  ],
};

const BOARD = { layout: 'inset' as const, pageType: 'auto' as const, panelCount: 3, whitespace: 'airy' as const };

describe('兜底整页提示词：不再把「留白」写成 white background', () => {
  it('declarative 模式把白底词全剥掉，且不再补回来', () => {
    const raw = '1.4::white background::, 1boy, 1girl, 2::无边框中央插画::, luxury boutique';
    const out = enforcePanelPrompt(raw, 'inset', { declarative: true });
    for (const tag of WHITE_GROUND_TAGS) {
      expect(out.prompt.toLowerCase()).not.toContain(tag.toLowerCase());
    }
    expect(out.prompt).toContain('luxury boutique'); // 场景必须留下
    expect(out.removed.join('|')).toMatch(/white background/i);
  });

  it('非 declarative（原版白底档）保持原样，不误伤别处调用', () => {
    const out = enforcePanelPrompt('1boy, indoors', 'inset');
    expect(out.prompt).toContain('white background');
  });

  it('剥掉白底词后仍保留「多格」信号（否则模型只画一格）', () => {
    const out = enforcePanelPrompt('1boy, 1girl', 'inset', { declarative: true });
    expect(out.prompt).toMatch(/multiple views/i);
  });
});

describe('声明式整页 nl：说「N 个独立画格」，不是「一张白底插画」', () => {
  const nl = buildDeclarativePageNl(BOARD, PAGE);

  it('开头就点明是 three-panel manga page 且是三个独立画格', () => {
    expect(nl.startsWith('A three-panel manga page')).toBe(true);
    expect(nl).toMatch(/three separate, individually framed comic panels/);
  });

  it('绝不出现 white background / unframed character illustration', () => {
    expect(nl.toLowerCase()).not.toContain('white background');
    expect(nl.toLowerCase()).not.toContain('unframed character illustration');
    expect(nl.toLowerCase()).not.toContain('one or two');
  });

  it('把三个概念分开写：格内有场景、只有格间空隙是页面底色', () => {
    expect(nl).toMatch(/its own full scene background/i);
    expect(nl).toMatch(/gap between panels and the page margin/i);
    expect(nl).toMatch(/that gap is the page background/i);
    expect(nl).toMatch(/not a request to remove the background inside any panel/i);
  });

  it('主画面被说成 large main panel，而不是 illustration', () => {
    expect(nl).toMatch(/large main panel/i);
    expect(nl).not.toMatch(/main illustration/i);
  });

  it('各格内容都进来了，且带连续性收束', () => {
    expect(nl).toContain('he leans down to her ear');
    expect(nl).toContain('blushing face');
    expect(nl).toContain('hand on her sleeve');
    expect(nl).toMatch(/same continuous instant/i);
  });

  it('单格页不会说 three-panel', () => {
    const one = buildDeclarativePageNl(
      { ...BOARD, panelCount: 1 },
      { ...PAGE, panels: [{ index: 0, title: '单格', nl: 'she stands alone' }] },
    );
    expect(one.startsWith('A one-panel manga page')).toBe(true);
    expect(one).not.toMatch(/three-panel/);
  });
});

describe('留白与边框由代码控制，不进提示词', () => {
  it('页边（margin）与格间隙（gutter）可以分别调', () => {
    const wide = pageSlotsFor('regular', 3, { margin: 0.12, gutter: 0.005 });
    const tight = pageSlotsFor('regular', 3, { margin: 0.02, gutter: 0.05 });
    expect(wide[0].x).toBeCloseTo(0.12, 5);
    expect(tight[0].x).toBeCloseTo(0.02, 5);
    // 页边变宽 → 格宽变窄；格间隙变大 → 格高变矮。两者互不牵连。
    expect(wide[0].width).toBeLessThan(tight[0].width);
    expect(wide[1].y - (wide[0].y + wide[0].height)).toBeCloseTo(0.005, 5);
    expect(tight[1].y - (tight[0].y + tight[0].height)).toBeCloseTo(0.05, 5);
  });

  it('不传参数时行为与之前完全一致（默认值不变）', () => {
    const slots = pageSlotsFor('regular', 3);
    expect(slots[0].x).toBeCloseTo(DEFAULT_MARGIN, 5);
    expect(slots[1].y - (slots[0].y + slots[0].height)).toBeCloseTo(DEFAULT_GUTTER, 5);
  });

  it('边框可整体覆盖：主格也能带框（不再被迫「无框插画」）', () => {
    const plain = pageSlotsFor('inset', 3);
    expect(plain[0].border).toBe('none');
    const framed = pageSlotsFor('inset', 3, { panelBorder: 'thin' });
    expect(framed.every(slot => slot.border === 'thin')).toBe(true);
  });

  it('极端参数被夹住，不会把格子挤出页面', () => {
    const slots = pageSlotsFor('regular', 3, { margin: 9, gutter: 9 });
    for (const slot of slots) {
      expect(slot.x).toBeGreaterThanOrEqual(0);
      expect(slot.x + slot.width).toBeLessThanOrEqual(1.0001);
      expect(slot.y + slot.height).toBeLessThanOrEqual(1.0001);
    }
  });

  it('开放拼版不受留白意图影响（它的语义就是铺满，白边要窄）', () => {
    const airy = pageSlotsFor('irregular', 3, { whitespace: 'airy' });
    const compact = pageSlotsFor('irregular', 3, { whitespace: 'compact' });
    expect(airy[0].x).toBeCloseTo(compact[0].x, 5);
    expect(airy[0].width).toBeCloseTo(compact[0].width, 5);
  });

  it('显式 margin 仍然能覆盖档位默认（要精确控制时不挡）', () => {
    const forced = pageSlotsFor('irregular', 3, { whitespace: 'airy', margin: 0.09 });
    expect(forced[0].x).toBeCloseTo(0.09, 5);
  });

  it('覆盖全部格位仍是「每格自己的图 + 格间隙露出页面底色」', () => {
    const canvas = pageSlotsFor('regular', 3, { whitespace: 'airy' });
    const covered = canvas.reduce((sum, slot) => sum + slot.width * slot.height, 0);
    // 留白 = 1 - 覆盖率；airy 下必须真的留出空白，而不是把格子画满整页
    expect(covered).toBeLessThan(0.9);
    expect(1 - covered).toBeGreaterThan(0.1);
  });

  it('留白意图真的改页边和格间隙（以前只有 inset 主图受影响）', () => {
    const compact = pageSlotsFor('regular', 3, { whitespace: 'compact' });
    const airy = pageSlotsFor('regular', 3, { whitespace: 'airy' });
    const gapOf = (slots: ReturnType<typeof pageSlotsFor>): number =>
      slots[1].y - (slots[0].y + slots[0].height);
    expect(airy[0].x).toBeGreaterThan(compact[0].x);      // 页边更宽
    expect(gapOf(airy)).toBeGreaterThan(gapOf(compact));  // 格间距更大
    expect(airy[0].width).toBeLessThan(compact[0].width); // 格子相应变窄
  });
});

describe('区域引导词：主画面是一个漫画格', () => {
  it('四档的主格引导词都不说 illustration', () => {
    for (const layout of ['regular', 'irregular', 'inset', 'unframed'] as const) {
      const leads = boardAreaLeads(layout, 'auto', 3);
      expect(leads[0].toLowerCase()).not.toContain('illustration');
    }
  });
});
