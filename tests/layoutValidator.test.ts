import { describe, expect, it } from 'vitest';
import {
  repairAndValidate,
  repairLayoutPlan,
  validateLayoutPlan,
} from '../src/manga/layoutValidator';
import type { ComicLayoutPlan, ComicPanelSlot } from '../src/types';

function slot(i: number, over: Partial<ComicPanelSlot> = {}): ComicPanelSlot {
  return {
    panelIndex: i,
    x: i * 0.34,
    y: 0,
    width: 0.32,
    height: 0.5,
    shape: 'rect',
    zIndex: i,
    role: i === 0 ? 'hero' : 'support',
    border: 'thin',
    overlapAllowed: false,
    ...over,
  };
}

function plan(over: Partial<ComicLayoutPlan> = {}): ComicLayoutPlan {
  return {
    style: 'open_montage',
    panelCount: 3,
    background: 'white',
    whitespace: { intent: 'airy', outerMargin: 0.05, gutter: 0.02, reservedRegions: [] },
    readingOrder: [1, 2, 3],
    slots: [slot(0), slot(1), slot(2)],
    designRationale: 'test',
    ...over,
  };
}

describe('Layout Validator — 合格布局', () => {
  it('合法的三格布局通过', () => {
    const r = validateLayoutPlan({ plan: plan() });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });
});

describe('Layout Validator — 结构约束', () => {
  it('slots 数量与 panelCount 不一致 → error', () => {
    const r = validateLayoutPlan({ plan: plan({ panelCount: 3, slots: [slot(0), slot(1)] }) });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('不一致'))).toBe(true);
  });

  it('用户固定 3 格但布局只给 2 格 → error', () => {
    const r = validateLayoutPlan({
      plan: plan({ panelCount: 2, slots: [slot(0), slot(1)], readingOrder: [1, 2] }),
      expectedPanelCount: 3,
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('用户固定 3 格'))).toBe(true);
  });

  it('用户锁定风格但布局换了风格 → error', () => {
    const r = validateLayoutPlan({
      plan: plan({ style: 'diagonal_panels' }),
      styleLocked: true,
      expectedStyle: 'hero_insets',
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('用户锁定风格'))).toBe(true);
  });

  it('readingOrder 不是完整排列 → error', () => {
    const r = validateLayoutPlan({ plan: plan({ readingOrder: [1, 1, 3] }) });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('readingOrder'))).toBe(true);
  });
});

describe('Layout Validator — 几何', () => {
  it('格子越出页面 → error', () => {
    const bad = slot(0, { x: 0.9, width: 0.5 });
    const r = validateLayoutPlan({ plan: plan({ slots: [bad, slot(1), slot(2)] }) });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('超出页面'))).toBe(true);
  });

  it('尺寸过小 → error', () => {
    const tiny = slot(0, { width: 0.01, height: 0.01 });
    const r = validateLayoutPlan({ plan: plan({ slots: [tiny, slot(1), slot(2)] }) });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('尺寸过小'))).toBe(true);
  });

  it('斜切形状缺 polygon → error', () => {
    const diag = slot(0, { shape: 'trapezoid' });
    const r = validateLayoutPlan({ plan: plan({ slots: [diag, slot(1), slot(2)] }) });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('polygon 顶点'))).toBe(true);
  });

  it('polygon 自交 → error', () => {
    const bowtie = slot(0, {
      shape: 'custom_polygon',
      polygon: [
        { x: 0, y: 0 }, { x: 0.3, y: 0.5 }, { x: 0, y: 0.5 }, { x: 0.3, y: 0 },
      ],
    });
    const r = validateLayoutPlan({ plan: plan({ slots: [bowtie, slot(1), slot(2)] }) });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('自交'))).toBe(true);
  });

  it('两格重叠且都没允许 → error', () => {
    const a = slot(0);
    const b = slot(1, { x: 0.1, y: 0 });
    const r = validateLayoutPlan({ plan: plan({ slots: [a, b, slot(2)] }) });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('重叠'))).toBe(true);
  });

  it('浮动 inset 声明 overlapAllowed 后可重叠', () => {
    const a = slot(0);
    const b = slot(1, { x: 0.1, y: 0, role: 'detail', overlapAllowed: true, shape: 'floating_rect' });
    const r = validateLayoutPlan({ plan: plan({ slots: [a, b, slot(2)] }) });
    expect(r.ok).toBe(true);
  });
});

describe('Layout Validator — 对白/留白关联', () => {
  it('台词指向不存在的格 → error', () => {
    const r = validateLayoutPlan({
      plan: plan(),
      dialogue: [{ text: '你好', panel: 9 }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('不存在的格'))).toBe(true);
  });

  it('普通格压到预留留白区 → warning（不阻断）', () => {
    const reserved = { x: 0.7, y: 0.7, width: 0.2, height: 0.2 };
    const r = validateLayoutPlan({
      plan: plan({
        slots: [slot(0), slot(1), slot(2, { x: 0.72, y: 0.72, width: 0.2, height: 0.2 })],
        whitespace: { intent: 'dramatic', outerMargin: 0.05, gutter: 0.02, reservedRegions: [reserved] },
      }),
    });
    expect(r.warnings.some(w => w.includes('留白区'))).toBe(true);
  });
});

describe('Layout Validator — 安全确定性修复', () => {
  it('repairLayoutPlan 把越界坐标夹回、把乱序 readingOrder 补全', () => {
    const bad = plan({
      slots: [slot(0, { x: -0.2, width: 2 }), slot(1), slot(2)],
      readingOrder: [2, 2, 99],
    });
    const { plan: fixed, fixes } = repairLayoutPlan(bad);
    expect(fixes.length).toBeGreaterThan(0);
    expect(fixed.slots[0].x).toBe(0);
    expect(fixed.slots[0].width).toBeLessThanOrEqual(1);
    // 保留已声明的合法顺序（2 在前 = 先读格2），只补齐缺失的 1、3，不擅自重排
    expect(fixed.readingOrder).toEqual([2, 1, 3]);
  });

  it('repairAndValidate 修复后能通过', () => {
    const bad = plan({
      readingOrder: [1, 1, 5],
      slots: [slot(0, { x: -0.1 }), slot(1), slot(2)],
    });
    const r = repairAndValidate({ plan: bad });
    expect(r.ok).toBe(true);
    expect(r.fixes.length).toBeGreaterThan(0);
  });
});
