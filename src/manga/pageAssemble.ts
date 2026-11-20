/**
 * ST-Story-Illustrator — 逐格素材合成整页（浏览器端）
 *
 * 逐格出图之后，页面由代码拼：白纸 + 各格图像 + 细黑框。
 * 这一步才是「框外留白」的正解 —— 白只出现在格子之外，格子里永远是每格自己的背景。
 *
 * 依赖注入 canvas / 图片加载，纯浏览器能力，不碰 ST 环境，便于测试里注入 mock。
 */

import { loadDrawableImage } from './bubbleComposite';
import { PAGE_HEIGHT, PAGE_WIDTH, type PageSlot } from './pageSlots';

export interface AssembleInput {
  /** 与 images 一一对应的格位 */
  slots: readonly PageSlot[];
  /** 每格的图片地址（柏宝绘图库返回的 path 或 dataUrl） */
  images: readonly string[];
  width?: number;
  height?: number;
  /** 页面底色（框外留白的颜色） */
  background?: string;
  /** 边框颜色 */
  borderColor?: string;
}

/** 主图裁切时的垂直锚点：略偏上，避免把脸切掉。 */
const CROP_ANCHOR_Y = 0.28;

/**
 * cover 裁切：源图按目标格的比例裁到刚好铺满，多余部分从两侧或上下裁掉。
 * 之所有要有锚点：竖图放进横格时上下会裁很多，默认居中会把头切掉。
 */
export function coverRect(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): { x: number; y: number; width: number; height: number } {
  if (!srcW || !srcH || !dstW || !dstH) return { x: 0, y: 0, width: srcW, height: srcH };
  const srcAspect = srcW / srcH;
  const dstAspect = dstW / dstH;
  if (srcAspect > dstAspect) {
    // 源更宽：左右裁
    const width = srcH * dstAspect;
    return { x: (srcW - width) / 2, y: 0, width, height: srcH };
  }
  // 源更高：上下裁，锚点偏上
  const height = srcW / dstAspect;
  const spare = srcH - height;
  return { x: 0, y: Math.max(0, spare * CROP_ANCHOR_Y), width: srcW, height };
}

export interface AssembleResult {
  canvas: HTMLCanvasElement;
  /** 每格实际画上去了没有（供 QC 日志） */
  drawn: boolean[];
}

/**
 * 把各格图像按 slots 合成到一张画布。
 * 缺图的格保留白底（不崩、不错位）；有图的格按 cover 裁切铺满。
 */
export function drawAssembledPage(
  doc: Document,
  input: AssembleInput,
  images: readonly HTMLImageElement[],
): AssembleResult {
  const width = input.width ?? PAGE_WIDTH;
  const height = input.height ?? PAGE_HEIGHT;
  const canvas = doc.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { canvas, drawn: [] };

  // 整页白纸 = 框外留白
  ctx.fillStyle = input.background ?? '#ffffff';
  ctx.fillRect(0, 0, width, height);

  const borderColor = input.borderColor ?? 'rgba(0,0,0,0.88)';
  const drawn: boolean[] = new Array(input.slots.length).fill(false);

  input.slots.forEach((slot, index) => {
    const img = images[index];
    const dx = slot.x * width;
    const dy = slot.y * height;
    const dw = slot.width * width;
    const dh = slot.height * height;
    if (!img || !img.width || !img.height) return;

    // 带框的浮层格：先垫一圈白边，免得压在别的格上时糊成一片
    if (slot.border === 'thin') {
      const pad = Math.max(3, Math.round(width * 0.006));
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(dx - pad, dy - pad, dw + pad * 2, dh + pad * 2);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(dx, dy, dw, dh);
    ctx.clip();
    const src = coverRect(img.width, img.height, dw, dh);
    ctx.drawImage(img, src.x, src.y, src.width, src.height, dx, dy, dw, dh);
    ctx.restore();

    if (slot.border === 'thin') {
      ctx.save();
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = Math.max(2, Math.round(width * 0.0035));
      ctx.strokeRect(dx, dy, dw, dh);
      ctx.restore();
    }
    drawn[index] = true;
  });

  return { canvas, drawn };
}

/** 加载 N 张图（CORS 安全）→ 合成 → 返回画布。任一格加载失败只跳过那一格。 */
export async function assemblePageCanvas(input: AssembleInput): Promise<AssembleResult | null> {
  if (!input.slots.length || !input.images.length) return null;
  const doc = typeof document !== 'undefined' ? document : null;
  if (!doc) return null;

  const loaded = await Promise.all(
    input.images.map(async (src) => {
      try {
        const { image, cleanup } = await loadDrawableImage(src);
        return { image, cleanup };
      } catch {
        return null;
      }
    }),
  );
  try {
    const images = loaded.map(item => item?.image ?? (undefined as unknown as HTMLImageElement));
    return drawAssembledPage(doc, input, images);
  } finally {
    // 画布已经把像素拷走了，blob URL 可以立刻释放
    loaded.forEach(item => item?.cleanup());
  }
}

/** 合成结果 → PNG Blob（用于上传落盘）。 */
export async function assemblePageBlob(input: AssembleInput): Promise<{ blob: Blob; drawn: boolean[] } | null> {
  const result = await assemblePageCanvas(input);
  if (!result) return null;
  const blob = await new Promise<Blob | null>(resolve => result.canvas.toBlob(resolve, 'image/png'));
  if (!blob) return null;
  return { blob, drawn: result.drawn };
}
