/**
 * 气泡避让：台词不许压在人物脸上。
 *
 * 这组用例盯的是用户报的那个现象——「台词总生成在角色的脸上」。
 * 断言不看具体坐标（换算法就会碎），只看几何关系：
 * 气泡矩形与「脸区」的重叠面积必须小到可以忽略。
 */

import { describe, it, expect } from 'vitest';
import { planBubbles, FACE_AVOID_ZONES, faceCoverRatio } from '../src/manga/bubblePlan';
import type { BubbleRect } from '../src/manga/bubbleTypes';

const PAGE = { width: 832, height: 1216 };

/** 等宽字：一个汉字 1em，够用的近似。 */
function measureOf(fontSize = 28) {
  return (s: string) => [...s].length * fontSize;
}

function faceBox() {
  const z = FACE_AVOID_ZONES[0];
  return {
    x: z.x * PAGE.width,
    y: z.y * PAGE.height,
    width: z.width * PAGE.width,
    height: z.height * PAGE.height,
  };
}

function overlap(a: BubbleRect, b: { x: number; y: number; width: number; height: number }): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function faceCover(r: BubbleRect): number {
  return overlap(r, faceBox()) / Math.max(1, r.width * r.height);
}

describe('气泡避脸', () => {
  it('一条短台词不压脸', () => {
    const rects = planBubbles([{ text: '放学一起走吗？' }], PAGE, measureOf());
    expect(rects).toHaveLength(1);
    expect(faceCover(rects[0])).toBeLessThan(0.02);
  });

  it('一条长台词（接近 60 字上限）也不压脸', () => {
    const long = '你刚才在走廊上说的那句话，我一直在想，可是我不敢问你是不是那个意思，所以就一直站在这里。';
    const rects = planBubbles([{ text: long }], PAGE, measureOf());
    expect(rects).toHaveLength(1);
    expect(faceCover(rects[0])).toBeLessThan(0.05);
  });

  it('四条台词逐条都不压脸，且互不重叠', () => {
    const items = [
      { text: '等一下。' },
      { text: '你听见了吗？' },
      { text: '外面好像在下雨。' },
      { text: '别走那么快。' },
    ];
    const rects = planBubbles(items, PAGE, measureOf());
    expect(rects).toHaveLength(4);
    for (const r of rects) {
      expect(faceCover(r)).toBeLessThan(0.06);
    }
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        expect(overlap(rects[i], rects[j])).toBe(0);
      }
    }
  });

  it('气泡不横跨画面中轴（会被人物劈成两半）', () => {
    const rects = planBubbles([{ text: '今天的天气真好啊，要不要一起出去走走' }], PAGE, measureOf());
    const r = rects[0];
    const crosses = r.x < PAGE.width / 2 && r.x + r.width > PAGE.width / 2;
    expect(crosses).toBe(false);
  });

  it('气泡宽度不会伸进中轴的人脸区（最宽 0.36 页宽）', () => {
    const rects = planBubbles([{ text: '这是一句相当长的台词，用来检查气泡到底能有多宽' }], PAGE, measureOf());
    expect(rects[0].width).toBeLessThanOrEqual(PAGE.width * 0.36);
  });

  it('全部气泡都完整落在画面里（含边距）', () => {
    const items = [{ text: '嗯。' }, { text: '走吧。' }, { text: '等等我！' }, { text: '……' }];
    for (const r of planBubbles(items, PAGE, measureOf())) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width).toBeLessThanOrEqual(PAGE.width);
      expect(r.y + r.height).toBeLessThanOrEqual(PAGE.height);
    }
  });

  it('模型指定了会压脸的锚点（tc）也会被换到不压脸的位置', () => {
    const rects = planBubbles([{ text: '你在看什么？', area: 'tc' as const }], PAGE, measureOf());
    expect(faceCover(rects[0])).toBeLessThan(0.05);
  });

  it('手动坐标仍然原地钉死（用户明确指定就尊重）', () => {
    const rects = planBubbles([{ text: '你好', x: 0.5, y: 0.5 }], PAGE, measureOf());
    expect(Math.abs(rects[0].x + rects[0].width / 2 - PAGE.width * 0.5)).toBeLessThan(2);
    expect(Math.abs(rects[0].y + rects[0].height / 2 - PAGE.height * 0.5)).toBeLessThan(2);
  });

  it('关掉避让（avoidFace:false）仍能正常排版，不会崩', () => {
    const off = planBubbles([{ text: '你在看什么？' }], PAGE, measureOf(), { avoidFace: false });
    expect(off).toHaveLength(1);
    expect(off[0].x + off[0].width).toBeLessThanOrEqual(PAGE.width);
    expect(off[0].y + off[0].height).toBeLessThanOrEqual(PAGE.height);
  });

  it('faceCoverRatio 对正中位置给出高比例（自检函数本身有效）', () => {
    const z = faceBox();
    const centered: BubbleRect = { x: z.x, y: z.y, width: z.width, height: z.height, lines: [] };
    expect(faceCoverRatio(centered, PAGE)).toBeGreaterThan(0.9);
  });
});
