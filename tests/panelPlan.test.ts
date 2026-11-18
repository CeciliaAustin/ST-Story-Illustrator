/**
 * 漫画分镜计划纯函数测试
 *
 * 测试 src/manga/panelPlan.ts：归一化、规则构建、台词清洗、LLM JSON 解析。
 */

import { describe, it, expect } from 'vitest';
import {
  PANEL_TAGS_BY_LAYOUT,
  PANEL_BUBBLE_AREAS,
  PANEL_DIALOGUE_MAX,
  normalizePanelLayout,
  normalizePanelPageType,
  normalizeDialoguePolicy,
  normalizeDialogueItems,
  buildPanelRule,
  panelDialogueClause,
  unframedNlSentence,
  parseComicPagePlan,
} from '../src/manga/panelPlan';

// ============================================================
// normalizePanelLayout / normalizePanelPageType
// ============================================================

describe('normalizePanelLayout', () => {
  it('passes through valid layouts', () => {
    expect(normalizePanelLayout('regular')).toBe('regular');
    expect(normalizePanelLayout('irregular')).toBe('irregular');
    expect(normalizePanelLayout('inset')).toBe('inset');
    expect(normalizePanelLayout('unframed')).toBe('unframed');
  });

  it('falls back to regular for dirty values', () => {
    expect(normalizePanelLayout('bogus')).toBe('regular');
    expect(normalizePanelLayout(undefined)).toBe('regular');
    expect(normalizePanelLayout(null)).toBe('regular');
    expect(normalizePanelLayout(123)).toBe('regular');
  });
});

describe('normalizePanelPageType', () => {
  it('passes a/b/c/d through', () => {
    for (const t of ['a', 'b', 'c', 'd']) expect(normalizePanelPageType(t)).toBe(t);
  });

  it('falls back to auto', () => {
    expect(normalizePanelPageType('z')).toBe('auto');
    expect(normalizePanelPageType(undefined)).toBe('auto');
  });
});

describe('normalizeDialoguePolicy', () => {
  it('handles all values', () => {
    expect(normalizeDialoguePolicy('auto')).toBe('auto');
    expect(normalizeDialoguePolicy('always')).toBe('always');
    expect(normalizeDialoguePolicy('eager')).toBe('eager');
    expect(normalizeDialoguePolicy('???')).toBe('auto');
  });
});

// ============================================================
// normalizeDialogueItems
// ============================================================

describe('normalizeDialogueItems', () => {
  it('returns empty for non-arrays', () => {
    expect(normalizeDialogueItems(null)).toEqual([]);
    expect(normalizeDialogueItems('text')).toEqual([]);
    expect(normalizeDialogueItems({})).toEqual([]);
  });

  it('normalizes a valid item', () => {
    const items = normalizeDialogueItems([{ text: '  放学一起走吗？  ', area: 'TL', mood: 'whisper', dir: 'v' }]);
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe('放学一起走吗？');
    expect(items[0].area).toBe('tl');
    expect(items[0].mood).toBe('whisper');
    expect(items[0].dir).toBe('v');
  });

  it('drops bad items and keeps order', () => {
    const items = normalizeDialogueItems([
      { text: '' },
      null,
      'string',
      { text: '第一句' },
      { text: '第二句' },
    ]);
    expect(items.map(i => i.text)).toEqual(['第一句', '第二句']);
  });

  it('caps at PANEL_DIALOGUE_MAX', () => {
    const items = normalizeDialogueItems(
      Array.from({ length: 10 }, (_, i) => ({ text: `台词${i}` })),
    );
    expect(items).toHaveLength(PANEL_DIALOGUE_MAX);
  });

  it('truncates overlong text and speaker', () => {
    const items = normalizeDialogueItems([{ text: '字'.repeat(200), speaker: '名'.repeat(50) }]);
    expect(items[0].text.length).toBe(60);
    expect(items[0].speaker?.length).toBe(16);
  });

  it('collapses line breaks in text', () => {
    const items = normalizeDialogueItems([{ text: '第一行\n第二行\r\n第三行' }]);
    expect(items[0].text).toBe('第一行 第二行 第三行');
  });

  it('falls back invalid area to undefined (auto-assign)', () => {
    const items = normalizeDialogueItems([{ text: 'x', area: 'center' }]);
    expect(items[0].area).toBeUndefined();
    expect(PANEL_BUBBLE_AREAS).not.toContain('center' as never);
  });

  it('clamps coordinates to 0..1 and rounds to 4 decimals', () => {
    const items = normalizeDialogueItems([{ text: 'x', x: 1.5, y: -0.2 }]);
    expect(items[0].x).toBe(1);
    expect(items[0].y).toBe(0);
  });

  it('drops non-finite coordinates', () => {
    const items = normalizeDialogueItems([{ text: 'x', x: 'bad', y: NaN }]);
    expect(items[0].x).toBeUndefined();
    expect(items[0].y).toBeUndefined();
  });
});

// ============================================================
// buildPanelRule
// ============================================================

describe('buildPanelRule', () => {
  const base = { backend: 'nai' as const, nl: true, dialogueMode: 'json' as const };

  it('returns empty string when disabled', () => {
    expect(buildPanelRule(false, base)).toBe('');
  });

  it('includes layout-specific composition tags with weights', () => {
    for (const layout of ['regular', 'irregular', 'inset', 'unframed'] as const) {
      const rule = buildPanelRule(true, { ...base, layout });
      for (const tag of PANEL_TAGS_BY_LAYOUT[layout]) {
        expect(rule).toContain(tag);
      }
    }
  });

  it('uses the no-nl variant when nl channel is off', () => {
    const on = buildPanelRule(true, { ...base, layout: 'regular', nl: true });
    const off = buildPanelRule(true, { ...base, layout: 'regular', nl: false });
    expect(on).toContain('In the upper panel');
    expect(off).toContain('没有 nl 通道');
  });

  it('appends the no-pos clause only for NAI + charPrompts', () => {
    const withPos = buildPanelRule(true, { ...base, layout: 'regular', charPrompts: true });
    const withoutPos = buildPanelRule(true, { ...base, layout: 'regular', charPrompts: false });
    const comfy = buildPanelRule(true, { layout: 'regular', backend: 'comfyui', charPrompts: true });
    expect(withPos).toContain('不需要 pos');
    expect(withoutPos).not.toContain('不需要 pos');
    expect(comfy).not.toContain('不需要 pos');
  });

  it('appends the dialogue clause only when dialogue is on', () => {
    const withD = buildPanelRule(true, { ...base, layout: 'regular', dialogue: true });
    const withoutD = buildPanelRule(true, { ...base, layout: 'regular', dialogue: false });
    expect(withD).toContain('【对白气泡】');
    expect(withoutD).not.toContain('【对白气泡】');
  });

  it('uses the pinned page type headline for unframed', () => {
    const rule = buildPanelRule(true, { ...base, layout: 'unframed', pageType: 'c' });
    expect(rule).toContain('C 型');
    expect(rule).toContain('right edge');
  });
});

describe('panelDialogueClause', () => {
  it('differs json vs tag format', () => {
    expect(panelDialogueClause('json')).toContain('images 数组');
    expect(panelDialogueClause('tag')).toContain('<dialogue>');
  });

  it('reflects policy', () => {
    expect(panelDialogueClause('json', 'always')).toContain('至少写 1 条');
    expect(panelDialogueClause('json', 'auto')).toContain('省略');
  });
});

describe('unframedNlSentence', () => {
  it('returns the classic A-type sentence for auto', () => {
    const s = unframedNlSentence('auto');
    expect(s).toContain('asymmetric three-scene');
    expect(s).toContain('no rectangular border surrounds the characters');
  });

  it('uses the pinned type headline', () => {
    expect(unframedNlSentence('b')).toContain('two-part manga page');
    expect(unframedNlSentence('d')).toContain('fills the whole page');
  });
});

// ============================================================
// parseComicPagePlan
// ============================================================

describe('parseComicPagePlan', () => {
  const validPlan = {
    pages: [{
      pageIndex: 0, title: '第一页', layout: 'irregular',
      panels: [
        { index: 0, title: '上格', characters: [{ name: 'Alice', act: '走进花园' }], mood: 'calm', tags: '1girl, garden', nl: 'Alice walks in.', dialogue: [{ text: '你好', area: 'tl' }] },
        { index: 1, title: '下格', characters: [], mood: '', tags: 'kiss', dialogue: [] },
      ],
    }],
  };

  it('parses a valid plan', () => {
    const result = parseComicPagePlan(validPlan);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].layout).toBe('irregular');
    expect(result.pages[0].panels).toHaveLength(2);
    expect(result.pages[0].panels[0].dialogue?.[0].text).toBe('你好');
    expect(result.warnings).toEqual([]);
  });

  it('parses a JSON string with markdown fence', () => {
    const result = parseComicPagePlan('```json\n' + JSON.stringify(validPlan) + '\n```');
    expect(result.pages).toHaveLength(1);
  });

  it('handles a single page object', () => {
    const result = parseComicPagePlan(validPlan.pages[0]);
    expect(result.pages).toHaveLength(1);
  });

  it('handles a bare page array', () => {
    const result = parseComicPagePlan([validPlan.pages[0]]);
    expect(result.pages).toHaveLength(1);
  });

  it('returns warning on bad JSON without throwing', () => {
    const result = parseComicPagePlan('{ not json ');
    expect(result.pages).toEqual([]);
    expect(result.warnings[0]).toContain('JSON 解析失败');
  });

  it('skips pages without panels and warns', () => {
    const result = parseComicPagePlan({ pages: [{ layout: 'regular', panels: [] }] });
    expect(result.pages).toEqual([]);
    expect(result.warnings.some(w => w.includes('无 panels'))).toBe(true);
  });

  it('drops invalid panels but keeps valid ones', () => {
    const result = parseComicPagePlan({
      pages: [{ layout: 'regular', panels: [null, { tags: 'ok' }, 42] }],
    });
    expect(result.pages[0].panels).toHaveLength(1);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('normalizes dirty layout and clamps indices', () => {
    const result = parseComicPagePlan({
      pages: [{ layout: 'bogus', panels: [{ tags: 'x' }] }],
    });
    expect(result.pages[0].layout).toBe('regular');
    expect(result.pages[0].pageIndex).toBe(0);
  });

  it('omits empty optional fields for round-trip stability', () => {
    const result = parseComicPagePlan({ pages: [{ panels: [{ tags: 'x' }] }] });
    const panel = result.pages[0].panels[0] as Record<string, unknown>;
    expect(panel).not.toHaveProperty('nl');
    expect(panel).not.toHaveProperty('dialogue');
  });
});
