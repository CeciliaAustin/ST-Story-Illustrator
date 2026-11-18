/**
 * 锚点匹配测试
 */

import { describe, it, expect } from 'vitest';
import { buildAnchor, matchAnchor, isAnchorValid } from '../src/selection/anchor';

describe('buildAnchor', () => {
  it('should build anchor with exact match', () => {
    const floorText = '这是开头的一段文字。角色A走进了房间，看到了角色B坐在窗边。这是后面的一段文字。';
    const selectedText = '角色A走进了房间，看到了角色B坐在窗边。';

    const anchor = buildAnchor(selectedText, floorText, 0);

    expect(anchor.selectedText).toBe(selectedText);
    expect(anchor.startOffset).toBe(10);
    expect(anchor.endOffset).toBe(10 + selectedText.length);
    expect(anchor.beforeAnchor).toContain('这是开头的一段文字');
    expect(anchor.afterAnchor).toContain('这是后面的一段文字');
  });

  it('should handle text not found in floor text', () => {
    const floorText = '这是楼层正文。';
    const selectedText = '不存在的选段';

    const anchor = buildAnchor(selectedText, floorText, 0);

    expect(anchor.selectedText).toBe(selectedText);
    expect(anchor.startOffset).toBeUndefined();
    expect(anchor.beforeAnchor).toBe('');
  });

  it('should truncate long selected text', () => {
    const longText = 'A'.repeat(3000);
    const floorText = longText;

    const anchor = buildAnchor(longText, floorText, 0);

    expect(anchor.selectedText.length).toBe(2000);
  });
});

describe('matchAnchor', () => {
  it('should match exact selected text', () => {
    const floorText = '前文。选段内容。后文。';
    const anchor = buildAnchor('选段内容。', floorText, 0);

    const result = matchAnchor(anchor, floorText);

    expect(result).not.toBeNull();
    expect(result!.startOffset).toBe(3);
    expect(result!.endOffset).toBe(3 + '选段内容。'.length);
  });

  it('should match using before/after anchors when exact fails', () => {
    const originalText = '前文锚点。选段内容。后文锚点。';
    const anchor = buildAnchor('选段内容。', originalText, 0);

    // 新文本中选段内容变了，但前后锚点还在
    const newText = '前文锚点。修改过的内容。后文锚点。';
    const result = matchAnchor(anchor, newText);

    expect(result).not.toBeNull();
    expect(result!.startOffset).toBe(5); // 前文锚点后面
    expect(result!.endOffset).toBe(12);  // 后文锚点开始前
  });

  it('should return null when no match possible', () => {
    const floorText = '前文。选段内容。后文。';
    const anchor = buildAnchor('选段内容。', floorText, 0);

    const completelyDifferent = '完全不同的文本内容。';
    const result = matchAnchor(anchor, completelyDifferent);

    expect(result).toBeNull();
  });
});

describe('isAnchorValid', () => {
  it('should return true when anchor matches', () => {
    const floorText = '前文。选段内容。后文。';
    const anchor = buildAnchor('选段内容。', floorText, 0);

    expect(isAnchorValid(anchor, floorText)).toBe(true);
  });

  it('should return false when anchor does not match', () => {
    const floorText = '前文。选段内容。后文。';
    const anchor = buildAnchor('选段内容。', floorText, 0);

    expect(isAnchorValid(anchor, '完全不同的文本')).toBe(false);
  });
});
