/**
 * 出图配置同步面板
 *
 * 展示柏宝绘当前的接入点 / 出图方案（只读同步），并允许一键切换当前方案
 * （切换走柏宝绘自己的 UI，见 planSwitch.ts）。
 * 同时展示各创作模式的 tag 副 API 指派，提醒用户它与柏宝绘的同步关系。
 *
 * 入口：注入到 ST 魔杖菜单（#extensionsMenu），也可通过导出函数直接打开。
 */

import {
  readOutConfig,
  moneySavingHint,
  type OutConfigSnapshot,
} from '../baibai/planConfig';
import { switchBaiBaiPlan } from '../baibai/planSwitch';
import {
  listSharedChannelInfos,
  readTagGenChannelId,
  type SharedChannelInfo,
} from '../baibai/secondaryLlm';

const PANEL_ID = 'sti-config-panel';
const OVERLAY_ID = 'sti-config-overlay';
const MENU_ID = 'sti-config-menu-item';

let panelEl: HTMLElement | null = null;
let overlayEl: HTMLElement | null = null;

function ensurePanel(): { panel: HTMLElement; overlay: HTMLElement } {
  if (panelEl && overlayEl && document.body.contains(panelEl)) {
    return { panel: panelEl, overlay: overlayEl };
  }

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'sti-config-overlay';
  overlay.addEventListener('click', () => hideConfigPanel());
  document.body.appendChild(overlay);

  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.className = 'sti-config-panel';
  document.body.appendChild(panel);

  panelEl = panel;
  overlayEl = overlay;
  return { panel, overlay };
}

export function showConfigPanel(): void {
  const { panel, overlay } = ensurePanel();
  render(panel);
  panel.style.display = 'flex';
  overlay.style.display = 'block';
}

export function hideConfigPanel(): void {
  if (panelEl) panelEl.style.display = 'none';
  if (overlayEl) overlayEl.style.display = 'none';
}

function section(title: string, subtitle?: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'sti-config-section';
  const h = document.createElement('div');
  h.className = 'sti-config-h';
  h.textContent = title;
  wrap.appendChild(h);
  if (subtitle) {
    const s = document.createElement('div');
    s.className = 'sti-config-sub';
    s.textContent = subtitle;
    wrap.appendChild(s);
  }
  return wrap;
}

function render(panel: HTMLElement): void {
  panel.innerHTML = '';
  const snap = readOutConfig();

  const head = document.createElement('div');
  head.className = 'sti-config-head';
  const title = document.createElement('h2');
  title.textContent = '出图配置同步';
  head.appendChild(title);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'sti-config-close';
  close.textContent = '×';
  close.addEventListener('click', () => hideConfigPanel());
  head.appendChild(close);
  panel.appendChild(head);

  const body = document.createElement('div');
  body.className = 'sti-config-body';

  // ── 当前状态 ──
  const cur = section('当前出图方案', '以下是柏宝绘此刻实际用于出图的配置，本面板实时同步。');
  const curBox = document.createElement('div');
  curBox.className = 'sti-config-current';
  curBox.innerHTML =
    `<div class="sti-config-cur-row"><span>方案</span><b>${esc(snap.activePlanName || '（未配置）')}</b></div>` +
    `<div class="sti-config-cur-row"><span>模型</span><b>${esc(activeModel(snap))}</b></div>` +
    `<div class="sti-config-cur-row"><span>接入点</span><b>${esc(activeEndpointName(snap))}</b></div>`;
  cur.appendChild(curBox);
  const hint = moneySavingHint(snap);
  if (hint) {
    const hintEl = document.createElement('div');
    hintEl.className = 'sti-config-money-hint';
    hintEl.textContent = hint;
    cur.appendChild(hintEl);
  }
  body.appendChild(cur);

  // ── 方案切换 ──
  const plans = section('切换方案', '点「切为当前」会在柏宝绘里切到该方案（走它自己的逻辑，落盘也同步）。若按钮无响应，请先打开一次柏宝绘设置面板。');
  const planList = document.createElement('div');
  planList.className = 'sti-config-list';
  if (snap.plans.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'sti-config-empty';
    empty.textContent = '柏宝绘里还没有出图方案，请先在柏宝绘设置 → 后端 → NovelAI 里建一套。';
    planList.appendChild(empty);
  }
  for (const p of snap.plans) {
    const row = document.createElement('div');
    row.className = `sti-config-item ${p.id === snap.activePlanId ? 'active' : ''}`;
    const info = document.createElement('div');
    info.className = 'sti-config-item-info';
    const name = document.createElement('div');
    name.className = 'sti-config-item-name';
    name.textContent = p.name + (p.id === snap.activePlanId ? ' · 当前' : '');
    const meta = document.createElement('div');
    meta.className = 'sti-config-item-meta';
    meta.textContent = `${p.model || '(未填模型)'} · ${p.endpointName}${p.portraitSize ? ` · ${p.portraitSize}` : ''}`;
    info.appendChild(name);
    info.appendChild(meta);
    row.appendChild(info);
    if (p.id !== snap.activePlanId) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sti-config-switch-btn';
      btn.textContent = '切为当前';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = '切换中…';
        const result = await switchBaiBaiPlan(p.id);
        if (result.ok) {
          showConfigPanel(); // 重绘显示新状态
        } else {
          btn.disabled = false;
          btn.textContent = '重试';
          alert(result.message);
        }
      });
      row.appendChild(btn);
    }
    planList.appendChild(row);
  }
  plans.appendChild(planList);
  body.appendChild(plans);

  // ── 接入点（只读）──
  const eps = section('接入点（只读）', '来自柏宝绘。增删/改地址请在柏宝绘设置里操作；密钥不会显示。');
  const epList = document.createElement('div');
  epList.className = 'sti-config-eplist';
  for (const e of snap.endpoints) {
    const row = document.createElement('div');
    row.className = 'sti-config-ep';
    row.textContent = `${e.name} · ${maskUrl(e.url)}${e.hasKey ? ' · 已设密钥' : ' · 未设密钥'}`;
    epList.appendChild(row);
  }
  if (snap.endpoints.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'sti-config-empty';
    empty.textContent = '柏宝绘里没有接入点。';
    epList.appendChild(empty);
  }
  eps.appendChild(epList);
  body.appendChild(eps);

  // ── tag 副 API 同步 ──
  const tag = section('Tag 生成副 API', '创作模式里的「跟随柏宝绘 tagGen」读的就是这里。你在柏宝绘改指派，弹窗自动跟随。');
  const channels = listSharedChannelInfos();
  const tagId = readTagGenChannelId();
  const tagCh = channels.find(c => c.id === tagId);
  const tagBox = document.createElement('div');
  tagBox.className = 'sti-config-current';
  tagBox.innerHTML =
    `<div class="sti-config-cur-row"><span>当前指派</span><b>${esc(tagCh ? `${tagCh.name} / ${tagCh.model}` : (tagId || '跟随主 API（未指派）'))}</b></div>` +
    `<div class="sti-config-cur-row"><span>共享渠道数</span><b>${channels.length} 条</b></div>`;
  tag.appendChild(tagBox);
  body.appendChild(tag);

  panel.appendChild(body);

  const foot = document.createElement('div');
  foot.className = 'sti-config-foot';
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.textContent = '刷新同步';
  refresh.addEventListener('click', () => showConfigPanel());
  foot.appendChild(refresh);
  const note = document.createElement('span');
  note.textContent = '本面板只读柏宝绘配置，出图仍由柏宝绘执行。';
  foot.appendChild(note);
  panel.appendChild(foot);
}

function activeModel(snap: OutConfigSnapshot): string {
  return snap.plans.find(p => p.id === snap.activePlanId)?.model || '(未配置)';
}

function activeEndpointName(snap: OutConfigSnapshot): string {
  const p = snap.plans.find(x => x.id === snap.activePlanId);
  return p?.endpointName || '(未配置)';
}

function maskUrl(url: string): string {
  if (!url) return '(未填地址)';
  return url.length > 42 ? url.slice(0, 42) + '…' : url;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

/** 注入魔杖菜单入口（懒加载轮询）。 */
export function injectConfigMenu(): () => void {
  let done = false;
  const tryInject = () => {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById(MENU_ID)) return;
    const item = document.createElement('div');
    item.className = 'extension_container interactable';
    item.tabIndex = 0;
    const link = document.createElement('a');
    link.id = MENU_ID;
    link.className = 'list-group-item';
    link.href = '#';
    link.title = 'ST 故事插画 · 出图配置';
    link.innerHTML = '<i class="fa-solid fa-images"></i> <span>配图设置</span>';
    link.addEventListener('click', (e) => {
      e.preventDefault();
      showConfigPanel();
      const m = document.getElementById('extensionsMenu');
      if (m) m.style.display = 'none';
    });
    item.appendChild(link);
    menu.appendChild(item);
    done = true;
  };
  tryInject();
  const timer = window.setInterval(() => {
    tryInject();
    if (done || document.getElementById(MENU_ID)) window.clearInterval(timer);
  }, 500);
  return () => window.clearInterval(timer);
}

export function destroyConfigPanel(): void {
  if (panelEl) { panelEl.remove(); panelEl = null; }
  if (overlayEl) { overlayEl.remove(); overlayEl = null; }
  document.getElementById(MENU_ID)?.remove();
}
