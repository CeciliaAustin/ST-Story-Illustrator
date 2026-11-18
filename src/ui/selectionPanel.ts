/**
 * 选段面板 UI
 *
 * 用户流程：选择剧情 → 选择创作模式 → 配置 → 预览 → 生成
 *
 * 支持：
 * - 当前楼层（默认最近一条 AI 回复）
 * - 指定单楼层
 * - 连续楼层范围
 * - 范围内勾选/排除楼层
 * - 手动粘贴或编辑剧情文本
 * - 预览显示楼层范围、说话人与文本
 * - 提交前可编辑最终剧情
 */

import type { StorySegment, CreationMode, ModeSettings } from '../types';
import {
  buildSingleSegment,
  buildRangeSegment,
  buildPickedSegment,
  buildManualSegment,
  defaultFloor,
  getAvailableFloors,
  validateSegment,
  getAnchorFloor,
} from '../selection/storySegment';

// ============================================================
// 常量
// ============================================================

const PANEL_ID = 'sti-selection-panel';
const PANEL_OVERLAY_ID = 'sti-selection-panel-overlay';

const MODE_LABELS: Record<CreationMode, string> = {
  'illustration': '正文插画',
  'comic': '正文漫画分镜',
  'chibi-status': 'QQ 人状态栏',
  'chibi-bonus': 'QQ 人彩蛋',
  'bw-manga': '黑白漫小剧场',
};

const MODE_DESCRIPTIONS: Record<CreationMode, string> = {
  'illustration': '提取一个瞬间或按设置拆分镜头，生成单图/多图',
  'comic': '提炼连续事件中的不同瞬间，排成漫画页',
  'chibi-status': '提取真实发生的瞬间，Q 版比例',
  'chibi-bonus': '选段用于识别角色和性格，另构思平行宇宙彩蛋',
  'bw-manga': '选取真实发生的瞬间，正常比例、黑白漫画风',
};

// ============================================================
// 状态
// ============================================================

let panelElement: HTMLElement | null = null;
let overlayElement: HTMLElement | null = null;
let currentSegment: StorySegment | null = null;
let currentMode: CreationMode = 'illustration';
let onConfirmCallback: ((segment: StorySegment, mode: CreationMode) => void) | null = null;

// 选段模式
type SelectionMethod = 'single' | 'range' | 'picked' | 'manual';
let currentMethod: SelectionMethod = 'single';
let selectedSingleFloor: number = -1;
let rangeStart: number = -1;
let rangeEnd: number = -1;
let excludedFloors: Set<number> = new Set();
let pickedFloors: number[] = [];
let manualText: string = '';

// ============================================================
// 面板创建
// ============================================================

export function showSelectionPanel(
  initialFloor?: number,
  onConfirm?: (segment: StorySegment, mode: CreationMode) => void,
): void {
  // 初始化默认值
  selectedSingleFloor = initialFloor ?? defaultFloor();
  rangeStart = selectedSingleFloor;
  rangeEnd = selectedSingleFloor;
  currentMethod = 'single';
  excludedFloors = new Set();
  pickedFloors = selectedSingleFloor >= 0 ? [selectedSingleFloor] : [];
  manualText = '';
  onConfirmCallback = onConfirm ?? null;

  // 构建并显示面板
  ensurePanel();
  renderPanel();
}

export function hideSelectionPanel(): void {
  if (overlayElement) {
    overlayElement.style.display = 'none';
  }
  if (panelElement) {
    panelElement.style.display = 'none';
  }
}

function ensurePanel(): void {
  // Overlay
  if (!overlayElement) {
    overlayElement = document.createElement('div');
    overlayElement.id = PANEL_OVERLAY_ID;
    overlayElement.className = 'sti-panel-overlay';
    overlayElement.addEventListener('click', (e: MouseEvent) => {
      if (e.target === overlayElement) {
        hideSelectionPanel();
      }
    });
    document.body.appendChild(overlayElement);
  }

  // Panel
  if (!panelElement) {
    panelElement = document.createElement('div');
    panelElement.id = PANEL_ID;
    panelElement.className = 'sti-selection-panel';
    document.body.appendChild(panelElement);
  }

  overlayElement.style.display = 'block';
  panelElement.style.display = 'block';
}

// ============================================================
// 面板渲染
// ============================================================

function renderPanel(): void {
  if (!panelElement) return;

  const floors = getAvailableFloors();

  panelElement.innerHTML = '';

  // 标题
  const title = document.createElement('div');
  title.className = 'sti-panel-title';
  title.textContent = '剧情选段';
  panelElement.appendChild(title);

  // 选段方式标签
  const methodTabs = document.createElement('div');
  methodTabs.className = 'sti-method-tabs';
  for (const method of ['single', 'range', 'picked', 'manual'] as SelectionMethod[]) {
    const tab = document.createElement('button');
    tab.className = `sti-method-tab ${currentMethod === method ? 'active' : ''}`;
    tab.textContent = methodLabel(method);
    tab.addEventListener('click', () => {
      currentMethod = method;
      renderPanel();
    });
    methodTabs.appendChild(tab);
  }
  panelElement.appendChild(methodTabs);

  // 选段内容区
  const content = document.createElement('div');
  content.className = 'sti-panel-content';

  switch (currentMethod) {
    case 'single':
      content.appendChild(renderSingleSelector(floors));
      break;
    case 'range':
      content.appendChild(renderRangeSelector(floors));
      break;
    case 'picked':
      content.appendChild(renderPickedSelector(floors));
      break;
    case 'manual':
      content.appendChild(renderManualEditor());
      break;
  }

  panelElement.appendChild(content);

  // 模式选择
  panelElement.appendChild(renderModeSelector());

  // 预览
  panelElement.appendChild(renderPreview());

  // 操作按钮
  panelElement.appendChild(renderActions());
}

function methodLabel(method: SelectionMethod): string {
  switch (method) {
    case 'single': return '单楼';
    case 'range': return '范围';
    case 'picked': return '勾选';
    case 'manual': return '手动';
  }
}

// ============================================================
// 单楼选择器
// ============================================================

function renderSingleSelector(floors: Array<{ floor: number; speaker: string; isUser: boolean; preview: string }>): HTMLElement {
  const container = document.createElement('div');
  container.className = 'sti-selector-container';

  const label = document.createElement('div');
  label.className = 'sti-selector-label';
  label.textContent = '选择楼层：';
  container.appendChild(label);

  const select = document.createElement('select');
  select.className = 'sti-floor-select';
  for (const f of floors) {
    const opt = document.createElement('option');
    opt.value = String(f.floor);
    opt.textContent = `[${f.floor}] ${f.speaker}: ${f.preview}...`;
    if (f.floor === selectedSingleFloor) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => {
    selectedSingleFloor = parseInt(select.value, 10);
    rebuildSegment();
    renderPreviewOnly();
  });
  container.appendChild(select);

  return container;
}

// ============================================================
// 范围选择器
// ============================================================

function renderRangeSelector(floors: Array<{ floor: number; speaker: string; isUser: boolean; preview: string }>): HTMLElement {
  const container = document.createElement('div');
  container.className = 'sti-selector-container';

  const rangeRow = document.createElement('div');
  rangeRow.className = 'sti-range-row';

  const startLabel = document.createElement('span');
  startLabel.textContent = '从';
  rangeRow.appendChild(startLabel);

  const startSelect = createFloorSelect(floors, rangeStart, (val) => {
    rangeStart = val;
    rebuildSegment();
    renderPreviewOnly();
  });
  rangeRow.appendChild(startSelect);

  const dash = document.createElement('span');
  dash.textContent = '到';
  rangeRow.appendChild(dash);

  const endSelect = createFloorSelect(floors, rangeEnd, (val) => {
    rangeEnd = val;
    rebuildSegment();
    renderPreviewOnly();
  });
  rangeRow.appendChild(endSelect);

  container.appendChild(rangeRow);

  // 排除楼层
  if (rangeStart >= 0 && rangeEnd >= 0) {
    const lo = Math.min(rangeStart, rangeEnd);
    const hi = Math.max(rangeStart, rangeEnd);
    const rangeFloors = floors.filter(f => f.floor >= lo && f.floor <= hi);

    if (rangeFloors.length > 0) {
      const excludeLabel = document.createElement('div');
      excludeLabel.className = 'sti-selector-label';
      excludeLabel.textContent = '排除楼层（勾选不想要的）：';
      container.appendChild(excludeLabel);

      const excludeList = document.createElement('div');
      excludeList.className = 'sti-exclude-list';
      for (const f of rangeFloors) {
        const item = document.createElement('label');
        item.className = 'sti-exclude-item';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = excludedFloors.has(f.floor);
        cb.addEventListener('change', () => {
          if (cb.checked) {
            excludedFloors.add(f.floor);
          } else {
            excludedFloors.delete(f.floor);
          }
          rebuildSegment();
          renderPreviewOnly();
        });
        item.appendChild(cb);
        item.appendChild(document.createTextNode(` [${f.floor}] ${f.speaker}: ${f.preview.slice(0, 50)}...`));
        excludeList.appendChild(item);
      }
      container.appendChild(excludeList);
    }
  }

  return container;
}

// ============================================================
// 勾选选择器
// ============================================================

function renderPickedSelector(floors: Array<{ floor: number; speaker: string; isUser: boolean; preview: string }>): HTMLElement {
  const container = document.createElement('div');
  container.className = 'sti-selector-container';

  const label = document.createElement('div');
  label.className = 'sti-selector-label';
  label.textContent = '勾选要纳入的楼层（按勾选顺序）：';
  container.appendChild(label);

  const list = document.createElement('div');
  list.className = 'sti-picked-list';
  for (const f of floors) {
    const item = document.createElement('label');
    item.className = 'sti-picked-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = pickedFloors.includes(f.floor);
    cb.addEventListener('change', () => {
      if (cb.checked) {
        if (!pickedFloors.includes(f.floor)) {
          pickedFloors.push(f.floor);
        }
      } else {
        pickedFloors = pickedFloors.filter(id => id !== f.floor);
      }
      rebuildSegment();
      renderPreviewOnly();
    });
    item.appendChild(cb);
    item.appendChild(document.createTextNode(` [${f.floor}] ${f.speaker}: ${f.preview.slice(0, 50)}...`));
    list.appendChild(item);
  }
  container.appendChild(list);

  return container;
}

// ============================================================
// 手动编辑器
// ============================================================

function renderManualEditor(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'sti-selector-container';

  const label = document.createElement('div');
  label.className = 'sti-selector-label';
  label.textContent = '粘贴或编辑剧情文本：';
  container.appendChild(label);

  const textarea = document.createElement('textarea');
  textarea.className = 'sti-manual-textarea';
  textarea.rows = 10;
  textarea.placeholder = '在此输入或粘贴剧情文本...';
  textarea.value = manualText;
  textarea.addEventListener('input', () => {
    manualText = textarea.value;
    rebuildSegment();
    renderPreviewOnly();
  });
  container.appendChild(textarea);

  const note = document.createElement('div');
  note.className = 'sti-manual-note';
  note.textContent = '手动文本不可伪造楼层归属，结果将放入插件作品历史。';
  container.appendChild(note);

  return container;
}

// ============================================================
// 模式选择器
// ============================================================

function renderModeSelector(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'sti-mode-selector';

  const label = document.createElement('div');
  label.className = 'sti-selector-label';
  label.textContent = '创作模式：';
  container.appendChild(label);

  const modeList = document.createElement('div');
  modeList.className = 'sti-mode-list';

  for (const mode of Object.keys(MODE_LABELS) as CreationMode[]) {
    const item = document.createElement('label');
    item.className = `sti-mode-item ${currentMode === mode ? 'active' : ''}`;
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'sti-mode';
    radio.value = mode;
    radio.checked = currentMode === mode;
    radio.addEventListener('change', () => {
      currentMode = mode;
      renderPanel();
    });
    item.appendChild(radio);

    const text = document.createElement('div');
    text.className = 'sti-mode-text';
    const name = document.createElement('div');
    name.className = 'sti-mode-name';
    name.textContent = MODE_LABELS[mode];
    const desc = document.createElement('div');
    desc.className = 'sti-mode-desc';
    desc.textContent = MODE_DESCRIPTIONS[mode];
    text.appendChild(name);
    text.appendChild(desc);
    item.appendChild(text);

    modeList.appendChild(item);
  }

  container.appendChild(modeList);
  return container;
}

// ============================================================
// 预览
// ============================================================

function renderPreview(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'sti-preview-container';
  container.id = 'sti-preview-container';

  rebuildSegment();

  if (!currentSegment) {
    const empty = document.createElement('div');
    empty.className = 'sti-preview-empty';
    empty.textContent = '请选择楼层或输入文本';
    container.appendChild(empty);
    return container;
  }

  // 楼层信息
  const info = document.createElement('div');
  info.className = 'sti-preview-info';
  const floorInfo = currentSegment.floorIds.length > 0
    ? `楼层 ${currentSegment.floorIds.join(', ')}`
    : '手动文本';
  info.textContent = `${floorInfo} | ${currentSegment.messages.length} 条消息 | ${currentSegment.text.length} 字`;
  container.appendChild(info);

  // 消息预览
  if (currentSegment.messages.length > 0) {
    const msgList = document.createElement('div');
    msgList.className = 'sti-preview-messages';
    for (const msg of currentSegment.messages) {
      const item = document.createElement('div');
      item.className = `sti-preview-message ${msg.isUser ? 'is-user' : ''}`;
      const speaker = document.createElement('span');
      speaker.className = 'sti-preview-speaker';
      speaker.textContent = `[${msg.floor}] ${msg.speaker}:`;
      const text = document.createElement('span');
      text.className = 'sti-preview-text';
      text.textContent = msg.text.slice(0, 200) + (msg.text.length > 200 ? '...' : '');
      item.appendChild(speaker);
      item.appendChild(text);
      msgList.appendChild(item);
    }
    container.appendChild(msgList);
  }

  // 完整文本预览（可编辑）
  const textLabel = document.createElement('div');
  textLabel.className = 'sti-selector-label';
  textLabel.textContent = '最终剧情文本（可编辑）：';
  container.appendChild(textLabel);

  const textarea = document.createElement('textarea');
  textarea.className = 'sti-preview-textarea';
  textarea.rows = 6;
  textarea.value = currentSegment.text;
  textarea.addEventListener('input', () => {
    if (currentSegment) {
      currentSegment = { ...currentSegment, text: textarea.value };
    }
  });
  container.appendChild(textarea);

  return container;
}

function renderPreviewOnly(): void {
  const container = document.getElementById('sti-preview-container');
  if (!container || !panelElement) return;

  const preview = renderPreview();
  container.replaceWith(preview);
}

// ============================================================
// 操作按钮
// ============================================================

function renderActions(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'sti-panel-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'sti-btn sti-btn-cancel';
  cancelBtn.textContent = '取消';
  cancelBtn.addEventListener('click', () => {
    hideSelectionPanel();
  });
  container.appendChild(cancelBtn);

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'sti-btn sti-btn-confirm';
  confirmBtn.textContent = '确认选段';
  confirmBtn.disabled = !currentSegment;
  confirmBtn.addEventListener('click', () => {
    if (currentSegment && onConfirmCallback) {
      // 验证选段有效性
      if (!validateSegment(currentSegment)) {
        // 选段已失效，提示用户
        const warning = document.createElement('div');
        warning.className = 'sti-preview-warning';
        warning.textContent = '选段已失效（聊天切换或消息删除），请重新选择。';
        panelElement?.appendChild(warning);
        return;
      }
      onConfirmCallback(currentSegment, currentMode);
      hideSelectionPanel();
    }
  });
  container.appendChild(confirmBtn);

  return container;
}

// ============================================================
// 辅助
// ============================================================

function createFloorSelect(
  floors: Array<{ floor: number; speaker: string; isUser: boolean; preview: string }>,
  currentValue: number,
  onChange: (val: number) => void,
): HTMLSelectElement {
  const select = document.createElement('select');
  select.className = 'sti-floor-select';
  for (const f of floors) {
    const opt = document.createElement('option');
    opt.value = String(f.floor);
    opt.textContent = `[${f.floor}] ${f.speaker}`;
    if (f.floor === currentValue) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => {
    onChange(parseInt(select.value, 10));
  });
  return select;
}

function rebuildSegment(): void {
  switch (currentMethod) {
    case 'single':
      currentSegment = selectedSingleFloor >= 0
        ? buildSingleSegment(selectedSingleFloor)
        : null;
      break;
    case 'range':
      currentSegment = rangeStart >= 0 && rangeEnd >= 0
        ? buildRangeSegment(rangeStart, rangeEnd, Array.from(excludedFloors))
        : null;
      break;
    case 'picked':
      currentSegment = pickedFloors.length > 0
        ? buildPickedSegment(pickedFloors)
        : null;
      break;
    case 'manual':
      currentSegment = manualText.trim()
        ? buildManualSegment(manualText)
        : null;
      break;
  }
}

export function destroySelectionPanel(): void {
  if (panelElement) {
    panelElement.remove();
    panelElement = null;
  }
  if (overlayElement) {
    overlayElement.remove();
    overlayElement = null;
  }
  onConfirmCallback = null;
  currentSegment = null;
}
