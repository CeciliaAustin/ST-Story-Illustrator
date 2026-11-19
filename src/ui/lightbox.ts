/**
 * ST-Story-Illustrator — 图片放大查看（Lightbox）
 *
 * 2026-11 修订：对齐柏宝绘原版的灯箱交互（原版文档 §6.7/6.13/§7）——
 * 漫画页落盘的是无字原图，气泡在显示时才 canvas 合成，于是灯箱可以：
 * - 「气泡」开关：带字 / 无字一键切换（合成失败自动退回无字原图，坑 11）；
 * - 「台词」面板：增删改台词，保存写回 artifact.dialogue，零额度重合成；
 * - 「移动气泡」：选中某一句 → 点击图上位置 → 原地钉死（手动位置不参与
 *   自动排版、不被避让挪动，用户说放哪就放哪）；
 * - 「下载」：当前显示那一版（合成时自建独立 blob，不复用显示层引用，坑 10）。
 */
import type { ComicDialogue } from '../types';
import type { PanelDialogueItem, PlanOptions, BubbleCompositeResult } from '../manga/bubbleTypes';
import { compositeDialogue } from '../manga/bubbleComposite';
import { normalizeDialogueEdits } from '../manga/bubbleOverlay';

let overlay: HTMLElement | null = null;

/** 打开大图。imageUrl 可以是原图或带字合成图。 */
export function openLightbox(imageUrl: string, caption?: string): void {
  ensureOverlay();
  if (!overlay) return;
  overlay.innerHTML = '';
  overlay.classList.remove('is-comic'); // 漫画灯箱的附加类不串场

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
// 漫画灯箱：气泡开关 / 台词编辑 / 移动定位 / 下载
// ============================================================

export interface ComicLightboxPlan {
  items: PanelDialogueItem[];
  opts: PlanOptions;
}

export interface ComicLightboxContext {
  baseSrc: string;
  caption?: string;
  /** 打开时的排版参数（bubbleOverlay.comicOverlayPlan 的产物）。 */
  plan: ComicLightboxPlan;
  /**
   * 保存台词（含手动位置）。实现方写回 artifact.dialogue、落盘、重挂卡片，
   * 并返回保存后的最新排版参数（数据可能被别处改过，以返回值为准）。
   */
  onSave: (items: ComicDialogue[] | undefined) => Promise<ComicLightboxPlan | null>;
}

/** 单开一层的状态（每次 open 重建，闭包天然隔离）。 */
interface ComicState {
  ctx: ComicLightboxContext;
  showBubbles: boolean;
  editing: boolean;
  moving: boolean;
  moveIndex: number;
  draft: PanelDialogueItem[];
  token: number;
  current: { url: string; revoke: () => void } | null;
}

/** 打开漫画灯箱。plan 为空（无台词）时直接走普通大图。 */
export function openComicLightbox(ctx: ComicLightboxContext): void {
  if (!ctx.plan.items.length) {
    openLightbox(ctx.baseSrc, ctx.caption);
    return;
  }
  ensureOverlay();
  if (!overlay) return;
  overlay.innerHTML = '';
  overlay.classList.add('is-comic');

  const state: ComicState = {
    ctx,
    showBubbles: true,
    editing: false,
    moving: false,
    moveIndex: 0,
    draft: ctx.plan.items.map(item => ({ ...item })),
    token: 0,
    current: null,
  };

  const stage = document.createElement('div');
  stage.className = 'sti-lb-stage';
  overlay.appendChild(stage);

  const img = document.createElement('img');
  img.className = 'sti-lightbox-img';
  img.alt = ctx.caption ?? '漫画页';
  stage.appendChild(img);

  // 移动气泡模式：点击图面 → 归一化坐标 → 钉死选中那句
  stage.addEventListener('click', event => {
    if (!state.moving) return;
    event.stopPropagation();
    const rect = img.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = Math.round(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * 10000) / 10000;
    const y = Math.round(Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) * 10000) / 10000;
    const item = state.draft[state.moveIndex];
    if (!item) return;
    item.x = x;
    item.y = y;
    void persist(state);
  });

  const caption = document.createElement('div');
  caption.className = 'sti-lightbox-caption';
  overlay.appendChild(caption);

  // 工具栏：气泡开关 / 台词 / 移动气泡 / 下载 / 关闭
  const bar = document.createElement('div');
  bar.className = 'sti-lb-toolbar';
  overlay.appendChild(bar);

  const bubbleBtn = toolButton('气泡', '带字 / 无字切换（合成失败自动退回无字原图）');
  bubbleBtn.classList.add('is-on');
  bubbleBtn.addEventListener('click', () => {
    state.showBubbles = !state.showBubbles;
    bubbleBtn.classList.toggle('is-on', state.showBubbles);
    render(state, img, caption, chips, panel);
  });
  bar.appendChild(bubbleBtn);

  const editBtn = toolButton('台词', '编辑台词：增删改后保存，立即重合成（不消耗出图额度）');
  editBtn.addEventListener('click', () => {
    state.editing = !state.editing;
    if (state.editing) state.moving = false;
    render(state, img, caption, chips, panel);
  });
  bar.appendChild(editBtn);

  const moveBtn = toolButton('移动气泡', '选中一句台词，再点击图上位置把它钉在那里（不被自动排版挪动）');
  moveBtn.addEventListener('click', () => {
    state.moving = !state.moving;
    if (state.moving) state.editing = false;
    render(state, img, caption, chips, panel);
  });
  bar.appendChild(moveBtn);

  const saveBtn = toolButton('下载', '保存当前显示的这一版（带字 / 无字跟随开关）');
  saveBtn.addEventListener('click', () => { void downloadCurrent(state); });
  bar.appendChild(saveBtn);

  const close = document.createElement('button');
  close.className = 'sti-lightbox-close';
  close.textContent = '×';
  close.setAttribute('aria-label', '关闭');
  close.addEventListener('click', closeLightbox);
  overlay.appendChild(close);

  // 移动模式：每句一个 chip，选中哪句、点哪儿钉哪儿
  const chips = document.createElement('div');
  chips.className = 'sti-lb-chips';
  overlay.appendChild(chips);

  // 台词编辑面板
  const panel = document.createElement('div');
  panel.className = 'sti-lb-dlg';
  overlay.appendChild(panel);

  overlay.style.display = 'flex';
  overlay.onclick = (e) => { if (e.target === overlay) closeLightbox(); };
  render(state, img, caption, chips, panel);
}

function toolButton(label: string, title: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sti-lb-btn';
  btn.textContent = label;
  btn.title = title;
  return btn;
}

/** 保存草稿 → ctx.onSave → 以返回的最新参数重建草稿。 */
async function persist(state: ComicState): Promise<void> {
  const saved = await state.ctx.onSave(normalizeDialogueEdits(state.draft));
  if (saved) {
    state.ctx.plan = saved;
    state.draft = saved.items.map(item => ({ ...item }));
  }
}

/** 当前显示的地址：带字（显示层 blob）/ 无字原图。 */
function currentSrc(state: ComicState): string {
  return state.showBubbles && state.current ? state.current.url : state.ctx.baseSrc;
}

/** 渲染（幂等）：图、chip、面板、caption 全部按当前状态重建。 */
function render(
  state: ComicState,
  img: HTMLImageElement,
  caption: HTMLElement,
  chips: HTMLElement,
  panel: HTMLElement,
): void {
  // —— 图 ——
  const token = ++state.token;
  if (state.current) { state.current.revoke(); state.current = null; }
  if (!state.showBubbles) {
    img.src = state.ctx.baseSrc;
  } else {
    img.src = state.ctx.baseSrc; // 先显示无字原图，合成好了再换（不白屏）
    void (async () => {
      const result: BubbleCompositeResult | null = await compositeDialogue(
        state.ctx.baseSrc, state.draft, state.ctx.plan.opts,
      );
      if (token !== state.token) { result?.revoke(); return; }
      if (!result) return; // 合成失败：保持无字原图，不升级成错误（坑 11）
      state.current = result;
      img.src = result.url;
    })();
  }

  // —— caption ——
  caption.textContent = state.moving
    ? `移动气泡：正在移动第 ${state.moveIndex + 1} 句——点击图上位置把它钉住`
    : (state.ctx.caption ?? '');

  // —— chips（移动模式） ——
  chips.innerHTML = '';
  chips.style.display = state.moving ? 'flex' : 'none';
  if (state.moving) {
    const hint = document.createElement('span');
    hint.className = 'sti-lb-chip-hint';
    hint.textContent = '选择要挪的台词：';
    chips.appendChild(hint);
    state.draft.forEach((item, index) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'sti-lb-chip' + (index === state.moveIndex ? ' is-on' : '') + (typeof item.x === 'number' ? ' is-done' : '');
      chip.textContent = truncate(item.text, 12);
      chip.addEventListener('click', event => {
        event.stopPropagation();
        state.moveIndex = index;
        render(state, img, caption, chips, panel);
      });
      chips.appendChild(chip);
    });
  }

  // —— 台词编辑面板 ——
  panel.innerHTML = '';
  panel.style.display = state.editing ? 'flex' : 'none';
  if (!state.editing) return;

  const head = document.createElement('div');
  head.className = 'sti-lb-dlg__head';
  const name = document.createElement('div');
  name.className = 'sti-lb-dlg__name';
  name.textContent = '台词（最多 4 条，每条 60 字内）';
  head.appendChild(name);
  const closePanel = document.createElement('button');
  closePanel.type = 'button';
  closePanel.className = 'sti-lb-dlg__x';
  closePanel.textContent = '×';
  closePanel.addEventListener('click', () => {
    state.editing = false;
    render(state, img, caption, chips, panel);
  });
  head.appendChild(closePanel);
  panel.appendChild(head);

  const list = document.createElement('div');
  list.className = 'sti-lb-dlg__list';
  state.draft.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'sti-lb-dlg__row';
    const no = document.createElement('span');
    no.className = 'sti-lb-dlg__no';
    no.textContent = String(index + 1);
    const text = document.createElement('input');
    text.type = 'text';
    text.className = 'sti-lb-dlg__text';
    text.value = item.text;
    text.maxLength = 60;
    text.addEventListener('input', () => { item.text = text.value; });
    text.addEventListener('click', e => e.stopPropagation());
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'sti-lb-dlg__del';
    del.textContent = '−';
    del.title = '删除这一条';
    del.addEventListener('click', () => {
      state.draft.splice(index, 1);
      if (state.moveIndex >= state.draft.length) state.moveIndex = Math.max(0, state.draft.length - 1);
      render(state, img, caption, chips, panel);
    });
    row.append(no, text, del);
    list.appendChild(row);
  });
  panel.appendChild(list);

  const actions = document.createElement('div');
  actions.className = 'sti-lb-dlg__actions';
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'sti-lb-dlg__btn';
  add.textContent = '加一条';
  add.disabled = state.draft.length >= 4;
  add.addEventListener('click', () => {
    state.draft.push({ text: '' });
    render(state, img, caption, chips, panel);
  });
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'sti-lb-dlg__btn sti-lb-dlg__btn--main';
  save.textContent = '保存';
  save.addEventListener('click', event => {
    event.stopPropagation();
    void (async () => {
      await persist(state);
      state.editing = false;
      render(state, img, caption, chips, panel);
    })();
  });
  actions.append(add, save);
  panel.appendChild(actions);
}

/** 下载当前显示的版本。合成时自建独立 blob，不复用显示层的引用（坑 10）。 */
async function downloadCurrent(state: ComicState): Promise<void> {
  const src = currentSrc(state);
  try {
    const blob = await (await fetch(src)).blob();
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = `comic_${Date.now().toString(36)}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch { /* 下载失败不打断浏览 */ }
}

function truncate(text: string, max: number): string {
  const clean = text.trim() || '（空）';
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export function closeLightboxAll(): void {
  closeLightbox();
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
