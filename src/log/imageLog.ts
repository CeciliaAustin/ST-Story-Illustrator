/**
 * 出图 / 读剧情 请求日志（本插件自己的调用记录）
 *
 * 为什么不用柏宝绘的「请求历史」：
 * - 那一页的数据是它模块内的内存 store，**刻意不持久化、也没有公开写入接口**，
 *   别的插件记不进去；只有它自己那条链路（楼层卡片 / 自动 tag）会写。
 * - 小剧场三套走的是公开出图接口，天然不在它那条链路上。
 *
 * 所以这里自己记一份：每次出图发出去的 prompt / nl / 负面 / 种子 / 耗时 / 错误原文，
 * 以及读剧情失败的副 API 报错——这些才是排查时要看的东西。
 * 内存级（刷新即清），与柏宝绘的定位一致，不写进聊天或 settings。
 */

export type ImageLogKind = 'image' | 'llm' | 'plan' | 'notice';
export type ImageLogStatus = 'ok' | 'error';

export interface ImageLogEntry {
  id: number;
  at: number;
  kind: ImageLogKind;
  mode: string;
  floor: number;
  /** image：card=走柏宝绘卡片，api=走公开出图接口 */
  source?: 'card' | 'api';
  prompt: string;
  nl?: string;
  negative?: string;
  /**
   * 这次出图用的角色外貌（取柏宝绘角色库，走它原生的 character prompt 通道）。
   * 「人物不像」时要看的就是这一段：空 = 当时没匹配上角色。
   */
  characters?: Array<{ name: string; tag: string; nl?: string }>;
  size?: string;
  /** 这次出图实际用的柏宝绘方案名（排查「明明分了方案却用旧的」的关键证据） */
  plan?: string;
  /** 该方案的模型名（NAI5 与 NAI4.5 账单差一倍，光看方案名有时不够） */
  model?: string;
  seed?: number;
  status: ImageLogStatus;
  durationMs?: number;
  error?: string;
}

const MAX_ENTRIES = 80;
const MAX_TEXT = 4000;

const entries: ImageLogEntry[] = [];
let nextId = 1;

function clip(text: string | undefined): string {
  const value = String(text ?? '');
  return value.length <= MAX_TEXT ? value : `${value.slice(0, MAX_TEXT)}…（原长 ${value.length}）`;
}

function push(record: Omit<ImageLogEntry, 'id' | 'at'>): ImageLogEntry {
  const entry: ImageLogEntry = {
    ...record,
    prompt: clip(record.prompt),
    ...(record.nl ? { nl: clip(record.nl) } : {}),
    ...(record.negative ? { negative: clip(record.negative) } : {}),
    ...(record.error ? { error: clip(record.error) } : {}),
    id: nextId,
    at: Date.now(),
  };
  nextId += 1;
  entries.unshift(entry);
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  return entry;
}

/** 记一次出图请求（成功或失败都记）。 */
export function recordImageLog(input: {
  mode: string;
  floor: number;
  source: 'card' | 'api';
  prompt: string;
  nl?: string;
  negative?: string;
  /**
   * 这次出图用的角色外貌（取柏宝绘角色库，走它原生的 character prompt 通道）。
   * 「人物不像」时要看的就是这一段：空 = 当时没匹配上角色。
   */
  characters?: Array<{ name: string; tag: string; nl?: string }>;
  size?: string;
  /** 这次出图实际用的柏宝绘方案名（排查「明明分了方案却用旧的」的关键证据） */
  plan?: string;
  /** 该方案的模型名（NAI5 与 NAI4.5 账单差一倍，光看方案名有时不够） */
  model?: string;
  seed?: number;
  status: ImageLogStatus;
  durationMs?: number;
  error?: string;
}): ImageLogEntry {
  return push({ kind: 'image', ...input });
}

/** 记一次读剧情 / 写 tag 的失败（副 API 报错就靠这条看见原文）。 */
export function recordLlmError(input: {
  mode: string;
  floor: number;
  error: string;
  prompt?: string;
}): ImageLogEntry {
  return push({
    kind: 'llm',
    mode: input.mode,
    floor: input.floor,
    prompt: input.prompt ?? '',
    status: 'error',
    error: input.error,
  });
}

/**
 * 记一次「按模式切出图方案」。
 *
 * 为什么值得单独记：方案（模型 + 画师串）切没切，从成图上很难一眼看出来，
 * 而它又是花钱与画风的总开关。记一条「QQ 人状态栏 → NAI4.5 · 成功 / 失败原因」，
 * 事后翻日志就能确定是"没切"还是"切了但效果不对"。
 */
export function recordPlanSwitch(input: {
  mode: string;
  plan: string;
  status: ImageLogStatus;
  /** 成功时是「已切到 X」，失败时是完整原因 */
  detail?: string;
}): ImageLogEntry {
  return push({
    kind: 'plan',
    mode: input.mode,
    floor: 0,
    prompt: input.detail ?? '',
    plan: input.plan,
    status: input.status,
  });
}

/**
 * 记一条「没失败、但用户必须知道」的提示。
 *
 * 目前只有一个来源：模型写了某个角色，但柏宝绘角色库里没有这个人 →
 * 这一格没有外貌 tag，画出来必然不像。不报的话用户只会看到「怎么又不像」，
 * 而根本原因（角色库缺条目）在图上是看不出来的。
 */
export function recordNotice(input: {
  mode: string;
  floor: number;
  text: string;
}): ImageLogEntry {
  return push({
    kind: 'notice',
    mode: input.mode,
    floor: input.floor,
    prompt: input.text,
    status: 'ok',
  });
}

export function getImageLog(): readonly ImageLogEntry[] {
  return entries;}

export function clearImageLog(): void {
  entries.length = 0;
}
