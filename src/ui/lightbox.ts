/**
 * ST-Story-Illustrator — 图片放大查看（Lightbox）
 */
import type { BubbleCompositeResult } from '../manga/bubbleTypes';

let overlay: HTMLElement | null = null;

/** 打开大图。imageUrl 可以是原图或带字合成图。 */
export function openLightbox(imageUrl: string, caption?: string): void {
  ensureOverlay();
  if (!overlay) return;
  overlay.innerHTML = '';

  const img = document.createElement('img');
  img.className = 'sti-lightbox-img';
  img.src = imageUrl;
  img.alt = caption ?? '图片';
  overlay.appendChild(img);

  if (caption) {
    const cap = document.createElement('div');
    cap.className = 'sti-lightbox-caption';
    cap.textContent = caption;
    overlay.appendChild(cap);
  }

  const close = document.createElement('button');
  close.className = 'sti-lightbox-close';
  close.textContent = '×';
  close.setAttribute('aria-label', '关闭');
  close.addEventListener('click', closeLightbox);
  overlay.appendChild(close);

  overlay.style.display = 'flex';
  overlay.onclick = (e) => { if (e.target === overlay) closeLightbox(); };
}

export function closeLightbox(): void {
  if (overlay) overlay.style.display = 'none';
}

function ensureOverlay(): void {
  if (overlay) return;
  overlay = document.createElement('div');
  overlay.id = 'sti-lightbox';
  overlay.className = 'sti-lightbox';
  overlay.style.display = 'none';
  document.body.appendChild(overlay);
}

export function destroyLightbox(): void {
  if (overlay) { overlay.remove(); overlay = null; }
}

// 供 card 使用：为带字合成图管理 revoke 生命周期
export interface CompositeHandle {
  result: BubbleCompositeResult | null;
}
