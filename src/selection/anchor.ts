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
