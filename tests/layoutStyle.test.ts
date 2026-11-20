import { describe, expect, it } from 'vitest';
import {
  defaultPanelCountForStyle,
  defaultWhitespaceForStyle,
  isStyleLocked,
  layoutStyleToLegacy,
  migrateLayoutChoice,
  normalizeLayoutStyle,
  normalizePanelCount,
  normalizeWhitespace,
  resolveLayoutStyle,
  resolvePanelCount,
  resolveWhitespaceIntent,
} from '../src/manga/layoutStyle';

describe('版面Style adapter — 归一化', () => {
  it('五种合法风格原样保留，脏值回落 open_montage', () => {
    for (const s of ['classic_grid', 'open_montage', 'diagonal_panels', 'hero_insets', 'freeform']) {
      expect(normalizeLayoutStyle(s)).toBe(s);
    }
    expect(normalizeLayoutStyle('garbage')).toBe('open_montage');
    expect(normalizeLayoutStyle(undefined)).toBe('open_montage');
  });

  it('格数只接受 2/3/4，其余回落 auto', () => {
    expect(normalizePanelCount(2)).toBe(2);
    expect(normalizePanelCount(3)).toBe(3);
    expect(normalizePanelCount(4)).toBe(4);
    expect(normalizePanelCount(0)).toBe('auto');
    expect(normalizePanelCount('auto')).toBe('auto');
    expect(normalizePanelCount(5)).toBe('auto');
  });

  it('留白只接受三档显式偏好，其余 auto', () => {
    for (const w of ['compact', 'airy', 'dramatic']) expect(normalizeWhitespace(w)).toBe(w);
    expect(normalizeWhitespace('auto')).toBe('auto');
    expect(normalizeWhitespace('balanced')).toBe('auto');
  });
});

describe('旧字段迁移（§4）', () => {
  it('旧四档映射到新风格，且不会把 irregular 误当斜切', () => {
    expect(migrateLayoutChoice('regular')).toBe('classic_grid');
    expect(migrateLayoutChoice('irregular')).toBe('open_montage');
    expect(migrateLayoutChoice('inset')).toBe('hero_insets');
    expect(migrateLayoutChoice('unframed')).toBe('hero_insets');
    expect(migrateLayoutChoice('auto')).toBe('open_montage');
    // 脏值也走安全回落，不产生非法枚举
    expect(migrateLayoutChoice('nonsense')).toBe('open_montage');
  });

  it('新风格→旧档为每种风格给出确定映射', () => {
    expect(layoutStyleToLegacy('classic_grid')).toBe('regular');
    expect(layoutStyleToLegacy('diagonal_panels')).toBe('irregular');
    expect(layoutStyleToLegacy('hero_insets')).toBe('inset');
    expect(layoutStyleToLegacy('open_montage')).toBe('irregular');
    expect(layoutStyleToLegacy('freeform')).toBe('irregular');
  });

  it('comicStyle 优先于旧 comicLayout；都没有时默认 freeform', () => {
    expect(resolveLayoutStyle({ comicStyle: 'diagonal_panels', comicLayout: 'regular' })).toBe('diagonal_panels');
    expect(resolveLayoutStyle({ comicLayout: 'inset' })).toBe('hero_insets');
    expect(resolveLayoutStyle({})).toBe('freeform');
  });

  it('格数新字段优先，旧字段兜底', () => {
    expect(resolvePanelCount({ comicPanelCount: 2, comicPanelsPerPage: 4 })).toBe(2);
    expect(resolvePanelCount({ comicPanelsPerPage: 3 })).toBe(3);
    expect(resolvePanelCount({})).toBe('auto');
  });

  it('不覆盖用户偏好：resolveLayoutStyle 只读不改入参', () => {
    const input = { comicLayout: 'regular' as const };
    resolveLayoutStyle(input);
    expect(input.comicLayout).toBe('regular');
  });
});

describe('留白与格数默认（§1.2 / §1.3）', () => {
  it('auto 时按风格取默认，用户显式偏好优先', () => {
    expect(resolveWhitespaceIntent(undefined, 'classic_grid')).toBe('compact');
    expect(resolveWhitespaceIntent('auto', 'hero_insets')).toBe('dramatic');
    expect(resolveWhitespaceIntent('airy', 'classic_grid')).toBe('airy');
  });

  it('各风格留白倾向与任务书表格一致', () => {
    expect(defaultWhitespaceForStyle('classic_grid')).toBe('compact');
    expect(defaultWhitespaceForStyle('open_montage')).toBe('airy');
    expect(defaultWhitespaceForStyle('diagonal_panels')).toBe('balanced');
    expect(defaultWhitespaceForStyle('hero_insets')).toBe('dramatic');
    expect(defaultWhitespaceForStyle('freeform')).toBe('balanced');
  });

  it('传统四格默认 4 格，其余默认 3 格', () => {
    expect(defaultPanelCountForStyle('classic_grid')).toBe(4);
    expect(defaultPanelCountForStyle('open_montage')).toBe(3);
    expect(defaultPanelCountForStyle('hero_insets')).toBe(3);
  });

  it('除 freeform 外都算用户钉死风格', () => {
    expect(isStyleLocked('classic_grid')).toBe(true);
    expect(isStyleLocked('diagonal_panels')).toBe(true);
    expect(isStyleLocked('hero_insets')).toBe(true);
    expect(isStyleLocked('freeform')).toBe(false);
  });
});
