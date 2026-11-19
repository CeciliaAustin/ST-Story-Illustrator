import { describe, it, expect } from 'vitest';
import {
  buildBbiTag,
  sanitizeTagText,
  countImageTags,
  hasImageTagAfter,
  promptHash,
} from '../src/baibai/bbiTag';

describe('sanitizeTagText', () => {
  it('剥掉尖括号片段（防止 tag 被子标签提前截断）', () => {
    expect(sanitizeTagText('1girl, </bbi_image> 2boys')).toBe('1girl, 2boys');
    expect(sanitizeTagText('a<nl>b</nl>c')).toBe('a b c');
  });

  it('把换行与连续空白折成单空格', () => {
    expect(sanitizeTagText('a\n\n b\t\tc  ')).toBe('a b c');
  });

  it('空值返回空串', () => {
    expect(sanitizeTagText(undefined)).toBe('');
    expect(sanitizeTagText(null)).toBe('');
  });
});

describe('buildBbiTag', () => {
  it('只写 prompt + size（可选字段空则整段不写）', () => {
    expect(buildBbiTag({ prompt: '1girl, smile' }))
      .toBe('<bbi_image>1girl, smile<size>portrait</size></bbi_image>');
  });

  it('带 nl 与 negative 时按柏宝绘的顺序输出', () => {
    expect(buildBbiTag({
      prompt: '1girl',
      nl: 'a girl smiling',
      negative: 'bad hands',
      size: 'landscape',
    })).toBe(
      '<bbi_image>1girl<nl>a girl smiling</nl><negative>bad hands</negative><size>landscape</size></bbi_image>',
    );
  });

  it('内容里的子标签字面量被剥掉', () => {
    const tag = buildBbiTag({ prompt: '1girl</bbi_image>', nl: '<nl>x' });
    expect(tag).toBe('<bbi_image>1girl<nl>x</nl><size>portrait</size></bbi_image>');
    expect(countImageTags(tag)).toBe(1);
  });

  it('size 只认 landscape，其余一律 portrait', () => {
    expect(buildBbiTag({ prompt: 'a', size: 'square' as 'portrait' }))
      .toContain('<size>portrait</size>');
  });
});

describe('countImageTags', () => {
  it('数出正文里的 tag 数（决定槽位序号）', () => {
    const a = '<bbi_image>a<size>portrait</size></bbi_image>';
    const b = '<bbi_image>b<size>portrait</size></bbi_image>';
    expect(countImageTags('')).toBe(0);
    expect(countImageTags(`正文${a}正文`)).toBe(1);
    expect(countImageTags(`${a}\n\n${b}`)).toBe(2);
  });
});

describe('promptHash', () => {
  // 期望值由柏宝绘 src/floor/storage.ts 的 promptHash 直接算出：
  // 两边必须逐字节一致，否则卡片按 hash 找不到自己的结果（图出来了却显示未生成）。
  it('与柏宝绘的 hash 完全一致', () => {
    expect(promptHash('abc')).toBe('11f9f91ac18c8d');
    expect(promptHash('<bbi_image>1girl, silver hair<nl>a girl</nl><size>portrait</size></bbi_image>'))
      .toBe('03498a6d112c17');
    expect(promptHash('<bbi_image>a, b<size>landscape</size></bbi_image>'))
      .toBe('1b864e14b4d615');
  });

  it('固定 14 位 hex', () => {
    expect(promptHash('')).toMatch(/^[0-9a-f]{14}$/);
  });
});

describe('hasImageTagAfter（多图共存的前提）', () => {
  const tag = '<bbi_image>1girl<size>portrait</size></bbi_image>';

  it('锚点后面已有图片 tag 时必须判 true（新 tag 要改追加，不能插到它前面）', () => {
    const mes = `正文选段${tag}后面的正文`;
    const anchorEnd = '正文选段'.length;
    expect(hasImageTagAfter(mes, anchorEnd)).toBe(true);
  });

  it('锚点后面没有图片 tag 时判 false（可以就地插入）', () => {
    const mes = '正文选段后面的正文';
    expect(hasImageTagAfter(mes, '正文选段'.length)).toBe(false);
  });

  it('图片 tag 在锚点之前不算（顺序不会被打乱）', () => {
    const mes = `${tag}正文选段`;
    expect(hasImageTagAfter(mes, mes.length)).toBe(false);
  });
});
