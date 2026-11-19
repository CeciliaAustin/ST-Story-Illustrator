/**
 * 柏宝绘「切换当前出图方案」触发器
 *
 * 为什么只能点 UI：
 * 柏宝绘把设置读进模块级 Vue 响应式对象 `settings`，只在启动时 hydrate 一次；
 * 外部直接改 extension_settings['baibai_image'] 不会被它读取（它读自己的内存副本）。
 * 唯一稳妥的切换方式是走它自己的 UI —— 点方案行的 `switchTo()`，让响应式对象自己变更。
 *
 * 三版踩过的坑（按时间顺序，别再踩）：
 * 1. 只点主入口、以为「渠道 → NAI」已经在前面 → 面板停在别的页时根本找不到方案行。
 * 2. 用 `shadowRoot()` 判断「面板是否已打开」→ **永远为真**。柏宝绘的 host 在启动时就
 *    建好了（`mount()` 里 `document.body.appendChild`），而 `.bbi-window` 才受 `ui.open`
 *    控制。于是永远不点菜单、里面只有空的 shadow 树，轮询到超时 → 静默失败 → 照旧用旧
 *    方案出图，钱花了方案没换。**判断"面板开着"只能看 `.bbi-window`。**
 * 3. 只看「方案行数量 > 0」就以为在 NAI 页签 → ComfyUI 页签也有 `.plan-item`，
 *    名字对不上，同样切不动。必须显式确认 NAI 页签是 `is-on`。
 *
 * 现在的纪律：
 * - 每一步都自己导航，并且每轮重新查 DOM（Vue 会重建节点，缓存引用会失效）。
 * - 切完必须看到 `aria-checked="true"` 落在目标方案上；看不到就**中止**，
 *   绝不让后面的出图带着旧方案跑（那是最贵的失败方式）。
 */

import { readOutConfig } from './planConfig';

export interface SwitchResult {
  ok: boolean;
  /** 'switched' 成功；'already' 本来就是当前；'wrong-backend' 当前渠道不是 NAI；
   *  'no-ui' 柏宝绘面板/按钮未就绪；'ambiguous' 方案名撞车；'error' 异常 */
  reason: 'switched' | 'already' | 'wrong-backend' | 'no-ui' | 'ambiguous' | 'error';
  message: string;
}

const HOST_ID = 'bbi-app-host';
const NAV_LABEL = '渠道';
const TAB_LABEL = 'NAI';

/** 面板 DOM 探针（诊断用）：失败时把「看到了什么」写进报错，省得瞎猜。 */
interface DomProbe {
  hasHost: boolean;
  open: boolean;
  navs: string[];
  tabs: string[];
  plans: string[];
}

function shadowRoot(): ShadowRoot | null {
  const host = document.getElementById(HOST_ID);
  return host?.shadowRoot ?? null;
}

/** 面板真的开着吗。**只看 `.bbi-window`**——它才受 ui.open 控制。 */
function panelWindow(): HTMLElement | null {
  return shadowRoot()?.querySelector<HTMLElement>('.bbi-window') ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** 轮询直到 fn 返回真值（或超时）。 */
async function waitFor<T>(fn: () => T | null | undefined, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(120);
  }
}

/**
 * 打开柏宝绘面板：魔杖菜单入口 → 顶栏按钮 → 悬浮球，依次尝试。
 * 返回是否点到了某个入口（点到了不代表已开，还要等 `.bbi-window`）。
 */
function clickOpenEntry(): boolean {
  const menu = document.getElementById('bbi-menu-item');
  if (menu) {
    menu.click();
    return true;
  }
  const topbar = document.querySelector<HTMLElement>('#bbi-topbar-button .drawer-toggle');
  if (topbar) {
    topbar.click();
    return true;
  }
  const orb = shadowRoot()?.querySelector<HTMLElement>('.bbi-orb');
  if (orb) {
    orb.click();
    return true;
  }
  return false;
}

/** 确保面板打开；返回 shadow root（面板元素在里面）。 */
async function ensurePanelOpen(timeoutMs: number): Promise<ShadowRoot | null> {
  if (panelWindow()) return shadowRoot();
  const root = shadowRoot();
  if (!root) return null; // 柏宝绘没加载
  if (!clickOpenEntry()) return null;
  return await waitFor(() => (panelWindow() ? shadowRoot() : null), timeoutMs);
}

// ============================================================
// 纯函数：元素 → 语义（单测锁这些规则）
// ============================================================

/** 导航按钮的文字：优先 title/aria-label，其次窄屏下的 .bbi-nav-label。 */
export function navLabelOf(btn: HTMLElement): string {
  const label = btn.querySelector('.bbi-nav-label')?.textContent;
  return (btn.getAttribute('title') ?? btn.getAttribute('aria-label') ?? label ?? btn.textContent ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 按名字找导航按钮：精确匹配唯一才用，绝不在多个里猜。 */
export function pickNavButton(buttons: HTMLElement[], label: string): HTMLElement | null {
  const exact = buttons.filter(btn => navLabelOf(btn) === label);
  return exact.length === 1 ? exact[0] : null;
}

/** 页签文字（`NAI` / `ComfyUI`）。 */
export function tabLabelOf(btn: HTMLElement): string {
  return (btn.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** 按名字找页签：精确优先；唯一前缀匹配也认（`NAI 图像` 这类）。 */
export function pickTab(tabs: HTMLElement[], label: string): HTMLElement | null {
  const exact = tabs.filter(btn => tabLabelOf(btn) === label);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const prefix = label ? tabs.filter(btn => tabLabelOf(btn).startsWith(label)) : [];
  return prefix.length === 1 ? prefix[0] : null;
}

/** 方案按钮上的名字。 */
export function planNameOf(btn: HTMLElement): string {
  return (btn.querySelector('.item-name')?.textContent ?? btn.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** 按名字找方案按钮：先精确、再唯一包含；多义就报错，绝不猜。 */
export function pickPlanRadio(
  radios: HTMLElement[],
  planName: string,
): { radio: HTMLElement | null; ambiguous: boolean } {
  const exact = radios.filter(btn => planNameOf(btn) === planName);
  if (exact.length === 1) return { radio: exact[0], ambiguous: false };
  if (exact.length > 1) return { radio: null, ambiguous: true };
  const fuzzy = planName ? radios.filter(btn => planNameOf(btn).includes(planName)) : [];
  if (fuzzy.length === 1) return { radio: fuzzy[0], ambiguous: false };
  return { radio: null, ambiguous: fuzzy.length > 1 };
}

/** 这个方案行现在是不是选中态（Vue 直接写 aria-checked，比读设置更即时）。 */
function isRadioChecked(radio: HTMLElement | null): boolean {
  return radio?.getAttribute('aria-checked') === 'true';
}

// ============================================================
// DOM 查询
// ============================================================

function navButtons(root: ShadowRoot): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('button.bbi-nav-item'));
}

function tabButtons(root: ShadowRoot): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('button[role="tab"]'));
}

/** 只认方案行里的单选按钮，避开接入点 / ComfyUI 预设行。 */
function planRadios(root: ShadowRoot): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('.plan-item button.item-main[role="radio"]'));
}

function probe(root: ShadowRoot | null): DomProbe {
  if (!root) return { hasHost: false, open: false, navs: [], tabs: [], plans: [] };
  return {
    hasHost: true,
    open: !!panelWindow(),
    navs: navButtons(root).map(navLabelOf).filter(Boolean),
    tabs: tabButtons(root).map(tabLabelOf).filter(Boolean),
    plans: planRadios(root).map(planNameOf).filter(Boolean),
  };
}

/** 一句话描述现场，报错时带上，用户能直接看出卡在哪一步。 */
function describe(root: ShadowRoot | null): string {
  const p = probe(root);
  if (!p.hasHost) return '柏宝绘未加载（找不到 #bbi-app-host）';
  const parts = [
    `面板${p.open ? '已开' : '未开'}`,
    `导航[${p.navs.join('/') || '空'}]`,
    `页签[${p.tabs.join('/') || '空'}]`,
    `方案行 ${p.plans.length} 个`,
  ];
  return parts.join(' · ');
}

// ============================================================
// 导航
// ============================================================

/**
 * 把面板带到「渠道 → NAI」。
 * 返回 'ready' 表示方案行已可查；'pending' 表示这一轮点了导航需要等重渲染。
 */
async function gotoNai(root: ShadowRoot): Promise<'ready' | 'pending' | 'stuck'> {
  const nav = pickNavButton(navButtons(root), NAV_LABEL);
  const tabs = tabButtons(root);
  // 导航按钮存在但没高亮 → 还在别的页；点它。
  if (nav && !nav.classList.contains('is-active')) {
    nav.click();
    await sleep(240); // 页面切换是 out-in 过渡，旧页先卸载
    return 'pending';
  }
  // 没有导航按钮、也没有页签：可能正处于过渡中
  if (!nav && tabs.length === 0) return 'pending';

  const tab = pickTab(tabButtons(shadowRoot() ?? root), TAB_LABEL);
  if (!tab) return 'stuck'; // 在渠道页却找不到 NAI 页签
  // 页签没选中 → 点它（ComfyUI 页签也有 .plan-item，不点开就会去点错方案）
  if (!tab.classList.contains('is-on')) {
    tab.click();
    await sleep(240); // KeepAlive + 过渡，面板整体重挂
    return 'pending';
  }
  return 'ready';
}

/** 关掉我们打开的面板（原本就开着的话不动它）。 */
function closePanelIfWeOpened(weOpened: boolean): void {
  if (!weOpened) return;
  const root = shadowRoot();
  if (!root) return;
  const close = Array.from(root.querySelectorAll<HTMLElement>('button.bbi-icon-btn')).find(
    btn => (btn.getAttribute('title') ?? '') === '关闭',
  );
  close?.click();
}

// ============================================================
// 主流程
// ============================================================

/**
 * 切换柏宝绘当前出图方案，并在返回前确认目标方案真的成了选中态。
 *
 * @param planId 目标方案 id（柏宝绘 nai.plans 里的 id）
 * @param timeoutMs 导航 + 找按钮的总等待上限
 */
export async function switchBaiBaiPlan(planId: string, timeoutMs = 15_000): Promise<SwitchResult> {
  const snap = readOutConfig();
  const target = snap.plans.find(p => p.id === planId);
  if (!target) {
    return { ok: false, reason: 'error', message: '方案不存在（可能已在柏宝绘里被删除）。' };
  }
  // 方案属于 NAI。当前出图渠道不是 NAI 时，切 NAI 方案对出图毫无影响——直接报错，
  // 免得又出现「以为切了、其实照旧用贵方案」的账单。
  if (snap.backend !== 'nai') {
    return {
      ok: false,
      reason: 'wrong-backend',
      message: `柏宝绘当前出图渠道是「${snap.backend}」，不是 NAI；按模式分配方案只对 NAI 生效。请先在柏宝绘里把出图后端改成 NAI。`,
    };
  }
  if (snap.activePlanId === planId) {
    return { ok: true, reason: 'already', message: `「${target.name}」已经是当前方案。` };
  }

  const weOpened = !panelWindow();
  let root = await ensurePanelOpen(5000);
  if (!root) {
    return {
      ok: false,
      reason: 'no-ui',
      message: `打不开柏宝绘面板，无法切换出图方案（${describe(shadowRoot())}）。请确认柏宝绘已启用。`,
    };
  }

  const deadline = Date.now() + timeoutMs;
  let ambiguous = false;
  let radio: HTMLElement | null = null;

  while (Date.now() < deadline) {
    root = panelWindow() ? shadowRoot() : await ensurePanelOpen(3000);
    if (!root) break;

    const navState = await gotoNai(root);
    if (navState !== 'ready') {
      // 点了导航/页签，等它重渲染后重来；stuck 也重试几次（过渡期可能短暂看不到页签）
      if (navState === 'stuck') await sleep(200);
      continue;
    }

    const picked = pickPlanRadio(planRadios(root), target.name);
    if (picked.radio) {
      radio = picked.radio;
      break;
    }
    if (picked.ambiguous) {
      ambiguous = true;
      break;
    }
    // 页签对了但没有这个方案名：可能仍在过渡，再给两轮
    await sleep(200);
  }

  if (ambiguous) {
    closePanelIfWeOpened(weOpened);
    return {
      ok: false,
      reason: 'ambiguous',
      message: `柏宝绘里有多个方案名含「${target.name}」，无法确定该点哪一个。请把方案名改成互不包含的写法。`,
    };
  }
  if (!radio) {
    // 现场描述要在关面板之前取，否则只剩「面板未开」这种没用的信息
    const scene = describe(shadowRoot());
    closePanelIfWeOpened(weOpened);
    return {
      ok: false,
      reason: 'no-ui',
      message: `没能在柏宝绘「渠道 → NAI」里找到方案「${target.name}」（${scene}）。请确认它是"出图方案"里的一行，而不是接入点。`,
    };
  }
  if (radio.hasAttribute('disabled')) {
    closePanelIfWeOpened(weOpened);
    return { ok: false, reason: 'no-ui', message: `方案「${target.name}」被禁用，无法选中。` };
  }

  // 已选中就没什么可点的（readOutConfig 可能滞后，以 DOM 为准）
  if (!isRadioChecked(radio)) {
    radio.click();
    // 兜底：个别主题把点击挂在整行上，按钮没接到事件时补一次（幂等，重复点无副作用）
    let confirmed = await waitFor(() => {
      const now = pickPlanRadio(planRadios(shadowRoot() ?? root!), target.name).radio;
      return isRadioChecked(now) ? true : null;
    }, 2500);
    if (!confirmed) {
      const row = radio.closest<HTMLElement>('.plan-item');
      row?.click();
      confirmed = await waitFor(() => {
        const now = pickPlanRadio(planRadios(shadowRoot() ?? root!), target.name).radio;
        return isRadioChecked(now) ? true : null;
      }, 2500);
    }
    if (!confirmed) {
      const now = describe(shadowRoot());
      closePanelIfWeOpened(weOpened);
      return {
        ok: false,
        reason: 'no-ui',
        message: `已点击方案「${target.name}」，但柏宝绘没有真的切过去（${now}）。`,
      };
    }
  }

  closePanelIfWeOpened(weOpened);

  // DOM 已确认选中 → 出图一定用新方案（它读的是同一份响应式状态）。
  // 设置副本（extension_settings）由它的 watcher 异步回写，可能晚一两个 tick，
  // 所以这里只等一小会儿做交叉核对，绝不用它去否定已经成功的切换——
  // 否则会出现「其实切了，我们却报失败、白扔一次读剧情额度」。
  const agreed = await waitFor(
    () => (readOutConfig().activePlanId === planId ? true : null),
    1200,
  );
  if (!agreed) {
    const after = readOutConfig();
    console.warn(
      `[配图] 方案已在面板上切到「${target.name}」，但设置副本仍显示「${after.activePlanName || '未知'}」，` +
        '以其自身落盘延迟处理，不影响本次出图。',
    );
  }
  return { ok: true, reason: 'switched', message: `已切到「${target.name}」。` };
}
