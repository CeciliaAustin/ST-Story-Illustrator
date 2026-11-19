/**
 * ST-Story-Illustrator — 气泡合成入口（CORS 安全 + 失败降级）
 *
 * 移植自文档 §6.6 / §6.9：
 * - 云端 URL 先 fetch 成字节 → blob URL → 加载图片，避免 canvas 被 CORS 污染
 * - 任何一步失败返回 null，调用方照常落盘无字原图（坑 11）
 * - 代次令牌防乱序：同一图连续改台词时旧结果作废并释放 blob
 */

import type { PanelDialogueItem, PlanOptions, BubbleCompositeResult } from './bubbleTypes';
import { drawBubbles } from './bubbleDraw';

// ============================================================
// 图片加载
// ============================================================

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = src;
  });
}

/**
 * 加载可安全绘制的图片。云端 URL 先 fetch 成字节转 blob URL（同源派生）。
 * data:/blob: 地址直接用（不会污染画布）。
 *
 * 相对路径兜底：柏宝绘条目里的 path 可能不带前导斜杠（`user/images/x.png`），
 * 直接 fetch 会按当前页面 URL 解析成 404——原版文档坑清单里的「同一路径多种写法」。
 * 失败时补一个前导斜杠再试一次。
 */
async function fetchBytes(src: string): Promise<Blob> {
  try {
    const response = await fetch(src, { mode: 'cors' });
    if (response.ok) return await response.blob();
  } catch { /* 落到下面的补斜杠重试 */ }
  const aliased = `/${src.replace(/^\/+/, '')}`;
  const response = await fetch(aliased, { mode: 'cors' });
  if (!response.ok) throw new Error(`fetch 失败: ${response.status}`);
  return await response.blob();
}

export async function loadDrawableImage(
  src: string,
): Promise<{ image: HTMLImageElement; cleanup: () => void }> {
  if (/^(blob|data):/i.test(src)) {
    return { image: await loadImage(src), cleanup: () => {} };
  }
  const blob = await fetchBytes(src);
  const url = URL.createObjectURL(blob);
  try {
    return { image: await loadImage(url), cleanup: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

// ============================================================
// 合成入口
// ============================================================

/**
 * 把台词合成到图片上，返回带字 blob URL + revoke 函数。
 * 任何失败返回 null——不让"气泡没画上"升级成"生成失败"。
 */
export async function compositeDialogue(
  imageUrl: string,
  items: PanelDialogueItem[],
  opts: PlanOptions = {},
): Promise<BubbleCompositeResult | null> {
  try {
    if (!items.length) return null;
    const { image, cleanup } = await loadDrawableImage(imageUrl);
    try {
      const canvas = drawBubbles(image, items, opts);
      if (!canvas) return null;
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) return null;
      const url = URL.createObjectURL(blob);
      return { url, filename: 'dialogue.png', revoke: () => URL.revokeObjectURL(url) };
    } finally {
      cleanup();
    }
  } catch {
    return null;
  }
}

// ============================================================
// 代次令牌（防异步乱序）
// ============================================================

/**
 * 创建一个合成令牌管理器。每次触发领一个令牌；回来时令牌过期则释放结果。
 * 用法：
 *   const token = mgr.next();
 *   const result = await compositeDialogue(...);
 *   if (!mgr.isCurrent(token)) { result?.revoke(); return; }
 */
export function createCompositeTokenManager() {
  let current = 0;
  return {
    next(): number {
      current += 1;
      return current;
    },
    isCurrent(token: number): boolean {
      return token === current;
    },
    revokeAll(): void {
      current += 1;
    },
  };
}
