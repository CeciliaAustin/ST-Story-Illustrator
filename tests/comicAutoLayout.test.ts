/**
 * 分镜「自动」档
 *
 * 线上诉求：用户不想自己选版面（「我对这个不是很懂」），希望模型按剧情自动排出
 * 有漫画美感的页。同时要保证：钉死档位时仍然只听用户的。
 */

import { describe, it, expect } from 'vitest';
import {
  buildPanelRule,
  normalizeLayoutChoice,
  resolvePanelsPerPage,
  PANEL_NL_SENTENCE,
  parseComicPagePlan,
} from '../src/manga/panelPlan';
import { buildComicSystemPrompt } from '../src/manga/planPrompts';

describe('normalizeLayoutChoice', () => {
  it('四档原样保留', () => {
    for (const v of ['regular', 'irregular', 'inset', 'unframed'] as const) {
      expect(normalizeLayoutChoice(v)).toBe(v);
    }
  });

  it('auto 与脏值都当自动', () => {
    expect(normalizeLayoutChoice('auto')).toBe('auto');
    expect(normalizeLayoutChoice(undefined)).toBe('auto');
    expect(normalizeLayoutChoice('bogus')).toBe('auto');
    expect(normalizeLayoutChoice(42)).toBe('auto');
  });
});

describe('resolvePanelsPerPage（自动档）', () => {
  it('用户没定格数 → 不约束（0）', () => {
    expect(resolvePanelsPerPage('auto', 0)).toBe(0);
    expect(resolvePanelsPerPage('auto')).toBe(0);
  });

  it('用户定了格数 → 照样钉住（挑版面与定格数不冲突）', () => {
    expect(resolvePanelsPerPage('auto', 3)).toBe(3);
    expect(resolvePanelsPerPage('auto', 4)).toBe(4);
  });
});

describe('自动档规则文本', () => {
  const rule = buildPanelRule(true, { layout: 'auto', nl: true });

  it('说明「版面自选」并要求在 layout 字段里报回来', () => {
    expect(rule).toContain('版面自选');
    expect(rule).toContain('`layout` 字段');
  });

  it('四档各带自己的构图词，不能混写', () => {
    expect(rule).toContain('"regular"');
    expect(rule).toContain('"irregular"');
    expect(rule).toContain('"inset"');
    expect(rule).toContain('"unframed"');
    expect(rule).toContain('1.4::2koma::');
    expect(rule).toContain('1.5::split screen::');
    expect(rule).toContain('不要把两档的构图词混着写');
  });

  it('不再套用任何单一档位的规则（例如双格档的「一张画布切两格」）', () => {
    expect(rule).not.toContain('一张画布切两格');
    expect(rule).not.toContain('这一张是双格漫画');
  });

  it('没有 nl 通道时不谈版面句', () => {
    const noNl = buildPanelRule(true, { layout: 'auto', nl: false });
    expect(noNl).toContain('版面自选');
    expect(noNl).not.toContain('先按你选的档位写 nl');
    expect(noNl).toContain('本次没有 nl 通道');
  });

  it('白底档要求特写格与主画之间留宽白边（挤在一起会糊）', () => {
    const inset = buildPanelRule(true, { layout: 'inset', nl: true });
    expect(inset).toContain('宽白边');
    expect(PANEL_NL_SENTENCE.inset.portrait).toContain('wide clean white gap');
  });
});

describe('自动档的 system 提示词', () => {
  const base = {
    panelMode: true,
    panelLayout: 'auto' as const,
    pageType: 'auto' as const,
    dialogue: true,
    dialoguePolicy: 'auto' as const,
    dialogueMode: 'json' as const,
    nl: true,
    backend: 'nai' as const,
    charPrompts: true,
    includeChinese: true,
    maxPages: 1,
    panelsPerPage: 0,
  };

  it('自动档不写「每页固定 N 格」——那会和「版面你挑」打架', () => {
    const prompt = buildComicSystemPrompt(base);
    expect(prompt).toContain('版面自选');
    expect(prompt).not.toContain('每页固定');
  });

  it('钉死档位时仍按那一档写规则', () => {
    const prompt = buildComicSystemPrompt({ ...base, panelLayout: 'regular' });
    expect(prompt).toContain('一张画布切两格');
    expect(prompt).not.toContain('版面自选');
  });

  it('钉死档位 + 定格数时，「每页固定 N 格」照旧生效', () => {
    const prompt = buildComicSystemPrompt({ ...base, panelLayout: 'regular', panelsPerPage: 4 });
    expect(prompt).toContain('每页固定 4 格');
  });
});

describe('解析：模型没写 layout 时的兜底', () => {
  const page = (panels: number, extra: Record<string, unknown> = {}) => ({
    pages: [{
      tags: '1girl, sitting, classroom',
      panels: Array.from({ length: panels }, (_, i) => ({ index: i, tags: `panel ${i}` })),
      ...extra,
    }],
  });

  it('2 格且没写 layout → 规整双格（几何确定，格内排气泡）', () => {
    const { pages } = parseComicPagePlan(page(2));
    expect(pages[0].layout).toBe('regular');
  });

  it('3 格且没写 layout → 拼版（几何未知就别假装知道）', () => {
    const { pages } = parseComicPagePlan(page(3));
    expect(pages[0].layout).toBe('irregular');
  });

  it('用户钉死档位时不按格数猜', () => {
    const { pages } = parseComicPagePlan(page(3), { fallbackLayout: 'regular' });
    expect(pages[0].layout).toBe('regular');
  });

  it('模型自己写了 layout 就听模型的', () => {
    const { pages } = parseComicPagePlan(page(3, { layout: 'unframed' }));
    expect(pages[0].layout).toBe('unframed');
  });
});
