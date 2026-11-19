/**
 * ST-Story-Illustrator — 小剧场楼层卡片
 *
 * 三套（QQ 人状态栏 / 彩蛋 / 黑白漫）共用一套卡片：
 *   头部 = 缩略图 + 类型角标 + 标题 + 折叠箭头
 *   主体 = 多格横排（每格左上 n/N 角标、右下重画按钮、图下短标题）
 *          或 单格「图 + 右侧标题/角色/情绪/台词」
 *   底部 = 角色 · 情绪标签 · 整条重出 · 逐格看大图 · 删除
 *
 * 数据全部来自 message.extra.sti_theater（见 store.ts），渲染一律 textContent，
 * 不把模型输出当 HTML 注入。
 */

import type { BbiStatusInfo, StoryKind } from '../types';
import { getStories, getSets, removeSet, type TheaterSet } from './store';
import { rerollPanel, rerollSet } from './reroll';
import { openGallery, openLightbox } from '../ui/lightbox';
import { saveChatSafe } from '../host/sillytavern';

const AREA_ID = 'sti-theater-area-';
const AREA_CLASS = 'sti-cs-bar';
const MOUNTED_ATTR = 'data-sti-theater-mounted';

const BUCKET_LABELS: Record<StoryKind, string> = {
  status: 'Q 版小剧场',
  bonus: '彩蛋时刻',
  manga: '黑白漫',
};

const KIND_ORDER: StoryKind[] = ['status', 'bonus', 'manga'];

// ============================================================
// 挂载
// ============================================================

/** 重挂某楼层的小剧场卡片。 */
export function mountTheater(floor: number): void {
  const mes = document.querySelector<HTMLElement>(`.mes[mesid="${floor}"]`);
  if (!mes) return;
  unmountTheater(floor);

  const groups: Array<{ kind: StoryKind; set: TheaterSet }> = [];
  for (const kind of KIND_ORDER) {
    for (const set of getSets(floor, kind)) groups.push({ kind, set });
  }
  if (groups.length === 0) return;

  const mesBlock = mes.querySelector<HTMLElement>('.mes_block') ?? mes;
  const area = document.createElement('div');
  area.id = `${AREA_ID}${floor}`;
  area.className = AREA_CLASS;
  area.setAttribute(MOUNTED_ATTR, String(floor));

  for (const { kind, set } of groups) {
    area.appendChild(buildCard(floor, kind, set));
  }
  mesBlock.appendChild(area);
}

export function unmountTheater(floor: number): void {
  const mes = document.querySelector<HTMLElement>(`.mes[mesid="${floor}"]`);
  if (!mes) return;
  const areas = mes.querySelectorAll(`[${MOUNTED_ATTR}="${floor}"]`);
  for (const area of Array.from(areas)) area.remove();
}

/** 重挂所有已渲染楼层的卡片（切换聊天 / 刷新后）。 */
export function remountAllTheater(): void {
  const nodes = document.querySelectorAll<HTMLElement>('.mes[mesid]');
  for (const node of Array.from(nodes)) {
    const floor = parseInt(node.getAttribute('mesid') ?? '', 10);
    if (Number.isFinite(floor)) {
      try { mountTheater(floor); } catch { /* 单楼失败不影响其它楼层 */ }
    }
  }
}

// ============================================================
// 卡片
// ============================================================

function buildCard(floor: number, kind: StoryKind, set: TheaterSet): HTMLElement {
  const card = document.createElement('details');
  card.className = 'sti-cs-card';
  card.open = true;
  card.setAttribute('data-sti-set', `${kind}:${set.setId}`);

  const total = set.panels.length;
  const cover = firstImage(set.panels);

  // ── 头部 ──
  const summary = document.createElement('summary');
  summary.className = 'sti-cs-summary';

  if (cover) {
    const thumb = document.createElement('img');
    thumb.className = 'sti-cs-thumb';
    thumb.src = cover;
    thumb.alt = '';
    thumb.loading = 'lazy';
    summary.appendChild(thumb);
  }

  const kicker = document.createElement('span');
  kicker.className = 'sti-cs-kicker';
  kicker.textContent = kind === 'bonus'
    ? BUCKET_LABELS.bonus
    : `${BUCKET_LABELS[kind]} · ${total} 格`;
  summary.appendChild(kicker);

  const headline = document.createElement('span');
  headline.className = 'sti-cs-headline';
  headline.textContent = set.title || '小剧场';
  summary.appendChild(headline);

  const chevron = document.createElement('i');
  chevron.className = 'fa-solid fa-chevron-down sti-cs-chevron';
  summary.appendChild(chevron);
  card.appendChild(summary);

  // ── 主体 ──
  const single = total === 1 && (set.panels[0].lines?.length ?? 0) > 0;
  const body = document.createElement('div');
  body.className = single ? 'sti-cs-body is-story' : 'sti-cs-body';

  if (single) {
    body.appendChild(buildSinglePanel(floor, kind, set, set.panels[0]));
  } else {
    const strip = document.createElement('div');
    strip.className = 'sti-cs-strip';
    for (const panel of set.panels) {
      strip.appendChild(buildStripPanel(floor, kind, set, panel, total));
    }
    body.appendChild(strip);
  }

  body.appendChild(buildFoot(floor, kind, set, total));
  card.appendChild(body);
  return card;
}

/** 多格横排里的一格：图（角标 + 重画）+ 图下短标题。 */
function buildStripPanel(
  floor: number,
  kind: StoryKind,
  set: TheaterSet,
  panel: BbiStatusInfo,
  total: number,
): HTMLElement {
  const figure = document.createElement('figure');
  figure.className = 'sti-cs-panel';

  const shot = document.createElement('div');
  shot.className = 'sti-cs-shot';

  const cell = document.createElement('div');
  cell.className = 'sti-cs-cell';
  cell.tabIndex = 0;
  cell.setAttribute('role', 'button');

  if (panel.imagePath) {
    const img = document.createElement('img');
    img.className = 'sti-cs-cell-img';
    img.src = panel.imagePath;
    img.alt = panel.title ?? `第 ${panel.index + 1} 格`;
    img.loading = 'lazy';
    cell.appendChild(img);
    cell.addEventListener('click', () => openPanel(set, panel));
    cell.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openPanel(set, panel);
      }
    });
  } else {
    const ph = document.createElement('div');
    ph.className = 'sti-cs-placeholder';
    ph.textContent = '未出图';
    cell.appendChild(ph);
  }

  const num = document.createElement('span');
  num.className = 'sti-cs-num';
  num.textContent = `${panel.index + 1}/${total}`;
  cell.appendChild(num);
  shot.appendChild(cell);

  shot.appendChild(buildRerollButton(floor, kind, set, panel));
  figure.appendChild(shot);

  const cap = document.createElement('figcaption');
  cap.className = 'sti-cs-panel-cap';
  cap.textContent = panel.title ?? '';
  figure.appendChild(cap);

  return figure;
}

/** 单格卡片：左边图，右边标题/角色/情绪/台词。 */
function buildSinglePanel(
  floor: number,
  kind: StoryKind,
  set: TheaterSet,
  panel: BbiStatusInfo,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'sti-cs-single';

  const shot = document.createElement('div');
  shot.className = 'sti-cs-shot is-figure';

  const figure = document.createElement('div');
  figure.className = 'sti-cs-cell';
  figure.tabIndex = 0;
  figure.setAttribute('role', 'button');
  if (panel.imagePath) {
    const img = document.createElement('img');
    img.className = 'sti-cs-photo';
    img.src = panel.imagePath;
    img.alt = panel.title ?? '小剧场';
    img.loading = 'lazy';
    figure.appendChild(img);
    figure.addEventListener('click', () => openPanel(set, panel));
  }
  shot.appendChild(figure);
  shot.appendChild(buildRerollButton(floor, kind, set, panel));
  row.appendChild(shot);

  const meta = document.createElement('div');
  meta.className = 'sti-cs-meta';

  const title = document.createElement('div');
  title.className = 'sti-cs-caption';
  title.textContent = panel.title || set.title || '小剧场';
  meta.appendChild(title);

  const sub = document.createElement('div');
  sub.className = 'sti-cs-cast';
  sub.textContent = (panel.cast ?? []).join(' · ');
  if (panel.mood) {
    const chip = document.createElement('span');
    chip.className = 'sti-cs-chip';
    chip.textContent = panel.mood;
    sub.appendChild(chip);
  }
  if (sub.textContent) meta.appendChild(sub);

  const lines = document.createElement('div');
  lines.className = 'sti-cs-lines';
  for (const line of panel.lines ?? []) {
    const rowEl = document.createElement('div');
    rowEl.className = line.speaker === '旁白' || !line.speaker ? 'sti-cs-line is-narr' : 'sti-cs-line';
    if (line.speaker && line.speaker !== '旁白') {
      const b = document.createElement('b');
      b.textContent = `${line.speaker}：`;
      rowEl.appendChild(b);
    }
    rowEl.appendChild(document.createTextNode(line.text));
    lines.appendChild(rowEl);
  }
  if (lines.childElementCount > 0) meta.appendChild(lines);

  row.appendChild(meta);
  return row;
}

/** 底部：角色、情绪、整条重出、逐格看大图、删除。 */
function buildFoot(floor: number, kind: StoryKind, set: TheaterSet, total: number): HTMLElement {
  const foot = document.createElement('div');
  foot.className = 'sti-cs-foot';

  if (set.cast.length > 0) {
    const cast = document.createElement('span');
    cast.className = 'sti-cs-cast';
    cast.textContent = set.cast.join(' · ');
    foot.appendChild(cast);
  }
  if (set.mood) {
    const chip = document.createElement('span');
    chip.className = 'sti-cs-chip';
    chip.textContent = set.mood;
    foot.appendChild(chip);
  }

  const spacer = document.createElement('span');
  spacer.className = 'sti-cs-spacer';
  foot.appendChild(spacer);

  const reroll = document.createElement('button');
  reroll.type = 'button';
  reroll.className = 'sti-cs-regen';
  reroll.textContent = '整条重出';
  reroll.addEventListener('click', async () => {
    await runBusy(reroll, '重出中…', async () => {
      const result = await rerollSet(floor, kind, set.setId);
      if (!result.ok) throw new Error(result.message ?? '整条重出失败。');
      mountTheater(floor);
    });
  });
  foot.appendChild(reroll);

  if (set.panels.some(p => !!p.imagePath)) {
    const gallery = document.createElement('button');
    gallery.type = 'button';
    gallery.className = 'sti-cs-link';
    gallery.textContent = '逐格看大图';
    gallery.addEventListener('click', () => {
      openGallery(
        set.panels
          .filter(p => !!p.imagePath)
          .map(p => ({ src: p.imagePath!, caption: p.title ?? '' })),
      );
    });
    foot.appendChild(gallery);
  }

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'sti-cs-link danger';
  del.textContent = '删除';
  del.addEventListener('click', async () => {
    removeSet(floor, kind, set.setId);
    await saveChatSafe();
    mountTheater(floor);
  });
  foot.appendChild(del);

  return foot;
}

/** 单格重画按钮（右下圆形 ↻）。 */
function buildRerollButton(
  floor: number,
  kind: StoryKind,
  set: TheaterSet,
  panel: BbiStatusInfo,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sti-cs-reroll';
  btn.title = '重画这张';
  btn.setAttribute('aria-label', '重画这张');
  btn.textContent = '↻';
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await runBusy(btn, '…', async () => {
      const result = await rerollPanel(floor, kind, set.setId, panel.index);
      if (!result.ok) throw new Error(result.message ?? '重画失败。');
      mountTheater(floor);
    });
  });
  return btn;
}

/** 点开单格：同一张卡片里的图可以左右翻。 */
function openPanel(set: TheaterSet, panel: BbiStatusInfo): void {
  const images = set.panels.filter(p => !!p.imagePath).map(p => ({ src: p.imagePath!, caption: p.title ?? '' }));
  if (images.length <= 1) {
    if (panel.imagePath) openLightbox(panel.imagePath, panel.title);
    return;
  }
  const at = images.findIndex(i => i.src === panel.imagePath);
  openGallery(images, at < 0 ? 0 : at);
}

/** 按钮忙碌态 + 失败提示。 */
async function runBusy(btn: HTMLButtonElement, busyText: string, task: () => Promise<void>): Promise<void> {
  const label = btn.textContent ?? '';
  btn.disabled = true;
  btn.textContent = busyText;
  btn.classList.add('is-busy');
  try {
    await task();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    notify(message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
    btn.classList.remove('is-busy');
  }
}

function notify(message: string, level: 'info' | 'error'): void {
  const toastr = (window as unknown as { toastr?: Record<string, (m: string) => void> }).toastr;
  if (toastr) {
    if (level === 'error') toastr.error?.(message);
    else toastr.info?.(message);
  } else if (level === 'error') {
    console.error('[ST-Story-Illustrator]', message);
  } else {
    console.info('[ST-Story-Illustrator]', message);
  }
}

function firstImage(panels: BbiStatusInfo[]): string | undefined {
  return panels.find(p => !!p.imagePath)?.imagePath;
}

/** 调试用：某楼层小剧场卡片数量。 */
export function getTheaterCardCount(floor: number): number {
  const mes = document.querySelector<HTMLElement>(`.mes[mesid="${floor}"]`);
  if (!mes) return 0;
  return mes.querySelectorAll('.sti-cs-card').length;
}

export { getStories };
