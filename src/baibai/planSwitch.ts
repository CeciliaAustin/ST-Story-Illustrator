/**
 * 柏宝绘「切换当前出图方案」触发器
 *
 * 为什么只能点 UI：
 * 柏宝绘把设置读进模块级 Vue 响应式对象，只在启动时 hydrate 一次；外部直接改
 * extension_settings['baibai_image'] 不会被它读取。唯一稳妥的切换方式是触发它
 * 自己的 UI（导航到「渠道」→ NAI → 点方案 radio），走它的 switchTo()。
 *
 * 上一版的失败原因（重要）：
 * 只点开了它的主入口，却默认「渠道页 / NAI 页签」已经在前台——只要它上次停在
 * 设置页或 ComfyUI 页签，方案 radio 根本不在 DOM 里，于是轮询几秒后静默失败，
 * 出图照旧用旧方案（NAI5），钱照花。现在每一步都自己导航、并且**必须确认**
 * activePlanId 真的变了才放行。
 *
 * 依赖它当前 DOM 结构（shadow DOM #bbi-app-host、.plan-item button[role=radio]、
 * 导航 button.bbi-nav-item、页签 button[role=tab]），柏宝绘升级后若结构变化，
 * 切换会失败——但失败会**中止生成**，不会悄悄用错方案。
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
const PANEL_TITLE = '渠道';
const TAB_LABEL = 'NAI';

function shadowRoot(): ShadowRoot | null {
  const host = document.getElementById(HOST_ID);
  return host?.shadowRoot ?? null;
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

/** 打开柏宝绘主面板（已开着则不动）。 */
function openPanelIfNeeded(): void {
  if (shadowRoot()) return;
  const menuItem = document.getElementById('bbi-menu-item');
  if (menuItem) {
    (menuItem as HTMLElement).click();
    return;
  }
  const orb = document.querySelector<HTMLElement>('.bbi-orb, [class*="bbi-floating-orb"]');
  orb?.click();
}

/** 方案列表里所有方案按钮（只认 plan-item 下那个，避免撞到接入点/ComfyUI 的单选）。 */
function planRadios(root: ShadowRoot): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('.plan-item button.item-main[role="radio"]'));
}

/** 按名字找方案按钮：先精确、再唯一包含；多义就报错，绝不猜。 */
export function pickPlanRadio(
  radios: HTMLElement[],
  planName: string,
): { radio: HTMLElement | null; ambiguous: boolean } {
  const nameOf = (btn: HTMLElement) =>
    (btn.querySelector('.item-name')?.textContent ?? btn.textContent ?? '').trim();
  const exact = radios.filter(btn => nameOf(btn) === planName);
  if (exact.length === 1) return { radio: exact[0], ambiguous: false };
  if (exact.length > 1) return { radio: null, ambiguous: true };
  const fuzzy = planName ? radios.filter(btn => nameOf(btn).includes(planName)) : [];
  if (fuzzy.length === 1) return { radio: fuzzy[0], ambiguous: false };
  return { radio: null, ambiguous: fuzzy.length > 1 };
}

/** 导航到「渠道」页：方案列表不在 DOM 时才点，避免无意义地打断用户。 */
function clickNavToBackend(root: ShadowRoot): boolean {
  if (planRadios(root).length > 0) return true;
  const navs = Array.from(root.querySelectorAll<HTMLElement>('button.bbi-nav-item'));
  const target = navs.find(btn => {
    const label = (btn.getAttribute('title') ?? btn.getAttribute('aria-label') ?? btn.textContent ?? '').trim();
    return label === PANEL_TITLE;
  });
  if (!target) return false;
  target.click();
  return true;
}

/** 在「渠道」页里切到 NAI 页签（方案列表只存在于这个页签）。 */
function clickNaiTab(root: ShadowRoot): boolean {
  if (planRadios(root).length > 0) return true;
  const tabs = Array.from(root.querySelectorAll<HTMLElement>('button[role="tab"]'));
  const target = tabs.find(btn => (btn.textContent ?? '').trim() === TAB_LABEL);
  if (!target) return false;
  target.click();
  return true;
}

/** 关掉我们打开的面板（原本就开着的话不动它）。 */
function closePanelIfWeOpened(root: ShadowRoot, weOpened: boolean): void {
  if (!weOpened) return;
  const close = Array.from(root.querySelectorAll<HTMLElement>('button.bbi-icon-btn')).find(
    btn => (btn.getAttribute('title') ?? '') === '关闭',
  );
  close?.click();
}

/**
 * 切换柏宝绘当前出图方案，并在返回前确认 activePlanId 真的变了。
 *
 * @param planId 目标方案 id（柏宝绘内的 id）
 * @param timeoutMs 导航 + 找按钮的总等待上限
 */
export async function switchBaiBaiPlan(planId: string, timeoutMs = 12_000): Promise<SwitchResult> {
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

  const hadPanel = !!shadowRoot();
  openPanelIfNeeded();
  const root = await waitFor(() => shadowRoot(), 4000);
  if (!root) {
    return {
      ok: false,
      reason: 'no-ui',
      message: '打不开柏宝绘面板，无法切换出图方案（请确认柏宝绘已启用）。',
    };
  }

  // 导航：渠道页 → NAI 页签 → 方案 radio。三步都失败才放弃。
  const deadline = Date.now() + timeoutMs;
  let radio: HTMLElement | null = null;
  let ambiguous = false;

  while (Date.now() < deadline) {
    if (planRadios(root).length === 0) {
      clickNavToBackend(root);
      await sleep(150);
      clickNaiTab(root);
      await sleep(150);
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
    await sleep(150);
  }

  if (ambiguous) {
    closePanelIfWeOpened(root, !hadPanel);
    return {
      ok: false,
      reason: 'ambiguous',
      message: `柏宝绘里有多个方案名含「${target.name}」，无法确定该点哪一个。请把方案名改成互不包含的写法。`,
    };
  }
  if (!radio) {
    closePanelIfWeOpened(root, !hadPanel);
    return {
      ok: false,
      reason: 'no-ui',
      message: `没能在柏宝绘「渠道 → NAI」里找到方案「${target.name}」。请确认它在方案列表里（不是接入点），或打开柏宝绘手动选一次。`,
    };
  }

  if (radio.hasAttribute('disabled')) {
    closePanelIfWeOpened(root, !hadPanel);
    return { ok: false, reason: 'no-ui', message: `方案「${target.name}」被禁用，无法选中。` };
  }

  radio.click();

  // 必须确认：点不到 / 没生效就中止，绝不带着旧方案去出图
  const confirmed = await waitFor(() => (readOutConfig().activePlanId === planId ? true : null), 4000);
  closePanelIfWeOpened(root, !hadPanel);

  if (!confirmed) {
    return {
      ok: false,
      reason: 'no-ui',
      message: `已点击方案「${target.name}」，但柏宝绘没有真的切过去（当前仍是「${readOutConfig().activePlanName}」）。`,
    };
  }
  return { ok: true, reason: 'switched', message: `已切到「${target.name}」。` };
}
