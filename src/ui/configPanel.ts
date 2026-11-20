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
import { readPromptSet, readPromptSetSource } from '../baibai/specPrompt';
import { switchBaiBaiPlan } from '../baibai/planSwitch';
import {
  listSharedChannelInfos,
  readTagGenChannelId,
  type SharedChannelInfo,
} from '../baibai/secondaryLlm';
import { getSettings, saveSettings } from '../host/sillytavern';
import {
  DEFAULT_SETTINGS,
  resolveModeSettings,
  type CreationMode,
  type StoryIllustratorSettings,
} from '../types';
import { buildStudioTabs, type StudioTab } from './studio';
import { styleWireframe } from './layoutPreview';
import { resolveLayoutStyle, normalizePanelCount } from '../manga/layoutStyle';
import type { ComicLayoutStyle } from '../types';
import { destroyWandMenu, injectWandMenu } from './wandMenu';
import { clearImageLog, getImageLog, type ImageLogEntry } from '../log/imageLog';
import { getRunStatus, runStatusText } from './runStatus';
import {
  PROMPT_DOCS,
  isCustomized,
  overrideKey,
  promptDocOf,
  resolveTemplate,
  type PromptDocId,
  type PromptVariant,
} from '../prompt/presets';

const PANEL_ID = 'sti-config-panel';
const OVERLAY_ID = 'sti-config-overlay';

/** 模式中文名（与选段弹窗保持一致） */
const MODE_LABEL: Record<string, string> = {
  'illustration': '正文插画',
  'comic': '正文漫画分镜',
  'chibi-status': 'QQ 人状态栏',
  'chibi-bonus': 'QQ 人彩蛋',
  'bw-manga': '黑白漫小剧场',
  'restore': '还原方案',
};

let panelEl: HTMLElement | null = null;
let overlayEl: HTMLElement | null = null;

/** 「提示词」标签页当前编辑哪一条 / 哪一版（面板重建后保持选择） */
let promptDocId: PromptDocId = 'illustration';
let promptVariant: PromptVariant = 'single';

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

export function showConfigPanel(tab: StudioTab = 'settings'): void {
  const { panel, overlay } = ensurePanel();
  render(panel, tab);
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

function render(panel: HTMLElement, tab: StudioTab = 'settings'): void {
  panel.innerHTML = '';
  const snap = readOutConfig();

  const head = document.createElement('div');
  head.className = 'sti-config-head';
  const title = document.createElement('h2');
  title.textContent = tab === 'log' ? '出图日志' : tab === 'prompts' ? '提示词' : '配图设置';
  head.appendChild(title);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'sti-config-close';
  close.textContent = '×';
  close.addEventListener('click', () => hideConfigPanel());
  head.appendChild(close);
  panel.appendChild(head);
  panel.appendChild(buildStudioTabs(tab));

  if (tab === 'log') {
    const logBody = document.createElement('div');
    logBody.className = 'sti-config-body';
    logBody.appendChild(renderLogSection());
    panel.appendChild(logBody);
    return;
  }

  if (tab === 'prompts') {
    const promptBody = document.createElement('div');
    promptBody.className = 'sti-config-body';
    promptBody.appendChild(renderPromptSettings(panel));
    panel.appendChild(promptBody);
    return;
  }

  const body = document.createElement('div');
  body.className = 'sti-config-body';

  // ── 当前状态 ──
  const cur = section(
    '当前出图方案',
    '以下是柏宝绘此刻实际用于出图的配置，本面板实时同步。正文插图固定用这套——插件不会替你改。',
  );
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
  // 画师串里带分格词：单格图会被画成一整页。这是「图跟卡片对不上」的常见原因，
  // 但它在成图上完全看不出来（只能看出「怎么四格全是大头」），所以在这里点明。
  const activePlan = snap.plans.find(p => p.id === snap.activePlanId);
  if (activePlan && activePlan.layoutWords.length > 0) {
    const warn = document.createElement('div');
    warn.className = 'sti-config-money-hint';
    warn.textContent =
      `这套方案的画师串里有「${activePlan.layoutWords.join(' / ')}」：`
      + '它会让每张图都画成一整页多格，而本插件的每张卡片只放一格。'
      + '想让卡片是单格，请换一条不带分格词的画师串（柏宝绘 → 画师串）。';
    cur.appendChild(warn);
  }
  body.appendChild(cur);

  // ── 读剧情用的提示词（柏宝绘自定义提示词是否已接上）──
  body.appendChild(renderPromptSource());

  // ── 自动出图：五个模式各自一个开关 ──
  body.appendChild(renderAutomationSettings());
  // ── 小剧场三套 ──
  body.appendChild(renderTheaterSettings());
  // ── 正文漫画分镜 ──
  body.appendChild(renderComicSettings());
  // ── 显示与入口 ──
  body.appendChild(renderUiSettings());

  // ── 各模式指定方案（只读，改在选段弹窗）──
  // 正文插画不参与：它固定用柏宝绘当前方案，插件不切（小剧场切走也会自动切回）。
  const modePlans = getSettings(DEFAULT_SETTINGS).modeOutPlans ?? {};
  const assigned = Object.entries(modePlans)
    .filter(([mode, id]) => !!id && mode !== 'illustration') as Array<[string, string]>;
  if (assigned.length > 0) {
    const perMode = section(
      '各创作模式指定的方案',
      '出图前把柏宝绘临时切到对应方案，出完自动切回原样（正文插图不受影响）。'
      + '要改请到选段弹窗底部「出图方案」。',
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
          + (plan.layoutWords.length ? '（⚠ 画师串含分格词，单格会被画成整页）' : '')
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
    meta.textContent = `${p.model || '(未填模型)'} · ${p.endpointName}${p.portraitSize ? ` · ${p.portraitSize}` : ''}`
      + (p.artistName ? ` · 画师串 ${p.artistName}` : '')
      + (p.layoutWords.length ? ' · ⚠ 画师串含分格词，会画成整页' : '');
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
/** 正在处理开关点击：这段时间里 patchSettings 不重建面板。 */
let insideToggle = false;

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
  // 开关就地生效，不需要把整个面板重画一遍：
  // 重建会丢滚动位置，还会把鼠标正按着的那个 checkbox 换掉——
  // 表现就是「点了没反应 / 看着还勾着」，得再点一次才正常。
  if (!insideToggle) showConfigPanel();
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
  key?: string,
): HTMLElement {
  const { el, control } = settingRow(label, hint);
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = checked;
  if (key) cb.dataset.stiToggle = key;
  cb.addEventListener('change', () => {
    insideToggle = true;
    try {
      onChange(cb.checked);
    } finally {
      insideToggle = false;
    }
    // 点完就取消焦点：不少主题把 checkbox 的焦点环画成粉/红色，看着像「还勾着」，
    // 用户会以为没关掉（其实值已经改了）。键盘 Tab 过来仍走 :focus-visible。
    cb.blur();
    if (key) syncToggles(key, cb.checked);
  });
  control.appendChild(cb);
  return el;
}

/**
 * 同一个设置可能有两个开关（「自动出图」组里一个，小剧场分组里还有一个）。
 * 改一个就必须把另一个也改成同一状态，否则界面上两处自相矛盾。
 */
function syncToggles(key: string, value: boolean): void {
  const nodes = document.querySelectorAll<HTMLInputElement>(`input[data-sti-toggle="${key}"]`);
  for (const node of nodes) node.checked = value;
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

/**
 * 自动出图总开关（每个模式一个）。
 *
 * 为什么要摆在一处：以前只有三套小剧场有「新楼层自动出图」，正文插画与正文漫画
 * 想自动也开不了；反过来只想开一套的时候，找开关得翻三段。五个放一起，
 * 勾哪个就是哪个，互相不影响。
 */
function renderAutomationSettings(): HTMLElement {
  const s = getSettings(DEFAULT_SETTINGS);
  const group = document.createElement('div');
  group.className = 'sti-config-group';

  const head = document.createElement('div');
  head.className = 'sti-config-group-h';
  head.textContent = '自动出图（每层 AI 回复后）';
  group.appendChild(head);

  const tip = document.createElement('div');
  tip.className = 'sti-config-sub';
  tip.textContent =
    '五个模式各自独立：勾上哪个就自动跑哪个，没勾的只能手动生成。'
    + '自动出图会持续消耗额度——先只开你想要的那一两套。';
  group.appendChild(tip);

  const rows: Array<[CreationMode, string, string]> = [
    ['illustration', '正文插图（柏宝绘卡片）', '往正文插 <bbi_image> tag 再点卡片出图：与柏宝绘自己的图一模一样（能重绘、改词、进请求历史），刷新不丢。'],
    ['comic', '正文漫画分镜', '按一页一张图出多格版面，还要先跑一次读剧情。每页都算一次出图，最贵，默认关。'],
    ['chibi-status', 'QQ 人状态栏', '楼层底部一张卡片，按剧情时间顺序排出几格。'],
    ['chibi-bonus', 'QQ 人彩蛋', '与正文无关的平行小片段；勾上后按下面的概率触发。'],
    ['bw-manga', '黑白漫小剧场', '正常比例、黑白画风；每格一张图，可带对白气泡。'],
  ];
  for (const [mode, label, hint] of rows) {
    const conf = resolveModeSettings(s, mode);
    group.appendChild(toggleRow(
      label,
      !!conf.autoTrigger,
      v => patchSettings(st => { st.modes[mode].autoTrigger = v; }),
      hint,
      `mode:${mode}:autoTrigger`,
    ));
  }

  group.appendChild(toggleRow(
    '出图后把柏宝绘方案切回原样',
    s.restorePlanAfterTask !== false,
    v => patchSettings(st => { st.restorePlanAfterTask = v; }),
    '柏宝绘的「当前方案」是全局的。小剧场按模式切走之后，如果不切回来，'
    + '接下来正文插图就会用 QQ 人/黑白漫那套模型与画师串出图。默认开着——正文永远用你自己选的那套。',
  ));

  return group;
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
  group.appendChild(b);

  // ③ 黑白漫
  const c = section('③ 黑白漫小剧场', '正常比例；黑白由「黑白锁定」与出图方案里的画师串共同决定。');
  c.appendChild(selectRow(
    '每条格数',
    String(manga?.shots ?? 1),
    SHOT_OPTIONS,
    v => patchSettings(st => { st.modes['bw-manga'].shots = Number(v); st.mangaShots = Number(v); }),
  ));
  c.appendChild(toggleRow(
    '黑白锁定（正向 monochrome / greyscale）',
    manga?.bwMangaMono !== false,
    v => patchSettings(st => { st.modes['bw-manga'].bwMangaMono = v; }),
    '正向上锁黑白、洗掉提示词里的彩色语义词（colorful / vivid / full color），'
    + '负面再压 color 一类词。不动你的画师串。关掉 = 完全交给画师串。',
  ));
  c.appendChild(toggleRow(
    '安全模式（避开露点/性描写）',
    manga?.bwMangaSafeMode !== false,
    v => patchSettings(st => { st.modes['bw-manga'].bwMangaSafeMode = v; st.mangaSafe = v; }),
    '只洗露点/性描写相关的 tag 与动作，并补一串 nsfw 负面词；不管黑白，也不动你的画师串。',
  ));
  c.appendChild(planSelectRow('bw-manga'));
  c.appendChild(toggleRow(
    '气泡对白',
    manga?.bwMangaDialogue !== false,
    v => patchSettings(st => { st.modes['bw-manga'].bwMangaDialogue = v; }),
    '读剧情时顺便让模型写 1~3 句中文台词，出图后由本地 canvas 画成气泡叠上去。'
    + '（原文档的黑白漫没有台词，这里做成可关。）',
  ));
  c.appendChild(selectRow(
    '气泡样式',
    manga?.bwMangaBubbleStyle ?? 'classic',
    [
      ['classic', '描边气泡'],
      ['bubble-vertical', '竖排气泡'],
      ['blend', '融入式（无框）'],
      ['blend-ink', '融入式 · 墨字'],
      ['blend-subtitle', '字幕条'],
    ],
    v => patchSettings(st => {
      st.modes['bw-manga'].bwMangaBubbleStyle = v as StoryIllustratorSettings['bubbleStyle'];
    }),
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
    options.push([
      plan.id,
      `${plan.name} · ${plan.endpointName} / ${plan.model || '未填模型'}${plan.layoutWords.length ? ' · ⚠整页' : ''}`,
    ]);
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
        : '出图前自动切到这套方案，出完切回原样；切不过去就停下报错（不会偷偷用旧方案烧钱）。',
  );
}

const COMIC_STYLE_CARDS: Array<{ id: ComicLayoutStyle; name: string; hint: string }> = [
  { id: 'classic_grid', name: '传统四格', hint: '纵向等宽 / 2×2，阅读节奏稳定' },
  { id: 'open_montage', name: '开放拼版', hint: '大小格自由组合、铺满整页（不留白边）' },
  { id: 'diagonal_panels', name: '斜切分格', hint: '斜边制造动势，适合冲突与速度' },
  { id: 'hero_insets', name: '主图 + 特写', hint: '一张主图 + 带框特写格；白底只在格子之外，格子里仍是完整场景' },
  { id: 'freeform', name: '自由构图', hint: '由 AI 按剧情设计版面并先出预览' },
];

/**
 * 版面风格卡片（带线框预览）。点卡片即选中；选完同步写 comicStyle 与旧 comicLayout，
 * 让旧代码路径仍然读到合法值。格数与留白偏好由下面两个下拉独立控制。
 */
function styleCardChooser(current: ComicLayoutStyle): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'sti-style-cards';
  const paint = (selected: ComicLayoutStyle): void => {
    wrap.querySelectorAll<HTMLElement>('.sti-style-card').forEach(card => {
      card.classList.toggle('selected', card.dataset.style === selected);
    });
  };
  for (const item of COMIC_STYLE_CARDS) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'sti-style-card';
    card.dataset.style = item.id;
    if (item.id === current) card.classList.add('selected');
    card.appendChild(styleWireframe(item.id, { size: 78, showOrder: false }));
    const name = document.createElement('div');
    name.className = 'sti-style-card-name';
    name.textContent = item.name;
    card.appendChild(name);
    const hint = document.createElement('div');
    hint.className = 'sti-style-card-hint';
    hint.textContent = item.hint;
    card.appendChild(hint);
    card.addEventListener('click', () => {
      patchSettings(st => {
        st.modes['comic'].comicStyle = item.id;
        // 同步旧字段，兼容还没迁移的读取路径（auto 没有对应旧枚举，落到 open_montage 语义的 irregular）
        st.modes['comic'].comicLayout = item.id === 'freeform' ? 'auto' : legacyOf(item.id);
        st.panelLayout = item.id === 'freeform' ? 'regular' : legacyOf(item.id);
      });
      paint(item.id);
    });
    wrap.appendChild(card);
  }
  return wrap;
}

function legacyOf(style: ComicLayoutStyle): 'regular' | 'irregular' | 'inset' {
  if (style === 'classic_grid') return 'regular';
  if (style === 'hero_insets') return 'inset';
  return 'irregular';
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

  // 新版面系统：带线框预览的风格卡片（§5）。老设置经 adapter 迁移，不覆盖用户偏好。
  const currentStyle = resolveLayoutStyle(comic ?? {});
  const styleLabel = document.createElement('div');
  styleLabel.className = 'sti-config-sublabel';
  styleLabel.textContent = '版面风格（点选，线框即版面示意）';
  box.appendChild(styleLabel);
  box.appendChild(styleCardChooser(currentStyle));

  box.appendChild(selectRow(
    '每页格数',
    String(normalizePanelCount(comic?.comicPanelCount ?? comic?.comicPanelsPerPage ?? 0)),
    [['auto', '自动（按剧情决定）'], ['2', '固定 2 格'], ['3', '固定 3 格'], ['4', '固定 4 格']],
    v => patchSettings(st => {
      const count = v === 'auto' ? 'auto' : Number(v) as 2 | 3 | 4;
      st.modes['comic'].comicPanelCount = count;
      st.modes['comic'].comicPanelsPerPage = count === 'auto' ? 0 : count;
    }),
    '格数独立于风格。固定后每页的 panels、版面 slots 与构图词（Nkoma）都会对齐；'
    + '自动则交给 AI 按这一瞬间的信息量决定（仍是一页一次出图，格数为提示词引导，非硬保证）。',
  ));
  box.appendChild(selectRow(
    '留白偏好',
    comic?.comicWhitespace ?? 'auto',
    [['auto', '由版面决定（推荐）'], ['compact', '紧凑'], ['airy', '舒展'], ['dramatic', '大面积留白']],
    v => patchSettings(st => {
      st.modes['comic'].comicWhitespace = v as StoryIllustratorSettings['modes']['comic']['comicWhitespace'];
    }),
    '留白默认跟着风格走（传统四格紧凑、主图+特写大面积留白），这里选了就以你的偏好为准。'
    + '每格都是单独出图再排版：留白是页面空白（框外），格子里永远保留自己的场景背景。'
    + '「开放拼版」本身是铺满页面的不等格拼版，留白偏好对它不起作用——要大片白边请选「主图 + 特写」。',
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

/**
 * 读剧情用的提示词来源（只读展示）。
 *
 * 为什么要摆出来：柏宝绘设置里的「自定义提示词」现在会被我们一并压进出图前
 * 读剧情的 system（服装一致性、什么算自创，全写在那份规范里）。用户改完它
 * 在小剧场看不到任何反馈，只能猜「生效了没有」——所以在这里直接报字数。
 */
function renderPromptSource(): HTMLElement {
  const set = readPromptSet();
  const src = readPromptSetSource();
  const block = section(
    '读剧情用的提示词',
    '柏宝绘 → 设置 →「自定义提示词」里的 NAI 规范与思维链，会被一并压进我们读剧情的请求'
    + '（和柏宝绘自己出图时一样）。留空不是没有规则：柏宝绘会用它内置的那一份，我们也照用同一份——'
    + '这样两边画同一个角色才会是同一张脸。',
  );
  const box = document.createElement('div');
  box.className = 'sti-config-eplist';
  const label = (kind: 'user' | 'builtin', len: number) =>
    kind === 'user' ? `你的自定义 · ${len} 字` : `柏宝绘内置 · ${len} 字`;
  const rows: Array<[string, string]> = [
    ['NAI 规范', label(src.spec, set.spec.length)],
    ['思维链', label(src.thinking, set.thinking.length)],
    ['破限词', label(src.jailbreak, set.jailbreak.length)],
  ];
  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'sti-config-ep';
    row.textContent = `${label} → ${value}`;
    box.appendChild(row);
  }
  block.appendChild(box);
  return block;
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
 * 出图日志（独立标签页）
 *
 * 柏宝绘的「请求历史」是它模块内的内存 store，刻意不持久化、也没有写入接口；
 * 而且**只有楼层卡片那条链路会写**（Card.vue 里调 beginImage/finishImage）。
 * 小剧场三套走的是公开出图接口，天生进不去那里——不是不想接，是没有口子。
 *
 * 所以这里自己记一份，重点是**失败时的错误原文**与**实际发出去的提示词**：
 * 那是判断「图为什么跟剧情无关」的唯一依据。
 */
/**
 * 「提示词」标签页。
 *
 * 设计取舍：
 * - 直接显示**当前生效的全文**（默认或覆盖），不是「比默认多了什么」——
 *   用户要能整段读一遍、整段改。
 * - 留空保存 = 恢复默认。这一条必须让用户看得见，否则「清空」会被理解成发空提示词。
 * - 改坏了的代价说明写在下面：字段名是解析器的契约，改字段名会解析失败。
 */
function renderPromptSettings(panel: HTMLElement): HTMLElement {
  const wrap = document.createElement('div');
  const doc = promptDocOf(promptDocId) ?? PROMPT_DOCS[0];
  promptDocId = doc.id;
  const hasMany = !!doc.defaults.many;
  const variant: PromptVariant = hasMany ? promptVariant : 'single';

  const settings = getSettings(DEFAULT_SETTINGS);
  const overrides = settings.promptOverrides ?? {};
  const customized = isCustomized(doc.id, variant, overrides);
  const current = resolveTemplate(doc.id, variant, overrides);

  wrap.appendChild(section(
    '内置提示词',
    '这就是插件「读剧情」时发给模型的原话（不含柏宝绘自定义提示词与角色库，那两段另行注入）。'
    + '留空保存 = 恢复内置默认。',
  ));

  // ── 选哪一套 ──
  const chips = document.createElement('div');
  chips.className = 'sti-prompt-chips';
  for (const item of PROMPT_DOCS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `sti-prompt-chip${item.id === doc.id ? ' active' : ''}`;
    btn.textContent = item.label;
    if (isCustomized(item.id, 'single', overrides) || (item.defaults.many && isCustomized(item.id, 'many', overrides))) {
      const dot = document.createElement('span');
      dot.className = 'sti-prompt-dot';
      dot.title = '这一套有自定义版本';
      btn.appendChild(dot);
    }
    btn.addEventListener('click', () => {
      promptDocId = item.id;
      promptVariant = 'single';
      render(panel, 'prompts');
    });
    chips.appendChild(btn);
  }
  wrap.appendChild(chips);

  // ── 单格 / 多格 ──
  if (hasMany) {
    const seg = document.createElement('div');
    seg.className = 'sti-prompt-seg';
    for (const [value, label] of [['single', '单格'], ['many', '多格']] as Array<[PromptVariant, string]>) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `sti-prompt-seg-btn${variant === value ? ' active' : ''}`;
      btn.textContent = label;
      const marked = isCustomized(doc.id, value, overrides);
      if (marked) {
        const dot = document.createElement('span');
        dot.className = 'sti-prompt-dot';
        dot.title = '这一版已自定义';
        btn.appendChild(dot);
      }
      btn.addEventListener('click', () => {
        promptVariant = value;
        render(panel, 'prompts');
      });
      seg.appendChild(btn);
    }
    wrap.appendChild(seg);
  }

  const hint = document.createElement('div');
  hint.className = 'sti-config-sub';
  hint.textContent = doc.hint;
  wrap.appendChild(hint);

  // ── 编辑区 ──
  const area = document.createElement('textarea');
  area.className = 'sti-prompt-area';
  area.value = current;
  area.spellcheck = false;
  area.rows = 20;
  wrap.appendChild(area);

  const vars = document.createElement('div');
  vars.className = 'sti-prompt-vars';
  vars.textContent = `可用变量：${doc.vars.map(v => `{{${v}}}`).join('  ')}`
    + ' · 条件段写法 {{#name}}…{{/name}}（成立才保留）/ {{^name}}…{{/name}}（不成立才保留）';
  wrap.appendChild(vars);

  // ── 操作 ──
  const bar = document.createElement('div');
  bar.className = 'sti-prompt-actions';

  const state = document.createElement('span');
  state.className = `sti-prompt-state${customized ? ' is-custom' : ''}`;
  state.textContent = customized ? '● 已自定义' : '○ 内置默认';
  bar.appendChild(state);

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'sti-prompt-btn';
  reset.textContent = '恢复默认';
  reset.disabled = !customized;
  reset.addEventListener('click', () => {
    const next = { ...getSettings(DEFAULT_SETTINGS) };
    const map = { ...(next.promptOverrides ?? {}) };
    delete map[overrideKey(doc.id, variant)];
    next.promptOverrides = map;
    saveSettings(next);
    render(panel, 'prompts');
  });
  bar.appendChild(reset);

  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'sti-prompt-btn is-primary';
  save.textContent = '保存';
  save.addEventListener('click', () => {
    const next = { ...getSettings(DEFAULT_SETTINGS) };
    const map = { ...(next.promptOverrides ?? {}) };
    const value = area.value.trim();
    if (!value) delete map[overrideKey(doc.id, variant)];
    else map[overrideKey(doc.id, variant)] = value;
    next.promptOverrides = map;
    saveSettings(next);
    render(panel, 'prompts');
  });
  bar.appendChild(save);
  wrap.appendChild(bar);

  const note = document.createElement('div');
  note.className = 'sti-config-sub sti-prompt-note';
  note.textContent = '改措辞、加规矩都没问题；但 JSON 的字段名（title / characters / tags / nl / cast / panels / lines …）'
    + '是解析器的契约，改名会让这一块解析不出来。改坏了点「恢复默认」。';
  wrap.appendChild(note);

  return wrap;
}

function renderLogSection(): HTMLElement {
  const entries = getImageLog();
  const live = getRunStatus();

  const box = section(
    '调用记录',
    '本插件自己记的（内存级，刷新即清）。正文插图/漫画走柏宝绘卡片，也会进它的「请求历史」；'
    + '小剧场走公开出图接口，只在这里。',
  );

  // ── 现在在干什么 ──
  const liveRow = document.createElement('div');
  liveRow.className = `sti-log-live ${live ? `is-${live.level}` : 'is-idle'}`;
  const liveDot = document.createElement('span');
  liveDot.className = 'sti-run-dot';
  liveRow.appendChild(liveDot);
  const liveText = document.createElement('span');
  liveText.textContent = live ? runStatusText(live) : '当前没有任务在跑。';
  liveRow.appendChild(liveText);
  box.appendChild(liveRow);

  const bar = document.createElement('div');
  bar.className = 'sti-log-bar';
  const count = document.createElement('span');
  const failed = entries.filter(e => e.status === 'error').length;
  count.textContent = `最近 ${entries.length} 条（上限 80）${failed ? ` · 失败 ${failed} 条` : ''}`;
  bar.appendChild(count);
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'sti-cs-regen';
  clear.textContent = '清空';
  clear.addEventListener('click', () => {
    clearImageLog();
    showConfigPanel('log');
  });
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'sti-cs-link';
  refresh.textContent = '刷新';
  refresh.style.marginLeft = '8px';
  refresh.addEventListener('click', () => showConfigPanel('log'));
  bar.appendChild(refresh);
  bar.appendChild(clear);
  box.appendChild(bar);

  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'sti-config-empty';
    empty.textContent = '还没有记录。生成一次图之后再回来看。';
    box.appendChild(empty);
    return box;
  }

  for (const entry of entries.slice(0, 40)) {
    box.appendChild(buildLogRow(entry));
  }
  return box;
}

function buildLogRow(entry: ImageLogEntry): HTMLElement {
  const row = document.createElement('details');
  row.className = `sti-log-item ${entry.status === 'error' ? 'is-error' : ''}`;

  const kindText = entry.kind === 'llm'
    ? '读剧情'
    : entry.kind === 'plan'
      ? '切方案'
      : entry.kind === 'notice'
        ? '提示'
        : '出图';

  const summary = document.createElement('summary');
  summary.className = 'sti-log-summary';
  summary.textContent = [
    formatTime(entry.at),
    kindText,
    // 'restore' 不是创作模式，是收尾的「还原方案」——直接显示中文，别让日志里冒英文键名
    entry.mode === 'restore' ? '还原方案' : MODE_LABEL[entry.mode] ?? entry.mode,
    entry.kind === 'plan' ? '' : `#${entry.floor}`,
    entry.kind === 'notice' ? '' : entry.status === 'error' ? '失败' : '成功',
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
  if (entry.kind === 'notice') {
    if (entry.prompt) body.appendChild(logField('说明', entry.prompt));
    row.appendChild(body);
    return row;
  }
  body.appendChild(logField('正向', entry.prompt));
  if (entry.nl) body.appendChild(logField('nl', entry.nl));
  if (entry.negative) body.appendChild(logField('负面', entry.negative));
  // 角色外貌：走柏宝绘原生的 character prompt 通道，不在这段正向词里。
  // 「人物不像」时先看这里——空的就是当时没匹配上角色库。
  body.appendChild(logField(
    '角色（柏宝绘角色库）',
    entry.characters?.length
      ? entry.characters.map(c => `${c.name}：${c.tag}`).join('\n')
      : '（这次没有带上任何角色外貌 —— 要么模型没写角色，要么名字没对上角色库）',
  ));
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
