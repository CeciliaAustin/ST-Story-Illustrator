/**
 * ST-Story-Illustrator — 分镜相关度（纯函数）
 *
 * 这一层解决一个实测问题：模型有时只吐出构图词（`multiple views, split screen,
 * white background`），出图就成了一张与剧情毫无关系的空页面。
 * 判据必须集中在一处：调用方据此决定「重问一次」还是「直接报错」。
 */

import type { ComicPagePlan, BaiBaiCharacter } from '../types';

/** 构图词族：只有这些词的 tag 串不构成画面内容。 */
const PANEL_FAMILY = new Set([
  'multiple views', '2koma', '3koma', '4koma', 'split screen', 'white background',
  '3格漫画', '三场景漫画构图', '非对称漫画页面布局', '开放分镜漫画构图',
  '无边框中央插画', '第二场景周围没有长方形画框', '主场景周围没有长方形包围',
  '人物自然融入白色空间',
]);

/** 逗号段的裸 tag：`1.4::multiple views::` 与 `multiple views` 视为同一个词。 */
function bareTag(segment: string): string {
  return segment
    .replace(/^\s*[\d.]+::/, '')
    .replace(/^\s*::/, '')
    .replace(/::\s*$/, '')
    .trim()
    .toLowerCase();
}

/** 一格 tag 里「非构图词」的条数。 */
export function contentTagCount(tags: string): number {
  return String(tags ?? '')
    .split(',')
    .map(bareTag)
    .filter(tag => tag && !PANEL_FAMILY.has(tag)).length;
}

/** 整份计划里是否存在「写出了画面内容」的格（>=2 个内容 tag）。 */
export function hasStoryContent(pages: ComicPagePlan[]): boolean {
  for (const page of pages) {
    for (const panel of page.panels) {
      if (contentTagCount(panel.tags) >= 2) return true;
    }
  }
  return false;
}

/**
 * 把角色库里的固定外貌 tag 并进分格 prompt。
 *
 * 只在模型漏写时才有实际效果：已有裸词一律跳过（比较口径与 enforcePanelPrompt 一致）。
 * 模型一个角色都没点名时：场上只有一个角色就补它；多个时不猜——把不在画面里的人
 * 塞进去比漏一个人更糟。
 */
export function mergeCharacterTags(
  prompt: string,
  names: string[],
  library: BaiBaiCharacter[],
): string {
  const present = new Set(prompt.split(',').map(bareTag).filter(Boolean));

  const wanted = names
    .map(name => library.find(c => c.name === name))
    .filter((c): c is BaiBaiCharacter => !!c);
  const sources = wanted.length ? wanted : (library.length === 1 ? library : []);

  const extra: string[] = [];
  for (const character of sources.slice(0, 2)) {
    for (const raw of String(character.tag ?? '').split(',')) {
      const piece = raw.trim();
      if (!piece) continue;
      const key = bareTag(piece);
      if (!key || present.has(key)) continue;
      present.add(key);
      extra.push(piece);
    }
  }
  return extra.length ? `${prompt}, ${extra.join(', ')}` : prompt;
}
