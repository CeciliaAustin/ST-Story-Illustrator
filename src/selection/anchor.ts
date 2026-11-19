/**
 * 选段锚点保存与匹配
 *
 * 不能只保存字符偏移。
 * 至少保存选段文本、前后锚点文本、段落索引。
 */

import type { SelectionAnchor } from '../types';

// ============================================================
// 常量
// ============================================================

/** 前后锚点的字符长度 */
const ANCHOR_LENGTH = 60;

/** 最大选段文本长度 */
const MAX_SELECTED_TEXT = 2000;

// ============================================================
// 锚点构建
// ============================================================

/**
 * 从选区和楼层正文构建选段锚点。
 *
 * @param selectedText 用户选中的文本
 * @param floorText 楼层完整正文（纯文本）
 * @param paragraphIndex 选区在楼层中的段落索引
 * @returns 选段锚点
 */
export function buildAnchor(
  selectedText: string,
  floorText: string,
  paragraphIndex: number,
): SelectionAnchor {
  const cleanSelected = selectedText.slice(0, MAX_SELECTED_TEXT);

  // 在楼层正文中查找选段位置
  const selectionStart = floorText.indexOf(cleanSelected);
  let beforeAnchor = '';
  let afterAnchor = '';
  let startOffset: number | undefined;
  let endOffset: number | undefined;

  if (selectionStart >= 0) {
    startOffset = selectionStart;
    endOffset = selectionStart + cleanSelected.length;

    // 提取前后锚点文本
    beforeAnchor = floorText.slice(Math.max(0, selectionStart - ANCHOR_LENGTH), selectionStart);
    afterAnchor = floorText.slice(endOffset, Math.min(floorText.length, endOffset + ANCHOR_LENGTH));
  } else {
    // 选段文本在楼层正文中找不到（可能是渲染后的文本与 mes 字段不完全一致）
    // 尝试模糊匹配：取选段前 30 字符在楼层中查找
    const fuzzyKey = cleanSelected.slice(0, 30);
    const fuzzyStart = floorText.indexOf(fuzzyKey);
    if (fuzzyStart >= 0) {
      startOffset = fuzzyStart;
      endOffset = fuzzyStart + cleanSelected.length;
      beforeAnchor = floorText.slice(Math.max(0, fuzzyStart - ANCHOR_LENGTH), fuzzyStart);
      afterAnchor = floorText.slice(endOffset, Math.min(floorText.length, endOffset + ANCHOR_LENGTH));
    }
  }

  return {
    selectedText: cleanSelected,
    beforeAnchor,
    afterAnchor,
    paragraphIndex,
    startOffset,
    endOffset,
  };
}

// ============================================================
// 锚点匹配
// ============================================================

/**
 * 在新的楼层正文中匹配锚点。
 * 用于消息编辑、swipe 切换后重新定位选段。
 *
 * @returns 匹配成功返回新的偏移量，失败返回 null
 */
export function matchAnchor(anchor: SelectionAnchor, newFloorText: string): {
  startOffset: number;
  endOffset: number;
} | null {
  // 1. 精确匹配选段文本
  const exactStart = newFloorText.indexOf(anchor.selectedText);
  if (exactStart >= 0) {
    return {
      startOffset: exactStart,
      endOffset: exactStart + anchor.selectedText.length,
    };
  }

  // 2. 用前后锚点联合匹配
  if (anchor.beforeAnchor && anchor.afterAnchor) {
    const beforeStart = newFloorText.indexOf(anchor.beforeAnchor);
    if (beforeStart >= 0) {
      const expectedSelectionStart = beforeStart + anchor.beforeAnchor.length;
      // 检查选段后面紧跟 afterAnchor
      const afterStart = newFloorText.indexOf(
        anchor.afterAnchor,
        expectedSelectionStart,
      );
      if (afterStart >= 0 && afterStart <= expectedSelectionStart + MAX_SELECTED_TEXT) {
        return {
          startOffset: expectedSelectionStart,
          endOffset: afterStart,
        };
      }
    }
  }

  // 3. 只用前锚点
  if (anchor.beforeAnchor) {
    const beforeStart = newFloorText.indexOf(anchor.beforeAnchor);
    if (beforeStart >= 0) {
      const selectionStart = beforeStart + anchor.beforeAnchor.length;
      return {
        startOffset: selectionStart,
        endOffset: Math.min(selectionStart + anchor.selectedText.length, newFloorText.length),
      };
    }
  }

  // 4. 只用后锚点
  if (anchor.afterAnchor) {
    const afterStart = newFloorText.indexOf(anchor.afterAnchor);
    if (afterStart >= 0) {
      const selectionEnd = afterStart;
      const selectionStart = Math.max(0, selectionEnd - anchor.selectedText.length);
      return {
        startOffset: selectionStart,
        endOffset: selectionEnd,
      };
    }
  }

  return null;
}

/**
 * 判断锚点是否仍然有效（选段文本在新楼层中存在）。
 */
export function isAnchorValid(anchor: SelectionAnchor, newFloorText: string): boolean {
  return matchAnchor(anchor, newFloorText) !== null;
}

// ============================================================
// 楼层正文提取
// ============================================================

/**
 * 从 .mes_text 元素提取纯文本。
 * 去除 HTML 标签，压空白。
 */
export function extractPlainText(mesText: HTMLElement): string {
  // 克隆节点避免修改原始 DOM
  const clone = mesText.cloneNode(true) as HTMLElement;
  // 移除可能的 <bbi_image> 等自定义标签内容
  clone.querySelectorAll('bbi_image').forEach(el => el.remove());
  // 获取文本内容
  return (clone.textContent ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 从 ST chat 数组的 mes 字段提取纯文本。
 * 去除 HTML 标签，压空白。
 */
export function extractPlainTextFromMes(mes: string): string {
  return String(mes ?? '')
    .replace(/<bbi_image[\s\S]*?<\/bbi_image>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ============================================================
// 宽松锚点定位（划线处插图用）
// ============================================================

/**
 * 归一化后的「骨架」：每个字符都记住它在原文里的下标。
 *
 * 为什么要这一层：用户划线拿到的是**渲染后的文本**（`window.getSelection()`），
 * 而我们要插进去的是 `message.mes` 原文。两者差的不是内容，而是：
 * - Markdown 强调符（`*动作*`、`**加粗**`）在 DOM 里根本不显示；
 * - 空行：DOM 里一个换行，mes 里常常是两个；
 * - 引号被排版成 “ ” ‘ ’，破折号被换成 ——；
 * - 零宽字符、全角半角差异。
 * 直接 `indexOf` 一定找不到 → 以前就一路落到「追加到本楼末尾」。
 */
const ZERO_WIDTH = /[\u200b-\u200f\u202a-\u202e\ufeff]/;
const MARK_CHARS = /[*_~`]/;
const QUOTE_MAP: Record<string, string> = {
  '“': '"', '”': '"', '„': '"', '«': '"', '»': '"',
  '‘': "'", '’': "'", '‚': "'", '‹': "'", '›': "'",
  '—': '-', '–': '-',
};

function skeleton(text: string): { s: string; map: number[] } {
  const src = String(text ?? '');
  const chars: string[] = [];
  const map: number[] = [];
  let lastSpace = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ZERO_WIDTH.test(ch) || MARK_CHARS.test(ch)) continue;
    if (/\s/.test(ch)) {
      // 连续空白（含换行）压成一个空格：DOM 与 mes 的空行数量差不该影响定位
      if (!chars.length || lastSpace) continue;
      chars.push(' ');
      map.push(i);
      lastSpace = true;
      continue;
    }
    lastSpace = false;
    const replaced = QUOTE_MAP[ch] ?? ch;
    // NFKC：全角标点/数字归一；结果可能是多个码位，都指回同一个原下标
    const normalized = replaced.normalize('NFKC').toLowerCase();
    for (const c of normalized) {
      chars.push(c);
      map.push(i);
    }
  }
  while (chars.length && chars[chars.length - 1] === ' ') {
    chars.pop();
    map.pop();
  }
  return { s: chars.join(''), map };
}

export interface AnchorRange {
  /** 选段在原文里的起始下标（含） */
  start: number;
  /** 结束下标（不含） */
  end: number;
}

/**
 * 在原文里找出选段的位置（宽松匹配）。
 *
 * 逐级退让：整段找不到就用前 60 / 40 / 24 个字符，再不行从 24 一路缩到 8
 * （用户可能在面板里改了选段的后半句，前 22 个字仍然对得上）。
 * 仍找不到才返回 null，由调用方决定兜底。
 */
export function findAnchorRange(haystack: string, needle: string): AnchorRange | null {
  const hay = skeleton(haystack);
  const pin = skeleton(needle);
  if (!hay.s || !pin.s) return null;
  const probes = [pin.s, pin.s.slice(0, 60), pin.s.slice(0, 40), pin.s.slice(0, 24)];
  for (let len = 22; len >= 8; len -= 2) probes.push(pin.s.slice(0, len));
  for (const probe of probes) {
    if (!probe.trim()) continue;
    const at = hay.s.indexOf(probe);
    if (at < 0) continue;
    const start = hay.map[at];
    const end = hay.map[at + probe.length - 1] + 1;
    return { start, end };
  }
  return null;
}

/**
 * 选段所在**行**的末尾下标（不含换行符）。
 *
 * 不插在选段正中间：Markdown 里那会把一句话劈成两段（`\n\n` 会断段），
 * 图片夹在半句话中间也读不下去。插在选段所在行之后，视觉上就是「划线那段下面」。
 */
export function lineEndAfter(text: string, index: number): number {
  const nl = String(text ?? '').indexOf('\n', Math.max(0, index));
  return nl < 0 ? String(text ?? '').length : nl;
}
