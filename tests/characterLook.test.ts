/**
 * 「2 people 却只画了一个人」的两道防线
 *
 * 线上现象：Base 写着 `2 people, restaurant`，`<characters>` 里只有 Elias 一条。
 * 根因两条：
 * 1. 提示词里写着「characters[].name 必须照抄角色库，不要造人」——用户扮演的「你」
 *    不在库里的，模型就不敢写，直接省掉；
 * 2. 代码只给「库里有 tag」的人建角色块，没 tag 的整个人被丢掉。
 * 修法：模型用 `cast[].look` 给库里没有的人补一次英文外貌；仍然对不上时，
 * 把 Base 的人数词改成与角色块一致，绝不出现「说两个、只给一个」。
 */

import { describe, it, expect } from 'vitest';
import { parseLooks } from '../src/theater/parseReply';
import { alignPeopleCount, declaredPeople } from '../src/theater/runtime';
import { characterPromptsFromLibrary } from '../src/manga/tagSplit';
import type { BaiBaiCharacter } from '../src/types';

const lib: BaiBaiCharacter[] = [
  { name: 'Elias', tag: '1boy, short messy blond hair, emerald green eyes' },
];

describe('parseLooks', () => {
  it('读出 cast[].look，只收英文', () => {
    const looks = parseLooks({
      cast: [
        { name: '小雪', look: '1girl, long black hair, red eyes' },
        { name: '阿明', look: '黑色短发，红色眼睛' },
      ],
    });
    expect(looks).toEqual([{ name: '小雪', look: '1girl, long black hair, red eyes' }]);
  });

  it('没有 look 就不产出（不许编）', () => {
    expect(parseLooks({ cast: [{ name: '小雪', outfit: 'white shirt' }] })).toEqual([]);
    expect(parseLooks({})).toEqual([]);
  });

  it('同名只留第一条，最多四人', () => {
    const looks = parseLooks({
      cast: [
        { name: 'A', look: '1girl, red hair' },
        { name: 'A', look: '1girl, blue hair' },
      ],
    });
    expect(looks).toHaveLength(1);
    expect(looks[0].look).toContain('red hair');
  });
});

describe('alignPeopleCount', () => {
  it('Base 说 2 people、实际只有 1 块 → 删掉人数词，让角色块自己的 1boy 说话', () => {
    expect(alignPeopleCount('2 people, restaurant, dining table, upper body', 1))
      .toBe('restaurant, dining table, upper body');
  });

  it('人数与块数一致时一个字都不动', () => {
    const tags = '2 people, restaurant, upper body';
    expect(alignPeopleCount(tags, 2)).toBe(tags);
  });

  it('没有任何角色块时 Base 说了算（不猜）', () => {
    const tags = '2 people, restaurant';
    expect(alignPeopleCount(tags, 0)).toBe(tags);
  });

  it('1girl, 1boy 这种分写也认得出来', () => {
    expect(declaredPeople('1girl, 1boy, cafe')).toBe(2);
    expect(alignPeopleCount('1girl, 1boy, cafe', 1)).toBe('cafe');
  });
});

describe('characterPromptsFromLibrary + looks', () => {
  it('库里没有的人用模型补的外貌建块（这就是「你」的那一块）', () => {
    const out = characterPromptsFromLibrary(
      ['Elias', '小雪'],
      lib,
      new Map([['小雪', ['leaning forward']]]),
      new Map([['小雪', '1girl, long black hair, red eyes']]),
    );
    expect(out.map(c => c.name)).toEqual(['Elias', '小雪']);
    expect(out[1].tag).toContain('long black hair');
    expect(out[1].tag).toContain('leaning forward');
  });

  it('既没库条目也没人补外貌：宁可不画，也不瞎编一张脸', () => {
    expect(characterPromptsFromLibrary(['路人甲'], lib)).toEqual([]);
  });

  it('库条目优先于模型补的外貌（库才是权威）', () => {
    const out = characterPromptsFromLibrary(
      ['Elias'],
      lib,
      undefined,
      new Map([['Elias', '1boy, pink hair']]),
    );
    expect(out[0].tag).toContain('blond hair');
    expect(out[0].tag).not.toContain('pink hair');
  });
});
