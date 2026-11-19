/**
 * ST-Story-Illustrator — 版面几何（纯函数）
 *
 * 为什么需要这个文件：气泡要像真漫画，第一条规则是**气泡不许离开自己那一格**——
 * 不能骑在两格之间的 gutter 上，也不能跑到别的格里去。而 NAI 回来的是一张位图，
 * 没法检测格线。好在版面是我们自己下发的：`2koma` / `3koma` / `4koma` 怎么切，
 * 由提示词钉死，几何也就是确定的，可以直接算出来。
 *
 * 只对 **regular**（规整等分）给出精确格位。其余三档：
 * - `irregular`：模型自选三种形态之一，几何不可知 → 返回空，退回整页排版（不假装知道）；
 * - `inset` / `unframed`：主画面区域是确定的，返回「允许放字的区域」；
 *   顶部脸特写条与右下浮格用 no-go 区挡掉——气泡压在特写格上同样是错的。
 *
 * 所有矩形都是**归一化**的（0~1），与图片实际像素无关。
 */

import type { PanelLayout, PanelPageType } from '../types';
import type { AvoidZone } from './bubbleTypes';

/** 一块可放气泡的区域（归一化）。 */
export interface PanelSlot {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 两格之间的 gutter 总宽（页宽比例）。规则里写的是「约页宽 3%」，取 2.4% 略保守。 */
const GAP = 0.024;

/**
 * 这一页的格位（按阅读顺序：从上到下、从左到右）。
 *
 * @param layout 版面档位
 * @param count  实际格数（2~4；0 表示未知）
 * @param pageType 无框档的页型（a/b/c/d，auto 按 A 型算）
 */
export function panelSlots(
  layout: PanelLayout,
  count: number,
  pageType: PanelPageType = 'auto',
): PanelSlot[] {
  const n = Math.min(4, Math.max(0, Math.round(Number(count) || 0)));

  if (layout === 'regular') {
    if (n <= 1) return [{ x: 0, y: 0, width: 1, height: 1 }];
    if (n === 2) {
      const h = (1 - GAP) / 2;
      return [
        { x: 0, y: 0, width: 1, height: h },
        { x: 0, y: h + GAP, width: 1, height: h },
      ];
    }
    if (n === 3) {
      // 上一条宽格（约 38%）+ 下方左右两个等宽格
      const top = 0.378;
      const botY = top + GAP;
      const botH = 1 - botY;
      const w = (1 - GAP) / 2;
      return [
        { x: 0, y: 0, width: 1, height: top },
        { x: 0, y: botY, width: w, height: botH },
        { x: w + GAP, y: botY, width: w, height: botH },
      ];
    }
    // 2×2 四等分
    const w = (1 - GAP) / 2;
    const h = (1 - GAP) / 2;
    return [
      { x: 0, y: 0, width: w, height: h },
      { x: w + GAP, y: 0, width: w, height: h },
      { x: 0, y: h + GAP, width: w, height: h },
      { x: w + GAP, y: h + GAP, width: w, height: h },
    ];
  }

  // 不规则拼版：三种形态由模型按内容挑，落成什么样我们不知道。
  // 宁可退回整页排版（旧行为），也不拿一套错的格位去钉气泡。
  if (layout === 'irregular') return [];

  if (layout === 'inset') {
    // 白底人物页：顶部 15~20% 是脸特写条，主体插画在中间偏下
    return [{ x: 0.02, y: 0.19, width: 0.96, height: 0.78 }];
  }

  // unframed：主插画区域（无框、铺到页底）
  switch (pageType) {
    case 'c':
      // 右缘竖长特写格占约 30% 宽，主插画在左侧
      return [{ x: 0.02, y: 0.02, width: 0.65, height: 0.96 }];
    case 'd':
      return [{ x: 0.02, y: 0.02, width: 0.96, height: 0.96 }];
    case 'a':
    case 'b':
    default:
      // 默认 A 型：顶部 20% 是特写条，主插画从 20% 往下铺到底
      return [{ x: 0.02, y: 0.21, width: 0.96, height: 0.77 }];
  }
}

/**
 * 这一页「绝对不能放气泡」的区域（归一化，页面坐标）。
 *
 * 特写格是放大镜，本来就小、内容又单一，气泡压上去会把那一格彻底糊掉。
 * 顶部脸特写条同理。这些框不进 slot，而是作为加权禁区。
 */
export function layoutNoGoZones(
  layout: PanelLayout,
  pageType: PanelPageType = 'auto',
): AvoidZone[] {
  if (layout === 'inset') {
    // 顶部横条 + 右下贴边小格
    return [
      { x: 0, y: 0, width: 1, height: 0.19, weight: 3 },
      { x: 0.6, y: 0.66, width: 0.4, height: 0.34, weight: 3 },
    ];
  }
  if (layout === 'unframed') {
    if (pageType === 'd') {
      return [{ x: 0.66, y: 0.74, width: 0.34, height: 0.26, weight: 3 }];
    }
    if (pageType === 'c') {
      return [{ x: 0.66, y: 0, width: 0.34, height: 1, weight: 3 }];
    }
    // A / B：右下浮格；顶部条已由 slot 起点挡掉
    return [{ x: 0.33, y: 0.71, width: 0.65, height: 0.27, weight: 3 }];
  }
  return [];
}

/** 页内一点落在哪一格（找不到就取中心最近的一格）。 */
export function slotIndexAt(slots: readonly PanelSlot[], px: number, py: number): number {
  if (!slots.length) return 0;
  let inside = -1;
  slots.forEach((s, i) => {
    if (px >= s.x && px <= s.x + s.width && py >= s.y && py <= s.y + s.height) inside = i;
  });
  if (inside >= 0) return inside;
  let best = 0;
  let bestDist = Infinity;
  slots.forEach((s, i) => {
    const dx = s.x + s.width / 2 - px;
    const dy = s.y + s.height / 2 - py;
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  });
  return best;
}
