/**
 * 正文行内挂载：选段 → 插在哪一段之后
 *
 * 线上现象：划线生成后图跑到整楼最下面；有时干脆插在半句话中间。
 * 根因两处：
 * 1) 拿「渲染后文本」去跟单个文本节点做 `includes`：Markdown 强调符不显示、
 *    引号被排版、空行数量不同 → 经常找不到 → 降级成追加末尾；
 * 2) 选区跨节点（`*他笑了*` 中间夹一个 `<em>`）时，任何单节点都不含完整选段。
 *
 * 这里锁住纯函数那一半：把片段拼起来再宽松匹配，并映射回「选段末尾所在的片段」。
 */

import { describe, it, expect } from 'vitest';
import { pickTextSegment } from '../src/ui/floorCards';

describe('pickTextSegment', () => {
  it('单段精确命中', () => {
    expect(pickTextSegment(['他推开门，雪落了进来。', '远处没有人。'], '雪落了进来')).toBe(0);
    expect(pickTextSegment(['他推开门。', '雪落了进来。'], '雪落了进来')).toBe(1);
  });

  it('选段被行内标签切成两段时仍能命中（拼起来再找）', () => {
    // DOM: 他笑了<em>一下</em>，转身走了。
    const segments = ['他笑了', '一下', '，转身走了。'];
    expect(pickTextSegment(segments, '他笑了一下')).toBe(1);
  });

  it('忽略 Markdown 强调符：渲染后是「他笑了」，原文里是 *他笑了*', () => {
    expect(pickTextSegment(['他笑了，转身走了。'], '*他笑了*')).toBe(0);
  });

  it('忽略弯引号 / 全角差异', () => {
    expect(pickTextSegment(['她说：“别走。”'], '她说:"别走。"')).toBe(0);
  });

  it('找不到时返回 -1（调用方据此如实降级，而不是假装插对了）', () => {
    expect(pickTextSegment(['完全不相干的正文'], '这句话不存在')).toBe(-1);
    expect(pickTextSegment([], '任意')).toBe(-1);
    expect(pickTextSegment(['有正文'], '   ')).toBe(-1);
  });

  it('同一句话出现两次时取第一处（与正文阅读顺序一致）', () => {
    expect(pickTextSegment(['好的。', '他说。', '好的。'], '好的')).toBe(0);
  });
});
