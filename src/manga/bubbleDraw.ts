/**
 * ST-Story-Illustrator — Canvas 气泡绘制
 *
 * 移植自文档 §6.10（drawBubbles / drawBlend / drawHeart / roundRectPath）。
 * 依赖 DOM canvas，但绘制逻辑确定；排版全部委托 bubblePlan 纯函数。
 */

import {
  normalizeBubbleStyle,
  normalizeBubbleFont,
  isBlendStyle,
  BUBBLE_FONT_STACKS,
  type PanelDialogueItem,
  type BubbleRect,
  type PlanOptions,
} from './bubbleTypes';
import {
  planBubbles,
  bubbleFontSize,
  blendFontSize,
  blendSpacing,
  blendInkFor,
  boxInkFor,
  PANEL_DIALOGUE_MAX,
} from './bubblePlan';

function perColOf(cols: string[]): number {
  return Math.max(0, ...cols.map(c => [...c].length));
}

function roundRectPath(ctx: CanvasRenderingContext2D, rect: BubbleRect, radius: number): void {
  const { x, y, width, height } = rect;
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function drawHeart(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.beginPath();
  ctx.moveTo(0, 9);
  ctx.bezierCurveTo(-11, -3, -5, -12, 0, -5);
  ctx.bezierCurveTo(5, -12, 11, -3, 0, 9);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

/** 绘制主函数：先把原图画上 canvas，再按形态分派。失败返回 null。 */
export function drawBubbles(
  image: HTMLImageElement,
  items: PanelDialogueItem[],
  opts: PlanOptions = {},
): HTMLCanvasElement | null {
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!width || !height) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, width, height);

  const style = normalizeBubbleStyle(opts.style);
  const fontStack = BUBBLE_FONT_STACKS[normalizeBubbleFont(opts.font)];
  if (isBlendStyle(style)) {
    drawBlend(ctx, items, fontStack, width, height, style, opts);
    return canvas;
  }

  const fontSize = bubbleFontSize({ width, height });
  ctx.font = `400 ${fontSize}px ${fontStack}`;
  const bubbles = planBubbles(items, { width, height }, s => ctx.measureText(s).width, opts);
  const ink = boxInkFor(style);

  for (const bubble of bubbles) {
    // 排版时为了塞进小格会缩小字号；绘制必须跟着小，否则字会挤出气泡
    const fs = bubble.fontSize ?? fontSize;
    const font = (w: string) => `${w} ${fs}px ${fontStack}`;
    const lineWidth = Math.max(2, Math.round(fs * 0.09));
    const tailSize = fs * 0.5;
    if (bubble.tail) {
      const baseY = bubble.tail === 'down' ? bubble.y + bubble.height : bubble.y;
      const tipY = bubble.tail === 'down' ? baseY + tailSize : baseY - tailSize;
      // 尾巴朝向人物：气泡在左半边就把尾巴放右下角、指向画面中轴，反之亦然。
      // 原来固定 0.28，气泡靠右时尾巴会翘到画面外，读起来像别人的台词。
      // 格内排版时 tailX 已经按「本格中轴」算好，直接用。
      const towardCenter = bubble.x + bubble.width / 2 < width / 2 ? 0.72 : 0.28;
      const baseX = typeof bubble.tailX === 'number' ? bubble.tailX : bubble.x + bubble.width * towardCenter;
      const inner = lineWidth / 2;
      ctx.beginPath();
      ctx.moveTo(baseX - tailSize * 0.5, baseY - Math.sign(baseY - tipY) * inner);
      ctx.lineTo(baseX, tipY);
      ctx.lineTo(baseX + tailSize * 0.5, baseY - Math.sign(baseY - tipY) * inner);
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#1a1a1a';
      ctx.lineWidth = lineWidth;
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.fill();
      roundRectPath(ctx, bubble, fs * 0.45);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = '#1a1a1a';
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(baseX - tailSize * 0.5, bubble.tail === 'down' ? bubble.y + bubble.height - lineWidth : bubble.y, tailSize, lineWidth + 1);
    } else {
      roundRectPath(ctx, bubble, fs * 0.35);
      ctx.fillStyle = 'rgba(18,16,15,0.82)';
      ctx.fill();
      ctx.strokeStyle = '#e8e4dc';
      ctx.lineWidth = Math.max(1.5, fs * 0.06);
      ctx.stroke();
    }

    ctx.fillStyle = ink.color;
    ctx.font = font('400');
    if (ink.glow) {
      ctx.shadowColor = ink.glow;
      ctx.shadowBlur = fs * 0.7;
    }
    ctx.textBaseline = 'top';
    if (bubble.vertical) {
      const step = fs * 1.15;
      const colSpacing = fs * 0.26;
      const colX = (ci: number) => bubble.x + bubble.width - fs * 0.7 - (ci + 1) * fs - ci * colSpacing;
      const totalH = Math.min(perColOf(bubble.lines), bubble.lines[0]?.length ?? 0) * step;
      bubble.lines.forEach((col, ci) => [...col].forEach((ch, ri) => ctx.fillText(ch, colX(ci), bubble.y + (bubble.height - totalH) / 2 + ri * step)));
    } else {
      const textHeight = bubble.lines.length * fs * 1.4;
      let cursorY = bubble.y + (bubble.height - textHeight) / 2 + fs * 0.08;
      for (const line of bubble.lines) {
        ctx.fillText(line, bubble.x + fs * 0.7, cursorY);
        cursorY += fs * 1.4;
      }
    }
    ctx.shadowBlur = 0; // 必须清，否则 whisper 的小爱心也带光（坑 9）
  }
  return canvas;
}

function drawBlend(
  ctx: CanvasRenderingContext2D,
  items: PanelDialogueItem[],
  fontStack: string,
  width: number,
  height: number,
  style: string,
  opts: PlanOptions = {},
): void {
  const baseFont = blendFontSize({ width, height });
  ctx.textBaseline = 'top';
  ctx.font = `400 ${baseFont}px ${fontStack}`;
  ctx.lineJoin = 'round';
  const measure = (s: string) => ctx.measureText(s).width;
  const rects = planBubbles(items, { width, height }, measure, { ...opts, style: style as import('../types').BubbleStyleId });
  const capped = items.slice(0, PANEL_DIALOGUE_MAX).filter(i => i.text.trim());
  const needsSampling = style === 'blend' || style === 'blend-vertical';

  rects.forEach((rect, index) => {
    // 格内排版会按格重排顺序，不能再按数组下标配对
    const item = capped[typeof rect.itemIndex === 'number' ? rect.itemIndex : index];
    if (!item) return;
    // 小格里的融入式文字在排版时已经缩过字号，绘制跟着缩
    const fontSize = rect.fontSize ?? baseFont;
    const spacing = style === 'blend-subtitle' ? fontSize * 0.1 : blendSpacing(fontSize);
    ctx.font = `400 ${fontSize}px ${fontStack}`;
    let avg = { r: 246, g: 238, b: 236 };
    if (needsSampling) {
      try {
        const sx = Math.max(0, Math.floor(rect.x - 8));
        const sy = Math.max(0, Math.floor(rect.y - 8));
        const sw = Math.min(width - sx, Math.ceil(rect.width + 16));
        const sh = Math.min(height - sy, Math.ceil(rect.height + 16));
        if (sw > 0 && sh > 0) {
          const data = ctx.getImageData(sx, sy, sw, sh).data;
          let r = 0, g = 0, b = 0, n = 0;
          for (let i = 0; i < data.length; i += 16) {
            if (data[i + 3] < 8) continue;
            r += data[i]; g += data[i + 1]; b += data[i + 2]; n += 1;
          }
          if (n > 0) avg = { r: r / n, g: g / n, b: b / n };
        }
      } catch {
        // 退回兜底浅底，文字照常画（坑 8）
      }
    }
    const ink = blendInkFor(style, avg);
    if (ink.band) {
      const padX = fontSize * 0.5;
      const padY = fontSize * 0.3;
      roundRectPath(ctx, { x: rect.x - padX, y: rect.y - padY, width: rect.width + padX * 2, height: rect.height + padY * 2, lines: [] }, fontSize * 0.28);
      ctx.fillStyle = ink.band;
      ctx.fill();
    }
    ctx.fillStyle = ink.color;
    if (ink.halo) {
      ctx.strokeStyle = ink.halo;
      ctx.lineWidth = Math.max(1.5, fontSize * 0.08);
    }
    if (ink.glow) {
      ctx.shadowColor = ink.glow;
      ctx.shadowBlur = fontSize * 0.6;
    }
    const drawChar = (ch: string, x: number, y: number) => {
      if (ink.halo) ctx.strokeText(ch, x, y);
      ctx.fillText(ch, x, y);
    };
    if (rect.vertical) {
      const step = fontSize * 1.15;
      rect.lines.forEach((col, ci) => {
        const colX = rect.x + rect.width - (ci + 1) * fontSize - ci * spacing;
        [...col].forEach((ch, ri) => drawChar(ch, colX, rect.y + ri * step));
      });
      ctx.shadowBlur = 0;
      if (item.mood === 'whisper' && style !== 'blend-subtitle') {
        const hx = Math.max(4, Math.min(width - fontSize * 3, rect.x + rect.width / 2));
        const hy = Math.min(height - fontSize * 2, rect.y + rect.height + fontSize * 0.4);
        drawHeart(ctx, hx, hy, fontSize * 0.9, '#D47F8E');
        drawHeart(ctx, hx + fontSize * 1.3, hy + fontSize * 0.4, fontSize * 0.6, '#D47F8E');
      }
    } else {
      let cursorY = rect.y + fontSize * 0.15;
      for (const line of rect.lines) {
        let x = rect.x;
        for (const ch of [...line]) {
          drawChar(ch, x, cursorY);
          x += measure(ch) + spacing;
        }
        cursorY += fontSize * 1.35;
      }
      ctx.shadowBlur = 0;
      if (item.mood === 'whisper' && style !== 'blend-subtitle') {
        const hx = Math.min(width - fontSize * 3, rect.x + rect.width + spacing * 0.6);
        const hy = Math.max(4, Math.min(height - fontSize * 2, rect.y + rect.height - fontSize * 0.2));
        drawHeart(ctx, hx, hy, fontSize * 0.9, '#D47F8E');
        drawHeart(ctx, hx + fontSize * 1.3, hy + fontSize * 0.4, fontSize * 0.6, '#D47F8E');
      }
    }
  });
}
