/**
 * 服装一致性链路测试
 *
 * 复现用户报的问题：柏宝书里明明记着「浅杏色连衣裙 + 米色开衫 / 灰色T恤 + 卡其裤」，
 * 柏宝绘自己出的图也是这么穿，但我们插件出的插图/漫画角色块里一件衣服都没有。
 * 根因：着装原文只当文本发给模型，模板又禁止写服装，代码也没把它拼回角色块。
 *
 * 这里锁住三步链路：
 *   1) 从柏宝书快照抽出结构化当前着装；
 *   2) 模型翻成英文后按名字解析成定妆表（中文丢弃、别名归一）；
 *   3) 逐字拼进每个角色块 / 页级 Base，同一批所有页都是同一套。
 */

import { describe, it, expect } from 'vitest';
import { bookOutfits, formatBookRoles, readBookRoles } from '../src/baibai/bookMemory';
import { buildOutfitBlock, outfitOf, resolveOutfits } from '../src/baibai/outfit';
import { parseIllustrationResponse } from '../src/manga/planPrompts';
import { parseComicPagePlan } from '../src/manga/panelPlan';
import { composePagePrompt } from '../src/manga/pageCompose';
import type { BaiBaiCharacter, ComicPagePlan } from '../src/types';

const LIBRARY: BaiBaiCharacter[] = [
  {
    name: 'Sissy',
    tag: '1girl, wavy brown hair, wine red eyes',
    fields: { sex: '1girl', hair: 'wavy brown hair', eyes: 'wine red eyes', outfit: '' },
  },
  {
    name: 'Elias',
    tag: '1boy, short messy blond hair, emerald green eyes',
    fields: { sex: '1boy', hair: 'short messy blond hair', eyes: 'emerald green eyes', outfit: '' },
  },
];

describe('bookOutfits — 柏宝书当前着装的结构化出口', () => {
  it('主角用人设名、NPC 用书名，正文点名的才发', () => {
    const snapshot = {
      revision: 1,
      protagonist: { appearance: '棕发', outfit: '浅杏色方领连衣裙 + 薄米色针织开衫' },
      npcs: [
        {
          name: 'Elias Miller',
          desc: '深灰色修身短袖T恤和卡其色工装裤',
          outfit: '',
          important: true,
        },
        { name: '路人甲', outfit: '校服', important: false, follow: false },
      ],
    };
    const got = bookOutfits(snapshot as never, '', 'Sissy');
    expect(got).toEqual([
      { name: 'Sissy', outfit: '浅杏色方领连衣裙 + 薄米色针织开衫' },
      { name: 'Elias Miller', outfit: '深灰色修身短袖T恤和卡其色工装裤' },
    ]);
  });

  it('正文点名的普通 NPC 也要带，没点名的不带', () => {
    const snapshot = {
      revision: 1,
      npcs: [
        { name: '小雪', outfit: '白衬衫', important: false },
        { name: '阿福', outfit: '管家服', important: false },
      ],
    };
    const got = bookOutfits(snapshot as never, '小雪推门进来');
    expect(got).toEqual([{ name: '小雪', outfit: '白衬衫' }]);
  });

  it('读不到角色参考整体返回 null，着装表也一起没有', () => {
    const got = formatBookRoles({ revision: 1 }, '');
    expect(got).toBe('');
  });
});

describe('buildOutfitBlock — 给写 tag 模型的定妆硬指令', () => {
  it('把书的当前着装翻成英文的要求写清楚，且每人只出现一次', () => {
    const block = buildOutfitBlock({
      bookOutfits: [{ name: 'Sissy', outfit: '浅杏色连衣裙' }],
      library: LIBRARY,
      cast: ['Sissy'],
      personaName: 'Sissy',
    });
    expect(block).toContain('【本批定妆');
    expect(block).toContain('浅杏色连衣裙');
    expect(block).toContain('cast[].outfit');
    expect(block.match(/Sissy:/g)).toHaveLength(1);
  });

  it('书里没有的人回落到角色库固定着装（英文）', () => {
    const lib: BaiBaiCharacter[] = [
      { ...LIBRARY[0], fields: { ...LIBRARY[0].fields, outfit: 'light apricot square-neck dress' } },
    ];
    const block = buildOutfitBlock({ cast: ['Sissy'], library: lib });
    expect(block).toContain('light apricot square-neck dress');
  });

  it('没有任何着装信息时不发空块', () => {
    expect(buildOutfitBlock({ cast: ['Sissy'], library: LIBRARY })).toBe('');
  });
});

describe('resolveOutfits — 模型回交的英文定妆', () => {
  it('数组写法：按名字解析，中文整条丢弃', () => {
    const got = resolveOutfits([
      { name: 'Sissy', outfit: 'light apricot square-neck fitted dress, beige knitted cardigan' },
      { name: 'Elias', outfit: '深灰色T恤' },
    ]);
    expect(got.size).toBe(1);
    expect(got.get('sissy')?.outfit).toContain('beige knitted cardigan');
  });

  it('「你」和人设名并到同一人，不会定两套衣服', () => {
    const got = resolveOutfits([
      { name: '你', outfit: 'white blouse' },
      { name: 'Sissy', outfit: 'light apricot dress' },
    ], 'Sissy');
    expect(got.size).toBe(1);
    expect([...got.values()][0].outfit).toBe('white blouse');
  });

  it('outfitOf 回落到角色库固定着装', () => {
    const lib: BaiBaiCharacter[] = [
      { ...LIBRARY[0], fields: { ...LIBRARY[0].fields, outfit: 'beige cardigan' } },
    ];
    expect(outfitOf('Sissy', new Map(), lib)).toBe('beige cardigan');
    expect(outfitOf('Elias', new Map(), lib)).toBe('');
  });
});

describe('解析层：定妆要能从两种 LLM 响应里取出来', () => {
  it('插画响应里的 cast[].outfit', () => {
    const response = parseIllustrationResponse(JSON.stringify({
      segments: [{ id: 's', source: 'scene', english: ['garden'], order: 0 }],
      cast: [
        { name: 'Sissy', outfit: 'light apricot dress, beige knitted cardigan' },
        { name: 'Elias', outfit: 'light grey t-shirt, khaki cargo pants' },
      ],
    }));
    expect(response?.outfits).toHaveLength(2);
    expect(response?.outfits?.[1].outfit).toContain('khaki cargo pants');
  });

  it('漫画响应顶层的 cast 分给每一页', () => {
    const plan: ComicPagePlan[] = parseComicPagePlan({
      pages: [
        { tags: '1girl, 1boy, restaurant', panels: [{ tags: 'talking' }] },
        { tags: '1girl, 1boy, restaurant', panels: [{ tags: 'smiling' }] },
      ],
      cast: [
        { name: 'Sissy', outfit: 'light apricot dress, beige knitted cardigan' },
        { name: 'Elias', outfit: 'light grey t-shirt, khaki cargo pants' },
      ],
    }).pages;
    expect(plan).toHaveLength(2);
    expect(plan[0].outfits).toHaveLength(2);
    expect(plan[1].outfits).toHaveLength(2);
    expect(plan[1].outfits?.[0].outfit).toBe(plan[0].outfits?.[0].outfit);
  });
});

describe('composePagePrompt — 定妆逐字进角色块（回归测试）', () => {
  const page = (outfits?: ComicPagePlan['outfits']): ComicPagePlan => ({
    pageIndex: 0,
    title: '咖啡馆',
    layout: 'regular',
    tags: '1girl, 1boy, restaurant, talking',
    ...(outfits ? { outfits } : {}),
    panels: [
      {
        index: 0,
        title: '说话',
        characters: [
          { name: 'Sissy', act: 'smiling' },
          { name: 'Elias', act: 'pointing at mouth' },
        ],
        tags: 'talking',
      },
    ],
  });

  it('有定妆时每个角色块都带上自己的那套，且 Base 不写服装', () => {
    const out = composePagePrompt(page([
      { name: 'Sissy', outfit: 'light apricot square-neck fitted dress, beige knitted cardigan' },
      { name: 'Elias', outfit: 'light grey t-shirt, khaki cargo pants' },
    ]), LIBRARY, { nativeCharacters: true });
    const sissy = out.characters.find(c => c.name === 'Sissy');
    const elias = out.characters.find(c => c.name === 'Elias');
    expect(sissy?.tag).toContain('beige knitted cardigan');
    expect(elias?.tag).toContain('khaki cargo pants');
    expect(out.prompt).not.toContain('cardigan');
    expect(out.prompt).not.toContain('khaki');
  });

  it('模型没给定妆时回落角色库固定着装', () => {
    const lib: BaiBaiCharacter[] = [
      { ...LIBRARY[0], fields: { ...LIBRARY[0].fields, outfit: 'navy school blazer, pleated skirt' } },
      LIBRARY[1],
    ];
    const out = composePagePrompt(page(), lib, { nativeCharacters: true });
    expect(out.characters.find(c => c.name === 'Sissy')?.tag).toContain('navy school blazer');
  });

  it('没有原生角色块时定妆也要进 Base，不然 NAI 还是自己编衣服', () => {
    const out = composePagePrompt(page([
      { name: 'Sissy', outfit: 'light apricot dress, beige cardigan' },
    ]), LIBRARY, { nativeCharacters: false });
    expect(out.prompt).toContain('beige cardigan');
  });

  it('已有同样着装不重复拼（多页同批逐字复用）', () => {
    const withOutfit = page([
      { name: 'Sissy', outfit: 'light apricot dress, beige cardigan' },
    ]);
    withOutfit.characters = [{
      name: 'Sissy',
      act: '',
      look: 'light apricot dress, beige cardigan',
    }];
    const lib: BaiBaiCharacter[] = [
      { ...LIBRARY[0], fields: { ...LIBRARY[0].fields, outfit: 'light apricot dress, beige cardigan' } },
    ];
    const out = composePagePrompt(withOutfit, lib, { nativeCharacters: true });
    const tag = out.characters.find(c => c.name === 'Sissy')?.tag ?? '';
    expect(tag.match(/beige cardigan/g)).toHaveLength(1);
  });
});
