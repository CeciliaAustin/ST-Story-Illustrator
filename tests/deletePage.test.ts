/**
 * 删除一页漫画：正文锚点摘除 + 可见性判定。
 *
 * 用户实测过两个症状，都固化在这里：
 * 1. 把正文里的 `<bbi_manwa>` 删掉后，卡片还在（刷新、重进聊天都还在）——
 *    因为旧逻辑把 inline 作品无条件算进「该显示」，完全没看正文。
 * 2. 删除需要一条确定的路：正文锚点、artifact 数据、DOM 卡片三样一起没。
 */
import { describe, it, expect } from 'vitest';
import { buildManwaTag, parseManwaTags, stripManwaTag } from '../src/baibai/manwaTag';
import { isArtifactVisible } from '../src/ui/floorCards';

const A = buildManwaTag('art_aaaa');
const B = buildManwaTag('art_bbbb');

describe('stripManwaTag — 从正文里摘掉某一条漫画 tag', () => {
  it('删掉指定 id 的 tag，其它页的 tag 原样保留', () => {
    const mes = `她抬眼看他。\n\n${A}\n\n他低下头。\n\n${B}\n`;
    const out = stripManwaTag(mes, 'art_aaaa');
    expect(out).not.toContain('art_aaaa');
    expect(out).toContain('art_bbbb');
    expect(parseManwaTags(out).map(r => r.id)).toEqual(['art_bbbb']);
  });

  it('独占一行的 tag 删掉时连空行一起收掉（正文不留越来越高的大空白）', () => {
    const mes = `正文第一行。\n\n${A}\n\n正文第二行。`;
    const out = stripManwaTag(mes, 'art_aaaa');
    expect(out).toBe('正文第一行。\n\n正文第二行。');
    expect(out).not.toMatch(/\n{3,}/);
  });

  it('只删那一条，同 id 之外一条都不动', () => {
    const mes = `${A}\n${A}`;
    const out = stripManwaTag(mes, 'art_aaaa');
    expect(parseManwaTags(out)).toHaveLength(0);
  });

  it('id 不存在时原样返回（不误删别的页）', () => {
    const mes = `正文\n\n${B}\n`;
    expect(stripManwaTag(mes, 'art_zzzz')).toBe(mes);
  });

  it('空 id / 空正文不炸', () => {
    expect(stripManwaTag('正文', '')).toBe('正文');
    expect(stripManwaTag('', 'art_aaaa')).toBe('');
  });

  it('tag 夹在句子中间时只删 tag 本身，不动同行文字', () => {
    const mes = `他停下${A}脚步。`;
    const out = stripManwaTag(mes, 'art_aaaa');
    expect(out).toBe('他停下脚步。');
  });
});

describe('isArtifactVisible — 正文删了 tag 就不该再显示', () => {
  const comic = (id: string, metadata: Record<string, unknown> = {}) => ({
    id,
    mountMode: 'inline' as const,
    metadata,
  });

  it('行内漫画有 tag → 显示', () => {
    expect(isArtifactVisible(comic('art_aaaa'), new Set(['art_aaaa']))).toBe(true);
  });

  it('行内漫画 tag 被删掉 → 不显示（这就是「删了提示词图还在」的根因）', () => {
    expect(isArtifactVisible(comic('art_aaaa'), new Set())).toBe(false);
  });

  it('另一页的 tag 救不了自己 → 不显示', () => {
    expect(isArtifactVisible(comic('art_aaaa'), new Set(['art_bbbb']))).toBe(false);
  });

  it('标过 inlineFallback 的老卡（正文里从来没有 tag）→ 仍显示', () => {
    expect(isArtifactVisible(comic('art_old', { inlineFallback: true }), new Set())).toBe(true);
  });

  it('挂在楼末的插画（trailing）不受正文 tag 影响 → 显示', () => {
    const illustration = { id: 'illu_1', mountMode: 'trailing' as const, metadata: {} };
    expect(isArtifactVisible(illustration, new Set())).toBe(true);
  });
});
