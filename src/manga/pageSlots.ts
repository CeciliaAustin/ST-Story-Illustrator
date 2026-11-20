/**
 * ST-Story-Illustrator — 确定性页内格位（纯函数）
 *
 * 为什么要有这个模块：只要还是「整页一次出图」，版面就只能靠 tag + nl 求模型施舍，
 * 于是必然出现三件事（用户实测）：
 *   1. 写了 3koma 得到等宽三条横带；不写 koma 就只画一格；
 *   2. 想表达「框外留白」，只能写 white background —— NAI 把它理解成「整张图没有背景」，
 *      结果框内也变成大白底，人物飘在纯白上；
 *   3. 格数没有任何程序级保证。
 *
 * 逐格出图之后这些问题全部消失：格子是**代码画的**，背景是**每格自己的图**，
 * 白底只是页面上没被格子占到的区域（= 框外留白）。
 *
 * 坐标一律用 0..1 归一化：x/y 是左上角，width/height 是占比。
 * 输出顺序 = 阅读顺序 = panelIndex 顺序；面积最大的格固定给 panelIndex 0（主图）。
 */

import type { BoardLayout } from './boardPrompt';

export type SlotBorder = 'none' | 'thin';

export interface PageSlot {
  panelIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  border: SlotBorder;
}

/** 合成页面的像素尺寸（竖版 A 比例，与柏宝绘 portrait 一致）。 */
export const PAGE_WIDTH = 832;
export const PAGE_HEIGHT = 1216;

/** 页边距（框外留白的下限）。 */
const MARGIN = 0.045;
/** 格间 gutter（黑线两侧的间隙）。 */
const GUTTER = 0.01;

export interface SlotOptions {
  /** 留白意图：airy/dramatic 时 inset 档把主图收得更小，页边更宽。 */
  whitespace?: 'compact' | 'balanced' | 'airy' | 'dramatic';
}

function clampSlot(slot: PageSlot): PageSlot {
  const x = Math.max(0, Math.min(1, slot.x));
  const y = Math.max(0, Math.min(1, slot.y));
  const width = Math.max(0.02, Math.min(1 - x, slot.width));
  const height = Math.max(0.02, Math.min(1 - y, slot.height));
  return { ...slot, x, y, width, height };
}

/** 等分横排（传统四格 / 2koma / 3koma 的原始形态）。 */
function regularSlots(count: number): PageSlot[] {
  if (count <= 1) {
    return [{ panelIndex: 0, x: MARGIN, y: MARGIN, width: 1 - MARGIN * 2, height: 1 - MARGIN * 2, border: 'thin' }];
  }
  const usable = 1 - MARGIN * 2 - GUTTER * (count - 1);
  const h = usable / count;
  return Array.from({ length: count }, (_, i) => ({
    panelIndex: i,
    x: MARGIN,
    y: MARGIN + i * (h + GUTTER),
    width: 1 - MARGIN * 2,
    height: h,
    border: 'thin' as SlotBorder,
  }));
}

/**
 * 开放拼版：大格 + 小格不等分配，铺满整页（这一档本来就不留白）。
 * 主格固定占左列，其余在右列竖排，高度按比例递减 —— 保证面积不相等。
 */
function irregularSlots(count: number): PageSlot[] {
  if (count <= 1) {
    return [{ panelIndex: 0, x: MARGIN, y: MARGIN, width: 1 - MARGIN * 2, height: 1 - MARGIN * 2, border: 'thin' }];
  }
  const usableW = 1 - MARGIN * 2;
  const usableH = 1 - MARGIN * 2;
  const heroW = count === 2 ? usableW * 0.64 : usableW * 0.57;
  const sideW = usableW - heroW - GUTTER;
  const slots: PageSlot[] = [
    { panelIndex: 0, x: MARGIN, y: MARGIN, width: heroW, height: usableH, border: 'thin' },
  ];
  const rest = count - 1;
  const totalGap = GUTTER * (rest - 1);
  // 递减权重：越往下越矮，形成「大小格」的节奏，而不是等分
  const weights = Array.from({ length: rest }, (_, i) => 1 / (i + 1.25));
  const weightSum = weights.reduce((a, b) => a + b, 0);
  let cursor = MARGIN;
  for (let i = 0; i < rest; i += 1) {
    const h = ((usableH - totalGap) * weights[i]) / weightSum;
    slots.push({
      panelIndex: i + 1,
      x: MARGIN + heroW + GUTTER,
      y: cursor,
      width: sideW,
      height: h,
      border: 'thin',
    });
    cursor += h + GUTTER;
  }
  return slots;
}

/**
 * 主图 + 特写（白底档）：页面是白纸，主图画在中间且**无框**，
 * 特写格带细黑框、浮在四周的白边上。
 *
 * 这正是用户要的「留白是框外留白」：白只出现在格子之外；
 * 格子里是每格自己的图，背景照常存在（不再是一个整页大白底）。
 */
function insetSlots(count: number, airy: boolean): PageSlot[] {
  if (count <= 1) {
    const m = airy ? 0.13 : 0.09;
    return [{ panelIndex: 0, x: m, y: m, width: 1 - m * 2, height: 1 - m * 2, border: 'none' }];
  }
  // 顶部窄横条：主图上方的一格
  const stripY = 0.035;
  const stripH = 0.12;
  // 主图：四边留白随留白意图变化
  const mainX = airy ? 0.055 : 0.05;
  const mainTop = stripY + stripH + 0.04;
  const mainH = 0.545;
  // 底部特写格
  const insetY = mainTop + mainH + 0.055;
  const insetH = 1 - insetY - 0.035;

  const slots: PageSlot[] = [
    { panelIndex: 0, x: mainX, y: mainTop, width: 1 - mainX * 2, height: mainH, border: 'none' },
    { panelIndex: 1, x: 0.14, y: stripY, width: 0.72, height: stripH, border: 'thin' },
  ];

  const rest = count - 2;
  // 底部：右下 → 左下 → 中下，最多三个特写格
  const boxes: Array<{ x: number; width: number }> = [
    { x: 0.60, width: 0.35 },
    { x: 0.055, width: 0.33 },
    { x: 0.42, width: 0.16 },
  ];
  for (let i = 0; i < Math.min(rest, boxes.length); i += 1) {
    slots.push({
      panelIndex: i + 2,
      x: boxes[i].x,
      y: insetY,
      width: boxes[i].width,
      height: insetH,
      border: 'thin',
    });
  }
  return slots;
}

/**
 * 无框档：主图铺满整页（不留页边）、无边框；特写格带细黑框浮在主图上。
 * 与 inset 的区别是「主图有没有页边留白」。
 */
function unframedSlots(count: number): PageSlot[] {
  const slots: PageSlot[] = [
    { panelIndex: 0, x: 0.015, y: 0.015, width: 0.97, height: 0.97, border: 'none' },
  ];
  const boxes: Array<{ x: number; y: number; width: number; height: number }> = [
    { x: 0.60, y: 0.03, width: 0.36, height: 0.17 },
    { x: 0.04, y: 0.79, width: 0.32, height: 0.17 },
    { x: 0.60, y: 0.79, width: 0.36, height: 0.17 },
  ];
  for (let i = 1; i < count; i += 1) {
    const box = boxes[Math.min(i - 1, boxes.length - 1)];
    slots.push({ panelIndex: i, ...box, border: 'thin' });
  }
  return slots;
}

/**
 * 按版面档 + 格数算出这一页的格位。
 * 超出该档容量的格数会被截断（调用方应先用 panelCount 限过），保证不重叠。
 */
export function pageSlotsFor(
  layout: BoardLayout,
  count: number,
  options: SlotOptions = {},
): PageSlot[] {
  const n = Math.max(1, Math.min(6, Math.floor(count) || 1));
  const airy = options.whitespace === 'airy' || options.whitespace === 'dramatic' || options.whitespace === undefined;
  let slots: PageSlot[];
  switch (layout) {
    case 'regular': slots = regularSlots(n); break;
    case 'irregular': slots = irregularSlots(n); break;
    case 'unframed': slots = unframedSlots(n); break;
    case 'inset':
    default: slots = insetSlots(n, airy); break;
  }
  // 该档容量不足时（例如 inset 只有 4 个位），多出来的格并进最后一格，绝不重叠
  const capacity = slots.length;
  if (n > capacity) {
    for (let i = capacity; i < n; i += 1) {
      slots.push({ ...slots[capacity - 1], panelIndex: i });
    }
  }
  return slots.slice(0, n).map(clampSlot);
}

/** 两格是否重叠（含边贴边视为不重叠，留 1px 容差）。 */
export function slotsOverlap(a: PageSlot, b: PageSlot): boolean {
  const eps = 0.002;
  return a.x + eps < b.x + b.width
    && b.x + eps < a.x + a.width
    && a.y + eps < b.y + b.height
    && b.y + eps < a.y + a.height;
}
