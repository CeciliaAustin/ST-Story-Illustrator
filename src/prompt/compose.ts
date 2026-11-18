/**
 * 英文 Prompt 组装纯函数
 *
 * 只选取 enabled === true 的片段。
 * 只读取 english，绝不读取 chinese。
 * 按 order 排序。
 * 对重复 Tag 做保守去重。
 * 保留 NovelAI / BBI 所需的权重语法和特殊字符。
 * 中文永远不能进入 prompt、negative 或其他生图字段。
 */

import type { TagSegment } from '../types';

// ============================================================
// 组装
// ============================================================

/**
 * 将英文 Tag 片段组装为完整 prompt 字符串。
 *
 * 规则：
 * - 只选取 enabled === true 的片段
 * - 只读取 english 数组
 * - 按 order 排序
 * - 保守去重（完全相同的裸词去重，权重词保留）
 * - 保留权重语法（如 1.4::multiple views::）
 */
export function composeEnglishPrompt(segments: TagSegment[]): string {
  const enabled = segments.filter(s => s.enabled);
  const sorted = [...enabled].sort((a, b) => a.order - b.order);

  // 收集所有英文 tag，按片段顺序
  const allTags: string[] = [];
  const seenBareTags = new Set<string>();

  for (const segment of sorted) {
    for (const tag of segment.english) {
      const trimmed = tag.trim();
      if (!trimmed) continue;

      // 获取裸词用于去重判断
      const bare = bareTagOf(trimmed);

      // 保守去重：如果裸词完全相同且不是权重块，跳过
      // 权重块（含 ::）保留不去重，因为可能是有意的重复强调
      if (bare && seenBareTags.has(bare) && !trimmed.includes('::')) {
        continue;
      }

      if (bare) seenBareTags.add(bare);
      allTags.push(trimmed);
    }
  }

  return allTags.join(', ');
}

// ============================================================
// 辅助
// ============================================================

/**
 * 获取 tag 的裸词形式（去除权重语法）。
 * "1.4::multiple views::" → "multiple views"
 * "2koma" → "2koma"
 */
export function bareTagOf(tag: string): string {
  let text = tag.trim();
  // 去除前缀权重 "数字::"
  text = text.replace(/^\s*[\d.]+\s*::/, '');
  // 去除前导 ::
  text = text.replace(/^\s*::/, '');
  // 去除后缀 ::
  text = text.replace(/::\s*$/, '');
  return text.trim().toLowerCase();
}

/**
 * 组装负面提示词。
 * 同样只读取英文。
 */
export function composeNegativePrompt(segments: TagSegment[]): string {
  const enabled = segments.filter(s => s.enabled && s.source === 'global');
  const sorted = [...enabled].sort((a, b) => a.order - b.order);

  const tags: string[] = [];
  for (const segment of sorted) {
    for (const tag of segment.english) {
      const trimmed = tag.trim();
      if (trimmed) tags.push(trimmed);
    }
  }

  return tags.join(', ');
}
