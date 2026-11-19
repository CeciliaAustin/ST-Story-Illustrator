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
import {
  buildSingleSegment,
  buildRangeSegment,
  buildPickedSegment,
  buildManualSegment,
  defaultFloor,
  getAvailableFloors,
  getChatFloorCount,
  validateSegment,
} from '../selection/storySegment';
import type { FloorOption } from '../selection/storySegment';
import { listSharedChannelInfos, readTagGenChannelId } from '../baibai/secondaryLlm';
import { readOutConfig } from '../baibai/planConfig';
import { buildStudioTabs } from './studio';

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
/** 是否把隐藏楼层（is_system）也列出来供选择 */
let includeHiddenFloors = false;
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
  const floors = getAvailableFloors({ includeHidden: includeHiddenFloors });

  panelElement.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'sti-panel-title';
  title.textContent = '生成配图';
  panelElement.appendChild(title);
  panelElement.appendChild(buildStudioTabs('generate'));

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
  // 「局部」不列楼层，无需隐藏楼层开关
  if (currentMethod !== 'local' && currentMethod !== 'manual') {
    content.appendChild(renderHiddenToggle());
  }
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
  panelElement.appendChild(renderLlmChannelSelector());
  panelElement.appendChild(renderOutPlanSelector());
  panelElement.appendChild(renderPreview());
  panelElement.appendChild(renderActions());
}

/**
 * 「查看所有楼层」开关。
 * ST 的隐藏楼层就是 is_system，默认被过滤，勾上后一并列出（标「隐藏」）。
 */
function renderHiddenToggle(): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'sti-hidden-toggle';

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = includeHiddenFloors;
  cb.addEventListener('change', () => {
    includeHiddenFloors = cb.checked;
    // 楼层列表变了，需要整体重绘
    renderPanel();
  });
  wrap.appendChild(cb);

  const text = document.createElement('span');
  text.textContent = '查看所有楼层（含已隐藏的楼层）';
  wrap.appendChild(text);

  return wrap;
}

/** 楼层选项的显示文本，隐藏楼层加标记。 */
function floorOptionText(f: FloorOption, previewLen = 40): string {
  const mark = f.hidden ? '（隐藏）' : '';
  return `[${f.floor}]${mark} ${f.speaker}: ${f.preview.slice(0, previewLen)}...`;
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

function renderSingleSelector(floors: FloorOption[]): HTMLElement {
  const container = document.createElement('div');
  container.className = 'sti-selector-container';

  const label = document.createElement('div');
  label.className = 'sti-selector-label';
  label.textContent = `选择楼层（共 ${floors.length} 层可选）：`;
  container.appendChild(label);

  const select = document.createElement('select');
  select.className = 'sti-floor-select';
  for (const f of floors) {
    const opt = document.createElement('option');
    opt.value = String(f.floor);
    opt.textContent = floorOptionText(f);
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
// 范围选择器（直接填楼层号）
// ============================================================

function renderRangeSelector(floors: FloorOption[]): HTMLElement {
  const container = document.createElement('div');
  container.className = 'sti-selector-container';

  const total = getChatFloorCount();
  const hint = document.createElement('div');
  hint.className = 'sti-selector-label';
  hint.textContent = `填写楼层区间（当前共 ${total} 层，楼层号 0–${Math.max(0, total - 1)}）：`;
  container.appendChild(hint);

  const rangeRow = document.createElement('div');
  rangeRow.className = 'sti-range-row';

  const startLabel = document.createElement('span');
  startLabel.textContent = '从';
  rangeRow.appendChild(startLabel);

  const startInput = createFloorNumberInput(rangeStart, total, (val) => {
    rangeStart = val;
    rebuildSegment();
    // 区间变化会影响排除列表，整体重绘该区域
    renderPanel();
  });
  rangeRow.appendChild(startInput);

  const dash = document.createElement('span');
  dash.textContent = '到';
  rangeRow.appendChild(dash);

  const endInput = createFloorNumberInput(rangeEnd, total, (val) => {
    rangeEnd = val;
    rebuildSegment();
    renderPanel();
  });
  rangeRow.appendChild(endInput);

  const unit = document.createElement('span');
  unit.textContent = '楼';
  rangeRow.appendChild(unit);

  container.appendChild(rangeRow);

  if (rangeStart >= 0 && rangeEnd >= 0 && floors.length > 0) {
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
        item.className = `sti-exclude-item ${f.hidden ? 'is-hidden-floor' : ''}`;
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = excludedFloors.has(f.floor);
        cb.addEventListener('change', () => {
          if (cb.checked) excludedFloors.add(f.floor);
          else excludedFloors.delete(f.floor);
          rebuildSegment(); renderPreviewOnly();
        });
        item.appendChild(cb);
        item.appendChild(document.createTextNode(` ${floorOptionText(f, 50)}`));
        excludeList.appendChild(item);
      }
      container.appendChild(excludeList);
    }
  }

  if (rangeStart >= 0 && rangeEnd >= 0 && Math.abs(rangeEnd - rangeStart) + 1 > 50) {
    const warn = document.createElement('div');
    warn.className = 'sti-manual-note';
    warn.textContent = '区间超过 50 层，只会取前 50 条消息。';
    container.appendChild(warn);
  }

  // 区间里有被隐藏的楼层时提醒：不勾「查看所有楼层」会被跳过
  if (!includeHiddenFloors && rangeStart >= 0 && rangeEnd >= 0) {
    const lo = Math.min(rangeStart, rangeEnd);
    const hi = Math.max(rangeStart, rangeEnd);
    const hiddenCount = getAvailableFloors({ includeHidden: true })
      .filter(f => f.hidden && f.floor >= lo && f.floor <= hi).length;
    if (hiddenCount > 0) {
      const warn = document.createElement('div');
      warn.className = 'sti-manual-note';
      warn.textContent = `该区间有 ${hiddenCount} 层是隐藏楼层，当前会被跳过。需要的话勾选上方「查看所有楼层」。`;
      container.appendChild(warn);
    }
  }

  return container;
}

/** 楼层号数字输入（允许直接敲，失焦/回车后生效）。 */
function createFloorNumberInput(
  currentValue: number,
  total: number,
  onChange: (val: number) => void,
): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'sti-floor-number';
  input.min = '0';
  input.max = String(Math.max(0, total - 1));
  input.value = currentValue >= 0 ? String(currentValue) : '';
  input.placeholder = '0';
  const commit = () => {
    const raw = input.value.trim();
    if (raw === '') return;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return;
    onChange(Math.max(0, Math.min(total - 1, n)));
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
  });
  return input;
}

// ============================================================
// 勾选选择器
// ============================================================

function renderPickedSelector(floors: FloorOption[]): HTMLElement {
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
    item.className = `sti-picked-item ${f.hidden ? 'is-hidden-floor' : ''}`;
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
    item.appendChild(document.createTextNode(` ${floorOptionText(f, 50)}`));
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
      item.classList.toggle('active', selectedModes.has(mode));
      // 点完就取消焦点：主题把 :focus 画成主题色描边（很多主题是粉红），
      // 焦点留在框上看着就像「还勾着」，用户会以为没取消。
      cb.blur();
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

  const hint = document.createElement('div');
  hint.className = 'sti-mode-hint';
  hint.id = 'sti-mode-hint';
  hint.textContent = '至少选一个创作模式才能生成。';
  hint.style.display = selectedModes.size === 0 ? '' : 'none';
  container.appendChild(hint);

  return container;
}

/**
 * LLM 渠道选择窗口：每个创作模式单独指派「读剧情 / 写 Tag」用的 LLM。
 * 渠道列表直接读柏宝绘的共享配置（用户在柏宝绘里加的 ds3.2 等），本扩展不另造配置界面。
 */
function renderLlmChannelSelector(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'sti-api-channel-selector';

  const label = document.createElement('div');
  label.className = 'sti-selector-label';
  label.textContent = 'LLM 渠道（读剧情 / 写 Tag；各模式分开指派，渠道同步自柏宝绘）：';
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
// 出图方案选择器（各模式分开指派柏宝绘方案）
// ============================================================

/**
 * 出图方案选择窗口：每个创作模式指定用柏宝绘的哪套出图方案（模型 / 接入点 / 尺寸）。
 *
 * 技术约束：柏宝绘公开出图接口不接受 planId，只能用它自己的「当前方案」。
 * 所以出图前会把这套方案切成当前（走柏宝绘自己的切换逻辑），串行队列天然安全。
 */
function renderOutPlanSelector(): HTMLElement {
  const container = document.createElement('div');
  container.className = 'sti-api-channel-selector';

  const label = document.createElement('div');
  label.className = 'sti-selector-label';
  label.textContent = '出图方案（各模式分开指派，方案同步自柏宝绘）：';
  container.appendChild(label);

  const snap = readOutConfig();
  const settings = getSettings(DEFAULT_SETTINGS);
  const modePlans = settings.modeOutPlans ?? {};

  if (snap.plans.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'sti-api-hint';
    hint.textContent = '柏宝绘里还没有出图方案。先去柏宝绘新建一套方案（例如 NAI4.5 省钱方案），这里会自动出现。';
    container.appendChild(hint);
    return container;
  }

  const list = document.createElement('div');
  list.className = 'sti-api-channel-list';

  // 正文插画不列：它固定用柏宝绘当前方案（用户自己选的那套），插件不切。
  // 小剧场切走方案后会自己切回来，所以也不影响正文。
  const note = document.createElement('div');
  note.className = 'sti-api-hint';
  note.textContent = '正文插画固定用柏宝绘当前方案，这里不参与切换；下面几套出完图会自动切回原方案。';
  list.appendChild(note);

  for (const mode of Object.keys(MODE_LABELS) as CreationMode[]) {
    if (mode === 'illustration') continue;
    const row = document.createElement('label');
    row.className = 'sti-api-channel-row';

    const name = document.createElement('span');
    name.className = 'sti-api-mode-name';
    name.textContent = MODE_LABELS[mode];
    row.appendChild(name);

    const select = document.createElement('select');
    select.className = 'sti-api-channel-select';

    const followOpt = document.createElement('option');
    followOpt.value = 'current';
    followOpt.textContent = `跟随当前方案（${snap.activePlanName || '未设置'}）`;
    select.appendChild(followOpt);

    for (const plan of snap.plans) {
      const opt = document.createElement('option');
      opt.value = plan.id;
      const family = plan.modelFamily !== 'unknown' ? ` · NAI${plan.modelFamily}` : '';
      opt.textContent = `${plan.name}${family} · ${plan.endpointName}`
        + (plan.layoutWords.length ? ' · ⚠整页' : '');
      select.appendChild(opt);
    }

    const current = modePlans[mode] ?? 'current';
    // 方案被删了：补一个失效项，别让选中态悄悄丢
    if (current !== 'current' && !snap.plans.some(p => p.id === current)) {
      const stale = document.createElement('option');
      stale.value = current;
      stale.textContent = `已失效方案（${current.slice(0, 8)}…）`;
      select.appendChild(stale);
    }
    select.value = current;

    select.addEventListener('change', () => {
      const next = getSettings(DEFAULT_SETTINGS);
      const map = { ...(next.modeOutPlans ?? {}) };
      if (select.value === 'current') delete map[mode];
      else map[mode] = select.value;
      next.modeOutPlans = map;
      saveSettings(next);
      window.dispatchEvent(new CustomEvent('sti-settings-changed'));
    });

    row.appendChild(select);
    list.appendChild(row);
  }

  container.appendChild(list);

  const hint = document.createElement('div');
  hint.className = 'sti-api-hint';
  hint.textContent = '指了方案的模式，出图前会先把柏宝绘切成该方案（可能短暂弹出柏宝绘面板）。'
    + '柏宝绘的「当前方案」是全局的，所以切换对所有用柏宝绘出图的地方都生效。';
  container.appendChild(hint);

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
  const btn = document.getElementById('sti-confirm-btn') as HTMLButtonElement | null;
  if (btn) {
    btn.textContent = selectedModes.size > 0
      ? `确认选段 · 生成 ${selectedModes.size} 份`
      : '请至少选一个创作模式';
    // 一个都没选时直接禁用：以前会偷偷把「正文插画」塞回去，
    // 结果是行还高亮着（主题色边框，看着像勾着）却没真选中。
    btn.disabled = !currentSegment || selectedModes.size === 0;
  }
  const hint = document.getElementById('sti-mode-hint');
  if (hint) hint.style.display = selectedModes.size === 0 ? '' : 'none';
}

// ============================================================
// 辅助
// ============================================================

function rebuildSegment(): void {
  const options = { includeHidden: includeHiddenFloors };
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
        ? buildSingleSegment(selectedSingleFloor, options)
        : null;
      break;
    case 'range':
      currentSegment = rangeStart >= 0 && rangeEnd >= 0
        ? buildRangeSegment(rangeStart, rangeEnd, Array.from(excludedFloors), options)
        : null;
      break;
    case 'picked':
      currentSegment = pickedFloors.length > 0
        ? buildPickedSegment(pickedFloors, options)
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
