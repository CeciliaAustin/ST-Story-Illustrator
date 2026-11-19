/**
 * 黑白漫「黑白锁定」回归测试
 *
 * 线上现象：黑白漫出图一直是全彩。
 * 原因不是模型不听话，而是代码里根本没有黑白：
 * - 正向词只拼「外貌 + tag + 景别」，没有任何 monochrome / greyscale；
 * - 负面词只补 nsfw，一条彩色词都没有；
 * - 解析阶段还把模型自己写的 monochrome / greyscale 当「画风词」删掉了。
 * 于是黑白完全由用户的画师串决定，画师串偏彩色 → 整页全彩。
 *
 * 这里锁住：
 * 1. 正向上锁 monochrome + greyscale（可关）；
 * 2. 正向里的彩色语义词被洗掉，但发色/瞳色这类身份词保留；
 * 3. 负面里同时有「压彩色」与「压 NSFW」，且两者能各自独立开关。
 */

import { describe, it, expect } from 'vitest';
import { buildMangaPrompt, buildTheaterImagePrompt, withMangaMono } from '../src/theater/prompts';
import {
  mergeNegative,
  stripMangaColorTags,
  MANGA_BW_POSITIVE,
  MANGA_BW_NEGATIVE,
  MANGA_SAFE_NEGATIVE,
} from '../src/theater/safeFilter';
import { runTheaterOne, type RunOneInput, type TheaterImageInput } from '../src/theater/runtime';

describe('buildMangaPrompt：黑白锁定', () => {
  it('默认把 monochrome / greyscale 放在正向最前面', () => {
    const p = buildMangaPrompt(['1girl, red eyes'], '1girl, sitting on the bed, bedroom');
    expect(p.startsWith(MANGA_BW_POSITIVE)).toBe(true);
  });

  it('洗掉彩色语义词，但保留发色/瞳色这类身份词', () => {
    const p = buildMangaPrompt(
      [],
      '1girl, red eyes, colorful background, vivid colors, smile, sitting on the bed',
    );
    expect(p).not.toContain('colorful background');
    expect(p).not.toContain('vivid colors');
    expect(p).toContain('red eyes');
  });

  it('mono=false 时回到旧行为（不锁黑白、也不洗彩色词）', () => {
    const p = buildMangaPrompt([], '1girl, colorful background, sitting on the bed', false);
    expect(p).not.toContain('monochrome');
    expect(p).toContain('colorful background');
  });

  it('同一套拼词只对黑白漫生效，QQ 人不受影响', () => {
    expect(buildTheaterImagePrompt('status', [], '1girl', true)).not.toContain('monochrome');
    expect(buildTheaterImagePrompt('manga', [], '1girl', false)).toContain('monochrome');
  });
});

describe('withMangaMono：给旧卡片补黑白锁', () => {
  it('缺 monochrome 时补在最前面', () => {
    expect(withMangaMono('1girl, sitting')).toBe(`${MANGA_BW_POSITIVE}, 1girl, sitting`);
  });

  it('已经写过就不重复加（权重翻倍会糊成灰块）', () => {
    const text = 'monochrome, greyscale, 1girl, sitting';
    expect(withMangaMono(text)).toBe(text);
  });

  it('只写 greyscale 也算已锁', () => {
    expect(withMangaMono('greyscale, 1girl')).toBe('greyscale, 1girl');
  });
});

describe('stripMangaColorTags', () => {
  it('整项剔除而不是删词，避免留下半句', () => {
    const r = stripMangaColorTags('1girl, full color, smile');
    expect(r.tags).toBe('1girl, smile');
    expect(r.hits).toEqual(['full color']);
  });

  it('white / black / grey 是黑白稿正常的明暗词，不洗', () => {
    const r = stripMangaColorTags('white shirt, black coat, grey sky');
    expect(r.tags).toBe('white shirt, black coat, grey sky');
    expect(r.hits).toEqual([]);
  });
});

describe('mergeNegative', () => {
  it('合并去重（大小写不敏感）', () => {
    expect(mergeNegative('nsfw, color', 'Color, rainbow')).toBe('nsfw, color, rainbow');
  });

  it('空段不产生多余逗号', () => {
    expect(mergeNegative('', undefined, null, 'color')).toBe('color');
    expect(mergeNegative('', '')).toBe('');
  });
});

const MANGA_READING = JSON.stringify({
  title: '雨里等她',
  characters: [{ name: 'Elias', act: 'standing under the umbrella' }],
  mood: '安静',
  tags: '1boy, holding umbrella, standing, street, rain, from side',
  nl: 'Elias stands under an umbrella in the rain.',
});

function makeInput(over: Partial<RunOneInput> = {}) {
  const calls: TheaterImageInput[] = [];
  const base: RunOneInput = {
    kind: 'manga',
    chatId: 'c1',
    floor: 3,
    swipe: 0,
    characterName: 'Elias',
    body: 'Elias 撑着伞站在雨里等她。',
    shots: 1,
    chibi: false,
    mangaSafe: true,
    backend: 'nai',
    llm: async () => MANGA_READING,
    generate: async input => {
      calls.push(input);
      return { path: 'user/images/x.png', seed: 7 };
    },
    readLooks: names => names.map(name => ({ name, tag: '' })),
    ...over,
  };
  return { input: base, calls };
}

describe('runTheaterOne：黑白漫负面词', () => {
  it('默认同时带「压彩色」与「压 NSFW」', async () => {
    const { input, calls } = makeInput();
    const result = await runTheaterOne(input);
    expect(result.ok).toBe(true);
    expect(calls[0].prompt).toContain('monochrome');
    expect(calls[0].negative).toContain('colorful');
    expect(calls[0].negative).toContain('nsfw');
  });

  it('关掉黑白锁定：仍压 NSFW，但不再压彩色、也不再锁黑白', async () => {
    const { input, calls } = makeInput({ mangaBw: false });
    await runTheaterOne(input);
    expect(calls[0].prompt).not.toContain('monochrome');
    expect(calls[0].negative).not.toContain('colorful');
    expect(calls[0].negative).toContain('nsfw');
  });

  it('关掉安全模式：仍压彩色，但不写 nsfw 词', async () => {
    const { input, calls } = makeInput({ mangaSafe: false });
    await runTheaterOne(input);
    expect(calls[0].negative).toContain('colorful');
    expect(calls[0].negative).not.toContain('nsfw');
  });

  it('两个都关：不发负面词（不发空串）', async () => {
    const { input, calls } = makeInput({ mangaBw: false, mangaSafe: false });
    await runTheaterOne(input);
    expect(calls[0].negative).toBeUndefined();
  });

  it('常量本身不互相包含（否则合并去重会把安全词吞掉）', () => {
    expect(MANGA_BW_NEGATIVE).not.toContain('nsfw');
    expect(MANGA_SAFE_NEGATIVE).not.toContain('colorful');
  });
});
