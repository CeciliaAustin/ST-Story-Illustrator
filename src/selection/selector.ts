/**
 * 选区检测
 *
 * 只响应 SillyTavern 聊天消息正文（.mes_text）内的选区。
 * 排除输入框、设置面板、扩展自身 UI 等非消息区域。
 */

// ============================================================
// 常量
// ============================================================

/** 消息正文容器选择器 */
const MES_TEXT_SELECTOR = '.mes_text';

/** 消息容器选择器 */
const MES_SELECTOR = '.mes';

/** 最小选区长度 */
const MIN_SELECTION_LENGTH = 2;

// ============================================================
// 选区验证
// ============================================================

/**
 * 检查选区是否在消息正文内。
 * 从选区的共同祖先向上查找 .mes_text 容器。
 */
export function isSelectionInMesText(selection: Selection): boolean {
  if (!selection || selection.rangeCount === 0) return false;

  const range = selection.getRangeAt(0);
  if (range.collapsed) return false;

  // 选区文本长度检查
  const text = selection.toString().trim();
  if (text.length < MIN_SELECTION_LENGTH) return false;

  // 从共同祖先向上查找 .mes_text
  let container: Node | null = range.commonAncestorContainer;
  if (container && container.nodeType === Node.TEXT_NODE) {
    container = container.parentNode;
  }

  while (container && container !== document.body) {
    if (container instanceof HTMLElement) {
      if (container.classList?.contains('mes_text')) {
        // 确认这个 .mes_text 在一个 .mes 内
        const mes = container.closest(MES_SELECTOR);
        if (mes) return true;
      }
    }
    container = container.parentNode;
  }

  return false;
}

/**
 * 从选区获取所属的 .mes_text 元素。
 */
export function getMesTextFromSelection(selection: Selection): HTMLElement | null {
  if (!selection || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  let container: Node | null = range.commonAncestorContainer;
  if (container && container.nodeType === Node.TEXT_NODE) {
    container = container.parentNode;
  }

  while (container && container !== document.body) {
    if (container instanceof HTMLElement && container.classList?.contains('mes_text')) {
      return container;
    }
    container = container.parentNode;
  }

  return null;
}

/**
 * 从选区获取所属的 .mes 元素。
 */
export function getMesFromSelection(selection: Selection): HTMLElement | null {
  const mesText = getMesTextFromSelection(selection);
  if (!mesText) return null;
  return mesText.closest(MES_SELECTOR);
}

// ============================================================
// 选区文本提取
// ============================================================

/**
 * 获取选区文本（去除首尾空白）。
 */
export function getSelectionText(selection: Selection): string {
  return selection.toString().trim();
}

/**
 * 获取选区在 .mes_text 内的段落索引。
 * 按 <p>、<br> 或直接文本节点分段。
 */
export function getParagraphIndex(selection: Selection, mesText: HTMLElement): number {
  if (!selection || selection.rangeCount === 0) return 0;

  const range = selection.getRangeAt(0);
  const startNode = range.startContainer;

  // 遍历 mesText 的子节点，计算段落索引
  let paragraphIndex = 0;
  let found = false;

  const walk = (node: Node): void => {
    if (found) return;
    if (node === startNode || (node.contains && node.contains(startNode))) {
      found = true;
      return;
    }
    if (node.nodeName === 'P' || node.nodeName === 'BR') {
      paragraphIndex++;
    }
    if (node.childNodes) {
      for (let i = 0; i < node.childNodes.length; i++) {
        walk(node.childNodes[i]);
      }
    }
  };

  for (let i = 0; i < mesText.childNodes.length; i++) {
    walk(mesText.childNodes[i]);
  }

  return paragraphIndex;
}

// ============================================================
// 选区变化监听
// ============================================================

export type SelectionCallback = (valid: boolean, selection: Selection | null) => void;

let currentCallback: SelectionCallback | null = null;
let documentListener: (() => void) | null = null;

/**
 * 开始监听选区变化。
 * 只在选区位于 .mes_text 内时触发回调。
 */
export function startSelectionListener(callback: SelectionCallback): void {
  stopSelectionListener();
  currentCallback = callback;

  const handler = (): void => {
    const selection = window.getSelection();
    if (!selection) {
      callback(false, null);
      return;
    }
    const valid = isSelectionInMesText(selection);
    callback(valid, valid ? selection : null);
  };

  // 使用 selectionchange 事件（更实时）+ mouseup（兼容性）
  document.addEventListener('selectionchange', handler);
  document.addEventListener('mouseup', handler);

  documentListener = (): void => {
    document.removeEventListener('selectionchange', handler);
    document.removeEventListener('mouseup', handler);
  };
}

/**
 * 停止监听选区变化。
 */
export function stopSelectionListener(): void {
  if (documentListener) {
    documentListener();
    documentListener = null;
  }
  currentCallback = null;
}
