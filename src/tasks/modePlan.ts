/**
 * 出图方案切换（按创作模式）
 *
 * 柏宝绘公开出图接口不接受 planId，只能改它自己的「当前方案」。任务队列是串行的，
 * 所以「切一次 → 出图 → 下个任务再按需切」不会互相干扰。切换失败不中断出图，
 * 只降级为「用当前方案」并记日志。
 */

import type { CreationMode, StoryIllustratorSettings } from '../types';
import { readOutConfig } from '../baibai/planConfig';
import { switchBaiBaiPlan } from '../baibai/planSwitch';

export async function ensureModeOutPlan(
  mode: CreationMode,
  settings: StoryIllustratorSettings,
): Promise<void> {
  const planId = settings.modeOutPlans?.[mode];
  if (!planId) return;

  const snap = readOutConfig();
  if (!snap.plans.some(p => p.id === planId)) {
    console.warn(`[ST-Story-Illustrator] ${mode} 指定的出图方案已不存在，改用当前方案。`);
    return;
  }
  if (snap.activePlanId === planId) return;

  try {
    const result = await switchBaiBaiPlan(planId);
    if (!result.ok && result.reason !== 'already') {
      console.warn(`[ST-Story-Illustrator] 切换出图方案失败（继续用当前方案）：${result.message}`);
    }
  } catch (e) {
    console.warn('[ST-Story-Illustrator] 切换出图方案异常（继续用当前方案）:', e);
  }
}
