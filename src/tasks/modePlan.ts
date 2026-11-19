/**
 * 出图方案切换（按创作模式）
 *
 * 柏宝绘公开出图接口不接受 planId，只能改它自己的「当前方案」。任务队列是串行的，
 * 所以「切一次 → 出图 → 下个任务再按需切」不会互相干扰。
 *
 * 纪律：**切不过去就抛错，绝不降级用当前方案。**
 * 之前这里是只 warn 就继续，于是三个模式全按柏宝绘当时那套（NAI5）出图——
 * 用户按模式分配 NAI4.5 方案就是为了省钱，静默降级等于替他多花钱还瞒着他。
 */

import type { CreationMode, StoryIllustratorSettings } from '../types';
import { MODE_LABEL } from '../types';
import { readOutConfig } from '../baibai/planConfig';
import { switchBaiBaiPlan } from '../baibai/planSwitch';

export async function ensureModeOutPlan(
  mode: CreationMode,
  settings: StoryIllustratorSettings,
): Promise<void> {
  const planId = settings.modeOutPlans?.[mode];
  if (!planId) return; // 没指定 = 跟随当前方案，这是用户的显式选择，不是失败

  const snap = readOutConfig();
  const target = snap.plans.find(p => p.id === planId);
  if (!target) {
    throw new Error(
      `${MODE_LABEL[mode]} 指定的出图方案已不存在（可能已被删除）。请到「配图设置」重新指定。`,
    );
  }
  if (snap.activePlanId === planId) return;

  let result: Awaited<ReturnType<typeof switchBaiBaiPlan>>;
  try {
    result = await switchBaiBaiPlan(planId);
  } catch (e) {
    throw new Error(
      `${MODE_LABEL[mode]} 切换出图方案「${target.name}」时出错：${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!result.ok) {
    throw new Error(`${MODE_LABEL[mode]} 无法切到出图方案「${target.name}」：${result.message}`);
  }

  // 双保险：切完再读一次，确认当前方案真的就是它
  const after = readOutConfig();
  if (after.activePlanId !== planId) {
    throw new Error(
      `${MODE_LABEL[mode]} 切换出图方案失败：当前仍是「${after.activePlanName || '未知'}」，` +
        `没有按指定的「${target.name}」出图。`,
    );
  }
}
