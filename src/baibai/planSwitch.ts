/**
 * 柏宝绘「切换当前出图方案」触发器
 *
 * 为什么这样实现：
 * 柏宝绘把设置读进模块级 Vue 响应式对象，只在启动时 hydrate 一次；外部直接改
 * extension_settings['baibai_image'] 不会被它读取。唯一稳妥的切换方式是触发它
 * 自己的 UI：openPanel('backend') → 找到方案 radio → 点击 → 走它的 switchTo()。
 * 这样内存与落盘都由柏宝绘自己完成，与我们只读不写的纪律一致。
 *
 * 依赖它当前 DOM 结构（shadow DOM #bbi-app-host、button[role=radio]），柏宝绘升级后
 * 若结构变化，切换会失败但**不会影响出图**（只是按钮无效），届时更新选择器即可。
 */

import { readOutConfig } from './planConfig';

export interface SwitchResult {
  ok: boolean;
  /** 'switched' 成功；'already' 本来就是当前；'no-ui' 柏宝绘面板/按钮未就绪；'error' 异常 */
  reason: 'switched' | 'already' | 'no-ui' | 'error';
  message: string;
}

/**
 * 在柏宝绘 shadow DOM 里找"改用这套方案出图"的 radio 按钮。
 * 用方案名匹配 item-name 文本，避免依赖 id（DOM 上不带 id）。
 */
function findPlanRadio(root: Document | ShadowRoot, planName: string): HTMLElement | null {
  const radios = Array.from(root.querySelectorAll<HTMLElement>('button.item-main[role="radio"]'));
  for (const btn of radios) {
    const nameEl = btn.querySelector('.item-name');
    const label = (nameEl?.textContent ?? btn.textContent ?? '').trim();
    if (label === planName || (planName && label.includes(planName))) return btn;
  }
  return null;
}

/** 找到柏宝绘 Vue 应用的 shadow root（若面板已挂载）。 */
function getBaiBaiShadowRoot(): ShadowRoot | null {
  const host = document.getElementById('bbi-app-host');
  return host?.shadowRoot ?? null;
}

/** 触发柏宝绘打开后端设置页（点击它注入魔杖菜单的入口，再由它自己 openPanel）。 */
function openBaiBaiBackendPanel(): void {
  const menuItem = document.getElementById('bbi-menu-item');
  if (menuItem) {
    (menuItem as HTMLElement).click();
    return;
  }
  // 兜底：直接找悬浮球
  const orb = document.querySelector<HTMLElement>('.bbi-orb, [class*="bbi-floating-orb"]');
  orb?.click();
}

/**
 * 切换柏宝绘当前出图方案。
 * 策略：校验目标存在 → 尝试打开面板 → 等方案 radio 出现 → 点击 → 轮询确认 activePlanId 变化。
 */
export async function switchBaiBaiPlan(planId: string, timeoutMs = 6000): Promise<SwitchResult> {
  const snap = readOutConfig();
  const target = snap.plans.find(p => p.id === planId);
  if (!target) {
    return { ok: false, reason: 'error', message: '方案不存在（可能已被删除）。' };
  }
  if (snap.activePlanId === planId) {
    return { ok: false, reason: 'already', message: `「${target.name}」已经是当前方案。` };
  }

  try {
    openBaiBaiBackendPanel();
  } catch {
    // 打不开也继续找，也许面板本来就开着
  }

  const deadline = Date.now() + timeoutMs;
  let clicked = false;
  while (Date.now() < deadline) {
    const shadow = getBaiBaiShadowRoot();
    if (shadow) {
      const radio = findPlanRadio(shadow, target.name);
      if (radio && !radio.hasAttribute('disabled')) {
        radio.click();
        clicked = true;
        break;
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }

  if (!clicked) {
    return {
      ok: false,
      reason: 'no-ui',
      message: '没能定位到柏宝绘的方案按钮。请打开柏宝绘设置（魔杖菜单 → 柏宝绘 → 后端），手动选「' + target.name + '」，本面板会自动同步。',
    };
  }

  // 轮询确认 activePlanId 已变（柏宝绘 switchTo 是同步写内存 + 防抖落盘）
  const confirmDeadline = Date.now() + 2000;
  while (Date.now() < confirmDeadline) {
    if (readOutConfig().activePlanId === planId) {
      return { ok: true, reason: 'switched', message: `已切到「${target.name}」。` };
    }
    await new Promise(r => setTimeout(r, 150));
  }
  return {
    ok: false,
    reason: 'no-ui',
    message: '已点击方案按钮，但未能确认切换结果。请到柏宝绘里确认当前方案是否为「' + target.name + '」。',
  };
}
