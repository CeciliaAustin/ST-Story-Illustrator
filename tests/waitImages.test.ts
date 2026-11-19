/**
 * 等柏宝绘出完正文插图（顺序竞态的唯一硬闸）
 *
 * 线上现象：正文插图忽然变成 Q 版/黑白漫的画风。根因不是画风设置，
 * 而是我们**先切了柏宝绘的「当前方案」**，它随后才把排队中的 NAI 请求发出去。
 * 这里锁住：有 tag 没出完就等、出完了立刻走、等不到有上限、没 tag 只给宽限。
 */

import { describe, it, expect, vi } from 'vitest';

const host = vi.hoisted(() => ({
  chat: [] as Array<Record<string, unknown>>,
}));

vi.mock('../src/host/sillytavern', () => ({
  getMessage: (floor: number) => host.chat[floor],
}));

const { waitForBaiBaiImages, imageTagsOf } = await import('../src/baibai/waitImages');
const { promptHash } = await import('../src/baibai/bbiTag');

const TAG_A = '<bbi_image>1girl, classroom<size>portrait</size></bbi_image>';
const TAG_B = '<bbi_image>1boy, rooftop, sunset<size>portrait</size></bbi_image>';

function setMes(
  mes: string,
  ready: Record<string, boolean> = {},
  swipeId = 0,
  /** 图记在哪个 swipe 桶里（默认与当前一致） */
  bucketSwipe = swipeId,
): void {
  const bucket: Record<string, Array<Record<string, unknown>>> = {};
  for (const [tag, ok] of Object.entries(ready)) {
    bucket[promptHash(tag)] = [{ status: ok ? 'ready' : 'error', path: ok ? '/user/images/x.png' : '' }];
  }
  host.chat[0] = { mes, swipe_id: swipeId, extra: { bbiImage: { [String(bucketSwipe)]: bucket } } };
}

const noSleep = () => Promise.resolve();

describe('waitForBaiBaiImages', () => {
  it('楼层里没有 tag：宽限期一到就走，不陪它耗', async () => {
    setMes('一段普通正文。');
    const r = await waitForBaiBaiImages(0, { graceMs: 0, sleep: noSleep });
    expect(r).toMatchObject({ tags: 0, pending: 0, timedOut: false });
  });

  it('所有 tag 都有图：立刻返回，不等', async () => {
    setMes(`正文\n${TAG_A}\n${TAG_B}`, { [TAG_A]: true, [TAG_B]: true });
    const r = await waitForBaiBaiImages(0, { sleep: noSleep });
    expect(r).toMatchObject({ tags: 2, pending: 0, timedOut: false });
  });

  it('有 tag 还没出完：等到上限并报告 pending（调用方据此提示画风可能不对）', async () => {
    setMes(`正文\n${TAG_A}\n${TAG_B}`, { [TAG_A]: true });
    const r = await waitForBaiBaiImages(0, { timeoutMs: 0, sleep: noSleep });
    expect(r.tags).toBe(2);
    expect(r.pending).toBe(1);
    expect(r.timedOut).toBe(true);
  });

  it('status=error 的条目不算出完（否则会拿错画风继续跑）', async () => {
    setMes(`正文\n${TAG_A}`, { [TAG_A]: false });
    const r = await waitForBaiBaiImages(0, { timeoutMs: 0, sleep: noSleep });
    expect(r.pending).toBe(1);
  });

  it('按 swipe 分桶读（另一条世界线的图不能拿来充数）', async () => {
    // 图记在 swipe 0 桶里，当前在 swipe 1
    setMes(`正文\n${TAG_A}`, { [TAG_A]: true }, 1, 0);
    const r = await waitForBaiBaiImages(0, { timeoutMs: 0, sleep: noSleep });
    expect(r.pending).toBe(1);
  });

  it('onWait 只在真的开始等时回调一次（状态条不闪）', async () => {
    setMes(`正文\n${TAG_A}`, {});
    const onWait = vi.fn();
    await waitForBaiBaiImages(0, { timeoutMs: 0, sleep: noSleep, onWait });
    expect(onWait).toHaveBeenCalledTimes(1);
    expect(onWait.mock.calls[0][0]).toMatchObject({ tags: 1, pending: 1 });
  });

  it('imageTagsOf 按出现顺序取出原文（hash 必须逐字节一致）', () => {
    setMes(`${TAG_B}\n中间\n${TAG_A}`);
    expect(imageTagsOf(0)).toEqual([TAG_B, TAG_A]);
  });
});
