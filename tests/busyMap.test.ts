/**
 * 画面密度图（busyMap）与「气泡往留白里躲」
 *
 * 线上现象：不管怎么调，台词还是压在脸上。
 * 根因：避让用的全是**猜**的矩形——整页「脸在 0.33~0.67」、每格「头在上半」。
 * 不规则拼版连格线在哪都不知道，只能退回整页猜，猜错就是挡脸。
 *
 * 这里锁住新做法：从成图本身读「哪一块花」，花的地方罚分、留白不罚。
 */

import { describe, it, expect } from 'vitest';
import { buildBusyGrid, busyInRect, isSparsePage, type BusyGrid } from '../src/manga/busyMap';
import { planBubbles } from '../src/manga/bubblePlan';

/** 造一张纯色 RGBA 图。 */
function solid(width: number, height: number, rgb: [number, number, number]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return data;
}

/** 在纯白底上画横线（模拟线稿）。 */
function lines(width: number, height: number, fromY: number, toY: number): Uint8ClampedArray {
  const data = solid(width, height, [255, 255, 255]);
  for (let y = fromY; y < toY; y += 3) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      data[i] = 20; data[i + 1] = 20; data[i + 2] = 20;
    }
  }
  return data;
}

describe('buildBusyGrid', () => {
  it('白底页每个格子都接近 0', () => {
    const grid = buildBusyGrid(solid(80, 80, [252, 250, 248]), 80, 80, 8, 8);
    expect(grid.mean).toBeLessThan(0.05);
    expect(Math.max(...grid.cells)).toBeLessThan(0.15);
    expect(isSparsePage(grid)).toBe(true);
  });

  it('有线稿的区域明显更「忙」', () => {
    const grid = buildBusyGrid(lines(80, 80, 0, 40), 80, 80, 8, 8);
    const top = grid.cells.slice(0, 4 * 8);
    const bottom = grid.cells.slice(4 * 8);
    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length);
    expect(avg(top)).toBeGreaterThan(0.5);
    expect(avg(bottom)).toBeLessThan(avg(top));
  });

  it('尺寸或像素数据缺失时返回全 0 网格，不抛异常', () => {
    const grid = buildBusyGrid(new Uint8ClampedArray(0), 0, 0, 4, 4);
    expect(grid.cells).toHaveLength(16);
    expect(grid.cells.every(v => v === 0)).toBe(true);
    expect(grid.mean).toBe(0);
  });
});

describe('busyInRect', () => {
  const grid: BusyGrid = {
    cols: 2, rows: 2, mean: 0.5,
    // 左上角很花，其余干净
    cells: [1, 0, 0, 0],
  };

  it('落在花的那一格 → 接近 1', () => {
    expect(busyInRect(grid, { x: 0, y: 0, width: 0.5, height: 0.5 })).toBeCloseTo(1, 5);
  });

  it('落在干净的格子 → 0', () => {
    expect(busyInRect(grid, { x: 0.5, y: 0.5, width: 0.5, height: 0.5 })).toBe(0);
  });

  it('跨格按面积加权', () => {
    expect(busyInRect(grid, { x: 0, y: 0, width: 1, height: 0.5 })).toBeCloseTo(0.5, 5);
  });

  it('没有网格 / 空矩形 → 0（不能把缺数据当成「到处都花」）', () => {
    expect(busyInRect(undefined, { x: 0, y: 0, width: 1, height: 1 })).toBe(0);
    expect(busyInRect(grid, { x: 0.5, y: 0.5, width: 0, height: 0.5 })).toBe(0);
  });
});

describe('planBubbles 用密度图避让', () => {
  const page = { width: 400, height: 400 };
  const measure = (s: string) => s.length * 10;
  // 4×4 网格：中间四格全是「花」（脸/头发的典型位置），四周干净
  const busy: BusyGrid = {
    cols: 4, rows: 4, mean: 0.25,
    cells: Array.from({ length: 16 }, (_, i) => {
      const x = i % 4;
      const y = Math.floor(i / 4);
      return x >= 1 && x <= 2 && y >= 1 && y <= 2 ? 1 : 0;
    }),
  };

  it('中间很花时，气泡不落在中间', () => {
    const [rect] = planBubbles(
      [{ text: '那句话' }],
      page,
      measure,
      { avoidFace: false, busy },
    );
    expect(rect).toBeTruthy();
    const cx = (rect.x + rect.width / 2) / page.width;
    const cy = (rect.y + rect.height / 2) / page.height;
    const inBusy = cx > 0.25 && cx < 0.75 && cy > 0.25 && cy < 0.75;
    expect(inBusy).toBe(false);
  });

  it('没有密度图时行为不变（仍能排出气泡）', () => {
    const rects = planBubbles([{ text: '那句话' }], page, measure, { avoidFace: false });
    expect(rects).toHaveLength(1);
  });
});
