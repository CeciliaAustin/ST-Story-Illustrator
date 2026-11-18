/**
 * 发送侧确定性纠正纯函数测试
 *
 * 测试 src/manga/panelEnforce.ts：
 * enforcePanelPrompt / decidePanelInjection / applyPanelToNl / enforceForGeneration。
 */

import { describe, it, expect } from 'vitest';
import {
  enforcePanelPrompt,
  decidePanelInjection,
  applyPanelToNl,
  enforceForGeneration,
} from '../src/manga/panelEnforce';

// ============================================================
// enforcePanelPrompt
// ============================================================

describe('enforcePanelPrompt', () => {
  it('returns empty for empty prompt', () => {
    expect(enforcePanelPrompt('', 'regular')).toEqual({ prompt: '', removed: [], added: [] });
    expect(enforcePanelPrompt('   ', 'unframed').prompt).toBe('');
  });

  it('adds missing required tags in front, preserving bare tags', () => {
    const result = enforcePanelPrompt('1girl, blue hair', 'regular');
    expect(result.prompt.startsWith('1.4::multiple views::')).toBe(true);
    expect(result.prompt).toContain('1girl');
    expect(result.added.length).toBe(3);
    expect(result.removed).toEqual([]);
  });

  it('treats weighted and bare tags as the same (no duplicate injection)', () => {
    const result = enforcePanelPrompt('1.4::multiple views::, 1.4::2koma::, 1.5::split screen::, 1girl', 'regular');
    expect(result.added).toEqual([]);
    expect(result.prompt).not.toContain('added');
    const occurrences = result.prompt.match(/multiple views/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it('removes forbidden tags for the layout', () => {
    const result = enforcePanelPrompt('3koma, 4koma, 1girl', 'regular');
    expect(result.removed).toContain('3koma');
    expect(result.removed).toContain('4koma');
    expect(result.prompt).not.toContain('3koma');
    expect(result.prompt).not.toContain('4koma');
  });

  it('removes 2koma for irregular (spec: never mix)', () => {
    const result = enforcePanelPrompt('1.4::2koma::, 1girl', 'irregular');
    expect(result.removed.some(r => r.includes('2koma'))).toBe(true);
    expect(result.prompt).not.toContain('2koma');
  });

  it('preserves weighted blocks across commas (never tears prompt apart)', () => {
    const result = enforcePanelPrompt('2::word with, comma inside::, 1girl', 'regular');
    expect(result.prompt).toContain('2::word with, comma inside::');
  });

  it('inset strips scene tags', () => {
    const result = enforcePanelPrompt('bedroom, window, sunlight from window, 1girl', 'inset');
    expect(result.removed).toContain('bedroom');
    expect(result.removed).toContain('window');
    expect(result.removed).toContain('sunlight from window');
    expect(result.prompt).toContain('1girl');
    expect(result.prompt).toContain('white background');
  });

  it('unframed keeps indoors anchor + up to 2 location tags, strips furniture/time', () => {
    const result = enforcePanelPrompt(
      'indoors, dorm room, classroom, street, bed, window, afternoon, 1girl',
      'unframed',
    );
    expect(result.prompt).toContain('indoors');
    expect(result.prompt).toContain('dorm room');
    expect(result.prompt).toContain('classroom');
    expect(result.prompt).not.toContain('street');
    expect(result.prompt).not.toContain('bed');
    expect(result.prompt).not.toContain('afternoon');
  });

  it('is idempotent: enforcing twice yields the same prompt', () => {
    const first = enforcePanelPrompt('1girl, 3koma', 'regular');
    const second = enforcePanelPrompt(first.prompt, 'regular');
    expect(second.prompt).toBe(first.prompt);
    expect(second.added).toEqual([]);
  });
});

// ============================================================
// decidePanelInjection
// ============================================================

describe('decidePanelInjection', () => {
  it('enabled when panelMode and not a story image', () => {
    expect(decidePanelInjection({
      panelMode: true, panelLayout: 'irregular', chibiOn: false, storyImage: false,
    })).toEqual({ enabled: true, layout: 'irregular' });
  });

  it('disabled for story image', () => {
    expect(decidePanelInjection({
      panelMode: true, panelLayout: 'regular', chibiOn: false, storyImage: true,
    }).enabled).toBe(false);
  });

  it('disabled when panelMode off', () => {
    expect(decidePanelInjection({
      panelMode: false, panelLayout: 'inset', chibiOn: false, storyImage: false,
    }).enabled).toBe(false);
  });

  it('forces regular when chibi is on', () => {
    expect(decidePanelInjection({
      panelMode: true, panelLayout: 'unframed', chibiOn: true, storyImage: false,
    })).toEqual({ enabled: true, layout: 'regular' });
  });

  it('normalizes dirty layout', () => {
    expect(decidePanelInjection({
      panelMode: true, panelLayout: '???' as never, chibiOn: false, storyImage: false,
    }).layout).toBe('regular');
  });
});

// ============================================================
// applyPanelToNl
// ============================================================

describe('applyPanelToNl', () => {
  it('returns empty for empty nl', () => {
    expect(applyPanelToNl('', 'regular')).toBe('');
  });

  it('prepends the layout sentence for English nl', () => {
    const result = applyPanelToNl('A girl stands in the garden.', 'regular');
    expect(result).toContain('two equal panels');
    expect(result).toContain('A girl stands in the garden.');
    expect(result.indexOf('two equal panels')).toBeLessThan(result.indexOf('A girl'));
  });

  it('uses landscape sentence when orientation is landscape', () => {
    expect(applyPanelToNl('Girl smiles.', 'regular', 'landscape')).toContain('side by side');
  });

  it('does not touch Chinese-dominant nl', () => {
    const cn = '一个女孩站在花园里微笑着';
    expect(applyPanelToNl(cn, 'regular')).toBe(cn);
  });

  it('still patches English nl that contains a Chinese character name', () => {
    // 关键回归：用字符数比而非"含中文"，避免误判导致兜底整轮失效（坑 5）
    const nl = 'Alice and 小樱 walk together in the garden.';
    const result = applyPanelToNl(nl, 'regular');
    expect(result).toContain('two equal panels');
  });

  it('does not re-patch nl that already mentions layout', () => {
    const nl = 'Two comic panels show a girl reading, separated by a thin gutter.';
    expect(applyPanelToNl(nl, 'regular')).toBe(nl);
  });

  it('uses unframed pinned page headline', () => {
    const result = applyPanelToNl('A girl smiles.', 'unframed', 'portrait', 'c');
    expect(result).toContain('right edge');
  });

  it('is idempotent', () => {
    const once = applyPanelToNl('A girl stands.', 'irregular');
    const twice = applyPanelToNl(once, 'irregular');
    expect(twice).toBe(once);
  });
});

// ============================================================
// enforceForGeneration
// ============================================================

describe('enforceForGeneration', () => {
  it('passes through unchanged when not applied', () => {
    const result = enforceForGeneration({
      prompt: '3koma, 1girl', nl: 'A girl stands.',
      panelMode: false, panelLayout: 'regular', chibiOn: false, storyImage: false,
    });
    expect(result.applied).toBe(false);
    expect(result.prompt).toBe('3koma, 1girl');
    expect(result.nl).toBe('A girl stands.');
  });

  it('applies enforce + apply when enabled', () => {
    const result = enforceForGeneration({
      prompt: '3koma, 1girl', nl: 'A girl stands.',
      panelMode: true, panelLayout: 'regular', chibiOn: false, storyImage: false,
    });
    expect(result.applied).toBe(true);
    expect(result.prompt).not.toContain('3koma');
    expect(result.prompt).toContain('multiple views');
    expect(result.nl).toContain('two equal panels');
    expect(result.removed).toContain('3koma');
  });
});
