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
import { extractPlainText } from '../selection/anchor';
import { openLightbox } from './lightbox';

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

  for (const artifact of inline) mountInline(mes, floor, artifact);
  if (trailing.length > 0) mountTrailing(mes, floor, trailing);
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

// ============================================================
// inline 挂载
// ============================================================

function mountInline(mes: HTMLElement, floor: number, artifact: VisualArtifact): void {
  const mesText = mes.querySelector<HTMLElement>('.mes_text');
  if (!mesText) return;
  const card = buildCard(artifact, floor, true);

  // 用 textAnchor 在正文里定位选段，插在其后
  let inserted = false;
  if (artifact.textAnchor) {
    const anchor = artifact.textAnchor;
    const target = findTextNodeAfter(mesText, anchor.selectedText);
    if (target) {
      target.parentNode?.insertBefore(card, target.nextSibling);
      inserted = true;
    }
  }
  // 定位失败降级：追加到正文末尾
  if (!inserted) mesText.appendChild(card);
}

/** 在 .mes_text 内找到包含 selectedText 的文本节点，返回其所在元素。 */
function findTextNodeAfter(root: HTMLElement, selectedText: string): Node | null {
  if (!selectedText) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if ((node.textContent ?? '').includes(selectedText)) return node;
  }
  return null;
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
  card.className = inline ? INLINE_CLASS : 'sti-floor-card';
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

  return card;
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
