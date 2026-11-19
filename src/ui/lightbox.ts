/**
 * ST-Story-Illustrator — 图片放大查看（Lightbox）
 *
 * 2026-11-19 修订：外观与交互对齐柏宝绘原版灯箱——
 * - 深色毛玻璃全屏遮罩，图片居中，右上角**图标工具栏**（下载 / 气泡 / 台词 / 移动 / 关闭）；
 * - 图下不再放任何文字行（那行 caption 是用户点名的「多出来一行字」）；
 * - 「气泡」开关：带字 / 无字一键切换（合成失败自动退回无字原图，坑 11）；
 * - 「台词」面板：增删改台词，保存写回 artifact.dialogue，零额度重合成；
 * - 「移动气泡」：选中某一句 → 点击图上位置 → 原地钉死（手动位置不参与自动排版）；
 * - 「下载」：走 saveImageFile（canvas 重编码，相对路径/跨域都能存）——
 *   旧实现 fetch URL 在柏宝绘相对路径/跨域图上静默失败，症状就是「点了没反应」。
 *
 * 性能纪律：图只在「带字状态或台词草稿变化」时才重合成；开关台词面板、
 * 选中 chip 这类纯 UI 操作不触发 canvas（旧实现每次 render 都重画一遍 = 闪屏）。
 */
import type { ComicDialogue } from '../types';
import type { PanelDialogueItem, PlanOptions } from '../manga/bubbleTypes';
import { compositeDialogue } from '../manga/bubbleComposite';
import { normalizeDialogueEdits } from '../manga/bubbleOverlay';
import { saveImageFile } from './saveImage';

let overlay: HTMLElement | null = null;

/** 打开大图。imageUrl 可以是原图或带字合成图。 */
export function openLightbox(imageUrl: string, caption?: string): void {
  ensureOverlay();
  if (!overlay) return;
  overlay.innerHTML = '';
  overlay.classList.remove('is-comic');

  const img = document.createElement('img');
  img.className = 'sti-lightbox-img';
  img.src = imageUrl;
  img.alt = caption ?? '图片';
  overlay.appendChild(img);

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
  /** 打开时的排版参数（bubbleOverlay.comicOverlayPlan 的产物）。 */
  plan: ComicLightboxPlan;
  /**
   * 保存台词（含手动位置）。实现方写回 artifact.dialogue、落盘、重挂卡片，
   * 并返回保存后的最新排版参数（数据可能被别处改过，以返回值为准）。
   */
  onSave: (items: ComicDialogue[] | undefined) => Promise<ComicLightboxPlan | null>;
  /** 点「改词」：实现方退出灯箱并打开改词面板（重画完成后卡片自己换图）。 */
  onEditPrompt?: () => void;
}

/** 单开一层的状态（每次 open 重建，闭包天然隔离）。 */
interface ComicState {
  ctx: ComicLightboxContext;
  showBubbles: boolean;
  editing: boolean;
  moving: boolean;
  moveIndex: number;
  draft: PanelDialogueItem[];
  /** 图的合成代次：只有图的输入变了才 ++，UI 状态变化不碰它 */
  imgToken: number;
  /** 保存代次：连点几次移动时，只认最后一次的结果，避免旧快照把新位置盖回去 */
  saveToken: number;
  current: { url: string; revoke: () => void } | null;
}

/** 打开漫画灯箱。plan 为空（无台词）时直接走普通大图。 */
export function openComicLightbox(ctx: ComicLightboxContext): void {
  if (!ctx.plan.items.length) {
    openLightbox(ctx.baseSrc);
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
    imgToken: 0,
    saveToken: 0,
    current: null,
  };

  // —— 右上角图标工具栏（柏宝绘同款：细线 SVG、圆角胶囊按钮）——
  const bar = document.createElement('div');
  bar.className = 'sti-lb-bar';
  bar.addEventListener('click', e => e.stopPropagation());
  overlay.appendChild(bar);

  const downloadBtn = iconButton('download', '下载当前版本（带字 / 无字跟随开关）');
  downloadBtn.addEventListener('click', () => {
    void saveImageFile(
      state.showBubbles && state.current ? state.current.url : ctx.baseSrc,
      `comic_${Date.now().toString(36)}.png`,
    );
  });
  bar.appendChild(downloadBtn);

  // 改词（柏宝绘楼层卡上的「编辑提示词」等价物）：退出大图、开改词面板
  if (ctx.onEditPrompt) {
    const promptBtn = iconButton('prompt', '改提示词并重画这一页');
    promptBtn.addEventListener('click', () => ctx.onEditPrompt?.());
    bar.appendChild(promptBtn);
  }

  const bubbleBtn = iconButton('bubble', '带字 / 无字切换（合成失败自动退回无字原图）');
  bubbleBtn.classList.add('is-on');
  bubbleBtn.addEventListener('click', () => {
    state.showBubbles = !state.showBubbles;
    bubbleBtn.classList.toggle('is-on', state.showBubbles);
    syncMoveTools();
    refreshImage(state, img);
  });
  bar.appendChild(bubbleBtn);

  const editBtn = iconButton('edit', '编辑台词：增删改后保存，立即重合成（不消耗出图额度）');
  editBtn.addEventListener('click', () => {
    state.editing = !state.editing;
    if (state.editing) state.moving = false;
    editBtn.classList.toggle('is-on', state.editing);
    syncMoveTools();
    renderBottom();
    renderPanel();
  });
  bar.appendChild(editBtn);

  const moveBtn = iconButton('move', '选中一句台词，再点击图上位置把它钉在那里（不被自动排版挪动）');
  moveBtn.addEventListener('click', () => {
    state.moving = !state.moving;
    if (state.moving) state.editing = false;
    moveBtn.classList.toggle('is-on', state.moving);
    editBtn.classList.toggle('is-on', state.editing);
    syncMoveTools();
    renderBottom();
    renderPanel();
  });
  bar.appendChild(moveBtn);

  const close = iconButton('close', '关闭 (Esc)');
  close.addEventListener('click', closeLightbox);
  bar.appendChild(close);

  // 移动模式下，气泡关闭时移动没有意义：三个工具联动置灰
  function syncMoveTools(): void {
    const disabled = !state.showBubbles;
    editBtn.disabled = disabled;
    moveBtn.disabled = disabled;
    if (disabled) { state.moving = false; state.editing = false; }
  }

  // —— 图片舞台 ——
  const stage = document.createElement('div');
  stage.className = 'sti-lb-stage';
  overlay.appendChild(stage);

  const img = document.createElement('img');
  img.className = 'sti-lightbox-img';
  img.alt = '漫画页';
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
    void persist(state, img);
    renderBottom();
  });

  // —— 底部条：移动模式的台词选择（编辑面板打开时隐藏）——
  const bottom = document.createElement('div');
  bottom.className = 'sti-lb-bottom';
  bottom.addEventListener('click', e => e.stopPropagation());
  overlay.appendChild(bottom);

  // —— 台词编辑面板（柏宝绘式居中浮层）——
  const panel = document.createElement('div');
  panel.className = 'sti-lb-dlg';
  panel.addEventListener('click', e => e.stopPropagation());
  overlay.appendChild(panel);

  function renderBottom(): void {
    bottom.innerHTML = '';
    bottom.style.display = state.moving && !state.editing ? 'flex' : 'none';
    if (bottom.style.display === 'none') return;
    const hint = document.createElement('span');
    hint.className = 'sti-lb-hint';
    hint.textContent = '点击台词选中，再点图上位置钉住：';
    bottom.appendChild(hint);
    state.draft.forEach((item, index) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'sti-lb-chip' + (index === state.moveIndex ? ' is-on' : '') + (typeof item.x === 'number' ? ' is-done' : '');
      chip.textContent = truncate(item.text, 12);
      chip.addEventListener('click', event => {
        event.stopPropagation();
        state.moveIndex = index;
        renderBottom();
      });
      bottom.appendChild(chip);
    });
  }

  function renderPanel(): void {
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
      editBtn.classList.remove('is-on');
      renderPanel();
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
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'sti-lb-dlg__del';
      del.textContent = '−';
      del.title = '删除这一条';
      del.addEventListener('click', () => {
        state.draft.splice(index, 1);
        if (state.moveIndex >= state.draft.length) state.moveIndex = Math.max(0, state.draft.length - 1);
        renderPanel();
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
      renderPanel();
    });
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'sti-lb-dlg__btn sti-lb-dlg__btn--main';
    save.textContent = '保存并重合成';
    save.addEventListener('click', () => {
      void (async () => {
        await persist(state, img);
        state.editing = false;
        editBtn.classList.remove('is-on');
        renderPanel();
      })();
    });
    actions.append(add, save);
    panel.appendChild(actions);
  }

  overlay.style.display = 'flex';
  overlay.onclick = (e) => { if (e.target === overlay) closeLightbox(); };

  syncMoveTools();
  renderBottom();
  renderPanel();
  refreshImage(state, img);
}

/** 细线 SVG 图标按钮（与柏宝绘 bbi-lb-btn 同款风格）。 */
function iconButton(
  icon: 'download' | 'bubble' | 'edit' | 'move' | 'close' | 'prompt',
  title: string,
): HTMLButtonElement {
  const paths: Record<string, string> = {
    download: '<path d="M12 4v11m0 0 4.5-4.5M12 15l-4.5-4.5M5 19h14"/>',
    bubble: '<path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-4 4V6z"/>',
    edit: '<path d="M4 20h4L20 8l-4-4L4 16v4zM14 6l4 4"/>',
    prompt: '<path d="M4 6h16M4 12h10M4 18h7"/><path d="M18 12l2 2-5 5h-2v-2l5-5z"/>',
    move: '<path d="M12 3v18M3 12h18M12 3l-2.5 2.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
  };
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sti-lb-btn';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.innerHTML =
    `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" ` +
    `stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[icon]}</svg>`;
  return btn;
}

/**
 * 应用草稿 → 立即重合成上屏 → 保存放后台。
 *
 * 关键顺序（旧实现的坑）：以前先 `await onSave()` 再重画，而 onSave 要过保存队列
 * （合并窗口 1.5s），于是「点一下图上的位置，两秒内什么都没发生」——
 * 用户以为移动功能坏了。现在本地草稿就是唯一真相：先按新位置画出来，
 * 落盘在后台跑；连续拖动时只认最后一次（saveToken）。
 */
async function persist(state: ComicState, img: HTMLImageElement): Promise<void> {
  const token = ++state.saveToken;
  refreshImage(state, img); // 立即上屏，不等存盘
  const draft = normalizeDialogueEdits(state.draft);
  const saved = await state.ctx.onSave(draft);
  if (token !== state.saveToken) return; // 期间又改过：以更新的草稿为准，别回滚
  if (!saved) return;
  // 只更新排版参数（格位/禁区可能被重算），**不回写草稿**：
  // 回写会把用户正在拖的那一条位置打回上一次保存的状态。
  state.ctx.plan = { items: state.ctx.plan.items, opts: saved.opts };
}

/**
 * 按当前状态刷新图。只在「带字开关或台词草稿变化」时重合成；
 * UI 状态（面板开关、chip 选中）不进入这里——旧实现每次 render 都 revoke + 重画，
 * 灯箱里点几下按钮图就跟着闪几下，就是它。
 */
function refreshImage(state: ComicState, img: HTMLImageElement): void {
  const token = ++state.imgToken;
  if (!state.showBubbles) {
    state.current?.revoke();
    state.current = null;
    img.src = state.ctx.baseSrc;
    return;
  }
  // 已经有带字图时**不要**先退回无字原图：等新的合成好了直接换，
  // 否则每挪一次气泡，画面都要闪一下（用户说的「一闪一闪」）。
  if (!state.current) img.src = state.ctx.baseSrc;
  void (async () => {
    const result = await compositeDialogue(state.ctx.baseSrc, state.draft, state.ctx.plan.opts);
    if (token !== state.imgToken) { result?.revoke(); return; }
    if (!result) return; // 合成失败：保持当前画面，不升级成错误（坑 11）
    state.current?.revoke();
    state.current = result;
    img.src = result.url;
  })();
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
