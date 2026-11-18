/**
 * 气泡排版纯函数测试（§6.4/6.5）
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeBubbleStyle,
  bubbleShellOf,
  bubbleVariantOf,
  isBlendStyle,
  normalizeBubbleFont,
} from '../src/manga/bubbleTypes';
import {
  wrapText,
  blendFontSize,
  layoutBlendH,
  layoutBlendV,
  deriveTextColor,
  blendInkFor,
  boxInkFor,
  planBubbles,
} from '../src/manga/bubblePlan';
import type { PanelDialogueItem } from '../src/manga/bubbleTypes';

// 简单 measure：每个字符宽度 10
const measure = (s: string) => [...s].length * 10;

describe('bubble style helpers', () => {
  it('normalizes styles', () => {
    expect(normalizeBubbleStyle('blend-ink')).toBe('blend-ink');
    expect(normalizeBubbleStyle('garbage')).toBe('classic');
  });

  it('detects shell and variant', () => {
    expect(bubbleShellOf('blend-glow')).toBe('blend');
    expect(bubbleShellOf('classic')).toBe('bubble');
    expect(isBlendStyle('blend')).toBe(true);
    expect(isBlendStyle('bubble-ink')).toBe(false);
    expect(bubbleVariantOf('bubble-vertical')).toBe('vertical');
    expect(bubbleVariantOf('blend-subtitle')).toBe('subtitle');
    expect(bubbleVariantOf('classic')).toBe('normal');
  });

  it('normalizes fonts', () => {
    expect(normalizeBubbleFont('kai')).toBe('kai');
    expect(normalizeBubbleFont('x')).toBe('sans');
  });
});

describe('wrapText', () => {
  it('returns single line when it fits', () => {
    expect(wrapText('你好', 100, measure)).toEqual(['你好']);
  });

  it('greedily wraps Chinese characters', () => {
    // maxWidth 20 → 每 2 字一行
    expect(wrapText('一二三四五', 20, measure)).toEqual(['一二', '三四', '五']);
  });

  it('returns empty for blank text', () => {
    expect(wrapText('   ', 100, measure)).toEqual([]);
  });

  it('collapses whitespace', () => {
    expect(wrapText('a  b   c', 1000, measure)).toEqual(['a b c']);
  });
});

describe('blendFontSize', () => {
  it('clamps to 13..36', () => {
    expect(blendFontSize({ width: 100, height: 100 })).toBe(13);
    expect(blendFontSize({ width: 2000, height: 2000 })).toBe(36);
  });

  it('scales with page', () => {
    expect(blendFontSize({ width: 1000, height: 800 })).toBe(22);
  });
});

describe('layoutBlendH / layoutBlendV', () => {
  it('horizontal layout computes width from chars + spacing', () => {
    const r = layoutBlendH('你好', 1000, 20, measure);
    expect(r.lines).toEqual(['你好']);
    expect(r.width).toBeGreaterThan(20);
    expect(r.height).toBe(Math.ceil(1 * 20 * 1.35));
  });

  it('vertical layout splits into columns right-to-left', () => {
    const r = layoutBlendV('一二三四五六', 100, 20);
    expect(r.cols.length).toBeGreaterThan(0);
    expect(r.cols.join('')).toBe('一二三四五六');
    const firstColLen = [...r.cols[0]].length;
    expect(r.cols.every(c => [...c].length <= firstColLen)).toBe(true);
  });
});

describe('deriveTextColor', () => {
  it('darkens text on light background with no halo (high contrast)', () => {
    const r = deriveTextColor({ r: 250, g: 250, b: 250 });
    // r*0.3 ≈ 75；浅底压深后对比充足，无需描边
    expect(r.color).toMatch(/^rgb\(75/);
    expect(r.halo).toBeNull();
  });

  it('lightens text on dark background', () => {
    const r = deriveTextColor({ r: 10, g: 10, b: 10 });
    expect(r.color).toMatch(/^rgb\(21/);
  });

  it('adds halo on mid-tone background', () => {
    // sRGB 180 → 相对亮度约 0.46，落在 0.35~0.55 的中间调区间 → 必描边
    const r = deriveTextColor({ r: 180, g: 180, b: 180 });
    expect(r.halo).not.toBeNull();
  });
});

describe('blendInkFor / boxInkFor', () => {
  it('uses fixed inks for fixed styles', () => {
    expect(blendInkFor('blend-glow', { r: 0, g: 0, b: 0 }).color).toBe('#fffaf2');
    expect(blendInkFor('blend-ink', { r: 255, g: 255, b: 255 }).color).toBe('#2a2320');
    expect(blendInkFor('blend-subtitle', { r: 0, g: 0, b: 0 }).band).not.toBeNull();
  });

  it('uses sampled ink for plain blend', () => {
    const r = blendInkFor('blend', { r: 250, g: 250, b: 250 });
    expect(r.color).toMatch(/^rgb\(/);
  });

  it('box ink variants', () => {
    expect(boxInkFor('bubble-glow').glow).not.toBeNull();
    expect(boxInkFor('bubble-ink').color).toBe('#2a2320');
    expect(boxInkFor('classic').color).toBe('#111111');
  });
});

describe('planBubbles', () => {
  const page = { width: 800, height: 1000 };

  it('returns empty for zero page', () => {
    expect(planBubbles([{ text: 'x' }], { width: 0, height: 0 }, measure)).toEqual([]);
  });

  it('places a single bubble inside the page', () => {
    const rects = planBubbles([{ text: '你好世界' }], page, measure);
    expect(rects).toHaveLength(1);
    expect(rects[0].x).toBeGreaterThanOrEqual(0);
    expect(rects[0].x + rects[0].width).toBeLessThanOrEqual(page.width);
    expect(rects[0].y + rects[0].height).toBeLessThanOrEqual(page.height);
    expect(rects[0].tail).toBeDefined();
  });

  it('avoids overlap between bubbles', () => {
    const items: PanelDialogueItem[] = [
      { text: '第一句话比较长一点' },
      { text: '第二句话也不短呢' },
      { text: '第三句' },
    ];
    const rects = planBubbles(items, page, measure);
    expect(rects).toHaveLength(3);
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const a = rects[i], b = rects[j];
        const overlap = a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
        expect(overlap).toBe(false);
      }
    }
  });

  it('respects manual positions (pinned, no auto move)', () => {
    const rects = planBubbles([{ text: '你好', x: 0.5, y: 0.5 }], page, measure);
    expect(rects).toHaveLength(1);
    expect(Math.abs((rects[0].x + rects[0].width / 2) - 0.5 * page.width)).toBeLessThan(2);
  });

  it('skips empty text', () => {
    expect(planBubbles([{ text: '' }, { text: '   ' }], page, measure)).toEqual([]);
  });

  it('caps at 4 bubbles', () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ text: `台词${i}` }));
    expect(planBubbles(items, page, measure).length).toBeLessThanOrEqual(4);
  });

  it('uses vertical columns for vertical style', () => {
    const rects = planBubbles([{ text: '竖排文字测试', dir: 'v' }], page, measure, { style: 'blend-vertical' });
    expect(rects[0].vertical).toBe(true);
  });

  it('subtitle style has no tail and sits at bottom', () => {
    const rects = planBubbles([{ text: '字幕条' }], page, measure, { style: 'bubble-subtitle' });
    expect(rects[0].tail).toBeUndefined();
    expect(rects[0].y + rects[0].height).toBeGreaterThan(page.height * 0.8);
  });
});
