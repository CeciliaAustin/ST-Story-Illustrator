/**
 * 「正在出图」状态条
 *
 * 为什么要有：小剧场三套走的是公开出图接口，柏宝绘的卡片与它的「生成中」指示
 * 都不参与——任务跑起来之后界面上什么都没有。用户只能干等，失败也看不出来，
 * 常常以为是卡死了。这里在右下角上方挂一条极小的状态条：
 *   出图前「黑白漫 · 读剧情中…」
 *   出图中「黑白漫 · 第 2/3 格 · 12s」
 *   结束「完成 · 3 张 · 38s」/「失败：……」
 *
 * 点它可以打开「出图日志」标签页。样式与柏宝绘的浮层保持一致的低干扰风格。
 */

import { MODE_LABEL, type CreationMode } from '../types';

type Level = 'running' | 'ok' | 'error';

export interface RunStatusSnapshot {
  level: Level;
  mode: CreationMode;
  stage: string;
  page?: number;
  totalPages?: number;
  startedAt: number;
  endedAt?: number;
  message?: string;
}

let el: HTMLElement | null = null;
let labelEl: HTMLElement | null = null;
let dotEl: HTMLElement | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let state: RunStatusSnapshot | null = null;
let onOpenLog: (() => void) | null = null;

const STAGE_TEXT: Record<string, string> = {
  queued: '排队中',
  reading: '读剧情中',
  review: '整理提示词',
  generating: '出图中',
  completed: '完成',
};

function ensure(): { root: HTMLElement; label: HTMLElement; dot: HTMLElement } {
  if (el && labelEl && dotEl && document.body.contains(el)) {
    return { root: el, label: labelEl, dot: dotEl };
  }
  const root = document.createElement('div');
  root.className = 'sti-run';
  root.style.display = 'none';
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');

  const dot = document.createElement('span');
  dot.className = 'sti-run-dot';
  root.appendChild(dot);

  const label = document.createElement('span');
  label.className = 'sti-run-label';
  root.appendChild(label);

  root.addEventListener('click', () => {
    onOpenLog?.();
  });

  document.body.appendChild(root);
  el = root;
  labelEl = label;
  dotEl = dot;
  return { root, label, dot };
}

/** 让状态条能点开日志页（index.ts 注入，避免这里 import UI 造成环）。 */
export function setRunStatusLogOpener(fn: () => void): void {
  onOpenLog = fn;
}

function elapsedSecondsOf(snapshot: RunStatusSnapshot): number {
  const end = snapshot.endedAt ?? Date.now();
  return Math.max(0, Math.round((end - snapshot.startedAt) / 1000));
}

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m${String(s).padStart(2, '0')}s`;
}

/** 状态条上那一行字（纯函数，便于单测）。 */
export function runStatusText(snapshot: RunStatusSnapshot): string {
  const mode = MODE_LABEL[snapshot.mode] ?? snapshot.mode;
  const stage = STAGE_TEXT[snapshot.stage] ?? snapshot.stage;
  const parts = [mode, stage];
  if (snapshot.page && snapshot.totalPages) parts.push(`第 ${snapshot.page}/${snapshot.totalPages} 格`);
  if (snapshot.level !== 'error') parts.push(formatElapsed(elapsedSecondsOf(snapshot)));
  const head = parts.join(' · ');
  return snapshot.message ? `${head}：${snapshot.message}` : head;
}

function paint(): void {
  if (!state) {
    if (el) el.style.display = 'none';
    return;
  }
  const { root, label, dot } = ensure();
  root.style.display = 'flex';
  root.className = `sti-run is-${state.level}`;
  dot.className = `sti-run-dot is-${state.level}`;
  label.textContent = runStatusText(state);
  root.title = state.level === 'error' ? '出错了，点开看日志' : '点开看这次出图的日志';
}

function startTimer(): void {
  if (timer) return;
  timer = setInterval(paint, 1000);
}

function stopTimer(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** 任务开始 / 进度更新。 */
export function updateRunStatus(patch: {
  mode: CreationMode;
  stage: string;
  page?: number;
  totalPages?: number;
}): void {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  const sameTask = state && state.level === 'running' && state.mode === patch.mode;
  state = {
    level: 'running',
    mode: patch.mode,
    stage: patch.stage,
    ...(patch.page ? { page: patch.page } : {}),
    ...(patch.totalPages ? { totalPages: patch.totalPages } : {}),
    startedAt: sameTask ? state!.startedAt : Date.now(),
    ...(sameTask && state?.message ? { message: state.message } : {}),
  };
  paint();
  startTimer();
}

/** 结束：成功停 4 秒、失败停 10 秒，然后自己收起来。 */
export function finishRunStatus(level: 'ok' | 'error', message = ''): void {
  stopTimer();
  if (!state) return;
  state = { ...state, level, endedAt: Date.now(), message, stage: 'completed' };
  paint();
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    state = null;
    paint();
  }, level === 'error' ? 10000 : 4000);
}

/** 当前状态（日志页顶部显示「现在在干什么」）。 */
export function getRunStatus(): RunStatusSnapshot | null {
  return state;
}

export function clearRunStatus(): void {
  stopTimer();
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  state = null;
  paint();
}

export function destroyRunStatus(): void {
  clearRunStatus();
  el?.remove();
  el = null;
  labelEl = null;
  dotEl = null;
}
