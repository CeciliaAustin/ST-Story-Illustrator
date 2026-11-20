/**
 * swipe 对齐：`message.extra` 不随 swipe 重置，作品必须自己按 swipe 分家。
 *
 * 用户实测：上一楼画好的漫画，swipe 出新正文之后还挂在新正文上。
 */

import { describe, expect, it } from 'vitest';
import { belongsToSwipe, artifactSwipeId } from '../src/storage/swipeScope';
import type { VisualArtifact } from '../src/types';

function makeArtifact(patch: Partial<VisualArtifact> = {}): VisualArtifact {
  return {
    id: 'sti-a',
    taskId: 't1',
    mode: 'comic',
    chatId: 'chat-1',
    sourceFloors: [5],
    anchorFloor: 5,
    mountMode: 'inline',
    imagePath: '/user/files/a.png',
    prompt: 'p',
    metadata: {},
    createdAt: 0,
    ...patch,
  };
}

const emptyTags = new Set<string>();

describe('artifactSwipeId', () => {
  it('读顶层 swipeId', () => {
    expect(artifactSwipeId(makeArtifact({ swipeId: 2 }))).toBe(2);
  });

  it('顶层缺失时兼容 metadata.swipeId', () => {
    expect(artifactSwipeId(makeArtifact({ metadata: { swipeId: 1 } }))).toBe(1);
  });

  it('都没有时返回 undefined（老数据）', () => {
    expect(artifactSwipeId(makeArtifact())).toBeUndefined();
  });

  it('非法值当作没有', () => {
    expect(artifactSwipeId(makeArtifact({ swipeId: -1 }))).toBeUndefined();
    expect(artifactSwipeId(makeArtifact({ swipeId: Number.NaN }))).toBeUndefined();
  });
});

describe('belongsToSwipe：有 swipeId 时严格对齐', () => {
  it('当前 swipe 就是生成它的那条 → 显示', () => {
    const a = makeArtifact({ swipeId: 1 });
    expect(belongsToSwipe(a, { currentSwipe: 1, taggedIds: emptyTags, swipeCount: 3 })).toBe(true);
  });

  it('swipe 走了 → 隐藏（旧图残留的正面场景）', () => {
    const a = makeArtifact({ swipeId: 0 });
    expect(belongsToSwipe(a, { currentSwipe: 1, taggedIds: emptyTags, swipeCount: 3 })).toBe(false);
  });

  it('swipe 切回去 → 又显示', () => {
    const a = makeArtifact({ swipeId: 0 });
    expect(belongsToSwipe(a, { currentSwipe: 0, taggedIds: emptyTags, swipeCount: 3 })).toBe(true);
  });

  it('即使当前 swipe 的正文有它的 tag，也不越权（tag 只在本 swipe 文本里）', () => {
    const a = makeArtifact({ swipeId: 2 });
    expect(belongsToSwipe(a, { currentSwipe: 0, taggedIds: new Set([a.id]), swipeCount: 3 })).toBe(false);
  });
});

describe('belongsToSwipe：老数据（无 swipeId）的降级', () => {
  it('当前正文有它的 bbi_manwa tag → 属于这条 swipe', () => {
    const a = makeArtifact();
    expect(belongsToSwipe(a, { currentSwipe: 2, taggedIds: new Set([a.id]), swipeCount: 3 })).toBe(true);
  });

  it('当前 swipe 已经有自己的漫画 tag，却没有它 → 老 swipe 的作品，藏', () => {
    const a = makeArtifact();
    expect(belongsToSwipe(a, { currentSwipe: 1, taggedIds: new Set(['sti-other']), swipeCount: 3 })).toBe(false);
  });

  it('没分叉过（只有一条 swipe）→ 显示，不误伤已有聊天', () => {
    const a = makeArtifact();
    expect(belongsToSwipe(a, { currentSwipe: 0, taggedIds: emptyTags, swipeCount: 1 })).toBe(true);
  });

  it('分叉过但判断不了：第一条 swipe 仍显示，切回去不会丢图', () => {
    const a = makeArtifact();
    expect(belongsToSwipe(a, { currentSwipe: 0, taggedIds: emptyTags, swipeCount: 4 })).toBe(true);
    expect(belongsToSwipe(a, { currentSwipe: 3, taggedIds: emptyTags, swipeCount: 4 })).toBe(false);
  });
});
