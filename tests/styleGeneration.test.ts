/**
 * 新风格 → 出图词：用户实测 A/B/C 三场景回归
 *
 * 实测 A：开放拼版 + 固定三格 + 留白由版面决定 → 旧链路注入 3koma+split screen，
 *         出成竖向等分、无留白。
 * 实测 B/C：主图+特写 + 固定三格 + 大面积留白 → 旧链路 NL 写 "one or two small
 *          panels"，出成只有一格。
 *
 * 本测试锁定新链路（stylePrompt）的行为：用户选什么就出什么词，且与格数冲突的旧词
 * 一律不出现。
 */
import { describe, it, expect } from 'vitest';
import {
  buildStyleGeneration,
  styleCompositionTags,
  styleLayoutNl,
  stripLegacyLayoutTags,
  resolveWhitespaceIntent,
} from '../src/manga/stylePrompt';

describe('styleCompositionTags — 构图词不再自相矛盾', () => {
  it('开放拼版固定三格：不注入 split screen / 无条件 multiple views', () => {
    const tags = styleCompositionTags('open_montage', 3);
    const joined = tags.join(',').toLowerCase();
    expect(joined).not.toContain('split screen');
    expect(joined).not.toContain('multiple views');
    expect(tags).toContain('3koma'); // 只保留用户钉死的格数提醒
  });

  it('主图+特写固定三格：注入 3koma 但不写 white background 当布局', () => {
    const tags = styleCompositionTags('hero_insets', 3);
    expect(tags).toContain('3koma');
    expect(tags.join(',').toLowerCase()).not.toContain('white background');
  });

  it('格数自动时：任何风格都不注入 koma 数字词', () => {
    for (const style of ['classic_grid', 'open_montage', 'hero_insets', 'diagonal_panels', 'freeform'] as const) {
      expect(styleCompositionTags(style, 'auto').join(',')).not.toMatch(/\dkoma/);
    }
  });
});

describe('styleLayoutNl — 版面与格数用明确英文钉死', () => {
  it('固定三格：明确 Exactly three separate panels（不是 one or two）', () => {
    const nl = styleLayoutNl('hero_insets', 3, 'dramatic').toLowerCase();
    expect(nl).toContain('exactly three separate panels');
    expect(nl).not.toContain('one or two');
    expect(nl).toContain('one large main panel plus two smaller bordered inset panels');
    expect(nl).toContain('exactly three panels in total');
  });

  it('开放拼版：声明不等大、不排成简单竖列', () => {
    const nl = styleLayoutNl('open_montage', 3, 'auto').toLowerCase();
    expect(nl).toContain('unequal in size');
    // 明确声明「不排成简单竖列」——这正是实测 A 出成竖排的反命题
    expect(nl).toMatch(/do not line up in a simple vertical column/);
    expect(nl).not.toContain('split screen');
  });

  it('大面积留白 → dramatic：明确大面积空区且不被填充', () => {
    const nl = styleLayoutNl('hero_insets', 3, 'dramatic').toLowerCase();
    expect(nl).toContain('large area of completely empty negative space');
    expect(nl).toContain('do not fill it');
  });

  it('留白由版面决定（auto）→ 用风格默认意图', () => {
    expect(resolveWhitespaceIntent('auto', 'open_montage')).toBe('airy');
    expect(resolveWhitespaceIntent('auto', 'hero_insets')).toBe('dramatic');
    expect(resolveWhitespaceIntent('dramatic', 'open_montage')).toBe('dramatic');
  });

  it('任意风格固定格数都带明确数字句，且不含铺满整页的措辞', () => {
    for (const style of ['classic_grid', 'open_montage', 'hero_insets'] as const) {
      const nl = styleLayoutNl(style, 4, 'compact').toLowerCase();
      expect(nl).toContain('exactly four separate panels');
      expect(nl).not.toContain('narrow margins');
      expect(nl).not.toContain('covers almost the whole page');
      expect(nl).not.toContain('filled edge to edge');
    }
  });
});

describe('stripLegacyLayoutTags — 出图前剥掉旧冲突词', () => {
  it('把实测 A 的旧构图词全剥掉，只留画面内容', () => {
    const stripped = stripLegacyLayoutTags(
      '1.4::3koma::, 1.4::multiple views::, 1.5::split screen::, 1girl, 1boy, couple, luxury boutique, fitting room',
    );
    expect(stripped.toLowerCase()).not.toContain('3koma');
    expect(stripped.toLowerCase()).not.toContain('split screen');
    expect(stripped.toLowerCase()).not.toContain('multiple views');
    expect(stripped).toContain('1girl');
    expect(stripped).toContain('luxury boutique');
  });

  it('white background 当布局也被剥掉，但场景道具词保留', () => {
    const stripped = stripLegacyLayoutTags(
      '1.4::white background::, cowboy shot, paper bag, plush rabbit, hand on neck',
    );
    expect(stripped.toLowerCase()).not.toContain('white background');
    expect(stripped).toContain('paper bag');
    expect(stripped).toContain('plush rabbit');
  });
});

describe('三场景端到端出图词（buildStyleGeneration）', () => {
  it('A 开放拼版三格：词的组成符合选择', () => {
    const g = buildStyleGeneration({ style: 'open_montage', panelCount: 3, whitespace: 'auto' });
    expect(g.tags).toContain('3koma');
    expect(g.tags).toContain('asymmetric layout');
    expect(g.nl.toLowerCase()).toContain('exactly three separate panels');
    expect(g.nl.toLowerCase()).toContain('large clean outer margins'); // airy 默认
  });

  it('B/C 主图+特写三格大面积留白：1 主 + 2 inset，不出现 one-or-two', () => {
    const g = buildStyleGeneration({ style: 'hero_insets', panelCount: 3, whitespace: 'dramatic' });
    expect(g.nl.toLowerCase()).toContain('one large main panel plus two smaller bordered inset panels');
    expect(g.nl.toLowerCase()).not.toContain('one or two');
    expect(g.nl.toLowerCase()).toContain('dramatic pause');
  });
});
