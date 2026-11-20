/**
 * 确定性版面合成器（几何核心，纯函数）
 *
 * 扩展指导 §3 / §5-B：当出图采用「逐格生成素材 + Canvas 合成」时，
 * 本模块按 layoutPlan.slots 把每格素材裁切、摆位、画边框，合成一整页。
 * 斜切格用 polygon clip（Path2D），边框沿同一路径描绘——不是先画矩形框再裁图。
 *
 * 初始化只提供「几何能力核心」；是否启用确定性出图由上层策略决定（当前默认整页一次出图）。
 * 依赖注入 ctx 与图像源，不碰 DOM、不发请求，便于用 mock ctx 单测路径正确性。
 */

import type { ComicLayoutPlan, ComicPanelSlot } from '../types';

/** 一格的图像源 + 它对应的 slot index。 */
export interface PanelImageSource {
  /** 对应 ComicPanelSlot.panelIndex（0 起）。 */
  panelIndex: number;
  image: CanvasImageSource;
  /** 源图裁切矩形（可选；不填就用整张）。 */
  srcRect?: { x: number; y: number; width: number; height: number };
}

/** 合成输出配置。 */
export interface ComposeOptions {
  /** 输出画布像素宽高（slot 的 0..1 坐标映射到它）。 */
  width: number;
  height: number;
  /** 是否画格子边框（默认 true，沿 polygon 画）。 */
  drawBorders?: boolean;
  /** 页面背景色；不填则用 plan.background 推导。 */
  background?: string;
}

function backgroundOf(plan: ComicLayoutPlan): string {
  switch (plan.background) {
    case 'black': return '#111111';
    case 'transparent': return 'rgba(0,0,0,0)';
    case 'scene': return '#ffffff';
    case 'white':
    default: return '#ffffff';
  }
}

/**
 * 构造一格的路径（矩形或 polygon）。返回 Path2D；若运行环境没有 Path2D，
 * 退化为用 ctx.beginPath 的路径（通过返回 null 让调用方走 ctx 原生绘制）。
 */
export function slotPath(slot: ComicPanelSlot, w: number, h: number): Path2D | null {
  if (typeof Path2D === 'undefined') return null;
  const p = new Path2D();
  const poly = slot.polygon;
  if (poly && poly.length >= 3 && slot.shape !== 'rect') {
    poly.forEach((pt, i) => {
      const x = pt.x * w;
      const y = pt.y * h;
      if (i === 0) p.moveTo(x, y);
      else p.lineTo(x, y);
    });
    p.closePath();
  } else {
    p.rect(slot.x * w, slot.y * h, slot.width * w, slot.height * h);
  }
  return p;
}

/** 把 slot 的 bounding box 作为源图目标矩形（图像铺满该格）。 */
function destinationRect(slot: ComicPanelSlot, w: number, h: number): [number, number, number, number] {
  return [slot.x * w, slot.y * h, slot.width * w, slot.height * h];
}

/**
 * 按 layoutPlan 把每格素材合成到 ctx。
 * 处理顺序按 zIndex，clip 用 polygon 路径，边框沿同一路径描边。
 * 缺图的格跳过（留空白），不影响其它格。
 */
export function composePageCanvas(
  ctx: CanvasRenderingContext2D,
  plan: ComicLayoutPlan,
  sources: readonly PanelImageSource[],
  options: ComposeOptions,
): void {
  const { width: w, height: h, drawBorders = true } = options;

  // 背景
  ctx.save();
  ctx.fillStyle = options.background ?? backgroundOf(plan);
  ctx.fillRect(0, 0, w, h);
  ctx.restore();

  const ordered = [...plan.slots].sort((a, b) => a.zIndex - b.zIndex);
  for (const slot of ordered) {
    const src = sources.find(s => s.panelIndex === slot.panelIndex);
    if (!src) continue;

    ctx.save();
    const path = slotPath(slot, w, h);
    if (path) ctx.clip(path);
    else {
      // 无 Path2D 环境：矩形 clip（斜切降级为 bbox，保证不崩）
      const [dx, dy, dw, dh] = destinationRect(slot, w, h);
      ctx.beginPath();
      ctx.rect(dx, dy, dw, dh);
      ctx.clip();
    }

    const [dx, dy, dw, dh] = destinationRect(slot, w, h);
    if (src.srcRect) {
      ctx.drawImage(src.image, src.srcRect.x, src.srcRect.y, src.srcRect.width, src.srcRect.height,
        dx, dy, dw, dh);
    } else {
      ctx.drawImage(src.image, dx, dy, dw, dh);
    }
    ctx.restore();

    if (drawBorders && slot.border !== 'none') {
      ctx.save();
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.lineWidth = slot.border === 'rough' ? 3 : 2;
      const borderPath = slotPath(slot, w, h);
      if (borderPath) {
        ctx.stroke(borderPath);
      } else {
        // 无 Path2D 环境（含 node 测试）降级为矩形边框，保证边框不缺失
        const [dx, dy, dw, dh] = destinationRect(slot, w, h);
        ctx.beginPath();
        ctx.rect(dx, dy, dw, dh);
        ctx.stroke();
      }
      ctx.restore();
    }
  }
}

/**
 * polygon 是否切到了「重要区域」（脸/手/道具/对白安全区）——任务书 §3 要求斜切不切这些。
 * 这里做保守的 bbox 相交检测：安全区完全落在某格 bbox 内才算安全，
 * 落在 polygon 之外或跨格的标记为风险，交给上层决定是否要 LLM 重排。
 */
export function polygonCutsSafeArea(slot: ComicPanelSlot, safe: { x: number; y: number; width: number; height: number }): boolean {
  // 格内自己的安全区本来就该在格内；这里检测的是「另一格的安全区被本格覆盖」
  const sx2 = safe.x + safe.width;
  const sy2 = safe.y + safe.height;
  const gx2 = slot.x + slot.width;
  const gy2 = slot.y + slot.height;
  const bboxHit = safe.x < gx2 && sx2 > slot.x && safe.y < gy2 && sy2 > slot.y;
  if (!bboxHit) return false;
  if (!slot.polygon || slot.polygon.length < 3 || slot.shape === 'rect') return true;
  // 安全区四角是否都在 polygon 内（点在多边形内：射线法）
  const inPoly = (px: number, py: number): boolean => {
    let inside = false;
    const pts = slot.polygon!;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x; const yi = pts[i].y;
      const xj = pts[j].x; const yj = pts[j].y;
      if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  };
  const corners = [
    [safe.x, safe.y], [sx2, safe.y], [safe.x, sy2], [sx2, sy2],
  ];
  // 只要有一个角在 polygon 外，就认为这个安全区被斜切边界切断 → 有风险
  return corners.some(([x, y]) => !inPoly(x, y));
}
