/**
 * 服装一致性：
 * 1) 本批服装只定一次（顶层 cast[].outfit），出图时逐字拼进每一格的角色块；
 * 2) 模型没给时回落到角色库的「固定着装」；
 * 3) act 里的服装词不再各格自己编（我们只拼 cast 的那一串）；
 * 4) 顶层的 <thinking> 块不能把解析带偏。
 */

import { describe, it, expect } from 'vitest';
import { runTheaterOne, type RunOneInput, type TheaterImageInput } from '../src/theater/runtime';
import { parseStatusReply } from '../src/theater/parseReply';
import { stripThinkingBlocks } from '../src/prompt/think';

const OUTFIT = 'white dress shirt, black pleated skirt, brown loafers';

const READING = JSON.stringify({
  title: '走廊上被拦住',
  cast: [{ name: 'Elias', outfit: OUTFIT }],
  panels: [
    {
      title: '他伸手拦住',
      characters: [{ name: 'Elias', act: 'reaching out an arm, blocking the way' }],
      mood: '紧张',
      tags: '1boy, corridor, arched window, afternoon sunlight, standing',
      nl: 'Elias stands in the corridor and reaches out to stop her.',
    },
    {
      title: '她抬头',
      characters: [{ name: 'Elias', act: 'looking down, frowning slightly' }],
      mood: '压低声音',
      tags: '1boy, corridor, close-up, backlighting, frown',
      nl: 'He looks down at her in the same corridor, frowning.',
    },
  ],
});

function makeInput(over: Partial<RunOneInput> = {}) {
  const calls: TheaterImageInput[] = [];
  const base: RunOneInput = {
    kind: 'status',
    chatId: 'c1',
    floor: 4,
    swipe: 0,
    characterName: 'Elias',
    body: 'Elias 在走廊上伸手拦住她。',
    shots: 2,
    chibi: false,
    mangaSafe: false,
    backend: 'nai',
    supportsCharacters: true,
    llm: async () => READING,
    generate: async input => {
      calls.push(input);
      return { path: 'user/images/x.png', seed: 7 };
    },
    readLooks: names =>
      names.map(name => (name === 'Elias'
        ? { name, tag: '1boy, short black hair, green eyes' }
        : { name, tag: '' })),
    ...over,
  };
  return { input: base, calls };
}

describe('本批服装只定一次', () => {
  it('每一格的角色块都带同一串服装，逐字一致', async () => {
    const { input, calls } = makeInput();
    const result = await runTheaterOne(input);

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.characters?.[0]?.tag).toContain(OUTFIT);
    }
    // 顺序照柏宝绘的规范：外貌 → 服装 → 动作
    expect(calls[0].characters?.[0]?.tag).toBe(
      `1boy, short black hair, green eyes, ${OUTFIT}, reaching out an arm, blocking the way`,
    );
  });

  it('两格的服装不因为动作不同而漂移', async () => {
    const { input, calls } = makeInput();
    await runTheaterOne(input);

    const outfitOf = (tag: string) => tag.split(',').slice(3, 6).join(',').trim();
    expect(outfitOf(calls[0].characters![0].tag)).toBe(outfitOf(calls[1].characters![0].tag));
  });

  it('模型没给 cast 时回落到角色库的固定着装', async () => {
    const reading = JSON.stringify({
      title: '站着',
      characters: [{ name: 'Elias', act: 'standing by the door' }],
      mood: '安静',
      tags: '1boy, doorway, indoor lighting, standing',
      nl: 'Elias stands by the door.',
    });
    const { input, calls } = makeInput({
      shots: 1,
      llm: async () => reading,
      readLooks: names => names.map(name => ({
        name,
        tag: '1boy, short black hair, green eyes',
        outfit: 'navy uniform jacket, white shirt collar',
      })),
    });
    await runTheaterOne(input);

    expect(calls[0].characters?.[0]?.tag).toContain('navy uniform jacket');
  });

  it('没有原生角色通道时，服装跟着外貌一起拼进正向词', async () => {
    const { input, calls } = makeInput({ supportsCharacters: false });
    await runTheaterOne(input);

    expect(calls[0].characters).toBeUndefined();
    expect(calls[0].prompt).toContain('white dress shirt');
  });
});

describe('parseStatusReply：cast → outfits', () => {
  it('读出本批服装', () => {
    const reading = parseStatusReply(READING, 'status');
    expect(reading.outfits).toEqual([{ name: 'Elias', outfit: OUTFIT }]);
  });

  it('中文服装不收（NAI 只认英文 tag），整条丢掉', () => {
    const reading = parseStatusReply(JSON.stringify({
      title: 'x',
      cast: [{ name: 'Elias', outfit: '白衬衫和黑裙子' }],
      tags: '1boy, standing',
    }), 'status');
    expect(reading.outfits).toBeUndefined();
  });

  it('没有 cast 时不影响解析', () => {
    const reading = parseStatusReply(JSON.stringify({
      title: 'x', characters: [{ name: 'Elias', act: 'standing' }], tags: '1boy, standing',
    }), 'status');
    expect(reading.outfits).toBeUndefined();
    expect(reading.panels).toHaveLength(1);
  });
});

describe('stripThinkingBlocks', () => {
  it('剥掉成对的 thinking 块', () => {
    const raw = '<thinking>先判断 {这里} 有花括号</thinking>{"title":"x","tags":"1boy"}';
    expect(stripThinkingBlocks(raw)).toBe('{"title":"x","tags":"1boy"}');
  });

  it('没闭合的也剥掉（吃到结尾）', () => {
    expect(stripThinkingBlocks('<thinking>没收尾 {"a":1}')).toBe('');
  });

  it('不带思考块时原样返回', () => {
    expect(stripThinkingBlocks('{"a":1}')).toBe('{"a":1}');
  });

  it('思考块里的花括号不会把读剧情解析带偏', () => {
    const raw = '<thinking>{"fake": true}</thinking>' + JSON.stringify({
      title: '真的', characters: [{ name: 'Elias', act: 'standing' }], tags: '1boy, standing',
    });
    const reading = parseStatusReply(raw, 'status');
    expect(reading.title).toBe('真的');
  });
});
