/**
 * 等柏宝绘把自己的正文插图画完。
 *
 * 为什么必须等：柏宝绘的公开出图接口**不接受 planId**，只能改它全局的「当前方案」。
 * 它的自动打标是「先读剧情写 tag、再排队出图」，两步之间有几十秒；我们一开跑就把
 * 当前方案切成 QQ 人/黑白漫那套，它随后发出去的那个 NAI 请求就用错了方案与画师串
 * ——用户看到的顺序是「正文插图 → 我们切方案 → 正文插图用的是切完的方案 → 我们出图」，
 * 整页画风错位，而且我们再切回去也来不及。
 *
 * 判据只用柏宝绘自己的账本：正文里每个 `<bbi_image>` tag 的原文算 promptHash，
 * 去 `message.extra.bbiImage[swipeId][hash]` 里找有没有 `status: 'ready'` 的条目。
 * 没条目 = 还没出完（它只在出完后才写 entry），有 = 这一张已经落地。
 *
 * 两条避免「白等」的规则：
 * - 楼层里连 tag 都没有：只给一小段宽限（默认 2.5s），等不到就走——说明柏宝绘的
 *   自动打标没开，或者这一楼根本不归它管，没必要陪它耗。
 * - 有 tag 但一直不出（后端没配 / 用户取消了）：到上限就放弃并返回 pending，
 *   调用方提示一句「画风可能不对」，绝不能把任务卡死。
 */

import { getMessage } from '../host/sillytavern';
import { promptHash } from './bbiTag';

const IMAGE_TAG = /<bbi_image>[\s\S]+?<\/bbi_image>/gi;

export interface WaitImagesOptions {
  /** 一次等待总上限（毫秒）。 */
  timeoutMs?: number;
  /** 楼层里还没有 tag 时，等它出现多久（毫秒）。 */
  graceMs?: number;
  /** 轮询间隔（毫秒）。 */
  pollMs?: number;
  /** 首次进入等待时回调一次（状态条用）。 */
  onWait?: (info: { tags: number; pending: number }) => void;
  /** 注入 sleep，便于测试。 */
  sleep?: (ms: number) => Promise<void>;
}

export interface WaitImagesResult {
  /** 正文里现在有几个 bbi_image tag。 */
  tags: number;
  /** 还没出完的 tag 数。 */
  pending: number;
  /** 等到上限仍未出完。 */
  timedOut: boolean;
  /** 实际等了多少毫秒（没等为 0）。 */
  waitedMs: number;
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** 这条 tag 是否已经有出好的图（任一 ready 条目即算）。 */
function hasReadyImage(floor: number, swipeId: number, tag: string): boolean {
  const msg = getMessage(floor) as Record<string, unknown> | undefined;
  const extra = msg?.extra as Record<string, unknown> | undefined;
  const store = extra?.bbiImage as Record<string, Record<string, unknown[]>> | undefined;
  if (!store) return false;
  const bucket = store[String(swipeId)];
  if (!bucket) return false;
  const list = bucket[promptHash(tag)];
  if (!Array.isArray(list)) return false;
  return list.some(entry => (entry as { status?: string } | null)?.status === 'ready');
}

/** 当前正文里的全部生图 tag 原文（按出现顺序）。 */
export function imageTagsOf(floor: number): string[] {
  const mes = String(getMessage(floor)?.mes ?? '');
  return [...mes.matchAll(IMAGE_TAG)].map(m => m[0]);
}

/**
 * 等这一楼的 bbi_image 全部出完。永不抛错——等不到只是「可能画风不对」，不该让任务失败。
 */
export async function waitForBaiBaiImages(
  floor: number,
  options: WaitImagesOptions = {},
): Promise<WaitImagesResult> {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const graceMs = options.graceMs ?? 2_500;
  const pollMs = options.pollMs ?? 800;
  const sleep = options.sleep ?? defaultSleep;
  const startedAt = Date.now();
  let notified = false;

  let swipeId = 0;
  try {
    const msg = getMessage(floor) as Record<string, unknown> | undefined;
    if (typeof msg?.swipe_id === 'number') swipeId = msg.swipe_id;
  } catch {
    /* 拿不到 swipe 就按 0 算，和柏宝绘的默认分桶一致 */
  }

  for (;;) {
    const tags = imageTagsOf(floor);
    const elapsed = Date.now() - startedAt;

    if (tags.length === 0) {
      // 还没写 tag：可能它还没来得及打标。宽限期内再等等，超了就当作与它无关
      if (elapsed >= graceMs) return { tags: 0, pending: 0, timedOut: false, waitedMs: elapsed };
      await sleep(Math.min(pollMs, Math.max(0, graceMs - elapsed)));
      continue;
    }

    const pending = tags.filter(tag => !hasReadyImage(floor, swipeId, tag)).length;
    if (pending === 0) return { tags: tags.length, pending: 0, timedOut: false, waitedMs: elapsed };

    if (!notified) {
      notified = true;
      options.onWait?.({ tags: tags.length, pending });
    }
    if (elapsed >= timeoutMs) return { tags: tags.length, pending, timedOut: true, waitedMs: elapsed };

    await sleep(Math.min(pollMs, Math.max(0, timeoutMs - elapsed)));
  }
}
