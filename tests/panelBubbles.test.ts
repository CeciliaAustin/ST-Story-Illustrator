/**
 * 漫画页气泡的「格内排版」。
 *
 * 用户报的是「有的时候会生成错位置，不像真的漫画」——真漫画的第一条排版语法
 * 是：气泡永远在自己那一格的框里，不骑 gutter、不跑格。这组用例只盯几何关系：
 * 每颗气泡是否完整落在某一格里、是否和邻格的气泡互不干涉、尾巴是否朝本格。
 */

import { describe, it, expect } from 'vitest';
import { planBubbles, assignDialogueToSlots, bubbleFontSize } from '../src/manga/bubblePlan';
import { panelSlots, layoutNoGoZones, slotIndexAt } from '../src/manga/panelSlots';
import type { PanelDialogueItem, BubbleRect } from '../src/manga/bubbleTypes';

const PAGE = { width: 832, height: 1216 };

/** 等宽字：一个汉字 28px（与 baseFont 同量级）。 */
const measure = (s: string) => [...s].length * 28;

function inside(rect: BubbleRect, box: { x: number; y: number; width: number; height: number }, tol = 1.5): boolean {
  return (
    rect.x >= box.x - tol &&
    rect.y >= box.y - tol &&
    rect.x + rect.width <= box.x + box.width + tol &&
    rect.y + rect.height <= box.y + box.height + tol
  );
}

function px(slot: { x: number; y: number; width: number; height: number }) {
  return {
    x: slot.x * PAGE.width,
    y: slot.y * PAGE.height,
    width: slot.width * PAGE.width,
    height: slot.height * PAGE.height,
  };
}

describe('panelSlots 几何', () => {
  it('规整两格：上下两块，中间留 gutter，不重叠', () => {
    const slots = panelSlots('regular', 2);
    expect(slots).toHaveLength(2);
    expect(slots[0].y).toBe(0);
    expect(slots[0].y + slots[0].height).toBeLessThan(slots[1].y);
    expect(slots[1].y + slots[1].height).toBeCloseTo(1, 5);
  });

  it('规整三格：上宽下二，阅读顺序为上→左下→右下', () => {
    const slots = panelSlots('regular', 3);
    expect(slots).toHaveLength(3);
    expect(slots[0].width).toBe(1);
    expect(slots[1].x).toBe(0);
    expect(slots[2].x).toBeGreaterThan(slots[1].x + slots[1].width);
    // 左下在右下左边，且两块都在上格下面
    expect(slots[1].y).toBeGreaterThan(slots[0].y + slots[0].height);
    expect(slots[2].y).toBe(slots[1].y);
  });

  it('规整四格：2×2，四块互不重叠', () => {
    const slots = panelSlots('regular', 4);
    expect(slots).toHaveLength(4);
    for (let i = 0; i < slots.length; i += 1) {
      for (let j = i + 1; j < slots.length; j += 1) {
        const a = px(slots[i]);
        const b = px(slots[j]);
        const overlap =
          a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
        expect(overlap).toBe(false);
      }
    }
    expect(slots[0].x).toBe(0);
    expect(slots[1].x).toBeGreaterThan(0.4);
    expect(slots[2].y).toBeGreaterThan(0.4);
  });

  it('不规则档不给格位（版面由模型挑，我们不假装知道）', () => {
    expect(panelSlots('irregular', 3)).toEqual([]);
  });

  it('无框档把顶部特写条让出来', () => {
    const slots = panelSlots('unframed', 3, 'a');
    expect(slots).toHaveLength(1);
    expect(slots[0].y).toBeGreaterThan(0.18);
  });

  it('inset / unframed 的特写格是禁区', () => {
    expect(layoutNoGoZones('inset').length).toBeGreaterThan(0);
    expect(layoutNoGoZones('unframed', 'a').length).toBeGreaterThan(0);
    expect(layoutNoGoZones('regular')).toEqual([]);
  });

  it('slotIndexAt 能把页内一点落回正确的格', () => {
    const slots = panelSlots('regular', 2);
    expect(slotIndexAt(slots, 0.5, 0.2)).toBe(0);
    expect(slotIndexAt(slots, 0.5, 0.8)).toBe(1);
  });
});

describe('台词分格', () => {
  const slots = panelSlots('regular', 2);

  it('模型写了 panel 就用它（1 起）', () => {
    const items: PanelDialogueItem[] = [
      { text: '上格', panel: 1 },
      { text: '下格', panel: 2 },
    ];
    expect(assignDialogueToSlots(items, slots)).toEqual([0, 1]);
  });

  it('没有任何线索时按阅读顺序均分，不会四句全塞进第一格', () => {
    const items: PanelDialogueItem[] = [
      { text: '一' }, { text: '二' }, { text: '三' }, { text: '四' },
    ];
    expect(assignDialogueToSlots(items, slots)).toEqual([0, 0, 1, 1]);
  });

  it('只有 area 时按 area 反查（它至少能说明上下）', () => {
    const items: PanelDialogueItem[] = [
      { text: '上半', area: 'tl' },
      { text: '下半', area: 'bl' },
    ];
    expect(assignDialogueToSlots(items, slots)).toEqual([0, 1]);
  });

  it('分不清的跟着上一句走，不会把一句话拆到两格', () => {
    const items: PanelDialogueItem[] = [
      { text: '第一句', panel: 2 },
      { text: '第二句' },
      { text: '第三句' },
    ];
    expect(assignDialogueToSlots(items, slots)).toEqual([1, 1, 1]);
  });

  it('panel 越界按缺省处理（不塞进不存在的格）', () => {
    const items: PanelDialogueItem[] = [{ text: 'x', panel: 9 }];
    const assigned = assignDialogueToSlots(items, slots);
    expect(assigned[0]).toBeGreaterThanOrEqual(0);
    expect(assigned[0]).toBeLessThan(slots.length);
  });

  it('写了说话人而他只出现在某一格时，放到那一格', () => {
    const items: PanelDialogueItem[] = [
      { text: '甲说的话', speaker: '甲' },
      { text: '乙说的话', speaker: '乙' },
    ];
    expect(assignDialogueToSlots(items, slots, [['甲'], ['乙']])).toEqual([0, 1]);
  });

  it('说话人两格都有（同框）时不硬猜，退回缺省', () => {
    const items: PanelDialogueItem[] = [{ text: '两个人都在', speaker: '甲' }];
    const assigned = assignDialogueToSlots(items, slots, [['甲', '乙'], ['甲']]);
    expect(assigned[0]).toBe(0); // 均分下第一条落第一格，不因歧义乱跳
  });

  it('模型写成 0 起（跟着 panels[].index）时整份按 0 起解释，不会整体错一格', () => {
    const items: PanelDialogueItem[] = [
      { text: '第一格', panel: 0 },
      { text: '第二格', panel: 1 },
    ];
    expect(assignDialogueToSlots(items, slots)).toEqual([0, 1]);
  });
});

describe('格内排版', () => {
  it('两格页：四句台词，每颗都完整落在自己那一格里（不骑 gutter）', () => {
    const slots = panelSlots('regular', 2);
    const items: PanelDialogueItem[] = [
      { text: '等一下。', panel: 1 },
      { text: '你听见了吗？', panel: 1 },
      { text: '外面好像在下雨。', panel: 2 },
      { text: '别走那么快。', panel: 2 },
    ];
    const rects = planBubbles(items, PAGE, measure, { panels: slots });
    expect(rects).toHaveLength(4);
    const boxes = slots.map(px);
    for (const rect of rects) {
      const hit = boxes.filter(box => inside(rect, box));
      expect(hit.length).toBe(1);
    }
    // 上格两颗、下格两颗
    expect(rects.filter(r => inside(r, boxes[0])).length).toBe(2);
    expect(rects.filter(r => inside(r, boxes[1])).length).toBe(2);
  });

  it('四格页：四句各回各格，顺序不乱', () => {
    const slots = panelSlots('regular', 4);
    const items: PanelDialogueItem[] = [
      { text: '第一格的话' },
      { text: '第二格的话' },
      { text: '第三格的话' },
      { text: '第四格的话' },
    ];
    const rects = planBubbles(items, PAGE, measure, { panels: slots });
    expect(rects).toHaveLength(4);
    const boxes = slots.map(px);
    rects.forEach((rect, i) => {
      expect(inside(rect, boxes[i])).toBe(true);
    });
  });

  it('三格页：气泡不会落到上方格子与下方格子之间的 gutter 上', () => {
    const slots = panelSlots('regular', 3);
    const items: PanelDialogueItem[] = [
      { text: '上面的话', panel: 1 },
      { text: '左下的话', panel: 2 },
      { text: '右下的话', panel: 3 },
    ];
    const rects = planBubbles(items, PAGE, measure, { panels: slots });
    const gutterY = slots[0].y + slots[0].height;
    for (const rect of rects) {
      const spansGutter =
        rect.y < gutterY * PAGE.height && rect.y + rect.height > gutterY * PAGE.height;
      expect(spansGutter).toBe(false);
    }
  });

  it('气泡之间不重叠（同一格里会自然往下叠）', () => {
    const slots = panelSlots('regular', 2);
    const items: PanelDialogueItem[] = [
      { text: '第一句', panel: 1 },
      { text: '第二句', panel: 1 },
      { text: '第三句', panel: 1 },
    ];
    const rects = planBubbles(items, PAGE, measure, { panels: slots });
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const a = rects[i];
        const b = rects[j];
        const overlap =
          a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
        expect(overlap).toBe(false);
      }
    }
  });

  it('长台词在小格里会缩字号，不会溢出格子', () => {
    const slots = panelSlots('regular', 4);
    const long = '你刚才在走廊上说的那句话我一直在想，可是我不敢问你是不是那个意思。';
    const rects = planBubbles([{ text: long, panel: 1 }], PAGE, measure, { panels: slots });
    expect(rects).toHaveLength(1);
    expect(inside(rects[0], px(slots[0]))).toBe(true);
    expect(rects[0].height).toBeLessThanOrEqual(px(slots[0]).height);
  });

  it('气泡不会整块盖住本格的脸区', () => {
    const slots = panelSlots('regular', 2);
    const slot = slots[1]; // 下半格
    const rects = planBubbles([{ text: '你好呀', panel: 2 }], PAGE, measure, { panels: slots });
    const face = {
      x: (slot.x + slot.width * 0.28) * PAGE.width,
      y: (slot.y + slot.height * 0.06) * PAGE.height,
      width: slot.width * 0.44 * PAGE.width,
      height: slot.height * 0.40 * PAGE.height,
    };
    const r = rects[0];
    const w = Math.min(r.x + r.width, face.x + face.width) - Math.max(r.x, face.x);
    const h = Math.min(r.y + r.height, face.y + face.height) - Math.max(r.y, face.y);
    const cover = w > 0 && h > 0 ? (w * h) / (r.width * r.height) : 0;
    expect(cover).toBeLessThanOrEqual(0.5);
  });

  it('格内气泡的尾巴朝本格中轴，且尾巴根在气泡内', () => {
    const slots = panelSlots('regular', 4);
    const rects = planBubbles([{ text: '嗯。', panel: 2 }], PAGE, measure, { panels: slots });
    const r = rects[0];
    expect(typeof r.tailX).toBe('number');
    expect(r.tailX as number).toBeGreaterThanOrEqual(r.x);
    expect(r.tailX as number).toBeLessThanOrEqual(r.x + r.width);
    const slotMidX = (slots[1].x + slots[1].width / 2) * PAGE.width;
    const bubbleMidX = r.x + r.width / 2;
    // 尾巴在靠近本格中轴的那一侧
    if (bubbleMidX < slotMidX) expect(r.tailX as number).toBeGreaterThan(bubbleMidX);
    else expect(r.tailX as number).toBeLessThan(bubbleMidX);
  });

  it('没有格位时保持整页排版（不传 panels 也不崩）', () => {
    const rects = planBubbles([{ text: '你好', panel: 2 }], PAGE, measure);
    expect(rects).toHaveLength(1);
    expect(rects[0].x + rects[0].width).toBeLessThanOrEqual(PAGE.width);
  });

  it('字幕条不走格内排版（它本来就在页底整条）', () => {
    const slots = panelSlots('regular', 2);
    const rects = planBubbles([{ text: '字幕', panel: 1 }], PAGE, measure, {
      panels: slots,
      style: 'bubble-subtitle',
    });
    expect(rects[0].y + rects[0].height).toBeGreaterThan(PAGE.height * 0.8);
  });

  it('每颗气泡记住自己排版时的字号，气泡高度装得下文字（字不会挤出框）', () => {
    const slots = panelSlots('regular', 4);
    const items: PanelDialogueItem[] = [
      { text: '第一格的台词' },
      { text: '第二格的台词稍微长一点点' },
    ];
    for (const rect of planBubbles(items, PAGE, measure, { panels: slots })) {
      expect(typeof rect.fontSize).toBe('number');
      const fs = rect.fontSize as number;
      // 行高 1.4 + 上下内边距，气泡必须比文字高
      expect(rect.height).toBeGreaterThanOrEqual(rect.lines.length * fs * 1.4);
    }
  });

  it('整页排版也走同一个字号公式（测量与绘制同源）', () => {
    const rects = planBubbles([{ text: '你好' }], PAGE, measure);
    expect(rects[0].fontSize).toBe(bubbleFontSize(PAGE));
  });
});
