/**
 * ST-Story-Illustrator — 「这张图声称画几个人」的解析
 *
 * 为什么单独一个文件：漫画页与小剧场（QQ 人）都要用同一条判据，
 * 而这条判据必须和 NAI 的人数词写法完全对齐（`2people` / `1girl, 1boy` / `2girls`）。
 * 两份实现各写一遍，迟早会漂移成「漫画认为 2 人、小剧场认为 1 人」。
 */

/** `2people` / `1girl, 1boy` / `2girls` 这类人数写法。 */
export const PEOPLE_COUNT_RE = /(?:^|,)\s*\d+\s*(?:people|girls|boys|others|girl|boy|other|person)\b/gi;

/** 英文数词：模型很爱写 `two people`，只认数字会把 2 人误判成 0 人。 */
const WORD_NUMBER: Record<string, number> = {
  single: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
};

/**
 * 这条提示词声称画几个人（所有人数词之和；没有人数词返回 0）。
 *
 * 三种写法都要认：`2people` / `two people` / `couple`。
 * 用户那张图的正向词写的是 `two people ... couple dining`——只认数字时
 * 返回 0，于是「人数对不上」的体检直接跳过，缺的那个人永远补不上。
 */
export function declaredPeople(tags: string): number {
  const text = String(tags ?? '');
  let total = 0;
  for (const match of text.matchAll(/\b(\d+)\s*(?:people|girls|boys|others|girl|boy|other|person)\b/gi)) {
    total += Number(match[1]) || 0;
  }
  if (!total) {
    for (const match of text.matchAll(/\b(single|one|two|three|four|five)\s+(?:people|girls|boys|others|girl|boy|other|person)\b/gi)) {
      total += WORD_NUMBER[match[1].toLowerCase()] ?? 0;
    }
  }
  if (!total && /\b(couple|pair)\b/i.test(text)) total = 2;
  return total;
}
