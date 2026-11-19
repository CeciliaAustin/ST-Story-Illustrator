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
 * 现在每次切换都会往「出图日志」写一条（成功/失败都写）。理由：方案是模型 + 画师串，
 * 切没切从成图上判断不了，只有日志能证明。
 */

import type { CreationMode, StoryIllustratorSettings } from '../types';
import { MODE_LABEL } from '../types';
import { readOutConfig } from '../baibai/planConfig';
import { switchBaiBaiPlan } from '../baibai/planSwitch';
import { recordPlanSwitch } from '../log/imageLog';

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
