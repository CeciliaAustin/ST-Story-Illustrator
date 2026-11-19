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

// ============================================================
// 逐格看大图（多图翻页）
// ============================================================

export interface GalleryItem {
  src: string;
  caption?: string;
}

let gallery: HTMLElement | null = null;
let galleryItems: GalleryItem[] = [];
let galleryIndex = 0;

/** 打开多图查看器，「逐格看大图」用。 */
export function openGallery(items: GalleryItem[], startIndex = 0): void {
  if (items.length === 0) return;
  galleryItems = items;
  galleryIndex = Math.min(Math.max(startIndex, 0), items.length - 1);
  ensureGallery();
  renderGallery();
  if (gallery) gallery.style.display = 'flex';
}

function ensureGallery(): void {
  if (gallery) return;
  const el = document.createElement('div');
  el.id = 'sti-gallery';
  el.className = 'sti-lightbox sti-gallery';
  el.style.display = 'none';
  el.addEventListener('click', (e) => {
    if (e.target === el) closeGallery();
  });

  const prev = document.createElement('button');
  prev.type = 'button';
  prev.className = 'sti-gallery-nav prev';
  prev.textContent = '‹';
  prev.addEventListener('click', (e) => { e.stopPropagation(); stepGallery(-1); });
  el.appendChild(prev);

  const stage = document.createElement('div');
  stage.className = 'sti-gallery-stage';
  el.appendChild(stage);

  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'sti-gallery-nav next';
  next.textContent = '›';
  next.addEventListener('click', (e) => { e.stopPropagation(); stepGallery(1); });
  el.appendChild(next);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'sti-lightbox-close';
  close.textContent = '×';
  close.setAttribute('aria-label', '关闭');
  close.addEventListener('click', closeGallery);
  el.appendChild(close);

  document.body.appendChild(el);
  gallery = el;

  el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') stepGallery(-1);
    if (e.key === 'ArrowRight') stepGallery(1);
    if (e.key === 'Escape') closeGallery();
  });
  el.tabIndex = 0;
}

function renderGallery(): void {
  if (!gallery) return;
  const stage = gallery.querySelector<HTMLElement>('.sti-gallery-stage');
  if (!stage) return;
  stage.innerHTML = '';

  const item = galleryItems[galleryIndex];
  if (!item) return;

  const img = document.createElement('img');
  img.className = 'sti-lightbox-img';
  img.src = item.src;
  img.alt = item.caption ?? '图片';
  stage.appendChild(img);

  const cap = document.createElement('div');
  cap.className = 'sti-lightbox-caption';
  cap.textContent = `${galleryIndex + 1}/${galleryItems.length}${item.caption ? ' · ' + item.caption : ''}`;
  stage.appendChild(cap);

  const single = galleryItems.length <= 1;
  gallery.querySelectorAll<HTMLElement>('.sti-gallery-nav').forEach(n => {
    n.style.display = single ? 'none' : '';
  });
}

function stepGallery(delta: number): void {
  if (galleryItems.length === 0) return;
  galleryIndex = (galleryIndex + delta + galleryItems.length) % galleryItems.length;
  renderGallery();
}

export function closeGallery(): void {
  if (gallery) gallery.style.display = 'none';
}

export function destroyLightbox(): void {
  if (overlay) { overlay.remove(); overlay = null; }
  if (gallery) { gallery.remove(); gallery = null; }
  galleryItems = [];
}

// 供 card 使用：为带字合成图管理 revoke 生命周期
export interface CompositeHandle {
  result: BubbleCompositeResult | null;
}
