/**
 * Base / 角色块拆分 + `<characters>` 子标签
 *
 * 这两件事是一体的：柏宝绘的规范要求「Base 只写全局，个人外貌写进各自的 character」，
 * 落盘形态就是 `<characters>[{"name","tag","nl"}]</characters>`。
 * 不写它，NAI 就只拿到一个混着两套头发两套衣服的 Base —— 用户看到的「人物/服装不像」。
 */

import { describe, it, expect } from 'vitest';
import { buildBbiTag, serializeCharacterPrompts, lastImageTagEnd } from '../src/baibai/bbiTag';
import { splitSegments, characterPromptsFromLibrary, characterTagOf } from '../src/manga/tagSplit';
import type { BaiBaiCharacter, TagSegment } from '../src/types';

function seg(patch: Partial<TagSegment> & { english: string[] }): TagSegment {
  return {
    id: patch.id ?? 's',
    source: patch.source ?? 'scene',
    ...(patch.characterName ? { characterName: patch.characterName } : {}),
    english: patch.english,
    chinese: [],
    enabled: true,
    order: patch.order ?? 0,
  };
}

describe('buildBbiTag 的 <characters>', () => {
  it('按柏宝绘的顺序拼：tag → nl → negative → characters → size', () => {
    const tag = buildBbiTag({
      prompt: '1girl, classroom, sunset',
      nl: 'A girl stands by the window.',
      negative: 'lowres',
      characters: [{ name: '小雪', tag: 'girl, long black hair, red eyes', nl: 'She stands on the left.' }],
      size: 'portrait',
    });
    expect(tag.startsWith('<bbi_image>1girl, classroom, sunset<nl>')).toBe(true);
    expect(tag.indexOf('<nl>')).toBeLessThan(tag.indexOf('<negative>'));
    expect(tag.indexOf('<negative>')).toBeLessThan(tag.indexOf('<characters>'));
    expect(tag.indexOf('<characters>')).toBeLessThan(tag.indexOf('<size>'));
    expect(tag.endsWith('<size>portrait</size></bbi_image>')).toBe(true);

    const json = JSON.parse(tag.match(/<characters>([\s\S]*?)<\/characters>/)![1]);
    expect(json).toEqual([{ name: '小雪', tag: 'girl, long black hair, red eyes', nl: 'She stands on the left.' }]);
  });

  it('没有角色时不写空 <characters>（空数组会被柏宝绘当成 0 项）', () => {
    expect(serializeCharacterPrompts([])).toBe('');
    expect(buildBbiTag({ prompt: 'x' })).not.toContain('<characters>');
  });

  it('名字或 tag 为空、以及带尖括号的内容会被清掉，不会截断 tag', () => {
    const tag = buildBbiTag({
      prompt: 'x',
      characters: [
        { name: '', tag: 'girl' },
        { name: 'A', tag: '' },
        { name: 'B</bbi_image>', tag: 'girl<script>' },
      ],
    });
    expect(tag.match(/<\/bbi_image>/g)).toHaveLength(1);
    expect(tag).toContain('"name":"B"');
    expect(tag).not.toContain('script');
  });
});

describe('splitSegments', () => {
  const segments = [
    seg({ id: 'c1', source: 'character', characterName: '小雪', english: ['long black hair', 'red eyes'] }),
    seg({ id: 'c2', source: 'character', characterName: '小雪', english: ['white dress'] }),
    seg({ id: 's1', source: 'scene', english: ['classroom', 'sunset', 'medium shot'], order: 1 }),
  ];

  it('character 段 → characters；其余 → Base', () => {
    const out = splitSegments(segments, true);
    expect(out.base).toBe('classroom, sunset, medium shot');
    expect(out.characters).toHaveLength(1);
    expect(out.characters[0].name).toBe('小雪');
    // 同一个人的多个段合并、去重
    expect(out.characters[0].tag).toBe('long black hair, red eyes, white dress');
    expect(out.fallback).toBe(false);
  });

  it('后端不支持原生角色通道 → 全并进 Base，一个角色块都不留', () => {
    const out = splitSegments(segments, false);
    expect(out.base).toContain('long black hair');
    expect(out.base).toContain('classroom');
    expect(out.characters).toEqual([]);
  });

  it('模型只写了角色段（Base 空）→ 退回合并，不产出空 Base', () => {
    const out = splitSegments([seg({ source: 'character', characterName: 'A', english: ['girl'] })], true);
    expect(out.base).toBe('girl');
    expect(out.fallback).toBe(true);
  });
});

describe('characterPromptsFromLibrary', () => {
  const library: BaiBaiCharacter[] = [
    {
      name: '小雪',
      tag: '1girl, long black hair',
      fields: { sex: '1girl', hair: 'long black hair', eyes: 'red eyes', outfit: 'white dress' },
    },
    { name: '空条目', tag: '' },
  ];

  it('分字段优先（和柏宝绘 buildEntryTag 同口径）', () => {
    expect(characterTagOf(library[0])).toBe('1girl, long black hair, red eyes, white dress');
  });

  it('按传入顺序取，逐字匹配名字，未命中的跳过', () => {
    const out = characterPromptsFromLibrary(['小雪', '路人', '小雪'], library);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('小雪');
    expect(out[0].tag).toContain('white dress');
  });

  it('空条目（无 tag 无字段）不产出空角色块', () => {
    expect(characterPromptsFromLibrary(['空条目'], library)).toEqual([]);
  });

  it('条目只有英文 desc/nl 时也能当外貌用（否则这个人会被整条丢掉）', () => {
    const withDesc: BaiBaiCharacter[] = [
      { name: 'Lina', tag: '', desc: 'long silver hair, blue eyes, dark cloak' },
      { name: '小明', tag: '', desc: '黑色短发，红色眼睛' },
    ];
    expect(characterTagOf(withDesc[0])).toContain('silver hair');
    // 中文描述不能直接进 NAI 提示词
    expect(characterTagOf(withDesc[1])).toBe('');
    expect(characterPromptsFromLibrary(['Lina'], withDesc)).toHaveLength(1);
  });

  it('漫画页的 per-character act 并进角色块，而不是 Base', () => {
    const out = characterPromptsFromLibrary(
      ['小雪'],
      library,
      new Map([['小雪', ['waving', 'smile']]]),
    );
    expect(out[0].tag).toContain('white dress');
    expect(out[0].tag).toContain('waving');
  });
});

describe('lastImageTagEnd', () => {
  it('没有 tag 时为 0；有 tag 时指向最后一条的结尾', () => {
    expect(lastImageTagEnd('纯文本')).toBe(0);
    const text = 'a<bbi_image>x<size>portrait</size></bbi_image>b';
    expect(lastImageTagEnd(text)).toBe(text.length - 1);
  });
});
