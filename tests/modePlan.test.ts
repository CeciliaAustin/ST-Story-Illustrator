/**
 * 按模式切方案 / 出图后还原方案
 *
 * 这两件事都只能在柏宝绘的 DOM 上做，真点不了；所以这里把「切换器」换成假的，
 * 锁住的是**记账与收尾的规则**：
 * - 切走前记下原方案，收尾一定要切回去（且不带 force 的快速路径不能用在收尾上）
 * - 没切过就什么都不做（别为了"还原"去动用户手动选的方案）
 * - 用户关掉「出图后还原」就保留
 * - 还原失败重试一次，最终失败要留痕（日志 + 提示），不能静默
 * - 重画插在队列任务中间跑时，先交还的那个不能把方案抢走（引用计数）
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  acquirePlanGuard,
  ensureModeOutPlan,
  releasePlanGuard,
  resetPlanGuard,
  restoreOutPlan,
  savedPlan,
  setPlanSwitcher,
} from '../src/tasks/modePlan';
import { clearImageLog, getImageLog } from '../src/log/imageLog';
import { initSTEnvironment } from '../src/host/sillytavern';
import { DEFAULT_SETTINGS, type StoryIllustratorSettings } from '../src/types';
import type { SwitchOptions, SwitchResult } from '../src/baibai/planSwitch';

/** 一个最小可用的柏宝绘设置：原方案 A（风乎）、模式方案 B（QQ人）。 */
async function stubST(activePlanId = 'planA'): Promise<void> {
  (globalThis as unknown as Record<string, unknown>).getContext = () => ({
    chat: [],
    extensionSettings: {
      baibai_image: {
        defaultBackend: 'nai',
        nai: {
          activePlanId,
          plans: [
            { id: 'planA', name: '风乎', model: 'nai-diffusion-5-full' },
            { id: 'planB', name: 'QQ人', model: 'nai-diffusion-4-5-full' },
          ],
        },
      },
    },
  });
  await initSTEnvironment();
}

function settingsWith(patch: Partial<StoryIllustratorSettings> = {}): StoryIllustratorSettings {
  return {
    ...DEFAULT_SETTINGS,
    modeOutPlans: { 'chibi-status': 'planB' },
    restorePlanAfterTask: true,
    ...patch,
  } as StoryIllustratorSettings;
}

interface Call {
  planId: string;
  force: boolean;
}

/** 装一个假切换器，按 sequence 依次返回结果（用完之后一直返回最后一项）。 */
function stubSwitcher(sequence: Array<Partial<SwitchResult>> = []): Call[] {
  const calls: Call[] = [];
  setPlanSwitcher(async (planId: string, options?: SwitchOptions) => {
    calls.push({ planId, force: options?.force === true });
    const step = sequence.length ? sequence[Math.min(calls.length - 1, sequence.length - 1)] : { ok: true };
    return {
      ok: step.ok !== false,
      reason: step.ok === false ? 'no-ui' : 'switched',
      message: step.message ?? (step.ok === false ? '打不开柏宝绘面板' : `已切到「${planId}」`),
    } as SwitchResult;
  });
  return calls;
}

beforeEach(async () => {
  resetPlanGuard();
  clearImageLog();
  setPlanSwitcher(null);
  await stubST();
});

describe('ensureModeOutPlan', () => {
  it('切走之前记住原方案', async () => {
    const calls = stubSwitcher();
    await ensureModeOutPlan('chibi-status', settingsWith());

    expect(calls).toEqual([{ planId: 'planB', force: false }]);
    expect(savedPlan()).toEqual({ id: 'planA', name: '风乎' });
  });

  it('已经是目标方案就什么都不做（每张图前可反复调用）', async () => {
    await stubST('planB');
    const calls = stubSwitcher();

    await ensureModeOutPlan('chibi-status', settingsWith());

    expect(calls).toHaveLength(0);
    // 没切过 → 没有需要还原的东西
    expect(savedPlan()).toBeNull();
  });

  it('没指定方案 = 跟随柏宝绘当前方案，不动它', async () => {
    const calls = stubSwitcher();

    await ensureModeOutPlan('chibi-status', settingsWith({ modeOutPlans: {} }));

    expect(calls).toHaveLength(0);
    expect(savedPlan()).toBeNull();
  });

  it('方案已被删除 → 抛错中止（绝不降级用当前方案出图）', async () => {
    stubSwitcher();

    await expect(
      ensureModeOutPlan('chibi-status', settingsWith({ modeOutPlans: { 'chibi-status': 'planGone' } })),
    ).rejects.toThrow(/已不存在/);
  });
});

describe('restoreOutPlan', () => {
  it('切回任务开始前那套，并且走 force（不信设置副本的"已经是了"）', async () => {
    const calls = stubSwitcher();
    await ensureModeOutPlan('chibi-status', settingsWith());

    const result = await restoreOutPlan(settingsWith());

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      { planId: 'planB', force: false },
      { planId: 'planA', force: true },
    ]);
    expect(savedPlan()).toBeNull();
  });

  it('没切过方案 → 不碰用户手动选的那套', async () => {
    const calls = stubSwitcher();

    const result = await restoreOutPlan(settingsWith());

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('用户关掉「出图后还原方案」→ 保留当前方案，并在日志里说明', async () => {
    const calls = stubSwitcher();
    await ensureModeOutPlan('chibi-status', settingsWith());

    const result = await restoreOutPlan(settingsWith({ restorePlanAfterTask: false }));

    expect(result.ok).toBe(true);
    expect(calls.map(c => c.planId)).toEqual(['planB']);
    const plan = getImageLog().find(e => e.kind === 'plan');
    expect(plan?.prompt).toContain('已关闭');
  });

  it('第一次还原失败会重试一次，成功就算还原成功', async () => {
    stubSwitcher([{ ok: true }, { ok: false, message: '面板还在过渡' }, { ok: true }]);
    await ensureModeOutPlan('chibi-status', settingsWith());

    const result = await restoreOutPlan(settingsWith());

    expect(result.ok).toBe(true);
    const restoreLogs = getImageLog().filter(e => e.kind === 'plan' && e.mode === 'restore');
    expect(restoreLogs).toHaveLength(1);
    expect(restoreLogs[0]?.status).toBe('ok');
  });

  it('两次都失败 → 报失败、写日志、留一条用户看得见的提示', async () => {
    stubSwitcher([{ ok: true }, { ok: false, message: '打不开柏宝绘面板' }]);
    const warn = vi.fn();
    (globalThis as unknown as Record<string, unknown>).toastr = { warning: warn };
    await ensureModeOutPlan('chibi-status', settingsWith());

    const result = await restoreOutPlan(settingsWith());

    expect(result.ok).toBe(false);
    expect(result.message).toContain('没能把柏宝绘的方案切回');

    const failed = getImageLog().find(e => e.kind === 'plan' && e.mode === 'restore');
    expect(failed?.status).toBe('error');

    const notice = getImageLog().find(e => e.kind === 'notice' && e.mode === 'restore');
    expect(notice?.prompt).toContain('手动切回');

    expect(warn).toHaveBeenCalled();
  });
});

describe('引用计数（重画插在队列任务中间）', () => {
  it('还有别的任务持有方案时，先交还的不还原', async () => {
    const calls = stubSwitcher();
    await ensureModeOutPlan('chibi-status', settingsWith());

    acquirePlanGuard(); // 队列任务
    acquirePlanGuard(); // 中途插进来的重画

    const first = await releasePlanGuard(settingsWith()); // 重画先结束
    expect(first.deferred).toBe(true);
    expect(calls.map(c => c.planId)).toEqual(['planB']); // 方案没被抢走
    expect(savedPlan()).not.toBeNull(); // 账还记着，等最后一个交还

    const last = await releasePlanGuard(settingsWith()); // 队列任务结束
    expect(last.ok).toBe(true);
    expect(calls.map(c => c.planId)).toEqual(['planB', 'planA']);
    expect(savedPlan()).toBeNull();
  });

  it('计数不会因为多交还几次而变成负数', async () => {
    const calls = stubSwitcher();
    acquirePlanGuard();
    acquirePlanGuard();

    await releasePlanGuard(settingsWith());
    await releasePlanGuard(settingsWith());
    await releasePlanGuard(settingsWith());

    // 没切过方案 → 多交还也只是不做事
    expect(calls).toHaveLength(0);
  });
});
