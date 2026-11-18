/**
 * 选段面板 UI
 *
 * 用户流程：选择剧情 → 选择创作模式（可多选） → 配置 → 预览 → 生成
 *
 * 选段方式（标签页顺序）：
 * - local（局部）：直接采用划线文本并预填充，可编辑；免选楼层，锚定划线所在楼
 * - single（单楼）：指定单个楼层
 * - range（范围）：连续楼层范围 + 排除楼层
 * - picked（勾选）：按勾选顺序选多个楼层
 *
 * 创作模式可多选：确认后为每个选中的模式各排一个任务。
 */

import type { StorySegment, CreationMode } from '../types';
import { DEFAULT_SETTINGS } from '../types';
import { getSettings, saveSettings } from '../host/sillytavern';
import { listSharedChannelInfos, readTagGenChannelId } from '../baibai/secondaryLlm';
import {
  buildSingleSegment,
  buildRangeSegment,
  buildPickedSegment,
  buildManualSegment,
  defaultFloor,
  getAvailableFloors,
  validateSegment,
} from '../selection/storySegment';

// ============================================================
// 常量
// ============================================================

const PANEL_ID = 'sti-selection-panel';
const PANEL_OVERLAY_ID = 'sti-selection-panel-overlay';

/** 标签页顺序：局部在最前 */
const METHOD_ORDER: SelectionMethod[] = ['local', 'single', 'range', 'picked'];

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
/** 多选模式：至少一个选中，默认插画 */
let selectedModes: Set<CreationMode> = new Set<CreationMode>(['illustration']);
let onConfirmCallback: ((segment: StorySegment, modes: CreationMode[]) => void) | null = null;

// 选段模式
type SelectionMethod = 'local' | 'single' | 'range' | 'picked' | 'manual';
let currentMethod: SelectionMethod = 'local';
let selectedSingleFloor: number = -1;
let rangeStart: number = -1;
let rangeEnd: number = -1;
let excludedFloors: Set<number> = new Set();
let pickedFloors: number[] = [];
/** 划线文本（打开面板时预填充到「局部」） */
let selectedTextSeed: string = '';
/** 划线所在楼（锚定楼层，供「局部」使用） */
let selectedFloorSeed: number = -1;

// ============================================================
// 面板创建
// ============================================================

export interface ShowPanelOptions {
  initialFloor?: number;
  /** 划线文本，预填充到「局部」标签页 */
  selectedText?: string;
  /** 是否默认打开「局部」标签页（划线触发时为 true） */
  startAtLocal?: boolean;
}

export function showSelectionPanel(
  initialFloorOrOptions?: number | ShowPanelOptions,
  onConfirm?: (segment: StorySegment, modes: CreationMode[]) => void,
): void {
  // 兼容旧调用：第一个参数是数字 = initialFloor
  const opts: ShowPanelOptions = typeof initialFloorOrOptions === 'number'
    ? { initialFloor: initialFloorOrOptions }
    : (initialFloorOrOptions ?? {});

  const seedFloor = opts.initialFloor ?? defaultFloor();
  selectedSingleFloor = seedFloor;
  rangeStart = seedFloor;
  rangeEnd = seedFloor;
  currentMethod = opts.startAtLocal !== false ? 'local' : 'single';
  excludedFloors = new Set();
  pickedFloors = seedFloor >= 0 ? [seedFloor] : [];
  selectedTextSeed = (opts.selectedText ?? '').trim();
  selectedFloorSeed = seedFloor;
  // 每次打开面板：局部文本 = 本次划线文本（有则用，无则清空）
  localText = selectedTextSeed;
  onConfirmCallback = onConfirm ?? null;

  ensurePanel();
  renderPanel();
}

export function hideSelectionPanel(): void {
  if (overlayElement) overlayElement.style.display = 'none';
  if (panelElement) panelElement.style.display = 'none';
}

function ensurePanel(): void {
  if (!overlayElement) {
    overlayElement = document.createElement('div');
    overlayElement.id = PANEL_OVERLAY_ID;
    overlayElement.className = 'sti-panel-overlay';
    overlayElement.addEventListener('click', (e: MouseEvent) => {
      if (e.target === overlayElement) hideSelectionPanel();
    });
    document.body.appendChild(overlayElement);
  }
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

  const title = document.createElement('div');
  title.className = 'sti-panel-title';
  title.textContent = '剧情选段';
  panelElement.appendChild(title);

  // 选段方式标签
  const methodTabs = document.createElement('div');
  methodTabs.className = 'sti-method-tabs';
  for (const method of METHOD_ORDER) {
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

  const content = document.createElement('div');
  content.className = 'sti-panel-content';
  switch (currentMethod) {
    case 'local':
    case 'manual':
      content.appendChild(renderLocalEditor());
      break;
    case 'single':
      content.appendChild(renderSingleSelector(floors));
      break;
    case 'range':
      content.appendChild(renderRangeSelector(floors));
      break;
    case 'picked':
      content.appendChild(renderPickedSelector(floors));
      break;
  }
  panelElement.appendChild(content);

  panelElement.appendChild(renderModeSelector());
  panelElement.appendChild(renderApiChannelSelector());
  panelElement.appendChild(renderPreview());
  panelElement.appendChild(renderActions());
}

function methodLabel(method: SelectionMethod): string {
  switch (method) {
    case 'local': return '局部';
    case 'single': return '单楼';
    case 'range': return '范围';
    case 'picked': return '勾选';
    case 'manual': return '局部';
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
    opt.textContent = `[${f.floor}] ${f.speaker}: ${f.preview.slice(0, 40)}...`;
    if (f.floor === selectedSingleFloor) opt.selected = true;
    select.appendChild(opt);
  }
  // 同步 select.value，避免 option.selected 与实际显示不一致（楼层错位 bug）
  if (selectedSingleFloor >= 0) select.value = String(selectedSingleFloor);
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
    rangeStart = val; rebuildSegment(); renderPreviewOnly();
  });
  rangeRow.appendChild(startSelect);

  const dash = document.createElement('span');
  dash.textContent = '到';
  rangeRow.appendChild(dash);
  const endSelect = createFloorSelect(floors, rangeEnd, (val) => {
    rangeEnd = val; rebuildSegment(); renderPreviewOnly();
  });
  rangeRow.appendChild(endSelect);
  container.appendChild(rangeRow);

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
          if (cb.checked) excludedFloors.add(f.floor);
          else excludedFloors.delete(f.floor);
          rebuildSegment(); renderPreviewOnly();
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
        if (!pickedFloors.includes(f.floor)) pickedFloors.push(f.floor);
      } else {
        pickedFloors = pickedFloors.filter(id => id !== f.floor);
      }
      rebuildSegment(); renderPreviewOnly();
    });
    item.appendChild(cb);
    item.appendChild(document.createTextNode(` [${f.floor}] ${f.speaker}: ${f.preview.slice(0, 50)}...`));
    list.appendChild(item);
  }
  container.appendChild(list);
  return container;
}

// ============================================================
// 局部编辑器（原「手动」，预填充划线文本）
// ============================================================

function renderLocalEditor(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'sti-selector-container';

  const label = document.createElement('div');
  label.className = 'sti-selector-label';
  label.textContent = '划线文本（可编辑，直接作为剧情内容）：';
  container.appendChild(label);

  const textarea = document.createElement('textarea');
  textarea.className = 'sti-manual-textarea';
  textarea.rows = 10;
  textarea.placeholder = '在此编辑剧情文本...';
  // 首次进入时用划线文本预填充；之后保留用户编辑
  textarea.value = localText;
  textarea.addEventListener('input', () => {
    localText = textarea.value;
    rebuildSegment();
    renderPreviewOnly();
  });
  container.appendChild(textarea);

  const note = document.createElement('div');
  note.className = 'sti-manual-note';
  const floorHint = selectedFloorSeed >= 0 ? `结果将挂载在第 ${selectedFloorSeed} 楼下方。` : '结果将放入插件作品历史。';
  note.textContent = `已锚定你划线的楼层。${floorHint}`;
  container.appendChild(note);

  return container;
}

/** 局部文本：打开面板时由划线文本初始化 */
let localText: string = '';

// ============================================================
// 模式选择器（多选 checkbox）
// ============================================================

function renderModeSelector(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'sti-mode-selector';

  const label = document.createElement('div');
  label.className = 'sti-selector-label';
  label.textContent = '创作模式（可多选，每个模式各生成一份）：';
  container.appendChild(label);

  const modeList = document.createElement('div');
  modeList.className = 'sti-mode-list';

  for (const mode of Object.keys(MODE_LABELS) as CreationMode[]) {
    const item = document.createElement('label');
    item.className = `sti-mode-item ${selectedModes.has(mode) ? 'active' : ''}`;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.name = 'sti-mode';
    cb.value = mode;
    cb.checked = selectedModes.has(mode);
    cb.addEventListener('change', () => {
      if (cb.checked) selectedModes.add(mode);
      else selectedModes.delete(mode);
      // 至少保留一个
      if (selectedModes.size === 0) {
        selectedModes.add('illustration');
        cb.checked = false;
      }
      item.classList.toggle('active', selectedModes.has(mode));
      // 只需更新按钮状态，不重绘整个面板（避免丢失编辑中的文本）
      updateConfirmButton();
    });
    item.appendChild(cb);

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

/**
 * API 渠道选择窗口：每个创作模式单独指派 LLM 渠道。
 * 渠道列表直接读柏宝绘的共享配置（用户在柏宝绘里加的 NAI5 / NAI4.5 等），本扩展不另造配置界面。
 */
function renderApiChannelSelector(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'sti-api-channel-selector';

  const label = document.createElement('div');
  label.className = 'sti-selector-label';
  label.textContent = 'LLM API 渠道（各模式分开指派；渠道自动同步自柏宝绘）：';
  container.appendChild(label);

  const channels = listSharedChannelInfos();
  const tagGenId = readTagGenChannelId();
  const settings = getSettings(DEFAULT_SETTINGS);
  const modeChannels = settings.modeChannels ?? {};

  if (channels.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'sti-api-hint';
    hint.textContent = '柏宝绘还没有副 API 渠道。在柏宝绘设置里添加渠道后，这里会自动出现，不用重启。';
    container.appendChild(hint);
  }

  const list = document.createElement('div');
  list.className = 'sti-api-channel-list';

  for (const mode of Object.keys(MODE_LABELS) as CreationMode[]) {
    const row = document.createElement('label');
    row.className = 'sti-api-channel-row';

    const name = document.createElement('span');
    name.className = 'sti-api-mode-name';
    name.textContent = MODE_LABELS[mode];
    row.appendChild(name);

    const select = document.createElement('select');
    select.className = 'sti-api-channel-select';

    const tagGenOpt = document.createElement('option');
    tagGenOpt.value = 'tagGen';
    const tagGenChannel = channels.find(c => c.id === tagGenId);
    tagGenOpt.textContent = tagGenId
      ? `跟随柏宝绘 tagGen（${tagGenChannel?.name ?? tagGenId}）`
      : '跟随柏宝绘 tagGen（未指派 → 回退主 API）';
    select.appendChild(tagGenOpt);

    const mainOpt = document.createElement('option');
    mainOpt.value = 'main';
    mainOpt.textContent = '酒馆主 API';
    select.appendChild(mainOpt);

    for (const ch of channels) {
      const opt = document.createElement('option');
      opt.value = ch.id;
      opt.textContent = `${ch.name}${ch.model ? ` · ${ch.model}` : ''}`;
      select.appendChild(opt);
    }

    const current = modeChannels[mode] ?? 'tagGen';
    // 存了已删除的渠道：补一个失效项，避免选中态悄悄丢掉
    if (current !== 'tagGen' && current !== 'main' && !channels.some(c => c.id === current)) {
      const stale = document.createElement('option');
      stale.value = current;
      stale.textContent = `已失效渠道（${current.slice(0, 10)}…）`;
      select.appendChild(stale);
    }
    select.value = current;

    select.addEventListener('change', () => {
      const next = getSettings(DEFAULT_SETTINGS);
      next.modeChannels = { ...(next.modeChannels ?? {}), [mode]: select.value };
      saveSettings(next);
      // 通知运行中的队列刷新 settings 引用，改完立刻生效，不用重启
      window.dispatchEvent(new CustomEvent('sti-settings-changed'));
    });

    row.appendChild(select);
    list.appendChild(row);
  }

  container.appendChild(list);
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

  const info = document.createElement('div');
  info.className = 'sti-preview-info';
  const floorInfo = currentSegment.floorIds.length > 0
    ? `楼层 ${currentSegment.floorIds.join(', ')}`
    : '手动文本';
  info.textContent = `${floorInfo} | ${currentSegment.messages.length} 条消息 | ${currentSegment.text.length} 字`;
  container.appendChild(info);

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

  const textLabel = document.createElement('div');
  textLabel.className = 'sti-selector-label';
  textLabel.textContent = '最终剧情文本（可编辑）：';
  container.appendChild(textLabel);

  const textarea = document.createElement('textarea');
  textarea.className = 'sti-preview-textarea';
  textarea.rows = 6;
  textarea.value = currentSegment.text;
  textarea.addEventListener('input', () => {
    if (currentSegment) currentSegment = { ...currentSegment, text: textarea.value };
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
  cancelBtn.addEventListener('click', () => hideSelectionPanel());
  container.appendChild(cancelBtn);

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'sti-btn sti-btn-confirm';
  confirmBtn.id = 'sti-confirm-btn';
  confirmBtn.textContent = `确认选段 · 生成 ${selectedModes.size} 份`;
  confirmBtn.disabled = !currentSegment;
  confirmBtn.addEventListener('click', () => {
    if (currentSegment && onConfirmCallback) {
      if (!validateSegment(currentSegment)) {
        const warning = document.createElement('div');
        warning.className = 'sti-preview-warning';
        warning.textContent = '选段已失效（聊天切换或消息删除），请重新选择。';
        panelElement?.appendChild(warning);
        return;
      }
      onConfirmCallback(currentSegment, Array.from(selectedModes));
      hideSelectionPanel();
    }
  });
  container.appendChild(confirmBtn);
  return container;
}

function updateConfirmButton(): void {
  const btn = document.getElementById('sti-confirm-btn');
  if (btn) btn.textContent = `确认选段 · 生成 ${selectedModes.size} 份`;
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
  if (currentValue >= 0) select.value = String(currentValue);
  select.addEventListener('change', () => onChange(parseInt(select.value, 10)));
  return select;
}

function rebuildSegment(): void {
  switch (currentMethod) {
    case 'local':
    case 'manual':
      // 局部文本锚定划线楼层；若用户清空文本则用划线原文兜底
      currentSegment = localText.trim()
        ? buildManualSegment(localText, selectedFloorSeed >= 0 ? [selectedFloorSeed] : [])
        : null;
      break;
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
  }
}

export function destroySelectionPanel(): void {
  if (panelElement) { panelElement.remove(); panelElement = null; }
  if (overlayElement) { overlayElement.remove(); overlayElement = null; }
  onConfirmCallback = null;
  currentSegment = null;
}
