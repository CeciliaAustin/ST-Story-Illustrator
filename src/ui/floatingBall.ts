/**
 * 悬浮球 🎨
 *
 * 可拖动、记住位置、可在设置里或直接点角上的 × 关掉。
 * 点一下打开「生成配图」面板（不需要先划线）。
 */

import { getSettings, saveSettings } from '../host/sillytavern';
import { DEFAULT_SETTINGS, type StoryIllustratorSettings } from '../types';
import { openStudio } from './studio';

const BALL_ID = 'sti-fab';
const HIDE_ID = 'sti-fab-hide';
const DRAG_THRESHOLD = 4;

let ball: HTMLElement | null = null;
let startX = 0;
let startY = 0;
let originLeft = 0;
let originTop = 0;
let moved = false;
let dragging = false;

function currentSettings(): StoryIllustratorSettings {
  return getSettings(DEFAULT_SETTINGS);
}

function defaultPosition(): { left: number; top: number } {
  const size = 46;
  const left = Math.max(8, window.innerWidth - size - 18);
  const top = Math.max(8, window.innerHeight - size - 110);
  return { left, top };
}

/** 挂载（或按设置隐藏）悬浮球。重复调用安全。 */
export function mountFloatingBall(): void {
  const settings = currentSettings();
  if (settings.showFloatingBall === false) {
    unmountFloatingBall();
    return;
  }
  if (ball && document.body.contains(ball)) return;

  const pos = settings.floatingBallPos ?? defaultPosition();
  const el = document.createElement('div');
  el.id = BALL_ID;
  el.className = 'sti-fab';
  el.title = 'ST 故事插画 · 点一下打开配图面板，可拖动';
  el.textContent = '🎨';
  el.style.left = `${clamp(pos.left, 0, window.innerWidth - 46)}px`;
  el.style.top = `${clamp(pos.top, 0, window.innerHeight - 46)}px`;
  el.tabIndex = 0;

  const hide = document.createElement('button');
  hide.type = 'button';
  hide.id = HIDE_ID;
  hide.className = 'sti-fab-hide';
  hide.title = '隐藏悬浮球（可在配图设置里重新打开）';
  hide.textContent = '×';
  hide.addEventListener('pointerdown', (e) => e.stopPropagation());
  hide.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    hideFloatingBall();
  });
  el.appendChild(hide);

  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('click', (e) => {
    e.preventDefault();
    // 拖动结束的那次 click 不当作点击
    if (moved) { moved = false; return; }
    openStudio('generate');
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openStudio('generate');
    }
  });

  document.body.appendChild(el);
  ball = el;

  window.addEventListener('resize', keepInside);
}

function onPointerDown(e: PointerEvent): void {
  if (!ball) return;
  if ((e.target as HTMLElement)?.id === HIDE_ID) return;
  dragging = true;
  moved = false;
  startX = e.clientX;
  startY = e.clientY;
  originLeft = ball.offsetLeft;
  originTop = ball.offsetTop;
  ball.classList.add('dragging');
  ball.setPointerCapture?.(e.pointerId);

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
}

function onPointerMove(e: PointerEvent): void {
  if (!dragging || !ball) return;
  const dx = e.clientX - startX;
  const dy = e.clientY - startY;
  if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
  moved = true;
  const left = clamp(originLeft + dx, 0, window.innerWidth - ball.offsetWidth);
  const top = clamp(originTop + dy, 0, window.innerHeight - ball.offsetHeight);
  ball.style.left = `${left}px`;
  ball.style.top = `${top}px`;
}

function onPointerUp(): void {
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  if (!dragging || !ball) return;
  dragging = false;
  ball.classList.remove('dragging');

  if (moved) {
    const settings = currentSettings();
    settings.floatingBallPos = { left: ball.offsetLeft, top: ball.offsetTop };
    saveSettings(settings);
  }
}

function keepInside(): void {
  if (!ball) return;
  const left = clamp(ball.offsetLeft, 0, window.innerWidth - ball.offsetWidth);
  const top = clamp(ball.offsetTop, 0, window.innerHeight - ball.offsetHeight);
  ball.style.left = `${left}px`;
  ball.style.top = `${top}px`;
}

/** 关掉悬浮球（写设置，下次启动也不出现）。 */
export function hideFloatingBall(): void {
  const settings = currentSettings();
  settings.showFloatingBall = false;
  saveSettings(settings);
  unmountFloatingBall();
  window.dispatchEvent(new CustomEvent('sti-settings-changed'));
}

export function unmountFloatingBall(): void {
  if (ball) {
    ball.remove();
    ball = null;
  }
  window.removeEventListener('resize', keepInside);
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  dragging = false;
}

/** 设置改动后重新同步（开关切换、位置重置）。 */
export function syncFloatingBall(): void {
  unmountFloatingBall();
  mountFloatingBall();
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), Math.max(min, max));
}
