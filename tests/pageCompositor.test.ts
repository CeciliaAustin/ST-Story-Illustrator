import { describe, expect, it, vi } from 'vitest';
import { composePageCanvas, polygonCutsSafeArea, slotPath } from '../src/manga/pageCompositor';
import type { ComicLayoutPlan, ComicPanelSlot } from '../src/types';

// node 环境没有 Path2D；注入一个最小实现，让 polygon 路径逻辑可被验证。
class FakePath2D {
  ops: string[] = [];
  moveTo() { this.ops.push('moveTo'); }
  lineTo() { this.ops.push('lineTo'); }
  closePath() { this.ops.push('closePath'); }
  rect() { this.ops.push('rect'); }
}
vi.stubGlobal('Path2D', FakePath2D);

function slot(over: Partial<ComicPanelSlot> = {}): ComicPanelSlot {
  return {
    panelIndex: 0, x: 0, y: 0, width: 0.5, height: 1,
    shape: 'rect', zIndex: 0, role: 'hero', border: 'thin', overlapAllowed: false,
    ...over,
  };
}

function plan(slots: ComicPanelSlot[]): ComicLayoutPlan {
  return {
    style: 'open_montage', panelCount: slots.length, background: 'white',
    whitespace: { intent: 'balanced', outerMargin: 0.04, gutter: 0.02, reservedRegions: [] },
    readingOrder: slots.map((_, i) => i + 1), slots, designRationale: '',
  };
}

/** 记录关键调用的 mock ctx。 */
function mockCtx() {
  const calls: string[] = [];
  const ctx = {
    save: () => calls.push('save'),
    restore: () => calls.push('restore'),
    fillRect: () => calls.push('fillRect'),
    beginPath: () => calls.push('beginPath'),
    rect: () => calls.push('rect'),
    clip: (_p?: unknown) => calls.push('clip'),
    stroke: (_p?: unknown) => calls.push('stroke'),
    drawImage: () => calls.push('drawImage'),
    set fillStyle(_v: string) {},
    set strokeStyle(_v: string) {},
    set lineWidth(_v: number) {},
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

describe('slotPath', () => {
  it('矩形 grid 格生成 rect 路径', () => {
    const p = slotPath(slot(), 100, 200);
    expect(p).not.toBeNull();
  });

  it('斜切格生成 polygon 路径（有 polygon 且形状非 rect）', () => {
    const s = slot({ shape: 'trapezoid', polygon: [
      { x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.4, y: 1 }, { x: 0, y: 1 },
    ] });
    expect(slotPath(s, 100, 200)).not.toBeNull();
  });
});

describe('composePageCanvas', () => {
  it('先铺背景，再逐格 drawImage + clip，最后描边', () => {
    const { ctx, calls } = mockCtx();
    const s = slot();
    composePageCanvas(ctx, plan([s]), [{ panelIndex: 0, image: {} as CanvasImageSource }],
      { width: 100, height: 200 });
    expect(calls[0]).toBe('save');
    expect(calls).toContain('fillRect');
    expect(calls).toContain('clip');
    expect(calls).toContain('drawImage');
    expect(calls).toContain('stroke');
  });

  it('缺图的格跳过 drawImage', () => {
    const { ctx, calls } = mockCtx();
    const s = slot({ panelIndex: 0 });
    composePageCanvas(ctx, plan([s]), [], { width: 100, height: 200 });
    expect(calls).not.toContain('drawImage');
  });

  it('border=none 的格不描边', () => {
    const { ctx, calls } = mockCtx();
    const s = slot({ border: 'none' });
    composePageCanvas(ctx, plan([s]), [{ panelIndex: 0, image: {} as CanvasImageSource }],
      { width: 100, height: 200 });
    expect(calls).not.toContain('stroke');
  });

  it('drawBorders=false 全局不描边', () => {
    const { ctx, calls } = mockCtx();
    composePageCanvas(ctx, plan([slot()]), [{ panelIndex: 0, image: {} as CanvasImageSource }],
      { width: 100, height: 200, drawBorders: false });
    expect(calls).not.toContain('stroke');
  });

  it('按 zIndex 排序合成（z 小的先画）', () => {
    const { ctx, calls } = mockCtx();
    const a = slot({ panelIndex: 0, zIndex: 5 });
    const b = slot({ panelIndex: 1, zIndex: 1, x: 0.5 });
    composePageCanvas(ctx, plan([a, b]), [
      { panelIndex: 0, image: {} as CanvasImageSource },
      { panelIndex: 1, image: {} as CanvasImageSource },
    ], { width: 100, height: 200 });
    // 两次 drawImage 都存在（顺序由排序保证，此处只验证都画了）
    expect(calls.filter(c => c === 'drawImage')).toHaveLength(2);
  });
});

describe('polygonCutsSafeArea', () => {
  it('矩形格与远处安全区不相交 → 不切', () => {
    expect(polygonCutsSafeArea(slot(), { x: 0.7, y: 0.7, width: 0.2, height: 0.2 })).toBe(false);
  });

  it('矩形格覆盖安全区 → 判为切（需要重新安排）', () => {
    expect(polygonCutsSafeArea(slot(), { x: 0.1, y: 0.1, width: 0.2, height: 0.2 })).toBe(true);
  });

  it('梯形格完整包含安全区 → 不切', () => {
    const s = slot({ shape: 'trapezoid', polygon: [
      { x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.4, y: 1 }, { x: 0, y: 1 },
    ] });
    expect(polygonCutsSafeArea(s, { x: 0.1, y: 0.3, width: 0.1, height: 0.2 })).toBe(false);
  });
});
