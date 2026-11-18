/**
 * ST-Story-Illustrator — 扩展入口
 *
 * 作为 SillyTavern 第三方扩展加载。负责：
 * - 初始化 ST 环境访问、加载设置、注册事件
 * - 选区监听 → 选段面板 → 确认 → 创建 VisualTask → 串行任务队列
 * - 各模式工作流（插画/漫画/小剧场）→ 出图 → 落盘 → 楼层挂载
 */

import './styles/style.css';

import { initSTEnvironment, getEventTypes, on, getSettings } from './host/sillytavern';
import { checkAvailability, waitForApi, isAvailable } from './baibai/bridge';
import { startSelectionListener, stopSelectionListener, isSelectionInMesText, getSelectionText } from './selection/selector';
import { resolveFloorFromSelection } from './selection/floorResolver';
import { buildAnchor, extractPlainText } from './selection/anchor';
import { showToolbar, hideToolbar, setOnGenerate, destroyToolbar } from './ui/selectionToolbar';
import { showSelectionPanel, hideSelectionPanel, destroySelectionPanel } from './ui/selectionPanel';
import { setSegmentCleanOptions } from './selection/storySegment';
import { destroyLightbox } from './ui/lightbox';
import { remountAll, mountFloor } from './ui/floorCards';
import { mountTheater } from './theater/mount';
import {
  DEFAULT_SETTINGS,
  type StoryIllustratorSettings,
  type CreationMode,
  type StorySegment,
} from './types';
import { TaskQueue } from './tasks/taskQueue';
import { createTaskRunner, createVisualTask } from './tasks/workflow';

// ============================================================
// 模块状态
// ============================================================

let initialized = false;
let settings: StoryIllustratorSettings = { ...DEFAULT_SETTINGS };
const cleanupFunctions: Array<() => void> = [];
let queue: TaskQueue | null = null;

// ============================================================
// 扩展入口
// ============================================================

export async function onActivate(): Promise<void> {
  if (initialized) return;
  console.log('[ST-Story-Illustrator] 开始初始化...');

  try {
    const stReady = await initSTEnvironment();
    if (!stReady) {
      console.warn('[ST-Story-Illustrator] SillyTavern 环境未就绪，扩展将以降级模式运行。');
    }

    settings = getSettings(DEFAULT_SETTINGS);
    applySettings();
    registerEvents();
    setupSelectionListener();
    initQueue();
    remountAllSafe();

    void waitForApi(10).then(result => {
      if (result.status === 'available') {
        console.log('[ST-Story-Illustrator] 柏宝绘 API 已就绪:', result.api.apiVersion);
      } else if (result.status === 'not_installed') {
        console.info('[ST-Story-Illustrator] 柏宝绘未安装。配图不可用，选段功能正常。');
      } else if (result.status === 'version_mismatch') {
        console.warn('[ST-Story-Illustrator] 柏宝绘 API 版本不兼容:', result.apiVersion);
      }
    });

    initialized = true;
    console.log('[ST-Story-Illustrator] 初始化完成。');
  } catch (err) {
    console.error('[ST-Story-Illustrator] 初始化失败:', err);
  }
}

function initQueue(): void {
  const runner = createTaskRunner({
    settings: settings.profiles ?? [],
    fullSettings: settings,
  });
  queue = new TaskQueue(runner, {
    taskTimeoutMs: 5 * 60 * 1000,
    onStatusChange: (task, status) => {
      console.log(`[ST-Story-Illustrator] 任务 ${task.id} → ${status}`);
    },
    onError: (task, error) => {
      console.error(`[ST-Story-Illustrator] 任务 ${task.id} 失败:`, error);
      showToast(`生成失败：${error.message}`, 'error');
    },
  });
}

function remountAllSafe(): void {
  try { remountAll(); } catch (e) { console.warn('[ST-Story-Illustrator] 挂载历史作品失败:', e); }
}

/** 把设置应用到各子模块（清洗策略等）。 */
function applySettings(): void {
  setSegmentCleanOptions({
    syncBaiBai: settings.syncBaiBaiExcludes ?? true,
    preferContent: settings.preferContentTag ?? true,
  });
}

// ============================================================
// 事件注册
// ============================================================

function registerEvents(): void {
  const events = getEventTypes();

  const offSettings = on(events.EXTENSION_SETTINGS_LOADED, () => {
    settings = getSettings(DEFAULT_SETTINGS);
    applySettings();
    queue = null;
    initQueue(); // 设置变化后用最新 profile/settings 重建队列
  });
  cleanupFunctions.push(offSettings);

  // 选段弹窗里改了「模式 → API 渠道」后，立即刷新运行中的设置引用，无需重启酒馆
  const onModeChannelsChanged = () => {
    settings = getSettings(DEFAULT_SETTINGS);
    applySettings();
    queue = null;
    initQueue();
  };
  window.addEventListener('sti-settings-changed', onModeChannelsChanged);
  cleanupFunctions.push(() => window.removeEventListener('sti-settings-changed', onModeChannelsChanged));

  const offReady = on(events.APP_READY, () => {
    const result = checkAvailability();
    if (result.status === 'available') {
      console.log('[ST-Story-Illustrator] 应用就绪，柏宝绘可用。');
    }
  });
  cleanupFunctions.push(offReady);

  const offChatChanged = on(events.CHAT_CHANGED, () => {
    hideToolbar();
    hideSelectionPanel();
    queue?.cancelAll();
  });
  cleanupFunctions.push(offChatChanged);

  const offDeleted = on(events.MESSAGE_DELETED, () => {
    hideToolbar();
    hideSelectionPanel();
  });
  cleanupFunctions.push(offDeleted);

  // 消息渲染 / swipe 后重挂该楼层作品与小剧场
  const reMount = (...args: unknown[]) => {
    const floor = extractFloorFromEventArg(args[0]);
    if (floor >= 0) {
      try { mountFloor(floor); mountTheater(floor); } catch { /* ignore */ }
    }
  };
  cleanupFunctions.push(on(events.CHARACTER_MESSAGE_RENDERED, reMount));
  cleanupFunctions.push(on(events.MESSAGE_SWIPED, reMount));
}

function extractFloorFromEventArg(arg: unknown): number {
  if (typeof arg === 'number') return arg;
  if (arg && typeof arg === 'object') {
    const o = arg as Record<string, unknown>;
    const v = o.mesid ?? o.messageId ?? o.floor;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const n = parseInt(v, 10);
      if (Number.isFinite(n)) return n;
    }
  }
  return -1;
}

// ============================================================
// 选区监听
// ============================================================

function setupSelectionListener(): void {
  setOnGenerate(handleGenerateFromSelection);
  startSelectionListener((valid: boolean, selection: Selection | null) => {
    if (!settings.enabled && !isAvailable()) {
      hideToolbar();
      return;
    }
    if (valid && selection) showToolbar(selection);
    else hideToolbar();
  });
}

function handleGenerateFromSelection(): void {
  const selection = window.getSelection();
  if (!selection || !isSelectionInMesText(selection)) {
    console.warn('[ST-Story-Illustrator] 无有效选区。');
    return;
  }

  const selectedText = getSelectionText(selection);
  if (!selectedText) {
    console.warn('[ST-Story-Illustrator] 选区文本为空。');
    return;
  }

  const floor = resolveFloorFromSelection(selection);
  if (!floor) {
    showToast('无法定位选区所属楼层，请重新选择。', 'warn');
    return;
  }

  const mesTextEl = document.querySelector<HTMLElement>(`.mes[mesid="${floor.mesId}"] .mes_text`);
  const floorText = mesTextEl ? extractPlainText(mesTextEl) : '';
  const anchor = buildAnchor(selectedText, floorText, 0);
  console.log('[ST-Story-Illustrator] 选区已捕获:', { floor: floor.mesId, textLength: selectedText.length, anchor });

  const availability = checkAvailability();
  if (availability.status !== 'available') {
    const msg = availability.status === 'not_installed'
      ? '柏宝绘未安装。选段已捕获，但配图功能不可用。'
      : `柏宝绘 API 不可用（${availability.status}）。选段已捕获，但配图不可用。`;
    showToast(msg, 'warn');
  }

  showSelectionPanel(
    { initialFloor: floor.mesId, selectedText: selectedText, startAtLocal: true },
    handleSegmentConfirmed,
  );
  hideToolbar();
}

function handleSegmentConfirmed(segment: StorySegment, modes: CreationMode[]): void {
  console.log('[ST-Story-Illustrator] 选段已确认:', {
    modes, sourceKind: segment.sourceKind, floorIds: segment.floorIds,
    textLength: segment.text.length, messageCount: segment.messages.length,
  });

  if (!isAvailable()) {
    showToast('柏宝绘不可用，无法生成。请确认柏宝绘已安装且版本兼容。', 'warn');
    return;
  }

  if (!queue) initQueue();
  // 每个选中的模式各排一个任务（复用同一段剧情）
  for (const mode of modes) {
    const task = createVisualTask(segment, mode);
    queue?.enqueue(task);
  }
  showToast(`已加入 ${modes.length} 个生成任务，开始处理。`, 'info');
}

// ============================================================
// 工具函数
// ============================================================

function showToast(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  const toastr = (window as unknown as Record<string, Record<string, ((m: string) => void) | undefined> | undefined>).toastr;
  if (toastr) {
    if (level === 'error') toastr.error?.(message);
    else if (level === 'warn') toastr.warning?.(message);
    else toastr.info?.(message);
  } else {
    if (level === 'error') console.error(message);
    else if (level === 'warn') console.warn(message);
    else console.info(message);
  }
}

export function onDisable(): void {
  console.log('[ST-Story-Illustrator] 卸载中...');
  queue?.cancelAll();
  stopSelectionListener();
  destroyToolbar();
  destroySelectionPanel();
  destroyLightbox();
  for (const cleanup of cleanupFunctions) {
    try { cleanup(); } catch { /* ignore */ }
  }
  cleanupFunctions.length = 0;
  initialized = false;
  console.log('[ST-Story-Illustrator] 卸载完成。');
}

export default {
  onActivate,
  onDisable,
};
