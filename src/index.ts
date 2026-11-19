/**
 * ST-Story-Illustrator — 扩展入口
 *
 * 作为 SillyTavern 第三方扩展加载。负责：
 * - 初始化 ST 环境访问、加载设置、注册事件
 * - 选区监听 → 选段面板 → 确认 → 创建 VisualTask → 串行任务队列
 * - 各模式工作流（插画/漫画/小剧场）→ 出图 → 落盘 → 楼层挂载
 */

import './styles/style.css';

import { initSTEnvironment, getEventTypes, on, getSettings, lastAssistantFloor } from './host/sillytavern';
import { checkAvailability, waitForApi, isAvailable } from './baibai/bridge';
import { startSelectionListener, stopSelectionListener, isSelectionInMesText, getSelectionText } from './selection/selector';
import { resolveFloorFromSelection } from './selection/floorResolver';
import { buildAnchor, extractPlainText } from './selection/anchor';
import { showToolbar, hideToolbar, setOnGenerate, destroyToolbar } from './ui/selectionToolbar';
import { showSelectionPanel, hideSelectionPanel, destroySelectionPanel } from './ui/selectionPanel';
import { setSegmentCleanOptions } from './selection/storySegment';
import { destroyLightbox } from './ui/lightbox';
import { destroyConfigPanel, hideConfigPanel, showConfigPanel } from './ui/configPanel';
import { remountAll, mountFloor } from './ui/floorCards';
import { mountTheater, remountAllTheater } from './theater/mount';
import { registerStudio, openStudio } from './ui/studio';
import { injectWandMenu, destroyWandMenu } from './ui/wandMenu';
import { mountFloatingBall, syncFloatingBall, unmountFloatingBall } from './ui/floatingBall';
import {
  clearRunStatus,
  destroyRunStatus,
  finishRunStatus,
  setRunStatusLogOpener,
  updateRunStatus,
} from './ui/runStatus';
import { hasStory } from './theater/store';
import { getArtifacts } from './storage/repository';
import { buildSingleSegment } from './selection/storySegment';
import {
  DEFAULT_SETTINGS,
  resolveModeSettings,
  type StoryIllustratorSettings,
  type CreationMode,
  type StorySegment,
} from './types';
import { TaskQueue } from './tasks/taskQueue';
import { createTaskRunner, createVisualTask, MODE_LABEL } from './tasks/workflow';

// ============================================================
// 模块状态
// ============================================================

let initialized = false;
let settings: StoryIllustratorSettings = { ...DEFAULT_SETTINGS };
const cleanupFunctions: Array<() => void> = [];
let queue: TaskQueue | null = null;
/** 状态条跟踪的是哪一条任务（换任务时重新计时的依据） */
let runTaskId = '';

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
    registerStudio({
      generate: (options) => { hideConfigPanel(); openGeneratePanel(options); },
      settings: () => { hideSelectionPanel(); showConfigPanel('settings'); },
      log: () => { hideSelectionPanel(); hideConfigPanel(); showConfigPanel('log'); },
    });
    setRunStatusLogOpener(() => openStudio('log'));
    registerEvents();
    setupSelectionListener();
    cleanupFunctions.push(injectWandMenu());
    mountFloatingBall();
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
    taskTimeoutMs: 12 * 60 * 1000,
    onStatusChange: (task, status) => {
      console.log(`[ST-Story-Illustrator] 任务 ${task.id} → ${status}`);
      // 状态条：排队/读剧情/出图 都显示；完成与失败各自收尾。
      // 一次多选会连着跑几个任务，换任务时从零计时（否则显示的是上一个任务的时长）。
      if (status === 'queued' || status === 'reading' || status === 'review' || status === 'generating') {
        if (runTaskId !== task.id) {
          runTaskId = task.id;
          clearRunStatus();
        }
        updateRunStatus({
          mode: task.mode,
          stage: status,
          ...(task.progress?.page ? { page: task.progress.page } : {}),
          ...(task.progress?.totalPages ? { totalPages: task.progress.totalPages } : {}),
        });
      } else if (status === 'completed') {
        finishRunStatus('ok');
        runTaskId = '';
      } else if (status === 'failed') {
        finishRunStatus('error', task.error ?? '未知错误');
        runTaskId = '';
      } else if (status === 'cancelled') {
        finishRunStatus('error', '已取消');
        runTaskId = '';
      }
    },
    onProgress: (task, progress) => {
      updateRunStatus({
        mode: task.mode,
        stage: progress.stage,
        ...(progress.page ? { page: progress.page } : {}),
        ...(progress.totalPages ? { totalPages: progress.totalPages } : {}),
      });
    },
    onError: (task, error) => {
      console.error(`[ST-Story-Illustrator] 任务 ${task.id} 失败:`, error);
      // 带上模式名：多选一起生成时，只报「生成失败」根本分不清是哪一份
      showToast(`${MODE_LABEL[task.mode]} 生成失败：${error.message}`, 'error');
    },
  });
}

function remountAllSafe(): void {
  try { remountAll(); } catch (e) { console.warn('[ST-Story-Illustrator] 挂载历史作品失败:', e); }
  try { remountAllTheater(); } catch (e) { console.warn('[ST-Story-Illustrator] 挂载小剧场失败:', e); }
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
    syncFloatingBall();
  });
  cleanupFunctions.push(offSettings);

  // 选段弹窗里改了「模式 → LLM 渠道 / 出图方案」后，立即刷新运行中的设置引用，无需重启酒馆
  const onModeSettingsChanged = () => {
    settings = getSettings(DEFAULT_SETTINGS);
    applySettings();
    queue = null;
    initQueue();
    syncFloatingBall();
  };
  window.addEventListener('sti-settings-changed', onModeSettingsChanged);
  cleanupFunctions.push(() => window.removeEventListener('sti-settings-changed', onModeSettingsChanged));

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
  cleanupFunctions.push(on(events.CHARACTER_MESSAGE_RENDERED, (...args: unknown[]) => {
    reMount(...args);
    const floor = extractFloorFromEventArg(args[0]);
    if (floor >= 0) maybeAutoTrigger(floor);
  }));
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
    if (valid && selection && settings.showSelectionToolbar !== false) showToolbar(selection);
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

/**
 * 面板入口（悬浮球 / 魔杖菜单）。
 * 没有划线时：默认定位到最后一层 AI 回复，从「单楼」开始。
 */
function openGeneratePanel(options?: { floor?: number; text?: string }): void {
  hideToolbar();
  const text = (options?.text ?? '').trim();
  const floor = typeof options?.floor === 'number' ? options.floor : lastAssistantFloor();

  if (text) {
    showSelectionPanel(
      {
        ...(floor >= 0 ? { initialFloor: floor } : {}),
        selectedText: text,
        startAtLocal: true,
      },
      handleSegmentConfirmed,
    );
  } else {
    showSelectionPanel(
      { ...(floor >= 0 ? { initialFloor: floor } : {}), startAtLocal: false },
      handleSegmentConfirmed,
    );
  }
}

// ============================================================
// 自动出图（新楼层）
// ============================================================

const autoRunning = new Set<string>();

/** 按设置决定这一层要不要自动出图；只出一次，失败不重试。 */
function maybeAutoTrigger(floor: number): void {
  if (!isAvailable()) return;
  if (settings.enabled === false) return;

  const orders: Array<{ mode: CreationMode; kind?: 'status' | 'bonus' | 'manga' }> = [
    // 正文两套排前面：它们是「正文的图」，出完正文就完整了；
    // 小剧场是附加物，后出不影响阅读。
    { mode: 'illustration' },
    { mode: 'comic' },
    { mode: 'chibi-status', kind: 'status' },
    { mode: 'chibi-bonus', kind: 'bonus' },
    { mode: 'bw-manga', kind: 'manga' },
  ];

  const picks: CreationMode[] = [];
  for (const { mode, kind } of orders) {
    const conf = resolveModeSettings(settings, mode);
    if (!conf.autoTrigger) continue;
    if (kind && hasStory(floor, kind)) continue;
    // 正文两套：本楼已经有作品就不再自动插（刷新/重渲会重复触发）
    if (!kind && getArtifacts(floor).some(a => a.mode === mode)) continue;
    if (kind === 'bonus') {
      const chance = Number(conf.chibiBonusChance ?? settings.chibiBonusChance ?? 25);
      if (chance <= 0) continue;
      if (chance < 100 && Math.random() * 100 >= chance) continue;
    }
    const key = `${floor}:${mode}`;
    if (autoRunning.has(key)) continue;
    picks.push(mode);
  }
  if (picks.length === 0) return;

  const segment = buildSingleSegment(floor);
  if (!segment) return;

  for (const mode of picks) {
    autoRunning.add(`${floor}:${mode}`);
    const task = createVisualTask(segment, mode);
    task.status = 'queued';
    queue?.enqueue(task);
  }
  showToast(`本楼自动生成 ${picks.length} 份，排队中。`, 'info');
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
  destroyConfigPanel();
  destroyWandMenu();
  unmountFloatingBall();
  destroyRunStatus();
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
