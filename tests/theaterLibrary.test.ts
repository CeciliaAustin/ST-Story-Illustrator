/**
 * 「人物不是我的角色」根治：把柏宝绘的角色库文本发进读剧情的 prompt
 *
 * 柏宝绘自己出图时，外貌不是靠名字查表，而是把整份角色库（字段式明细）
 * 发进读剧情的请求里，让模型照抄（见 autoTag/charAnchors.ts 文件头）。
 * 我们之前只发「名字名单」：模型看不到发色瞳色，名字一不一样就彻底失联——
 * 正文写「Cecilia」而库里叫「Sissy」时，它只会自己编一个白毛/棕发的路人。
 *
 * 这里锁住：
 * 1. 角色库字段能渲染成文本（与柏宝绘同一套字段）；
 * 2. 「谁是谁」讲清楚（用户扮演谁 / 角色卡是谁 / 人设摘要）；
 * 3. 名字归一 + 代词分流：你/我 → 用户扮演的那位，他/她 → 角色卡那位；
 * 4. act 绑进该角色自己的 characters[].tag，Base 里不再混入个人动作。
 */

import { describe, it, expect } from 'vitest';
import { buildCastBlock, buildLibraryBlock, formatLibraryEntry, normalizeName } from '../src/theater/library';
import { makeLookReader } from '../src/tasks/theaterRun';
import { runTheaterOne, type RunOneInput, type TheaterImageInput } from '../src/theater/runtime';

const LIB = [
  {
    name: 'Elias',
    tag: '1boy, short blond hair, green eyes, tall',
    fields: { sex: '1boy', hair: 'short blond hair', eyes: 'green eyes', body: 'tall' },
    nl: 'a tall blond young man',
    scope: 'global' as const,
  },
  {
    name: 'Sissy',
    tag: '1girl, long brown curly hair, wine red eyes',
    fields: { sex: '1girl', hair: 'long brown curly hair', eyes: 'wine red eyes' },
    scope: 'chat' as const,
  },
];

describe('buildLibraryBlock：按柏宝绘的字段形态渲染', () => {
  it('字段逐个列出来（模型要照抄的就是这些）', () => {
    const line = formatLibraryEntry(LIB[0]);
    expect(line).toContain('Elias');
    expect(line).toContain('头发=short blond hair');
    expect(line).toContain('眼睛=green eyes');
    expect(line).toContain('［全局］');
  });

  it('字段全空时回落到整串 tag，不吐一个空行给模型', () => {
    const line = formatLibraryEntry({ name: 'X', tag: '1girl, red hair', fields: {} });
    expect(line).toContain('外貌=1girl, red hair');
  });

  it('文本里写明这是唯一合法的名字来源，且外貌不许自己编', () => {
    const block = buildLibraryBlock(LIB);
    expect(block).toContain('唯一合法');
    expect(block).toContain('不要自己编');
    expect(block).toContain('Sissy');
  });

  it('空库返回空串（不能告诉模型一个不存在的库）', () => {
    expect(buildLibraryBlock([])).toBe('');
  });
});

describe('buildCastBlock：正文里的「你」要落到具体条目', () => {
  it('列出用户扮演者与角色卡主角', () => {
    const block = buildCastBlock({
      personaName: 'Sissy',
      cardName: 'Elias',
      personaText: '大三学生，棕色卷发，酒红色眼睛。',
      cardText: '身高 192 的金发男生，文学系。',
    });
    expect(block).toContain('用户扮演：Sissy');
    expect(block).toContain('「你」');
    expect(block).toContain('角色卡主角：Elias');
    expect(block).toContain('棕色卷发');
  });

  it('什么都没有时返回空串', () => {
    expect(buildCastBlock({ personaName: '', cardName: '', personaText: '', cardText: '' })).toBe('');
  });
});

describe('makeLookReader：代词分流 + 不瞎兜底', () => {
  const read = makeLookReader(LIB, { cardName: 'Elias', personaName: 'Sissy' });

  it('「你」= 用户扮演的那位（以前会错拿对方的外貌）', () => {
    expect(read(['你'])[0].tag).toContain('brown curly hair');
  });

  it('「他」= 角色卡那位', () => {
    expect(read(['他'])[0].tag).toContain('blond hair');
  });

  it('库里没有的名字留空（编一个外貌比没有更糟）', () => {
    expect(read(['Julian'])[0].tag).toBe('');
  });

  it('括号注的名字也能对上', () => {
    const withNote = makeLookReader(
      [{ name: 'Sissy（我）', tag: '1girl, brown hair', fields: {} }],
      { personaName: 'Sissy' },
    );
    expect(withNote(['Sissy'])[0].tag).toContain('brown hair');
  });

  it('归一化只去空白与标点，不做拼音/翻译', () => {
    expect(normalizeName(' Elias （他） ')).toBe('elias他');
  });

  it('唯一解时一对一补位（正文叫 Cecilia、库里叫 Sissy）', () => {
    const looks = read(['Elias', 'Cecilia']);
    expect(looks[0].tag).toContain('blond hair');
    expect(looks[1].tag).toContain('brown curly hair');
  });

  it('两个都对不上就不补（宁可没有外貌，也不把两张脸画反）', () => {
    const looks = read(['Julian', 'Marcus']);
    expect(looks.map(l => l.tag)).toEqual(['', '']);
  });
});

const READING = JSON.stringify({
  title: '替我挡光',
  characters: [
    { name: 'Elias', act: 'stepping to the sunny side, raising one hand' },
    { name: 'Sissy', act: 'walking beside him, holding a notebook' },
  ],
  mood: '默契',
  tags: '2girls, outdoors, sunlight, arched corridor, standing',
  nl: 'Elias steps to the sunny side and shields Sissy from the noon light.',
});

function makeInput(over: Partial<RunOneInput> = {}) {
  const calls: TheaterImageInput[] = [];
  const base: RunOneInput = {
    kind: 'status',
    chatId: 'c1',
    floor: 3,
    swipe: 0,
    characterName: 'Elias',
    body: 'Elias 侧过身替 Sissy 挡住正午的太阳。',
    shots: 1,
    chibi: false,
    mangaSafe: false,
    backend: 'nai',
    supportsCharacters: true,
    llm: async () => READING,
    generate: async input => {
      calls.push(input);
      return { path: 'user/images/x.png', seed: 7 };
    },
    readLooks: makeLookReader(LIB, { cardName: 'Elias', personaName: 'Sissy' }),
    ...over,
  };
  return { input: base, calls };
}

describe('runTheaterOne：act 绑回各自的角色块', () => {
  it('A 的动作进 A 的 characters[].tag，不混进 Base', async () => {
    const { input, calls } = makeInput();
    const result = await runTheaterOne(input);
    expect(result.ok).toBe(true);
    const elias = calls[0].characters?.find(c => c.name === 'Elias');
    expect(elias?.tag).toContain('stepping to the sunny side');
    expect(elias?.tag).toContain('blond hair');
    // Base 只留全局信息：个人动作不许再出现在这里（否则会被安到另一个人身上）
    expect(calls[0].prompt).not.toContain('stepping to the sunny side');
    expect(calls[0].prompt).toContain('outdoors');
  });

  it('读剧情时能看见角色库与「谁是谁」', async () => {
    let seen: { system: string; user: string } | null = null;
    const { input } = makeInput({
      libraryBlock: buildLibraryBlock(LIB),
      castBlock: buildCastBlock({ personaName: 'Sissy', cardName: 'Elias', personaText: '棕色卷发', cardText: '金发' }),
      llm: async (system, user) => {
        seen = { system, user };
        return READING;
      },
    });
    await runTheaterOne(input);
    const { system } = seen as unknown as { system: string; user: string };
    expect(system).toContain('角色固定外貌库');
    expect(system).toContain('wine red eyes');
    expect(system).toContain('用户扮演：Sissy');
  });
});
