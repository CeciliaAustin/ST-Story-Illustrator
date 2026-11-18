/**
 * Prompt 组装纯函数测试
 *
 * 从 src/prompt/compose.ts 导入实际实现，
 * 测试 composeEnglishPrompt、bareTagOf、composeNegativePrompt。
 */

import { describe, it, expect } from 'vitest';
import { composeEnglishPrompt, composeNegativePrompt, bareTagOf } from '../src/prompt/compose';
import type { TagSegment } from '../src/types';

// 辅助：快速构造 TagSegment
function makeSegment(
  source: 'character' | 'scene' | 'global',
  english: string[],
  order: number,
  enabled = true,
): TagSegment {
  return {
    id: `seg-${source}-${order}`,
    source,
    english,
    chinese: [],
    enabled,
    order,
  };
}

describe('composeEnglishPrompt', () => {
  it('should compose from enabled segments sorted by order', () => {
    const segments = [
      makeSegment('scene', ['kiss', 'hug'], 2),
      makeSegment('character', ['blue hair', 'red eyes'], 1),
    ];
    expect(composeEnglishPrompt(segments)).toBe('blue hair, red eyes, kiss, hug');
  });

  it('should skip disabled segments', () => {
    const segments = [
      makeSegment('character', ['blue hair'], 1),
      makeSegment('scene', ['kiss'], 2, false),
    ];
    expect(composeEnglishPrompt(segments)).toBe('blue hair');
  });

  it('should handle empty segments', () => {
    expect(composeEnglishPrompt([])).toBe('');
  });

  it('should filter empty english strings', () => {
    const segments = [
      makeSegment('character', ['blue hair', '', 'red eyes'], 1),
    ];
    expect(composeEnglishPrompt(segments)).toBe('blue hair, red eyes');
  });

  it('should deduplicate identical bare tags', () => {
    const segments = [
      makeSegment('character', ['blue hair'], 1),
      makeSegment('scene', ['blue hair', 'kiss'], 2),
    ];
    // 'blue hair' appears in both segments, should be deduplicated
    expect(composeEnglishPrompt(segments)).toBe('blue hair, kiss');
  });

  it('should preserve weighted tags (not deduplicate them)', () => {
    const segments = [
      makeSegment('character', ['1.4::multiple views::'], 1),
      makeSegment('scene', ['multiple views'], 2),
    ];
    // Weighted tag should not be deduplicated against bare version
    const result = composeEnglishPrompt(segments);
    expect(result).toContain('1.4::multiple views::');
    expect(result).toContain('multiple views');
  });

  it('should preserve order across multiple segments', () => {
    const segments = [
      makeSegment('global', ['4koma', 'multiple views'], 0),
      makeSegment('character', ['blue hair'], 1),
      makeSegment('scene', ['kiss', 'hug'], 2),
    ];
    expect(composeEnglishPrompt(segments)).toBe('4koma, multiple views, blue hair, kiss, hug');
  });
});

describe('bareTagOf', () => {
  it('should strip numeric weight prefix', () => {
    expect(bareTagOf('1.4::multiple views::')).toBe('multiple views');
  });

  it('should strip leading :: ', () => {
    expect(bareTagOf('::some tag')).toBe('some tag');
  });

  it('should strip trailing ::', () => {
    expect(bareTagOf('some tag::')).toBe('some tag');
  });

  it('should return lowercase for dedup comparison', () => {
    expect(bareTagOf('Blue Hair')).toBe('blue hair');
  });

  it('should pass through plain tags', () => {
    expect(bareTagOf('2koma')).toBe('2koma');
  });

  it('should handle empty string', () => {
    expect(bareTagOf('')).toBe('');
  });
});

describe('composeNegativePrompt', () => {
  it('should only include global segments', () => {
    const segments = [
      makeSegment('character', ['bad anatomy'], 1),
      makeSegment('global', ['lowres', 'bad quality'], 2),
      makeSegment('scene', ['blurry'], 3),
    ];
    expect(composeNegativePrompt(segments)).toBe('lowres, bad quality');
  });

  it('should skip disabled global segments', () => {
    const segments = [
      makeSegment('global', ['lowres'], 1, false),
      makeSegment('global', ['bad quality'], 2),
    ];
    expect(composeNegativePrompt(segments)).toBe('bad quality');
  });

  it('should handle empty segments', () => {
    expect(composeNegativePrompt([])).toBe('');
  });

  it('should sort by order', () => {
    const segments = [
      makeSegment('global', ['bad quality'], 3),
      makeSegment('global', ['lowres'], 1),
    ];
    expect(composeNegativePrompt(segments)).toBe('lowres, bad quality');
  });
});
