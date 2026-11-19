/**
 * 「人物不像我的人」回归测试
 *
 * 柏宝绘自己画多角色走的是 NAI 的 character prompts（v4_prompt.char_captions），
 * 公开接口对应 `characters` 字段。它源码里写得很明白：**不要把多份完整外貌拼进
 * 正向词**，否则会重叠躯干、互相污染。我们之前正是拼进正向词的：
 *
 *   prompt = 外貌1 + 外貌2 + 动作 tag + Q版串
 *
 * 结果 NAI 把两个人的外貌揉成一张路人脸——用户看到的就是「跟我的角色毫无关系」。
 *
 * 这里锁住三件事：
 * 1. 支持 characters 的后端：外貌只走 characters，正向词里不许再出现；
 * 2. 不支持的后端（NAI3/ComfyUI）：才回落成拼进正向词；
 * 3. 角色库里没有的人要冒泡到 missingLooks，别静默画成别人。
 */

import { describe, it, expect } from 'vitest';
import { runTheaterOne, type RunOneInput, type TheaterImageInput } from '../src/theater/runtime';

const LIB = [
  { name: 'Elias', tag: '1boy, short black hair, green eyes', nl: 'a tall young man' },
  { name: 'Cecilia', tag: '1girl, brown curly hair, wine red eyes' },
];

const READING = JSON.stringify({
  title: '他抢先拿走笔记',
  characters: [{ name: 'Elias', act: 'picking up a notebook from the desk' }],
  mood: '微妙',
  tags: '1boy, holding notebook, classroom, wooden desk, standing',
  nl: 'Elias picks up the blue notebook from her desk in the classroom.',
});

function makeInput(over: Partial<RunOneInput> = {}) {
  const calls: TheaterImageInput[] = [];
  const base: RunOneInput = {
    kind: 'status',
    chatId: 'c1',
    floor: 3,
    swipe: 0,
    characterName: 'Elias',
    body: 'Elias 伸手把 Cecilia 桌上的笔记本拿了起来。',
    shots: 1,
    chibi: false,
    mangaSafe: false,
    backend: 'nai',
    llm: async () => READING,
    generate: async input => {
      calls.push(input);
      return { path: 'user/images/x.png', seed: 7 };
    },
    readLooks: names =>
      names.map(name => {
        const hit = LIB.find(c => c.name === name);
        return hit ? { name, tag: hit.tag, ...(hit.nl ? { nl: hit.nl } : {}) } : { name, tag: '' };
      }),
    ...over,
  };
  return { input: base, calls };
}

describe('runTheaterOne：外貌走柏宝绘的 character 通道', () => {
  it('支持 characters 时，正向词里不再拼外貌', async () => {
    const { input, calls } = makeInput({ supportsCharacters: true });
    const result = await runTheaterOne(input);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).not.toContain('short black hair');
    expect(calls[0].characters?.[0]?.tag).toContain('short black hair');
  });

  it('把这一格的 nl 一起发出去（剧情细节只能靠它落在画面上）', async () => {
    const { input, calls } = makeInput({ supportsCharacters: true });
    await runTheaterOne(input);
    expect(calls[0].nl).toContain('Elias picks up the blue notebook');
  });

  it('外貌存进格数据，单格重画才能还原同一批人', async () => {
    const { input } = makeInput({ supportsCharacters: true });
    const result = await runTheaterOne(input);
    expect(result.stories[0].characters?.[0]?.tag).toContain('short black hair');
  });

  it('后端不支持 characters（NAI3/ComfyUI）时才回落成拼进正向词', async () => {
    const { input, calls } = makeInput({ supportsCharacters: false });
    await runTheaterOne(input);
    expect(calls[0].prompt).toContain('short black hair');
    expect(calls[0].characters).toBeUndefined();
  });

  it('角色库里没有的名字冒泡出来（否则用户只会看到「怎么又不像」）', async () => {
    const body = 'Elias 和 Julian 在拱廊下说话。';
    const reading = JSON.stringify({
      title: '拱廊',
      characters: [{ name: 'Julian', act: 'holding a stack of books' }],
      tags: '1boy, holding books, arched corridor, standing, daylight',
      nl: 'Julian holds a stack of books under the archway.',
    });
    const { input } = makeInput({ body, llm: async () => reading, supportsCharacters: true });
    const result = await runTheaterOne(input);
    expect(result.missingLooks).toContain('Julian');
  });
});

describe('runTheaterOne：读剧情的 system 与 user 分开传', () => {
  it('system 是规则、user 是正文，不再把两者拼成一条塞进 user', async () => {
    let seen: { system: string; user: string } | null = null;
    const { input } = makeInput({
      supportsCharacters: true,
      roster: ['Elias', 'Cecilia'],
      llm: async (system, user) => {
        seen = { system, user };
        return READING;
      },
    });
    await runTheaterOne(input);
    expect(seen).not.toBeNull();
    const { system, user } = seen as unknown as { system: string; user: string };
    expect(system.length).toBeGreaterThan(40);
    // 角色名单进 user，让模型照抄名字（名字对不上就取不到外貌）
    expect(user).toContain('Elias、Cecilia');
    expect(user).toContain('正文：');
    // 规则不该再混进 user
    expect(user).not.toContain('只输出一个 JSON 对象');
  });
});
