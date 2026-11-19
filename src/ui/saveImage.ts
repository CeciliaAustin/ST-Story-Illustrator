/**
 * ST-Story-Illustrator — 图片保存到本地
 *
 * 下载不直接 fetch URL：柏宝绘条目的 path 可能是相对路径，也可能是跨域地址，
 * `fetch + a[download]` 那条路在跨域时静默失败（用户看到的症状就是「点了没反应」）。
 * 这里走与显示层同一条 `loadDrawableImage` 通道拿到可绘制的图，
 * 再用 canvas.toBlob 落一份干净 PNG——只要显示层能画出来的图就一定能存下来。
 */

import { loadDrawableImage } from '../manga/bubbleComposite';

/** 把任意（原图 / 带字合成图）保存为 PNG。失败返回 false，不抛错。 */
export async function saveImageFile(src: string, filename: string): Promise<boolean> {
  try {
    const { image, cleanup } = await loadDrawableImage(src);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return false;
      ctx.drawImage(image, 0, 0);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) return false;
      const url = URL.createObjectURL(blob);
      try {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        return true;
      } finally {
        URL.revokeObjectURL(url);
      }
    } finally {
      cleanup();
    }
  } catch {
    return false;
  }
}
