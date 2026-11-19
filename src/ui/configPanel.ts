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
import { getSettings, saveSettings } from '../host/sillytavern';
import { DEFAULT_SETTINGS, type CreationMode, type StoryIllustratorSettings } from '../types';
import { buildStudioTabs } from './studio';
import { destroyWandMenu, injectWandMenu } from './wandMenu';
import { clearImageLog, getImageLog, type ImageLogEntry } from '../log/imageLog';

const PANEL_ID = 'sti-config-panel';
const OVERLAY_ID = 'sti-config-overlay';

/** 模式中文名（与选段弹窗保持一致） */
const MODE_LABEL: Record<string, string> = {
  'illustration': '正文插画',
  'comic': '正文漫画分镜',
  'chibi-status': 'QQ 人状态栏',
  'chibi-bonus': 'QQ 人彩蛋',
  'bw-manga': '黑白漫小剧场',
};

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
  title.textContent = '配图设置';
  head.appendChild(title);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'sti-config-close';
  close.textContent = '×';
  close.addEventListener('click', () => hideConfigPanel());
  head.appendChild(close);
  panel.appendChild(head);
  panel.appendChild(buildStudioTabs('settings'));

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

  // ── 小剧场三套 ──
  body.appendChild(renderTheaterSettings());
  // ── 正文漫画分镜 ──
  body.appendChild(renderComicSettings());
  // ── 显示与入口 ──
  body.appendChild(renderUiSettings());
  // ── 出图日志 ──
  body.appendChild(renderLogSection());

  // ── 各模式指定方案（只读，改在选段弹窗）──
  const modePlans = getSettings(DEFAULT_SETTINGS).modeOutPlans ?? {};
  const assigned = Object.entries(modePlans).filter(([, id]) => !!id) as Array<[string, string]>;
  if (assigned.length > 0) {
    const perMode = section(
      '各创作模式指定的方案',
      '出图前会自动把柏宝绘切到对应方案（串行执行，不会互相打断）。要改请到选段弹窗底部「出图方案」。',
    );
    const box = document.createElement('div');
    box.className = 'sti-config-eplist';
    for (const [mode, planId] of assigned) {
      const plan = snap.plans.find(p => p.id === planId);
      const row = document.createElement('div');
      row.className = 'sti-config-ep';
      const label = MODE_LABEL[mode] ?? mode;
      row.textContent = plan
        ? `${label} → ${plan.name} · ${plan.endpointName}`
        : `${label} → 方案已失效（${planId.slice(0, 8)}…）`;
      box.appendChild(row);
    }
    perMode.appendChild(box);
    body.appendChild(perMode);
  }

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
  note.textContent = '出图仍由柏宝绘执行；本页开关只影响本插件。';
  foot.appendChild(note);
  panel.appendChild(foot);
}

// ============================================================
// 小剧场 / 显示设置
// ============================================================

const SHOT_OPTIONS: Array<[string, string]> = [
  ['1', '1 格 · 单画面'],
  ['2', '2 格 · 起 → 落'],
  ['3', '3 格 · 起 → 转 → 落'],
  ['4', '4 格 · 小分镜'],
];

const CHANCE_OPTIONS: Array<[string, string]> = [
  ['0', '0% · 不出'],
  ['25', '25% · 偶尔'],
  ['50', '50% · 一半'],
  ['100', '100% · 每楼都出'],
];

/** 改设置 → 落盘 → 重绘面板 → 通知运行中的队列重建。 */
function patchSettings(mutate: (s: StoryIllustratorSettings) => void): void {
  const next = getSettings(DEFAULT_SETTINGS);
  // 旧存档可能缺某些模式的字段：先补齐再改，避免点一下就抛错
  const empty: StoryIllustratorSettings['modes'][keyof StoryIllustratorSettings['modes']] = {
    enabled: false, autoTrigger: false, profileId: '', shots: 1,
  };
  next.modes = (next.modes ?? {}) as StoryIllustratorSettings['modes'];
  for (const mode of ['illustration', 'comic', 'chibi-status', 'chibi-bonus', 'bw-manga'] as const) {
    next.modes[mode] = { ...empty, ...(next.modes[mode] ?? {}) };
  }
  mutate(next);
  saveSettings(next);
  showConfigPanel();
  window.dispatchEvent(new CustomEvent('sti-settings-changed'));
}

function settingRow(label: string, hint?: string): { el: HTMLElement; control: HTMLElement } {
  const el = document.createElement('div');
  el.className = 'sti-set-row';

  const left = document.createElement('div');
  left.className = 'sti-set-label';
  left.textContent = label;
  if (hint) {
    const small = document.createElement('small');
    small.textContent = hint;
    left.appendChild(small);
  }

  const control = document.createElement('div');
  control.className = 'sti-set-control';

  el.appendChild(left);
  el.appendChild(control);
  return { el, control };
}

function toggleRow(
  label: string,
  checked: boolean,
  onChange: (value: boolean) => void,
  hint?: string,
): HTMLElement {
  const { el, control } = settingRow(label, hint);
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = checked;
  cb.addEventListener('change', () => onChange(cb.checked));
  control.appendChild(cb);
  return el;
}

function selectRow(
  label: string,
  value: string,
  options: Array<[string, string]>,
  onChange: (value: string) => void,
  hint?: string,
): HTMLElement {
  const { el, control } = settingRow(label, hint);
  const select = document.createElement('select');
  for (const [val, text] of options) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = text;
    if (val === value) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => onChange(select.value));
  control.appendChild(select);
  return el;
}

/** 小剧场三套的开关与格数（真的会改变出图行为，不是摆设）。 */
function renderTheaterSettings(): HTMLElement {
  const s = getSettings(DEFAULT_SETTINGS);
  const status = s.modes?.['chibi-status'];
  const bonus = s.modes?.['chibi-bonus'];
  const manga = s.modes?.['bw-manga'];

  const group = document.createElement('div');
  group.className = 'sti-config-group';

  const head = document.createElement('div');
  head.className = 'sti-config-group-h';
  head.textContent = '小剧场（QQ 人 / 彩蛋 / 黑白漫）';
  group.appendChild(head);

  const tip = document.createElement('div');
  tip.className = 'sti-config-sub';
  tip.textContent = '三套互不影响，可以同时开；同时开时每层出图量会叠加。画风与画师串跟随下面选中的出图方案。';
  group.appendChild(tip);

  // ① QQ 人状态栏
  const a = section('① QQ 人小剧场状态栏', '楼层底部一张卡片，按剧情时间顺序排出「怎么走到这个结果」的几格。');
  a.appendChild(selectRow(
    '每层格数',
    String(status?.shots ?? 1),
    SHOT_OPTIONS,
    v => patchSettings(st => { st.modes['chibi-status'].shots = Number(v); st.chibiStatusShots = Number(v); }),
  ));
  a.appendChild(selectRow(
    '画风',
    status?.chibiStyle ?? 'card',
    [['card', 'Q 版（大头小身）'], ['thumb', '写实小图']],
    v => patchSettings(st => {
      st.modes['chibi-status'].chibiStyle = v === 'thumb' ? 'thumb' : 'card';
      st.chibiStatusStyle = v === 'thumb' ? 'thumb' : 'card';
    }),
  ));
  a.appendChild(planSelectRow('chibi-status'));
  a.appendChild(toggleRow(
    '新楼层自动出图',
    !!status?.autoTrigger,
    v => patchSettings(st => { st.modes['chibi-status'].autoTrigger = v; }),
    '开启后每一层 AI 回复完自动生成，不再需要划线。注意会持续消耗出图额度。',
  ));
  group.appendChild(a);

  // ② 彩蛋
  const b = section('② 彩蛋小剧场', '与正文剧情无关的平行小片段，题材放开，每次换花样。');
  b.appendChild(selectRow(
    '每条格数',
    String(bonus?.shots ?? 1),
    SHOT_OPTIONS,
    v => patchSettings(st => { st.modes['chibi-bonus'].shots = Number(v); st.chibiBonusShots = Number(v); }),
  ));
  b.appendChild(selectRow(
    '自动触发概率',
    String(bonus?.chibiBonusChance ?? s.chibiBonusChance ?? 25),
    CHANCE_OPTIONS,
    v => patchSettings(st => {
      st.modes['chibi-bonus'].chibiBonusChance = Number(v);
      st.chibiBonusChance = Number(v);
    }),
    '只在「新楼层自动出图」开着时生效；手动点彩蛋不受概率限制。',
  ));
  b.appendChild(planSelectRow('chibi-bonus'));
  b.appendChild(toggleRow(
    '新楼层自动出彩蛋',
    !!bonus?.autoTrigger,
    v => patchSettings(st => { st.modes['chibi-bonus'].autoTrigger = v; }),
  ));
  group.appendChild(b);

  // ③ 黑白漫
  const c = section('③ 黑白漫小剧场', '正常比例、黑白画风；画风由出图方案里的画师串决定。');
  c.appendChild(selectRow(
    '每条格数',
    String(manga?.shots ?? 1),
    SHOT_OPTIONS,
    v => patchSettings(st => { st.modes['bw-manga'].shots = Number(v); st.mangaShots = Number(v); }),
  ));
  c.appendChild(toggleRow(
    '安全洗（去掉写实/彩色相关词）',
    manga?.bwMangaSafeMode !== false,
    v => patchSettings(st => { st.modes['bw-manga'].bwMangaSafeMode = v; st.mangaSafe = v; }),
    '只改负面词与冲突词，不改你的画师串。',
  ));
  c.appendChild(planSelectRow('bw-manga'));
  c.appendChild(toggleRow(
    '新楼层自动出黑白漫',
    !!manga?.autoTrigger,
    v => patchSettings(st => { st.modes['bw-manga'].autoTrigger = v; }),
  ));
  group.appendChild(c);

  return group;
}

/**
 * 「出图方案」下拉：方案 = 接入点 + 模型 + 画师串，柏宝绘里已经建好的那几套。
 * 留空 = 跟随柏宝绘当前方案（不切换）。
 */
function planSelectRow(mode: CreationMode): HTMLElement {
  const snap = readOutConfig();
  const current = getSettings(DEFAULT_SETTINGS).modeOutPlans?.[mode] ?? '';
  const options: Array<[string, string]> = [['', '跟随当前方案']];
  for (const plan of snap.plans) {
    options.push([plan.id, `${plan.name} · ${plan.endpointName} / ${plan.model || '未填模型'}`]);
  }
  return selectRow(
    '出图方案',
    current,
    options,
    v => patchSettings(st => {
      st.modeOutPlans = { ...(st.modeOutPlans ?? {}) };
      if (v) st.modeOutPlans[mode] = v;
      else delete st.modeOutPlans[mode];
    }),
    snap.plans.length === 0
      ? '柏宝绘里还没有出图方案，请先在柏宝绘设置里建一套。'
      : snap.backend !== 'nai'
        ? `柏宝绘当前出图渠道是「${snap.backend}」，按模式分配方案只对 NAI 生效——这样选会在生成时直接报错，不会白花钱。`
        : '出图前会自动切到这套方案；切不过去就停下报错（不会偷偷用旧方案烧钱）。',
  );
}

/** ④ 正文漫画分镜 */
function renderComicSettings(): HTMLElement {
  const s = getSettings(DEFAULT_SETTINGS);
  const comic = s.modes?.['comic'];

  const group = document.createElement('div');
  group.className = 'sti-config-group';
  const head = document.createElement('div');
  head.className = 'sti-config-group-h';
  head.textContent = '④ 正文漫画分镜';
  group.appendChild(head);

  const box = section('正文插图切成漫画格', '与三套小剧场并列；勾选「正文漫画分镜」时生效，图会按分镜插进正文。');
  box.appendChild(selectRow(
    '版面',
    comic?.comicLayout ?? 'regular',
    [['regular', '规整四格'], ['irregular', '斜切分镜'], ['inset', '主图 + 嵌入格'], ['unframed', '无边框融白']],
    v => patchSettings(st => {
      st.modes['comic'].comicLayout = v as StoryIllustratorSettings['modes']['comic']['comicLayout'];
      st.panelLayout = v as StoryIllustratorSettings['panelLayout'];
    }),
  ));
  box.appendChild(selectRow(
    '最多页数',
    String(comic?.comicMaxPages ?? 1),
    [['1', '1 页'], ['2', '2 页'], ['3', '3 页']],
    v => patchSettings(st => { st.modes['comic'].comicMaxPages = Number(v); }),
  ));
  box.appendChild(toggleRow(
    '气泡对白',
    s.dialogueEnabled !== false,
    v => patchSettings(st => {
      st.dialogueEnabled = v;
      st.modes['comic'].comicDialoguePolicy = v ? 'always' : 'auto';
    }),
    '开启后会把选段里的台词排进气泡，出图后合成一次到图上。',
  ));
  group.appendChild(box);
  return group;
}

/** 显示与入口：悬浮球、划词按钮。 */
function renderUiSettings(): HTMLElement {
  const s = getSettings(DEFAULT_SETTINGS);
  const group = document.createElement('div');
  group.className = 'sti-config-group';

  const head = document.createElement('div');
  head.className = 'sti-config-group-h';
  head.textContent = '入口与显示';
  group.appendChild(head);

  group.appendChild(toggleRow(
    '悬浮球（🎨）',
    s.showFloatingBall !== false,
    v => patchSettings(st => { st.showFloatingBall = v; }),
    '关掉后仍可从魔杖菜单打开；悬浮球可以拖动，位置会记住。',
  ));
  group.appendChild(toggleRow(
    '划词时显示「生成配图」按钮',
    s.showSelectionToolbar !== false,
    v => patchSettings(st => { st.showSelectionToolbar = v; }),
    '关掉后只能从魔杖菜单或悬浮球打开面板。',
  ));
  group.appendChild(toggleRow(
    '选段只提取 <content> 里的正文',
    s.preferContentTag !== false,
    v => patchSettings(st => { st.preferContentTag = v; }),
    '兼容把思维链写进正文的预设，避免把思考过程算进剧情。',
  ));

  return group;
}

/**
 * 出图日志
 *
 * 柏宝绘的「请求历史」是它模块内的内存 store，刻意不持久化、也没有写入接口；
 * 小剧场三套走公开出图接口，天生不在它那条链路上。所以这里自己记一份，
 * 重点是**失败时的错误原文**，那是排查时唯一有用的东西。
 */
function renderLogSection(): HTMLElement {
  const entries = getImageLog();
  const box = section(
    '出图日志',
    '本插件自己记的调用记录（内存级，刷新即清）。柏宝绘的「请求历史」不对外开放写入，小剧场进不去那里，看这里。',
  );

  const bar = document.createElement('div');
  bar.className = 'sti-log-bar';
  const count = document.createElement('span');
  count.textContent = `最近 ${entries.length} 条（上限 80）`;
  bar.appendChild(count);
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'sti-cs-regen';
  clear.textContent = '清空';
  clear.addEventListener('click', () => {
    clearImageLog();
    showConfigPanel();
  });
  bar.appendChild(clear);
  box.appendChild(bar);

  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'sti-config-empty';
    empty.textContent = '还没有记录。生成一次图之后再回来看。';
    box.appendChild(empty);
    return box;
  }

  for (const entry of entries.slice(0, 30)) {
    box.appendChild(buildLogRow(entry));
  }
  return box;
}

function buildLogRow(entry: ImageLogEntry): HTMLElement {
  const row = document.createElement('details');
  row.className = `sti-log-item ${entry.status === 'error' ? 'is-error' : ''}`;

  const summary = document.createElement('summary');
  summary.className = 'sti-log-summary';
  summary.textContent = [
    formatTime(entry.at),
    entry.kind === 'llm' ? '读剧情' : entry.kind === 'plan' ? '切方案' : '出图',
    MODE_LABEL[entry.mode] ?? entry.mode,
    entry.kind === 'plan' ? '' : `#${entry.floor}`,
    entry.status === 'error' ? '失败' : '成功',
    entry.durationMs !== undefined ? `${(entry.durationMs / 1000).toFixed(1)}s` : '',
    entry.plan ? `方案 ${entry.plan}` : '',
    entry.seed !== undefined ? `seed ${entry.seed}` : '',
  ].filter(Boolean).join(' · ');
  row.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'sti-log-body';

  if (entry.error) {
    const err = document.createElement('div');
    err.className = 'sti-log-error';
    err.textContent = entry.error;
    body.appendChild(err);
  }
  if (entry.kind === 'plan') {
    if (entry.prompt) body.appendChild(logField('说明', entry.prompt));
    if (entry.plan) body.appendChild(logField('出图方案', entry.plan));
    row.appendChild(body);
    return row;
  }
  body.appendChild(logField('正向', entry.prompt));
  if (entry.nl) body.appendChild(logField('nl', entry.nl));
  if (entry.negative) body.appendChild(logField('负面', entry.negative));
  if (entry.plan) body.appendChild(logField('出图方案', entry.plan));
  if (entry.model) body.appendChild(logField('模型', entry.model));
  if (entry.source) body.appendChild(logField('来源', entry.source === 'card' ? '柏宝绘卡片' : '公开出图接口'));

  row.appendChild(body);
  return row;
}

function logField(label: string, value: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'sti-log-field';
  const head = document.createElement('div');
  head.className = 'sti-log-field-label';
  head.textContent = label;
  const text = document.createElement('div');
  text.className = 'sti-log-field-value';
  text.textContent = value;
  wrap.appendChild(head);
  wrap.appendChild(text);
  return wrap;
}

function formatTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function activeModel(snap: OutConfigSnapshot): string {
  return snap.plans.find(p => p.id === snap.activePlanId)?.model || '(未配置)';
}function activeEndpointName(snap: OutConfigSnapshot): string {
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

/** 兼容旧入口：魔杖菜单现在由 wandMenu.ts 统一注入两个入口。 */
export function injectConfigMenu(): () => void {
  return injectWandMenu();
}

export function destroyConfigPanel(): void {
  if (panelEl) { panelEl.remove(); panelEl = null; }
  if (overlayEl) { overlayEl.remove(); overlayEl = null; }
  destroyWandMenu();
}
