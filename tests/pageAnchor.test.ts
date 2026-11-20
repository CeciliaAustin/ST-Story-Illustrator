/**
 * 每页独立正文锚点（任务书 §8）。
 * 一页一个 source range：用本页台词原文定位，没台词退回 beat.event，最后退回选段开头。
 */
import { describe, it, expect, vi } from 'vitest';
import type { ComicPagePlan } from '../src/types';

// workflow.ts 顶层 import 了浏览器/ST 模块，用轻量 mock 隔离，只取纯函数。
vi.mock('../src/host/sillytavern', () => ({
  saveChatSafe: async () => {},
  readPersonaName: () => '',
  getContext: () => ({}),
  getCurrentChatId: () => '',
  getEventTypes: () => ({}),
}));

const { pickPageAnchorText } = await import('../src/tasks/workflow');

function page(partial: Partial<ComicPagePlan> = {}): ComicPagePlan {
  return { pageIndex: 0, title: '', layout: 'regular', tags: '', panels: [], ...partial };
}

const SEGMENT = '「等等。」他拉住她的手腕。\n她回头，眼里带着笑。\n门在身后轻轻关上。';

describe('pickPageAnchorText', () => {
  it('有台词：用本页第一句台词原文定位（不是选段开头）', () => {
    expect(pickPageAnchorText(page({ dialogue: [{ text: '她回头，眼里带着笑。' }] }), SEGMENT))
      .toBe('她回头，眼里带着笑。');
  });

  it('台词太长只取前 24 字，避免跨过多个句子', () => {
    const long = '这是一句非常非常长的台词它一直说个不停然后牵扯到后面好几句完全不相关的内容';
    expect(pickPageAnchorText(page({ dialogue: [{ text: long }] }), SEGMENT)).toBe(long.slice(0, 24));
  });

  it('没台词但 beat.event 在原文里：用它定位', () => {
    expect(pickPageAnchorText(page({ beat: { event: '门在身后轻轻关上' } }), SEGMENT))
      .toBe('门在身后轻轻关上');
  });

  it('beat.event 不在原文里（模型概括）：退回选段开头', () => {
    expect(pickPageAnchorText(page({ beat: { event: '两人最终和解' } }), SEGMENT))
      .toBe(SEGMENT.slice(0, 120));
  });

  it('什么都没有：退回选段开头', () => {
    expect(pickPageAnchorText(page(), SEGMENT)).toBe(SEGMENT.slice(0, 120));
  });

  it('两页有不同台词 → 得到不同锚点（不会全堆一处）', () => {
    const p1 = page({ pageIndex: 0, dialogue: [{ text: '「等等。」他拉住她的手腕。' }] });
    const p2 = page({ pageIndex: 1, dialogue: [{ text: '门在身后轻轻关上。' }] });
    expect(pickPageAnchorText(p1, SEGMENT)).not.toBe(pickPageAnchorText(p2, SEGMENT));
  });
});
