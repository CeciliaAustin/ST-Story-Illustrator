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

export type ImageLogKind = 'image' | 'llm';
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
  size?: string;
  /** 这次出图实际用的柏宝绘方案名（排查「明明分了方案却用旧的」的关键证据） */
  plan?: string;
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
  size?: string;
  /** 这次出图实际用的柏宝绘方案名（排查「明明分了方案却用旧的」的关键证据） */
  plan?: string;
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

export function getImageLog(): readonly ImageLogEntry[] {
  return entries;
}

export function clearImageLog(): void {
  entries.length = 0;
}
