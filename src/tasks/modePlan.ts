/**
 * 出图方案切换（按创作模式）
 *
 * 柏宝绘公开出图接口不接受 planId，只能改它自己的「当前方案」。任务队列是串行的，
 * 所以「切一次 → 出图 → 下个任务再按需切」不会互相干扰。
 *
 * 纪律：**切不过去就抛错，绝不降级用当前方案。**
 * 之前这里是只 warn 就继续，于是三个模式全按柏宝绘当时那套（NAI5）出图——
 * 用户按模式分配 NAI4.5 方案就是为了省钱，静默降级等于替他多花钱还瞒着他。
 *
 * 另一个更隐蔽的坑：方案是**全局**的。小剧场切走之后不切回来，接下来正文插图
 * （走柏宝绘卡片）就会用 QQ 人/黑白漫那套模型与画师串出图——用户看到的是
 * 「选了 QQ 人，正文插图也跟着变成 Q 版了」。所以这里还负责记住切换前的方案，
 * 任务结束时还原（见 restoreOutPlan）。
 *
 * 每次切换都会往「出图日志」写一条（成功/失败都写）。理由：方案是模型 + 画师串，
 * 切没切从成图上判断不了，只有日志能证明。
 */

import type { CreationMode, StoryIllustratorSettings } from '../types';
import { MODE_LABEL } from '../types';
import { readOutConfig } from '../baibai/planConfig';
import { switchBaiBaiPlan } from '../baibai/planSwitch';
import { recordPlanSwitch } from '../log/imageLog';

/** 任务开始前那套方案（第一次切走时记下，任务结束还原用）。 */
let savedPlanId: string | null = null;
let savedPlanName = '';

/** 清掉记住的原方案（切换失败/用户主动放弃时调用，避免还原到一半的状态）。 */
export function forgetSavedPlan(): void {
  savedPlanId = null;
  savedPlanName = '';
}

/**
 * 把柏宝绘切到该模式指定的出图方案。
 *
 * - 没指定（留空）= 跟随柏宝绘当前方案，这是用户的显式选择，直接返回。
 * - 已经是目标方案 = 直接返回（幂等，可以在每张图前反复调用）。
 * - 切不过去 = 抛错中止任务。
 */
export async function ensureModeOutPlan(
  mode: CreationMode,
  settings: StoryIllustratorSettings,
): Promise<void> {
  const planId = settings.modeOutPlans?.[mode];
  if (!planId) return;

  const snap = readOutConfig();
  const target = snap.plans.find(p => p.id === planId);
  if (!target) {
    const message =
      `${MODE_LABEL[mode]} 指定的出图方案已不存在（可能已在柏宝绘里删除）。` +
      '请到「配图设置 → 小剧场 → 出图方案」重新指定。';
    recordPlanSwitch({ mode, plan: planId.slice(0, 8), status: 'error', detail: message });
    throw new Error(message);
  }
  if (snap.activePlanId === planId) return;

  // 第一次切走前记下原方案：任务结束后要还原，否则正文插图会被这套方案污染
  if (savedPlanId === null) {
    savedPlanId = snap.activePlanId || '';
    savedPlanName = snap.activePlanName || '';
  }

  let result: Awaited<ReturnType<typeof switchBaiBaiPlan>>;
  try {
    result = await switchBaiBaiPlan(planId);
  } catch (e) {
    const detail = `${MODE_LABEL[mode]} 切换出图方案「${target.name}」时出错：${e instanceof Error ? e.message : String(e)}`;
    recordPlanSwitch({ mode, plan: target.name, status: 'error', detail });
    throw new Error(detail);
  }
  if (!result.ok) {
    const detail = `${MODE_LABEL[mode]} 无法切到出图方案「${target.name}」：${result.message}`;
    recordPlanSwitch({ mode, plan: target.name, status: 'error', detail });
    throw new Error(detail);
  }

  recordPlanSwitch({ mode, plan: target.name, status: 'ok', detail: result.message });
}

export interface RestoreResult {
  ok: boolean;
  /** 还原失败的原因（成功时为空） */
  message?: string;
}

/**
 * 任务结束：把柏宝绘的当前方案切回任务开始前那套。
 *
 * - 本任务没切过方案 → 什么都不做（零成本）。
 * - `restorePlanAfterTask` 关掉 → 保留当前方案（用户显式选择了这种用法）。
 * - 还原失败**不抛错**：任务本身已经出完图了，不能因为收尾失败把成功报成失败；
 *   只把原因写进日志并提示。
 *
 * 为什么不先读设置比对：柏宝绘的设置落盘有延迟，读到的可能还是切换前那份，
 * 据此跳过还原就会把「QQ 人那套」留在全局。宁可多一次点击。
 */
export async function restoreOutPlan(settings: StoryIllustratorSettings): Promise<RestoreResult> {
  const target = savedPlanId;
  const targetName = savedPlanName;
  savedPlanId = null;
  savedPlanName = '';
  if (!target) return { ok: true };
  if (settings.restorePlanAfterTask === false) {
    recordPlanSwitch({ mode: 'restore', plan: targetName, status: 'ok', detail: '已关闭「出图后还原方案」，保留当前方案。' });
    return { ok: true };
  }

  try {
    const result = await switchBaiBaiPlan(target);
    if (!result.ok) {
      const message = `出图已完成，但没能把柏宝绘的方案切回「${targetName || target}」：${result.message}`;
      recordPlanSwitch({ mode: 'restore', plan: targetName || target, status: 'error', detail: message });
      return { ok: false, message };
    }
    recordPlanSwitch({ mode: 'restore', plan: targetName || target, status: 'ok', detail: result.message });
    return { ok: true };
  } catch (e) {
    const message = `出图已完成，但还原方案时出错：${e instanceof Error ? e.message : String(e)}`;
    recordPlanSwitch({ mode: 'restore', plan: targetName || target, status: 'error', detail: message });
    return { ok: false, message };
  }
}
