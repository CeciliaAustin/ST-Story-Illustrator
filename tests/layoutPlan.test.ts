import { describe, expect, it } from 'vitest';
import { parseLayoutPlan, parseVisualDirection } from '../src/manga/layoutPlan';

const rawLayout = {
  style: 'hero_insets',
  panelCount: 2,
  background: 'white',
  whitespace: { intent: 'dramatic', outerMargin: 0.08, gutter: 0.03,
    reservedRegions: [{ x: 0.7, y: 0.7, width: 0.2, height: 0.2 }] },
  readingOrder: [1, 2],
  slots: [
    { panelIndex: 0, x: 0.05, y: 0.2, width: 0.7, height: 0.7, shape: 'rect', role: 'hero', border: 'none', zIndex: 0, overlapAllowed: false },
    { panelIndex: 1, x: 0.6, y: 0.7, width: 0.3, height: 0.25, shape: 'floating_rect', role: 'detail', border: 'thin', zIndex: 1, overlapAllowed: true },
  ],
  designRationale: '主画面 + 浮格',
};

describe('Stage A — Visual Direction 解析', () => {
  it('合法方向完整解析', () => {
    const d = parseVisualDirection({
      beatId: 'b1', visualFocus: '手部特写', emotionalTone: '安静',
      pageRhythm: '停顿', recommendedLayout: 'hero_insets', recommendedPanelCount: 3,
      reason: '情绪停顿适合特写', whitespaceIntent: 'dramatic', readingOrder: 'top_to_bottom',
    });
    expect(d?.recommendedLayout).toBe('hero_insets');
    expect(d?.recommendedPanelCount).toBe(3);
    expect(d?.whitespaceIntent).toBe('dramatic');
  });

  it('脏字段回落安全默认，不产生非法枚举', () => {
    const d = parseVisualDirection({ recommendedLayout: 'nonsense', readingOrder: 'x', whitespaceIntent: 'x' });
    expect(d?.recommendedLayout).toBe('open_montage');
    expect(d?.readingOrder).toBe('top_to_bottom');
    expect(d?.whitespaceIntent).toBe('balanced');
  });

  it('非对象返回 undefined', () => {
    expect(parseVisualDirection(null)).toBeUndefined();
    expect(parseVisualDirection('x')).toBeUndefined();
  });
});

describe('Stage B/C — Layout Plan 解析与校验', () => {
  it('合法 hero_insets 布局解析通过', () => {
    const parsed = parseLayoutPlan(rawLayout);
    expect(parsed).toBeDefined();
    expect(parsed!.plan.style).toBe('hero_insets');
    expect(parsed!.plan.slots).toHaveLength(2);
    expect(parsed!.validation.ok).toBe(true);
  });

  it('修复后的 plan 被回传（不只是校验记录）', () => {
    const dirty = {
      ...rawLayout,
      readingOrder: [2, 2, 99],
      slots: [
        { ...rawLayout.slots[0], x: -0.2, width: 2 },
        rawLayout.slots[1],
      ],
    };
    const parsed = parseLayoutPlan(dirty)!;
    // clamp 生效在回传的 plan 上，而不只是写进 fixes
    expect(parsed.plan.slots[0].x).toBe(0);
    expect(parsed.plan.slots[0].width).toBeLessThanOrEqual(1);
    expect(parsed.plan.readingOrder).toEqual([2, 1]);
    expect(parsed.validation.fixes.length).toBeGreaterThan(0);
  });

  it('用户固定 3 格时，布局只给 2 格 → 校验 error', () => {
    const parsed = parseLayoutPlan(rawLayout, { expectedPanelCount: 3 });
    expect(parsed!.validation.ok).toBe(false);
    expect(parsed!.validation.errors.some(e => e.includes('用户固定 3 格'))).toBe(true);
  });

  it('用户锁定 hero_insets 但布局换风格 → error', () => {
    const parsed = parseLayoutPlan({ ...rawLayout, style: 'diagonal_panels' }, {
      styleLocked: true, expectedStyle: 'hero_insets',
    });
    expect(parsed!.validation.ok).toBe(false);
    expect(parsed!.validation.errors.some(e => e.includes('用户锁定风格'))).toBe(true);
  });

  it('兼容 layoutPlan 嵌套写法', () => {
    const parsed = parseLayoutPlan({ layoutPlan: rawLayout });
    expect(parsed).toBeDefined();
    expect(parsed!.plan.style).toBe('hero_insets');
  });

  it('没有 slots 就返回 undefined（不伪造布局）', () => {
    expect(parseLayoutPlan({ style: 'hero_insets' })).toBeUndefined();
    expect(parseLayoutPlan(null)).toBeUndefined();
  });

  it('polygon 顶点与 safeAreas 被解析', () => {
    const parsed = parseLayoutPlan({
      ...rawLayout,
      slots: [{ ...rawLayout.slots[0], shape: 'trapezoid',
        polygon: [{ x: 0, y: 0 }, { x: 0.7, y: 0 }, { x: 0.5, y: 0.7 }, { x: 0.05, y: 0.7 }],
        safeAreas: [{ type: 'bubble', x: 0.1, y: 0.1, width: 0.2, height: 0.15 }],
      }, rawLayout.slots[1]],
    })!;
    expect(parsed.plan.slots[0].polygon).toHaveLength(4);
    expect(parsed.plan.slots[0].safeAreas?.[0].type).toBe('bubble');
    expect(parsed.validation.ok).toBe(true);
  });
});
