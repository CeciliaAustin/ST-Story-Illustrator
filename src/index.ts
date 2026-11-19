/**
 * ST-Story-Illustrator — 扩展入口
 *
 * 作为 SillyTavern 第三方扩展加载。负责：
 * - 初始化 ST 环境访问、加载设置、注册事件
 * - 选区监听 → 选段面板 → 确认 → 创建 VisualTask → 串行任务队列
 * - 各模式工作流（插画/漫画/小剧场）→ 出图 → 落盘 → 楼层挂载
 */

import './styles/style.css';

import {
  initSTEnvironment,
  getEventTypes,
  on,
  getSettings,
  getMessage,
  isAiStoryMessage,
  lastAssistantFloor,
} from './host/sillytavern';
import { checkAvailability, waitForApi, isAvailable } from './baibai/bridge';
import { startSelectionListener, stopSelectionListener, isSelectionInMesText, getSelectionText } from './selection/selector';
import { resolveFloorFromSelection } from './selection/floorResolver';
import { buildAnchor, extractPlainText } from './selection/anchor';
import { showToolbar, hideToolbar, setOnGenerate, destroyToolbar } from './ui/selectionToolbar';
import { showSelectionPanel, hideSelectionPanel, destroySelectionPanel } from './ui/selectionPanel';
import { setSegmentCleanOptions } from './selection/storySegment';
import { destroyLightbox } from './ui/lightbox';
import { destroyPromptDialog } from './ui/promptDialog';
import { destroyConfigPanel, hideConfigPanel, showConfigPanel } from './ui/configPanel';
import { remountAll, mountFloor, ensureFloorMounted } from './ui/floorCards';
import { mountTheater, remountAllTheater, ensureTheaterMounted } from './theater/mount';
import { onChatMutation, destroyChatObserver } from './host/domObserver';
import { ensureManwaRegexRegistered } from './baibai/manwaTag';
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
  type StoryIllustratorSettings,
  type CreationMode,
  type StorySegment,
} from './types';
import { TaskQueue } from './tasks/taskQueue';
import { createTaskRunner, createVisualTask, MODE_LABEL } from './tasks/workflow';
import { pickAutoModes } from './tasks/autoTrigger';

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
      prompts: () => { hideSelectionPanel(); showConfigPanel('prompts'); },
      log: () => { hideSelectionPanel(); hideConfigPanel(); showConfigPanel('log'); },
    });
    setRunStatusLogOpener(() => openStudio('log'));
    registerEvents();
    ensureManwaRegex();
    setupSelectionListener();
    cleanupFunctions.push(injectWandMenu());
    mountFloatingBall();
    initQueue();
    remountAllSafe();
    // 刷新/切聊天/柏宝绘重写楼层都不会发渲染事件，自愈只能靠观察器
    cleanupFunctions.push(onChatMutation(reconcileRendered));

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
        // 成功但需要提醒的事（例如「角色库里没有 Julian」）走这里：
        // 不报的话用户只会觉得「怎么又不像我的人」，永远想不到是角色库缺条目。
        finishRunStatus('ok', task.progress?.message ?? '');
        if (task.progress?.message) showToast(task.progress.message, 'warn');
        releaseAutoKey(task);
        runTaskId = '';
      } else if (status === 'failed') {
        finishRunStatus('error', task.error ?? '未知错误');
        releaseAutoKey(task);
        runTaskId = '';
      } else if (status === 'cancelled') {
        finishRunStatus('error', '已取消');
        releaseAutoKey(task);
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

/**
 * 注册漫画 tag 的托管正则（`<bbi_manwa>` → 锚点 / 提示词侧删除）。
 *
 * 这一步必须在「能写 tag」之前成功，否则正文里会出现一串裸的 `<bbi_manwa>`。
 * ST 的 `extension_settings` 在扩展激活早期偶尔还没就绪，所以失败要重试几次。
 */
function ensureManwaRegex(): void {
  if (ensureManwaRegexRegistered()) return;
  let tries = 0;
  const timer = window.setInterval(() => {
    tries += 1;
    if (ensureManwaRegexRegistered() || tries > 20) window.clearInterval(timer);
  }, 500);
  cleanupFunctions.push(() => window.clearInterval(timer));
}

function remountAllSafe(): void {
  try { remountAll(); } catch (e) { console.warn('[ST-Story-Illustrator] 挂载历史作品失败:', e); }
  try { remountAllTheater(); } catch (e) { console.warn('[ST-Story-Illustrator] 挂载小剧场失败:', e); }
}

/**
 * 逐楼对账：该有的卡片在不在，缺了才补。
 *
 * 跑在 `#chat` 的 MutationObserver 上。ST 打开聊天时是**整批重建** `.mes` 且
 * **不发渲染事件**，所以「刷新后小剧场全没了」只能靠这条兜住；单条消息被
 * `.mes_text.html()` 重写（柏宝绘图出来之后就会这么干）同样靠它补回来。
 */
function reconcileRendered(): void {
  for (const node of Array.from(document.querySelectorAll<HTMLElement>('.mes[mesid]'))) {
    const floor = parseInt(node.getAttribute('mesid') ?? '', 10);
    if (!Number.isFinite(floor)) continue;
    try { ensureFloorMounted(floor); } catch { /* 单楼失败不影响其它楼层 */ }
    try { ensureTheaterMounted(floor); } catch { /* 同上 */ }
  }
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
    // 上一条聊天里没等到渲染的标记必须清掉：楼层号在另一条聊天里没有意义
    autoPending.clear();
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
  // 只有「这一层刚到」才配自动出图。不能直接挂在渲染事件上：
  // 打开聊天 / 切聊天时 ST 会把整段历史重新渲染一遍，每一条都会触发，
  // 轻则给历史楼层补一堆图，重则几十个任务同时排队。
  const offReceived = on(events.MESSAGE_RECEIVED, (...args: unknown[]) => {
    const floor = extractFloorFromEventArg(args[0]);
    if (floor < 0) return;
    if (!isAiStoryMessage(getMessage(floor))) return;
    autoPending.add(floor);
  });
  cleanupFunctions.push(offReceived);

  cleanupFunctions.push(on(events.CHARACTER_MESSAGE_RENDERED, (...args: unknown[]) => {
    reMount(...args);
    const floor = extractFloorFromEventArg(args[0]);
    // 标记只看一次：这条渲染是新楼层才算，历史重渲直接忽略
    if (floor >= 0 && autoPending.delete(floor)) maybeAutoTrigger(floor);
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
/** 已经为「柏宝绘还没握手」重试过的楼层：只补一次，避免没装扩展时反复排队 */
const autoWaited = new Set<number>();
/**
 * 刚「到达」的 AI 楼层（MESSAGE_RECEIVED 打过标记，渲染完再消费）。
 * 不在渲染事件里直接触发，是因为打开聊天会把整段历史重渲一遍。
 */
const autoPending = new Set<number>();

/**
 * 任务收尾后交还占位。
 *
 * 以前这个 set 只进不出：某一层自动出图失败后，那一条 `${floor}:${mode}`
 * 永久留在里面，用户重新渲染 / 重试都再也不会触发——只能重启酒馆。
 */
function releaseAutoKey(task: { source: StorySegment; mode: CreationMode }): void {
  const floor = task.source.floorIds[0];
  if (typeof floor === 'number') autoRunning.delete(`${floor}:${task.mode}`);
}

/** 按设置决定这一层要不要自动出图；每个模式每层只出一次。 */
function maybeAutoTrigger(floor: number): void {
  if (!isAvailable()) {
    // 以前这里是 `if (!isAvailable()) return;` 直接退出，而本楼渲染往往早于
    // 柏宝绘桥接握手（尤其刚刷新页面）——那一层就永远不出图了。
    // 现在等一次 API 就绪再补一次，且只补一次。
    if (!autoWaited.has(floor)) {
      autoWaited.add(floor);
      void waitForApi(6).then(r => {
        if (r.status === 'available') maybeAutoTrigger(floor);
      });
    }
    return;
  }
  // 这里曾经有一道 `settings.enabled === false` 的门。那个总开关默认 false，
  // 而整个插件**没有任何界面**能把它改成 true（它只写在设置结构里）——
  // 于是自动出图对所有用户都是死代码：「勾了自动出图但没出」就是这个。
  // 真正该管这件事的是各模式自己的 autoTrigger（见 pickAutoModes）。
  const picks = pickAutoModes(settings, floor, {
    hasStory: kind => hasStory(floor, kind),
    hasArtifact: mode => getArtifacts(floor).some(a => a.mode === mode),
    busy: key => autoRunning.has(key),
  });
  if (picks.length === 0) {
    console.debug(`[ST-Story-Illustrator] 第 ${floor} 层没有需要自动生成的模式。`);
    return;
  }

  const segment = buildSingleSegment(floor);
  if (!segment) {
    // 取不到正文就等于没有可画的剧情：说清楚，否则用户只看到「勾了却没反应」
    console.warn(`[ST-Story-Illustrator] 第 ${floor} 层取不到正文，跳过自动出图。`);
    showToast('自动出图跳过：这一楼没有可读的正文。', 'warn');
    return;
  }
  if (!queue) initQueue();

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
  destroyPromptDialog();
  destroyConfigPanel();
  destroyWandMenu();
  unmountFloatingBall();
  destroyRunStatus();
  destroyChatObserver();
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
