/**
 * 选区工具条
 *
 * 轻量浮动按钮，紧贴选区附近。
 * 只在有效聊天正文选区出现。
 * 不遮挡选区，不导致选区丢失。
 */

// ============================================================
// 常量
// ============================================================

const TOOLBAR_ID = 'sti-selection-toolbar';
const TOOLBAR_CLASS = 'sti-selection-toolbar';
const TOOLBAR_BUTTON_CLASS = 'sti-toolbar-btn';

// ============================================================
// 状态
// ============================================================

let toolbarElement: HTMLElement | null = null;
let onGenerateCallback: (() => void) | null = null;

// ============================================================
// 工具条管理
// ============================================================

/**
 * 创建工具条 DOM 元素（如果不存在）。
 */
function ensureToolbar(): HTMLElement {
  if (toolbarElement && document.body.contains(toolbarElement)) {
    return toolbarElement;
  }

  const toolbar = document.createElement('div');
  toolbar.id = TOOLBAR_ID;
  toolbar.className = TOOLBAR_CLASS;
  toolbar.style.display = 'none';

  const button = document.createElement('button');
  button.className = TOOLBAR_BUTTON_CLASS;
  button.type = 'button';
  button.textContent = '生成配图';
  button.addEventListener('mousedown', (e: MouseEvent) => {
    // 阻止 mousedown 导致选区丢失
    e.preventDefault();
  });
  button.addEventListener('click', (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (onGenerateCallback) {
      onGenerateCallback();
    }
  });

  toolbar.appendChild(button);
  document.body.appendChild(toolbar);
  toolbarElement = toolbar;

  return toolbar;
}

/**
 * 显示工具条在选区附近。
 */
export function showToolbar(selection: Selection): void {
  const toolbar = ensureToolbar();
  if (selection.rangeCount === 0) return;

  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();

  // 工具条定位在选区上方
  const top = rect.top + window.scrollY - 40;
  const left = rect.left + window.scrollX + (rect.width / 2);

  toolbar.style.display = 'flex';
  toolbar.style.top = `${Math.max(0, top)}px`;
  toolbar.style.left = `${left}px`;
}

/**
 * 隐藏工具条。
 */
export function hideToolbar(): void {
  if (toolbarElement) {
    toolbarElement.style.display = 'none';
  }
}

/**
 * 设置"生成配图"按钮的回调。
 */
export function setOnGenerate(callback: () => void): void {
  onGenerateCallback = callback;
}

/**
 * 移除工具条（扩展卸载时调用）。
 */
export function destroyToolbar(): void {
  if (toolbarElement) {
    toolbarElement.remove();
    toolbarElement = null;
  }
  onGenerateCallback = null;
}
