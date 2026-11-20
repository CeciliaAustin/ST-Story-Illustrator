import { describe, expect, it } from 'vitest';
import { buildLayoutDirective } from '../src/manga/layoutDirective';
import { buildComicSystemPrompt } from '../src/manga/planPrompts';
import type { ComicPlanOptions } from '../src/manga/planPrompts';

const baseOptions: ComicPlanOptions = {
  panelMode: true,
  panelLayout: 'auto',
  pageType: 'auto',
  dialogue: true,
  dialogueMode: 'json',
  dialoguePolicy: 'auto',
  nl: true,
  backend: 'nai',
  charPrompts: true,
  includeChinese: true,
  maxPages: 1,
};

describe('版面导演指令（Stage A/B prompt）', () => {
  it('锁定风格时写明"不得擅自换"', () => {
    const text = buildLayoutDirective({ style: 'hero_insets', panelCount: 3, whitespace: 'auto' });
    expect(text).toContain('用户指定的风格');
    expect(text).toContain('不得擅自换成别的风格');
    expect(text).toContain('主画面 + 浮动特写');
  });

  it('自由模式允许 LLM 自选风格与格数', () => {
    const text = buildLayoutDirective({ style: 'freeform', panelCount: 'auto', whitespace: 'auto' });
    expect(text).toContain('自由模式');
    expect(text).toContain('格数由你按 beat 决定');
    expect(text).toContain('recommendedLayout');
  });

  it('固定格数写明必须正好 N 个 slots', () => {
    const text = buildLayoutDirective({ style: 'classic_grid', panelCount: 4, whitespace: 'compact' });
    expect(text).toContain('格数固定为 4 格');
    expect(text).toContain('紧凑');
  });

  it('auto 留白按风格默认（hero_insets → dramatic）', () => {
    const text = buildLayoutDirective({ style: 'hero_insets', panelCount: 'auto', whitespace: 'auto' });
    expect(text).toContain('大面积留白');
  });

  it('输出 direction 与 layout 两个字段的 schema', () => {
    const text = buildLayoutDirective({ style: 'open_montage', panelCount: 3, whitespace: 'airy' });
    expect(text).toContain('"direction"');
    expect(text).toContain('"layout"');
    expect(text).toContain('"slots"');
    expect(text).toContain('custom_polygon');
    expect(text).toContain('0~1');
  });
});

describe('buildComicSystemPrompt 接入导演指令', () => {
  it('不传新维度时完全兼容（不含导演指令）', () => {
    const sys = buildComicSystemPrompt(baseOptions);
    expect(sys).not.toContain('版面导演');
  });

  it('传了 layoutStyle 时把导演指令注入 system', () => {
    const sys = buildComicSystemPrompt({
      ...baseOptions,
      layoutStyle: 'diagonal_panels',
      layoutPanelCount: 3,
      layoutWhitespace: 'auto',
    });
    expect(sys).toContain('版面导演');
    expect(sys).toContain('斜切分格');
    expect(sys).toContain('格数固定为 3 格');
  });
});
