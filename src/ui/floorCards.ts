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
import { getArtifacts } from '../storage/repository';
import { getMessage } from '../host/sillytavern';
import { manwaAnchors, parseManwaTags } from '../baibai/manwaTag';
import { extractPlainText, findAnchorRange } from '../selection/anchor';
import { openLightbox } from './lightbox';
import { rerollComicPage } from '../manga/rerollPage';

const INLINE_CLASS = 'sti-inline-card';
const TRAILING_AREA_CLASS = 'sti-trailing-area';
const TRAILING_AREA_ID = 'sti-trailing-area-';
const MOUNTED_ATTR = 'data-sti-mounted';

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

/** 重挂单个楼层的所有作品卡片。先清理旧卡片，再按 mountMode 挂载。 */
export function mountFloor(floor: number): void {
  const mes = document.querySelector<HTMLElement>(`.mes[mesid="${floor}"]`);
  if (!mes) return;
  unmountFloor(floor);

  const artifacts = getArtifacts(floor);
  // 正文已嵌入的图片不再用 DOM 卡片呈现（图片已成为正文内容）
  const visible = artifacts.filter(a => a.metadata?.embeddedInBody !== true);
  const inline = visible.filter(a => a.mountMode === 'inline');
  const trailing = visible.filter(a => a.mountMode !== 'inline');

  // 漫画页一律走 `<bbi_manwa>` 锚点：位置由正文里的 tag 决定，刷新后正则重建锚点、
  // 卡片跟着回来。只有**上线前生成的老卡**（正文里一条漫画 tag 都没有）才退回旧的行内插入。
  const manwa = mountManwa(mes, floor, visible);

  // 正文里有漫画 tag = 这一条 swipe 的漫画已经各自归位。
  // 此时**不能再把剩下的 artifact 行内挂一遍**：那些多半属于另一条 swipe
  // （tag 只存在于它自己那条 `mes` 里），挂出来就是「切了 swipe 图还在」。
  for (const artifact of inline) {
    if (manwa.consumed.has(artifact.id)) continue;
    // 有 tag 时默认不再行内挂（剩下的多半属于别的 swipe）；
    // 只有「当时就没写进正文」的那几页才单独放行。
    if (manwa.tagged && artifact.metadata?.inlineFallback !== true) continue;
    mountInline(mes, floor, artifact);
  }
  if (trailing.length > 0) mountTrailing(mes, floor, trailing);
}

/**
 * 把漫画卡片挂进正文里的 `<bbi_manwa>` 锚点（按 tag 出现顺序一一对应）。
 *
 * 返回已挂载的 artifact id 与「这一楼到底有没有漫画 tag」：调用方据此决定
 * 要不要把剩余的 artifact 用旧方式挂一遍（有 tag 就一律不挂，见调用处）。
 */
function mountManwa(
  mes: HTMLElement,
  floor: number,
  artifacts: VisualArtifact[],
): { consumed: Set<string>; tagged: boolean } {
  const consumed = new Set<string>();
  const refs = parseManwaTags(getMessage(floor)?.mes ?? '');
  if (!refs.length) return { consumed, tagged: false };

  const anchors = manwaAnchors(floor);
  if (!anchors.length) return { consumed, tagged: true };

  const byId = new Map(artifacts.map(a => [a.id, a]));
  const count = Math.min(anchors.length, refs.length);

  for (let i = 0; i < count; i += 1) {
    const artifact = byId.get(refs[i].id);
    if (!artifact) continue; // 锚点在、数据不在：留空，不猜
    if (anchors[i].querySelector(`[${MOUNTED_ATTR}]`)) { consumed.add(artifact.id); continue; }
    anchors[i].appendChild(buildCard(artifact, floor, true));
    consumed.add(artifact.id);
  }
  return { consumed, tagged: true };
}

/** 清理某楼层的所有本插件卡片。 */
export function unmountFloor(floor: number): void {
  const mes = document.querySelector<HTMLElement>(`.mes[mesid="${floor}"]`);
  if (!mes) return;
  const cards = mes.querySelectorAll(`[${MOUNTED_ATTR}="${floor}"]`);
  for (const card of Array.from(cards)) card.remove();
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
 * 对账：这一楼该有的卡片在不在，缺了才重挂。
 *
 * 与 `mountFloor` 的区别是**幂等且便宜**——它被 `#chat` 的 MutationObserver
 * 每帧调用，不能每次都拆掉重建（重建会让正在看的图闪烁，也会自己喂自己 mutation）。
 * 判定按 artifact id 逐个核对，所以「两张卡被 ST 重渲冲掉一张」这种半残状态也能修好。
 */
export function ensureFloorMounted(floor: number): void {
  const mes = document.querySelector<HTMLElement>(`.mes[mesid="${floor}"]`);
  if (!mes) return;
  const visible = getArtifacts(floor).filter(a => a.metadata?.embeddedInBody !== true);
  if (visible.length === 0) return;

  const present = new Set<string>();
  for (const node of Array.from(mes.querySelectorAll<HTMLElement>('[data-sti-artifact-id]'))) {
    const id = node.getAttribute('data-sti-artifact-id');
    if (id) present.add(id);
  }
  if (visible.every(a => present.has(a.id))) return;
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

  const img = document.createElement('img');
  img.className = 'sti-card-image';
  img.src = artifact.imagePath;
  img.alt = `${MODE_LABELS[artifact.mode] || artifact.mode} 作品`;
  img.loading = 'lazy';
  img.addEventListener('click', () => openLightbox(artifact.imagePath, img.alt));
  card.appendChild(img);

  const caption = document.createElement('div');
  caption.className = 'sti-card-caption';
  // 只显示简短自然语言描述，不再显示插画 tag / 模式标签（用户不想要那些 tag）
  caption.appendChild(document.createTextNode(artifact.nl ? artifact.nl.slice(0, 80) : ''));
  if (caption.textContent) card.appendChild(caption);

  // 漫画页不再走柏宝绘卡片，它那套「重绘」也就跟着没了——补一个。
  // 只换种子重画同一套词（prompt + nl + 角色块），台词气泡重新合成。
  if (artifact.mode === 'comic') card.appendChild(buildComicActions(artifact, floor));

  return card;
}

/** 漫画卡片的操作行：重画 + 一句状态（失败原因直接写在图上，不弹窗打断）。 */
function buildComicActions(artifact: VisualArtifact, floor: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'sti-card-actions';

  const status = document.createElement('span');
  status.className = 'sti-card-status';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'sti-card-btn';
  button.textContent = '重画';
  button.title = '同一套提示词、换一个种子重画这一页（台词气泡会重新合成）';
  button.addEventListener('click', event => {
    event.stopPropagation();
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = '重画中…';
    status.textContent = '';
    void (async () => {
      try {
        const result = await rerollComicPage(floor, artifact.id);
        if (!result.ok) {
          status.textContent = result.message ?? '重画失败。';
          button.disabled = false;
          button.textContent = '重画';
          return;
        }
        mountFloor(floor); // 新图 / 新种子，重新挂一遍
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : String(err);
        button.disabled = false;
        button.textContent = '重画';
      }
    })();
  });

  row.appendChild(button);
  row.appendChild(status);
  return row;
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
