/**
 * ST-Story-Illustrator — 格数兜底（纯函数）
 *
 * 用户钉了「固定三格」，出图却只有一格 —— 现场证据：`expectedPanelCount: 3`
 * 而 `renderedPanelCount: 1`，`pageSlots` 只有一条，整页塌成一张单图。
 *
 * 原因不在排版：逐格出图的格子数 = `page.panels` 的条数，而 panels 是模型写的。
 * 规则里写着「必须正好 3 条」，模型照样能给 1 条（它把三格写进了一个 subject）。
 * 只要它少给，代码就没有内容可排 —— 于是「三格」变成「一格」。
 *
 * 这里做的是**不编新事件**的补齐：一页仍然是一个连续瞬间，补出来的格只是
 * 同一瞬间的另一处切面（景别递进），内容取自本页已有的 nl / tags，
 * 不新增人物、不新增动作、不跳时间。真要三个不同的画面，靠规划层重问，
 * 这一层只保证「格数对、人物对、别空着」。
 */

import type { ComicPagePlan, ComicPanelPlan } from '../types';

/** 补格用的景别阶梯：同一瞬间从远到近推一遍，比「三格一模一样」好得多。 */
const SHOT_LADDER = ['medium shot', 'close-up', 'extreme close-up', 'wide shot'];

/** 这些 tag 是场景/光线/构图，不是「可以推近看的细节」。 */
const NOT_DETAIL = /(?:^|\b)(?:room|interior|light|lighting|air|winter|summer|autumn|spring|day|night|morning|evening|background|shot|view|angle|focus|depth of field|blur|bokeh)(?:\b|$)/i;

function bare(segment: string): string {
  return segment.replace(/^\s*[\d.]+::/, '').replace(/^\s*::/, '').replace(/::\s*$/, '').trim();
}

const PERSON_TAG = /^(?:\d+\s*(?:girl|boy|other)s?|\d+\s*people|couple|solo|multiple girls|multiple boys)$/i;

/**
 * 从整页 tag 里挑「可以推近拍」的东西：道具、接触点、局部。
 * 模型写 tag 时道具通常是一个短名词短语，这里按「非人物、非场景、非光线、长度 ≤ 4 词」筛。
 */
export function detailTagsOf(tags: string, limit = 3): string[] {
  const out: string[] = [];
  for (const piece of String(tags ?? '').split(',')) {
    const word = bare(piece);
    if (!word) continue;
    if (PERSON_TAG.test(word)) continue;
    if (NOT_DETAIL.test(word)) continue;
    if (word.split(/\s+/).length > 4) continue;
    if (out.some(x => x.toLowerCase() === word.toLowerCase())) continue;
    out.push(word);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 把一页补到 `target` 格（只在不足时补；多了交给调用方截断）。
 *
 * 补出来的格：
 * - `nl` = 本页第一格的 nl（同一瞬间）+ 一句「推近到某处」；
 * - `shot` = 景别阶梯里没被用过的那个；
 * - `composition` = `single_detail`：有人在、只画局部，不是空镜；
 * - `characters` 继承第一格（规划层漏写时为 []，由页级阵容兜底）。
 */
export function expandPanels(page: ComicPagePlan, target: number): ComicPanelPlan[] {
  const panels = [...(page.panels ?? [])];
  const want = Math.max(1, Math.round(Number(target) || 0));
  if (!panels.length || panels.length >= want) return panels.slice(0, want);

  const first = panels[0]!;
  const baseNl = String(first.nl ?? page.nl ?? '').trim();
  const details = detailTagsOf(String(page.tags ?? ''));
  const usedShots = new Set(panels.map(p => String(p.shot ?? '').trim().toLowerCase()).filter(Boolean));

  while (panels.length < want) {
    const index = panels.length;
    const shot = SHOT_LADDER.find(s => !usedShots.has(s))
      ?? SHOT_LADDER[index % SHOT_LADDER.length]!;
    usedShots.add(shot.toLowerCase());
    const detail = details[(index - 1) % Math.max(1, details.length)] ?? '';
    const closer = detail
      ? `the same moment, pushed in closer on ${detail}`
      : 'the same moment from a closer angle';
    panels.push({
      index,
      title: '',
      composition: 'single_detail',
      characters: first.characters ?? [],
      mood: String(first.mood ?? ''),
      shot,
      ...(first.subject ? { subject: String(first.subject) } : {}),
      tags: '',
      nl: baseNl ? `${baseNl}, ${closer}` : `${closer[0]!.toUpperCase()}${closer.slice(1)}.`,
    });
  }
  return panels;
}
