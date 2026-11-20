/**
 * ST-Story-Illustrator — 楼层作品卡片挂载
 *
 * 从 message.extra 读取 VisualArtifact，按 mountMode 挂载：
 * - inline：插入正文流中对应选段位置（anchorFloor + textAnchor 定位；失败降级到底部）
 * - trailing：挂载在楼层 .mes_block 末尾独立区域
 *
 * 不写 <bbi_image> 到正文（数据上不污染），只在 DOM 层插入卡片。
 * 渲染用 textContent，绝不把模型输出当 HTML 注入（SPEC §17）。
 */

import type { VisualArtifact, CreationMode } from '../types';
import { DEFAULT_SETTINGS } from '../types';
import { getArtifacts, removeArtifact, updateArtifact } from '../storage/repository';
import { belongsToSwipe } from '../storage/swipeScope';
import { getMessage, getSettings, getSwipeId, getSwipeCount, saveChatSafe } from '../host/sillytavern';
import { buildManwaTag, manwaAnchors, parseManwaTags, removeManwaTag } from '../baibai/manwaTag';
import { extractPlainText, findAnchorRange } from '../selection/anchor';
import { comicOverlayPlan, comicBaseImageOf } from '../manga/bubbleOverlay';
import { compositeDialogue } from '../manga/bubbleComposite';
import { openLightbox, openComicLightbox, closeLightbox } from './lightbox';
import { rerollComicPage } from '../manga/rerollPage';
import { saveImageFile } from './saveImage';
import { openPromptDialog } from './promptDialog';
import { confirmDialog } from './confirm';

const INLINE_CLASS = 'sti-inline-card';
const TRAILING_AREA_CLASS = 'sti-trailing-area';
const TRAILING_AREA_ID = 'sti-trailing-area-';
const MOUNTED_ATTR = 'data-sti-mounted';

/**
 * 漫画卡片的气泡合成句柄（显示层持有 blob，卡片被拆掉时释放）。
 *
 * 与原版同款的三条纪律：
 * - 卡片 <img> 永远先指向无字原图，合成成功后才换成带字 blob；
 * - 合成失败保持无字原图，不升级成错误（原版坑 11）；
 * - 同一张卡重复合成前先 revoke 旧 blob，避免内存泄漏。
 */
const cardOverlays = new WeakMap<HTMLElement, { revoke: () => void }>();

function revokeCardOverlay(card: HTMLElement): void {
  cardOverlays.get(card)?.revoke();
  cardOverlays.delete(card);
}

const MODE_LABELS: Record<CreationMode, string> = {
  'illustration': '插画',
  'comic': '漫画分镜',
  'chibi-status': 'QQ人状态',
  'chibi-bonus': 'QQ人彩蛋',
  'bw-manga': '黑白漫',
};

// ============================================================
// 挂载入口
// ============================================================

/**
 * 重挂单个楼层的所有作品卡片。
 *
 * **增量挂载**：先算出这一楼「应该出现在 DOM 里」的 artifact 集合，只拆多余的、
 * 补缺失的、换过期的，绝不把还正确的卡拆掉重建——以前的「先 unmountFloor 再全挂」
 * 会被对账循环放大成闪屏（对账每 250ms 发现凑不齐 → 全拆重建 → 图片重新加载 → 又触发对账）。
 */
/**
 * 一条作品在当前正文下该不该显示（纯函数，便于单测）。
 *
 * 行内漫画的「锚点」就是正文里那一条 `<bbi_manwa>`：
 * tag 不在了 = 这一页已被移出正文（用户手动删掉，或走删除键），不该再显示。
 * 只有显式标过 `inlineFallback` 的老数据（上线前没写 tag 的那批）才能无锚点行内插入。
 * trailing 作品本来就不在正文里（挂在楼末），照常显示。
 */
export function isArtifactVisible(
  artifact: Pick<VisualArtifact, 'id' | 'mountMode' | 'metadata'>,
  tagIds: ReadonlySet<string>,
): boolean {
  if (artifact.mountMode === 'inline') {
    if (tagIds.has(artifact.id)) return true;
    return artifact.metadata?.inlineFallback === true;
  }
  return true;
}

export function mountFloor(floor: number): void {
  const mes = document.querySelector<HTMLElement>(`.mes[mesid="${floor}"]`);
  if (!mes) return;

  // 楼层身份：`message.extra` 不随 swipe 重置，必须自己把作品和当前 swipe 对齐，
  // 否则 swipe 出新正文后上一版画好的漫画仍然挂在新正文上（旧图残留）。
  const currentSwipe = getSwipeId(floor);
  const refs = parseManwaTags(getMessage(floor)?.mes ?? '');
  const tagged = refs.length > 0;
  const scope = {
    currentSwipe,
    taggedIds: new Set(refs.map(ref => ref.id)),
    swipeCount: getSwipeCount(floor),
  };

  const visible = getArtifacts(floor)
    .filter(a => a.metadata?.embeddedInBody !== true)
    .filter(a => belongsToSwipe(a, scope));
  const byId = new Map(visible.map(a => [a.id, a]));

  // 期望集合：与下方挂载规则一一对应，对账（ensureFloorMounted）也用它判断齐不齐
  //
  // 关键判定（用户实测过）：**行内漫画的锚点就是正文里的 `<bbi_manwa>` tag**。
  // 以前这里写成「没有 tag 时把所有 inline 作品都算进 expected」，等于只要
  // `message.extra` 里还有数据就永远显示——于是把正文里的 tag 删掉后，
  // 卡片照样挂着，刷新、重进聊天都还在（extra 不随正文编辑重置）。
  // 现在：inline 作品必须能在正文里找到自己的 tag 才显示；只有显式标过
  // `inlineFallback` 的老卡（上线前就没写过 tag 的那批）才允许无锚点行内插入。
  const expected = new Set<string>();
  const tagIds = new Set(refs.map(ref => ref.id));
  for (const artifact of visible) {
    if (!isArtifactVisible(artifact, tagIds)) continue;
    expected.add(artifact.id);
  }

  // ── 拆：不在期望集合里的（swipe 切换后残留的旧页等）──
  for (const node of Array.from(mes.querySelectorAll<HTMLElement>(`[${MOUNTED_ATTR}="${floor}"]`))) {
    if (node.classList.contains(TRAILING_AREA_CLASS)) continue; // 容器单独处理
    const id = node.getAttribute('data-sti-artifact-id') ?? '';
    const artifact = byId.get(id);
    const stale = !expected.has(id)
      // 图换过（重画成功）：内容过期，整卡重建
      || (artifact && node.getAttribute('data-sti-src') !== artifact.imagePath);
    if (stale) {
      revokeCardOverlay(node);
      node.remove();
    }
  }

  // ── 补 ──
  const missing = (id: string): VisualArtifact | undefined => {
    if (!expected.has(id)) return undefined;
    if (mes.querySelector(`[data-sti-artifact-id="${id}"]`)) return undefined; // 已在 DOM，别动它（动了就闪）
    return byId.get(id);
  };

  // 漫画页一律走 `<bbi_manwa>` 锚点：位置由正文里的 tag 决定，刷新后正则重建锚点、
  // 卡片跟着回来。只有**上线前生成的老卡**（正文里一条漫画 tag 都没有）才退回旧的行内插入。
  let anchored = 0;
  if (tagged) {
    const anchors = manwaAnchors(floor);
    const count = Math.min(anchors.length, refs.length);
    for (let i = 0; i < count; i += 1) {
      const artifact = missing(refs[i].id);
      if (!artifact) continue; // 锚点在、数据不在：留空，不猜；已在 DOM 的也不重挂
      anchors[i].appendChild(buildCard(artifact, floor, true));
      anchored += 1;
    }
  }

  // 正文里的 tag 已经各自归位；行内挂载只服务「当时就没写进正文」的老卡
  // （新逻辑下 inline 作品没 tag 就不显示，所以这里只放行 inlineFallback。）
  for (const artifact of visible) {
    if (artifact.mountMode !== 'inline') continue;
    if (artifact.metadata?.inlineFallback !== true) continue;
    if (!missing(artifact.id)) continue;
    mountInline(mes, floor, artifact);
  }

  const trailing = visible.filter(a => a.mountMode !== 'inline' && missing(a.id));
  if (trailing.length > 0) mountTrailing(mes, floor, trailing);
  else {
    // 期望里没有 trailing 作品了：把空壳区域拆掉（删除作品后不留「ST 创作」空标题）
    const wantsTrailing = visible.some(a => a.mountMode !== 'inline' && expected.has(a.id));
    if (!wantsTrailing) {
      const area = mes.querySelector(`#${CSS.escape(`${TRAILING_AREA_ID}${floor}`)}`);
      if (area) area.remove();
    }
  }
}

/** 清理某楼层的所有本插件卡片。 */
export function unmountFloor(floor: number): void {
  const mes = document.querySelector<HTMLElement>(`.mes[mesid="${floor}"]`);
  if (!mes) return;
  const cards = mes.querySelectorAll(`[${MOUNTED_ATTR}="${floor}"]`);
  for (const card of Array.from(cards)) {
    revokeCardOverlay(card as HTMLElement); // 释放显示层持有的带字 blob
    card.remove();
  }
}

/** 重挂所有已渲染楼层的卡片（聊天切换 / swipe 后用）。 */
export function remountAll(): void {
  const nodes = document.querySelectorAll<HTMLElement>('.mes[mesid]');
  for (const node of Array.from(nodes)) {
    const floor = parseInt(node.getAttribute('mesid') ?? '', 10);
    if (Number.isFinite(floor)) mountFloor(floor);
  }
}

/**
 * 对账：这一楼该有的卡片在不在，缺了才补。
 *
 * 跑在 `#chat` 的 MutationObserver 上。`mountFloor` 已是**增量挂载**（只拆多余的、
 * 补缺失的，不重建还正确的卡），所以这里直接委托它即可——即使被观察器每 250ms
 * 调一次，也不会再出现「拆了又建、图片反复重载」的闪屏。
 */
export function ensureFloorMounted(floor: number): void {
  mountFloor(floor);
}

// ============================================================
// inline 挂载
// ============================================================

function mountInline(mes: HTMLElement, floor: number, artifact: VisualArtifact): void {
  const mesText = mes.querySelector<HTMLElement>('.mes_text');
  if (!mesText) return;
  const card = buildCard(artifact, floor, true);

  // 用 textAnchor 在正文里定位选段，插在**选段所在那一段之后**
  let inserted = false;
  if (artifact.textAnchor) {
    const block = locateAnchorBlock(mesText, artifact.textAnchor.selectedText);
    if (block) {
      insertAfterBlock(mesText, block, card);
      inserted = true;
    }
  }
  // 定位失败降级：追加到正文末尾
  if (!inserted) mesText.appendChild(card);
}

/** 可以承载卡片插入的块级元素（正文里的一行/一段）。 */
const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TR', 'PRE']);

/**
 * 在 .mes_text 里定位选段所在的块。
 *
 * 以前的 `textNode.includes(selectedText)` 有两个真实缺陷：
 * 1) 渲染后的文本与 `mes` 原文不同（Markdown 强调符不显示、引号被排版、空白数量不同），
 *    直接 includes 常常找不到 → 一路降级成「追加到本楼末尾」，用户看到的图就跑到最下面；
 * 2) 选区跨了多个节点（`*他笑了*` 这样中间夹一个 `<em>`）时，任何单个文本节点都不含完整选段。
 *
 * 这里把整段文本**拼起来**再配合 `findAnchorRange`（骨架归一化）找位置，最后映射回
 * 那个位置所在的块级元素——插在整段之后，视觉上就是「划线那一行的下面」。
 */
/**
 * 选段末尾落在第几个文本片段里（-1 = 没找到）。
 *
 * 抽成纯函数是为了能真测：正文被 `<em>` / `<strong>` 切成好几段时，任何单段都不含
 * 完整选段，必须先把片段拼起来再找。这一层不做 DOM，只吃字符串数组。
 */
export function pickTextSegment(segments: readonly string[], selectedText: string): number {
  const text = String(selectedText ?? '').trim();
  if (!text || !segments.length) return -1;
  let joined = '';
  const spans: Array<{ start: number; end: number }> = [];
  for (const seg of segments) {
    spans.push({ start: joined.length, end: joined.length + seg.length });
    joined += seg;
  }
  const range = findAnchorRange(joined, text);
  if (!range) return -1;
  const hit = spans.findIndex(s => range.end > s.start && range.end <= s.end);
  return hit >= 0 ? hit : spans.length - 1;
}

export function locateAnchorBlock(root: HTMLElement, selectedText: string): HTMLElement | null {
  const text = String(selectedText ?? '').trim();
  if (!text) return null;

  const nodes: Array<{ node: Text; text: string }> = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    // 跳过已经挂上的卡片（说明文字里可能含同样的字）与柏宝绘的 tag 区
    if (!parent || parent.closest(`[${MOUNTED_ATTR}]`) || parent.closest('bbi_image')) continue;
    const value = node.textContent ?? '';
    if (!value) continue;
    nodes.push({ node: node as Text, text: value });
  }
  if (!nodes.length) return null;

  const index = pickTextSegment(nodes.map(n => n.text), text);
  if (index < 0) return null;

  let block: HTMLElement = nodes[index].node.parentElement ?? root;
  // 往上找到「正文的一行/一段」：卡片是块级元素，插在行内会把这行劈成两半
  while (block.parentElement && block.parentElement !== root && !BLOCK_TAGS.has(block.tagName)) {
    block = block.parentElement;
  }
  return block;
}

/** 把卡片插在块之后；同一处已有卡片时排到它们后面（多页漫画保持阅读顺序）。 */
function insertAfterBlock(root: HTMLElement, block: HTMLElement, card: HTMLElement): void {
  let anchor: Element = block;
  while (anchor.nextElementSibling?.matches(`[${MOUNTED_ATTR}]`)) {
    anchor = anchor.nextElementSibling;
  }
  if (anchor === root.lastElementChild) root.appendChild(card);
  else root.insertBefore(card, anchor.nextSibling);
}

// ============================================================
// trailing 挂载
// ============================================================

function mountTrailing(mes: HTMLElement, floor: number, artifacts: VisualArtifact[]): void {
  const mesBlock = mes.querySelector<HTMLElement>('.mes_block') ?? mes;
  let area = mesBlock.querySelector<HTMLElement>(`#${TRAILING_AREA_ID}${floor}`);
  if (!area) {
    area = document.createElement('div');
    area.id = `${TRAILING_AREA_ID}${floor}`;
    area.className = TRAILING_AREA_CLASS;
    area.setAttribute(MOUNTED_ATTR, String(floor));
    const header = document.createElement('div');
    header.className = 'sti-trailing-header';
    header.textContent = 'ST 创作';
    area.appendChild(header);
    mesBlock.appendChild(area);
  }
  for (const artifact of artifacts) {
    area.appendChild(buildCard(artifact, floor, false));
  }
}

// ============================================================
// 卡片构建
// ============================================================

function buildCard(artifact: VisualArtifact, floor: number, inline: boolean): HTMLElement {
  const card = document.createElement('div');
  // 漫画卡单独一个类：它要长得像柏宝绘的楼层卡（图即卡片，无边框无底色）
  const comic = inline && artifact.mode === 'comic';
  card.className = [
    inline ? INLINE_CLASS : 'sti-floor-card',
    ...(comic ? ['is-comic'] : []),
  ].join(' ');
  card.setAttribute(MOUNTED_ATTR, String(floor));
  card.setAttribute('data-sti-artifact-id', artifact.id);
  card.setAttribute('data-sti-src', artifact.imagePath);

  const img = document.createElement('img');
  img.className = 'sti-card-image';
  // 永远先显示无字原图：气泡是显示层合成的（对齐柏宝绘原版架构），
  // artifact.imagePath 落盘的就是无字原图，图库里也只有这一份
  img.src = artifact.imagePath;
  img.alt = `${MODE_LABELS[artifact.mode] || artifact.mode} 作品`;
  img.loading = 'lazy';
  if (comic) {
    attachBubbleOverlay(card, img, artifact);
    img.addEventListener('click', () => openComicCardLightbox(floor, artifact.id, img.alt));
  } else {
    img.addEventListener('click', () => openLightbox(artifact.imagePath, img.alt));
  }
  card.appendChild(img);

  if (comic) {
    // 柏宝绘同款：操作收在图上的悬浮图标组（hover 淡显），图底下不放任何文字行
    card.appendChild(buildComicActions(artifact, floor));
  } else {
    const caption = document.createElement('div');
    caption.className = 'sti-card-caption';
    // 只显示简短自然语言描述，不再显示插画 tag / 模式标签（用户不想要那些 tag）
    caption.appendChild(document.createTextNode(artifact.nl ? artifact.nl.slice(0, 80) : ''));
    if (caption.textContent) card.appendChild(caption);
  }

  return card;
}

// ============================================================
// 漫画卡片操作（柏宝绘同款：右上角悬浮图标组）
// ============================================================

/** 内联 SVG 图标（与柏宝绘的 icon 风格一致：细线、24 视窗）。 */
function svgIcon(name: 'redraw' | 'download' | 'dialog' | 'edit' | 'trash'): string {
  const paths: Record<string, string> = {
    // 循环箭头（重绘）
    redraw: '<path d="M20 11a8 8 0 1 0-2.34 5.66M20 5v6h-6" fill="none"/>',
    // 下载
    download: '<path d="M12 4v11m0 0 4.5-4.5M12 15l-4.5-4.5M5 19h14" fill="none"/>',
    // 对话气泡（气泡 / 台词）
    dialog: '<path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-4 4V6z" fill="none"/>',
    // 铅笔（改提示词）
    edit: '<path d="M4 20h4L20 8l-4-4L4 16v4zM14 6l4 4" fill="none"/>',
    // 垃圾桶（删除这一页）
    trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M10 11v5M14 11v5" fill="none"/>',
  };
  return `<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}

/**
 * 漫画卡片的悬浮操作组：改词 / 重画 / 下载 / 气泡与台词（打开灯箱）。
 * 平时淡显几乎不可见，hover 卡片才浮出来——图片平时只有一颗小点，柏宝绘同款。
 */
function buildComicActions(artifact: VisualArtifact, floor: number): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'sti-figure-actions';

  const make = (label: string, icon: 'redraw' | 'download' | 'dialog' | 'edit' | 'trash'): HTMLButtonElement => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sti-figure-fab';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.innerHTML = svgIcon(icon);
    // 防止点按钮触发图片的灯箱
    btn.addEventListener('click', e => e.stopPropagation());
    return btn;
  };

  const status = document.createElement('span');
  status.className = 'sti-card-status';

  const edit = make('改提示词', 'edit');
  edit.title = '改这一页的提示词（正向词 / nl）并重画';
  edit.addEventListener('click', () => editComicPrompt(floor, artifact.id));

  const redraw = make('重画这一页', 'redraw');
  redraw.title = '同一套提示词、换一个种子重画这一页（台词气泡会重新合成）';
  redraw.addEventListener('click', () => {
    if (redraw.disabled) return;
    redraw.disabled = true;
    redraw.classList.add('is-busy');
    status.textContent = '';
    void (async () => {
      try {
        const result = await rerollComicPage(floor, artifact.id);
        if (!result.ok) {
          status.textContent = result.message ?? '重画失败。';
          redraw.disabled = false;
          redraw.classList.remove('is-busy');
          return;
        }
        mountFloor(floor); // 新图 / 新种子，增量重挂（旧卡因 data-sti-src 过期会被换掉）
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : String(err);
        redraw.disabled = false;
        redraw.classList.remove('is-busy');
      }
    })();
  });

  const download = make('下载这张图', 'download');
  download.title = '下载当前显示的这一版（带字 / 无字跟随页面）';
  download.addEventListener('click', () => {
    const img = document.querySelector<HTMLImageElement>(`[data-sti-artifact-id="${artifact.id}"] img`);
    void saveImageFile(img?.src ?? artifact.imagePath, `comic_${Date.now().toString(36)}.png`);
  });

  const dialog = make('气泡与台词', 'dialog');
  dialog.title = '打开大图：气泡开关、改台词、移动气泡位置';
  dialog.addEventListener('click', () => openComicCardLightbox(floor, artifact.id, imgAlt(artifact)));

  // 删除整页：正文里的 `<bbi_manwa>` 锚点、artifact 数据、卡片三样一起没
  const remove = make('删除这一页', 'trash');
  remove.title = '删除这一页（正文里的漫画标记一起清掉）';
  remove.classList.add('sti-figure-fab--danger');
  remove.addEventListener('click', () => {
    if (remove.disabled) return;
    remove.disabled = true;
    void (async () => {
      try {
        const done = await requestDeleteComicPage(floor, artifact.id);
        // 成功时卡片已经被摘掉；取消就把按钮还原
        if (!done) remove.disabled = false;
      } catch (err) {
        remove.disabled = false;
        status.textContent = err instanceof Error ? err.message : String(err);
      }
    })();
  });

  wrap.append(edit, redraw, download, dialog, remove, status);
  return wrap;
}

/**
 * 改词面板：把这一页当时发出去的正向词 + nl 摊开，改完就地重画。
 * 重画成功后就地重挂卡片（旧卡 imagePath 过期会被换掉），并回写新词。
 */
function editComicPrompt(floor: number, artifactId: string): void {
  const artifact = getArtifacts(floor).find(a => a.id === artifactId);
  if (!artifact) return;
  const page = typeof artifact.metadata?.pageTitle === 'string' ? artifact.metadata.pageTitle : '';
  const panelCount = typeof artifact.metadata?.panelCount === 'number' ? artifact.metadata.panelCount : 0;
  const cast = Array.isArray(artifact.metadata?.characters)
    ? (artifact.metadata.characters as Array<{ name: string; tag: string; nl?: string }>)
      .filter(c => c && typeof c.name === 'string' && typeof c.tag === 'string')
      .map(c => ({ name: c.name, tag: c.tag, ...(c.nl ? { nl: c.nl } : {}) }))
    : [];
  openPromptDialog({
    prompt: artifact.prompt ?? '',
    nl: artifact.nl ?? '',
    ...(cast.length ? { characters: cast } : {}),
    ...(page || panelCount
      ? { subtitle: [page, panelCount ? `${panelCount} 格` : '', cast.length ? `${cast.length} 人` : ''].filter(Boolean).join(' · ') }
      : {}),
    onApply: async (prompt, nl, characters) => {
      const result = await rerollComicPage(floor, artifactId, {
        prompt,
        nl,
        ...(characters.length ? { characters } : {}),
      });
      if (result.ok) mountFloor(floor);
      return result;
    },
    onDelete: () => requestDeleteComicPage(floor, artifactId),
  });
}

function imgAlt(artifact: VisualArtifact): string {
  return `${MODE_LABELS[artifact.mode] || artifact.mode} 作品`;
}

// ============================================================
// 漫画气泡：显示层合成 + 灯箱上下文
// ============================================================

/**
 * 给漫画卡接上「显示时合成」：落盘的无字原图先上屏，
 * 气泡在后台合成、好了再换上去（原版柏宝绘同款，文档 §1B.4 路线 B）。
 */
function attachBubbleOverlay(card: HTMLElement, img: HTMLImageElement, artifact: VisualArtifact): void {
  const settings = getSettings(DEFAULT_SETTINGS);
  const plan = comicOverlayPlan(artifact, settings);
  if (!plan) return; // 没台词：无字原图直接上，也不占合成资源
  const baseSrc = comicBaseImageOf(artifact); // 旧烧录卡迁移：原图还在就用原图，避免双重气泡

  let generation = 0; // 每张卡一个代次令牌：同卡重复合成时旧的作废（原版坑：异步乱序）
  const held: { current: { revoke: () => void } | null } = { current: null };
  const myToken = ++generation;
  void (async () => {
    const result = await compositeDialogue(baseSrc, plan.items, plan.opts);
    if (myToken !== generation || !result) { result?.revoke(); return; }
    held.current?.revoke();
    held.current = result;
    img.src = result.url;
    card.setAttribute('data-sti-bubbled', '');
  })();
  cardOverlays.set(card, {
    revoke: () => {
      generation += 1; // 在途的合成回来即作废
      held.current?.revoke();
      held.current = null;
    },
  });
}

/**
 * 台词/气泡位置改动后，立即重绘这一张卡的气泡（不整楼重挂、不闪屏）。
 *
 * 根因：灯箱 onSave 以前调 mountFloor，但那函数是增量挂载——卡片还在 DOM、
 * data-sti-src（无字原图路径）也没变，于是被判为「没过期」直接跳过，气泡不重合成。
 * 用户看到的就是「灯箱里明明改好了、关掉却还是旧的，退出聊天重进才对」。
 *
 * 这里只处理目标卡片：撤销旧 blob、先把 <img> 退回无字原图，再按最新 artifact
 * 重新合成一遍。其它卡片与 DOM 结构完全不动，所以不会闪。
 */
export function refreshComicCard(floor: number, artifactId: string): void {
  const mes = document.querySelector<HTMLElement>(`.mes[mesid="${floor}"]`);
  if (!mes) return;
  const card = mes.querySelector<HTMLElement>(`[data-sti-artifact-id="${artifactId}"]`);
  if (!card) return;
  const artifact = getArtifacts(floor).find(a => a.id === artifactId);
  if (!artifact || artifact.mode !== 'comic') return;
  const img = card.querySelector<HTMLImageElement>('img.sti-card-image');
  if (!img) return;

  // 撤销这张卡上一轮的带字 blob，并把图先退回无字原图
  revokeCardOverlay(card);
  card.removeAttribute('data-sti-bubbled');
  img.src = comicBaseImageOf(artifact);
  // 用最新的 dialogue 重新合成（读的是刚写回的 artifact）
  attachBubbleOverlay(card, img, artifact);
}

/**
 * 删除一页漫画：摘正文锚点 → 撤卡片 → 删数据 → 落盘。
 *
 * 顺序不能换。先摘 tag，否则刷新后托管正则会照着残留的 tag 再建一个空锚点；
 * 反过来先删数据再摘 tag，中间态会让对账把卡片误判成"数据丢了"。
 */
export async function deleteComicPage(floor: number, artifactId: string): Promise<boolean> {
  const artifact = getArtifacts(floor).find(a => a.id === artifactId);
  if (!artifact) return false;

  // 1) 正文里那一行 `<bbi_manwa>`（漫画页才有；插画走柏宝绘的 bbi_image，不动它）
  const mes = getMessage(floor)?.mes ?? '';
  if (mes.includes(buildManwaTag(artifactId))) {
    const removed = await removeManwaTag({ floor, artifactId });
    // 正文没摘干净就别删数据：否则刷新后正则会照残留 tag 造一个空锚点，卡在那儿再也删不掉
    if (!removed.ok) return false;
  }

  // 2) 这张卡的合成 blob 与节点
  const card = document.querySelector<HTMLElement>(
    `.mes[mesid="${floor}"] [data-sti-artifact-id="${artifactId}"]`,
  );
  if (card) {
    revokeCardOverlay(card);
    card.remove();
  }

  // 3) 数据
  removeArtifact(floor, artifactId);

  // 4) 落盘 + 对账（这一楼不再有作品时，"ST 创作"空壳也会一起收掉）
  await saveChatSafe();
  mountFloor(floor);
  return true;
}

/** 带确认的删除（卡片按钮 / 灯箱 / 改词面板共用一套文案）。 */
export async function requestDeleteComicPage(floor: number, artifactId: string): Promise<boolean> {
  const artifact = getArtifacts(floor).find(a => a.id === artifactId);
  const page = typeof artifact?.metadata?.pageTitle === 'string' && artifact.metadata.pageTitle
    ? `「${artifact.metadata.pageTitle}」`
    : '这一页漫画';
  const ok = await confirmDialog({
    title: '删除这一页？',
    message: `${page}会从正文和存档里一起删掉（正文里的漫画标记也会一并清掉）。酒馆图库里的图片文件不会被删。`,
    confirmText: '删除这一页',
  });
  if (!ok) return false;
  return deleteComicPage(floor, artifactId);
}

/** 打开某一页漫画的灯箱（气泡开关 / 台词编辑 / 移动定位 / 下载）。 */
function openComicCardLightbox(floor: number, artifactId: string, alt: string): void {
  const latest = getArtifacts(floor).find(a => a.id === artifactId);
  if (!latest) return;
  const settings = getSettings(DEFAULT_SETTINGS);
  const plan = comicOverlayPlan(latest, settings);
  if (!plan) {
    openLightbox(latest.imagePath, alt);
    return;
  }
  openComicLightbox({
    baseSrc: comicBaseImageOf(latest),
    plan,
    onEditPrompt: () => {
      // 灯箱里点「改词」：先退出灯箱，再开改词面板（重画完成后卡片自己会换图）
      closeLightbox();
      editComicPrompt(floor, artifactId);
    },
    onDelete: () => requestDeleteComicPage(floor, artifactId),
    onSave: async items => {
      // 写回 artifact（台词 + 手动钉的位置一起存）；
      // 落盘走防抖保存，不 await —— 否则点一下气泡要等 1.5s 才有反馈。
      updateArtifact(floor, artifactId, { dialogue: items ?? [] });
      void saveChatSafe();
      // 关键：不能用 mountFloor——它是增量挂载，卡片还在 DOM 且图路径没变就会被
      // 判为没过期而跳过，气泡仍是旧的。这里精准重绘这一张卡，关灯箱即可见。
      refreshComicCard(floor, artifactId);
      const fresh = getArtifacts(floor).find(a => a.id === artifactId);
      if (!fresh) return null;
      return comicOverlayPlan(fresh, settings);
    },
  });
}

// ============================================================
// 暴露给报告/调试
// ============================================================

export function getMountedCardCount(floor: number): number {
  const mes = document.querySelector<HTMLElement>(`.mes[mesid="${floor}"]`);
  if (!mes) return 0;
  return mes.querySelectorAll(`[${MOUNTED_ATTR}="${floor}"].${INLINE_CLASS}, [${MOUNTED_ATTR}="${floor}"].sti-floor-card`).length;
}

export { extractPlainText };
