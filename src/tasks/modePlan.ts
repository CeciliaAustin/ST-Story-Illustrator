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
 * 还原为什么会「看起来没生效」（踩过的第三个坑，别再踩）：
 * 早先判断「现在是不是已经是原方案」用的是 `readOutConfig().activePlanId`，
 * 也就是柏宝绘异步回写到 extension_settings 的那份**副本**。副本慢一拍甚至整个
 * 没跟上（它自己 watcher 的 ready 未置位时干脆不回写），于是：
 *   副本说「已经是原方案」→ 我们直接收工 → 面板上其实还停在 QQ 人 → 用户看到
 *   「出完图方案没切回去」，而日志还写着「已经是当前方案」。
 * 现在还原一律走 `force`（打开面板、按 aria-checked 认），并且：
 *   - 失败重试一次（面板/页签过渡期的抖动不该算失败）；
 *   - 最终失败写进「出图日志」并弹一条提示——方案没还原会污染下一次正文插图，
 *     这种账必须让用户当场看见，不能只落在 console 里。
 *
 * 再一个坑：`savedPlanId` 是模块级的，而「重画」可以在队列任务跑着的时候插进来。
 * 谁先退出谁还原，就会把还在出图的任务手里的方案抢走。所以改用引用计数
 * （acquirePlanGuard / releasePlanGuard），最后一个交还的才负责还原。
 */

import type { CreationMode, StoryIllustratorSettings } from '../types';
import { MODE_LABEL } from '../types';
import { readOutConfig } from '../baibai/planConfig';
import { switchBaiBaiPlan, type SwitchOptions, type SwitchResult } from '../baibai/planSwitch';
import { recordPlanSwitch, recordNotice } from '../log/imageLog';

// ============================================================
// 切换器（生产恒为 switchBaiBaiPlan；测试可替换，避免依赖柏宝绘 DOM）
// ============================================================

type PlanSwitcher = (planId: string, options?: SwitchOptions) => Promise<SwitchResult>;

let switchPlan: PlanSwitcher = (planId, options) => switchBaiBaiPlan(planId, options);

/** 仅测试用：传 null 还原成真实实现。 */
export function setPlanSwitcher(fn: PlanSwitcher | null): void {
  switchPlan = fn ?? ((planId, options) => switchBaiBaiPlan(planId, options));
}

// ============================================================
// 状态
// ============================================================

/** 任务开始前那套方案（第一次切走时记下，任务结束还原用）。 */
let savedPlanId: string | null = null;
let savedPlanName = '';

/** 正在持有方案的任务数。最后一个交还的负责还原。 */
let holders = 0;

/** 清掉记住的原方案（切换失败/用户主动放弃时调用，避免还原到一半的状态）。 */
export function forgetSavedPlan(): void {
  savedPlanId = null;
  savedPlanName = '';
}

/** 当前记住的原方案（诊断/测试用）。 */
export function savedPlan(): { id: string; name: string } | null {
  return savedPlanId === null ? null : { id: savedPlanId, name: savedPlanName };
}

/** 进入一个会按模式切方案的任务（重画、整条重出也算）。 */
export function acquirePlanGuard(): void {
  holders += 1;
}

/** 仅测试用：把引用计数与记住的方案清空，保证用例互不影响。 */
export function resetPlanGuard(): void {
  holders = 0;
  savedPlanId = null;
  savedPlanName = '';
}

// ============================================================
// 切换
// ============================================================

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

  let result: SwitchResult;
  try {
    result = await switchPlan(planId);
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

// ============================================================
// 还原
// ============================================================

export interface RestoreResult {
  ok: boolean;
  /** 还原失败的原因（成功时为空） */
  message?: string;
  /** 还有别的任务在用方案，这次先不还原（等最后一个交还时再还原） */
  deferred?: boolean;
}

/** 还原重试次数（第一次失败多半是面板/页签过渡期没就绪）。 */
const RESTORE_ATTEMPTS = 2;
const RESTORE_RETRY_MS = 700;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 弹一条提示（没有 toastr 就算了，日志里一定有）。 */
function warnUser(text: string): void {
  // 用 globalThis 而不是 window：收尾可能跑在非浏览器环境（单测/降级），别为一条提示崩掉
  const toastr = (globalThis as { toastr?: { warning?: (m: string) => void } }).toastr;
  try {
    toastr?.warning?.(text);
  } catch {
    /* 提示失败不影响还原结果 */
  }
}

/**
 * 收尾：把柏宝绘的当前方案切回任务开始前那套。
 *
 * - 本任务没切过方案 → 什么都不做（零成本）。
 * - `restorePlanAfterTask` 关掉 → 保留当前方案（用户显式选择了这种用法）。
 * - 还原失败**不抛错**：任务本身已经出完图了，不能因为收尾失败把成功报成失败；
 *   但会写日志 + 弹提示，让用户知道该手动切回去。
 *
 * 为什么一律 `force`：见文件头「还原为什么会看起来没生效」。多开一次柏宝绘面板，
 * 换的是「方案真的回到了原样」这个确定性。
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

  let lastMessage = '';
  for (let attempt = 1; attempt <= RESTORE_ATTEMPTS; attempt += 1) {
    try {
      const result = await switchPlan(target, { force: true, timeoutMs: 12_000 });
      if (result.ok) {
        const detail = attempt === 1 ? result.message : `${result.message}（第 ${attempt} 次尝试）`;
        recordPlanSwitch({ mode: 'restore', plan: targetName || target, status: 'ok', detail });
        return { ok: true };
      }
      lastMessage = result.message;
    } catch (e) {
      lastMessage = e instanceof Error ? e.message : String(e);
    }
    if (attempt < RESTORE_ATTEMPTS) await sleep(RESTORE_RETRY_MS);
  }

  const message =
    `出图已完成，但没能把柏宝绘的方案切回「${targetName || target}」：${lastMessage}` +
    '。现在它停在这次出图用的那套上——请到柏宝绘「渠道 → NAI」手动切回，' +
    '否则接下来的正文插图也会用这套模型与画师串。';
  recordPlanSwitch({ mode: 'restore', plan: targetName || target, status: 'error', detail: message });
  recordNotice({ mode: 'restore', floor: 0, text: message });
  warnUser('配图：方案没能切回原样，请到柏宝绘里手动切回。');
  return { ok: false, message };
}

/**
 * 交还方案（配合 acquirePlanGuard）。
 * 还有别的任务在用时只减计数、不还原——还原是最后一个交还者的责任。
 */
export async function releasePlanGuard(
  settings: StoryIllustratorSettings,
): Promise<RestoreResult> {
  holders = Math.max(0, holders - 1);
  if (holders > 0) return { ok: true, deferred: true };
  return restoreOutPlan(settings);
}
