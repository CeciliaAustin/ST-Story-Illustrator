/**
 * 台词 100% 原文引用：逐字抽候选 + 按引用回填 + 改写丢弃
 * 用户实测 A：台词被改写（要求 100% 复刻）。
 */
import { describe, it, expect } from 'vitest';
import {
  resolveSourceDialogue,
  reconcileDialogueWithSource,
  sourceDialogueBlock,
} from '../src/manga/sourceDialogue';

const SEGMENT =
  '叶均低头替她理好衣领。「别动，」他低声说，「否则歪了。」\n' +
  '温明徽抬眼看他：“你什么时候学会这么细心的？”\n' +
  '「大概是，「他笑了一下，「遇到你以后。」';

describe('resolveSourceDialogue — 逐字抽取原文台词', () => {
  it('抽出引号内的台词，保留标点，编号稳定', () => {
    const lines = resolveSourceDialogue(SEGMENT);
    expect(lines.length).toBeGreaterThan(0);
    // 每句都必须能在原文里逐字找到（不做任何加工）
    for (const line of lines) {
      expect(SEGMENT.includes(line.text)).toBe(true);
    }
    expect(lines.map(l => l.index)).toEqual(lines.map((_, i) => i));
  });

  it('猜引号前的说话人', () => {
    const lines = resolveSourceDialogue(SEGMENT);
    expect(lines.some(l => l.speaker === '他')).toBe(true);
  });

  it('没有引号时退到逐行', () => {
    const lines = resolveSourceDialogue('第一行台词！\n第二行台词？');
    expect(lines.map(l => l.text)).toEqual(['第一行台词！', '第二行台词？']);
  });

  it('空输入返回空', () => {
    expect(resolveSourceDialogue('')).toEqual([]);
    expect(resolveSourceDialogue(null)).toEqual([]);
  });
});

describe('reconcileDialogueWithSource — 回填原文 / 丢弃改写', () => {
  const lines = resolveSourceDialogue(SEGMENT);

  it('按 sourceIndex 回填成逐字原文（text 被覆盖）', () => {
    const idx = lines[0].index;
    const out = reconcileDialogueWithSource(
      [{ text: '模型乱写的占位', sourceIndex: idx } as never], lines,
    );
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe(lines[0].text);
    expect(SEGMENT.includes(out[0].text)).toBe(true);
  });

  it('模型逐字写对了原文：命中后仍用原文那一串', () => {
    const target = lines[1].text;
    const out = reconcileDialogueWithSource([{ text: target }], lines);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe(target);
  });

  it('模型改写原文（改字/缩写/纠错）：整条丢弃，绝不画改写版', () => {
    const rewritten = '遇到你之后我就变得很有耐心了呢'; // 语义相近但不是原文
    const out = reconcileDialogueWithSource([{ text: rewritten }], lines);
    expect(out).toHaveLength(0);
  });

  it('保留 area/panel/x/y/dir/mood 等排版字段', () => {
    const idx = lines[0].index;
    const out = reconcileDialogueWithSource(
      [{ text: '', sourceIndex: idx, panel: 2, area: 'br', x: 0.8, y: 0.3, dir: 'v', mood: 'whisper' } as never],
      lines,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ panel: 2, area: 'br', x: 0.8, y: 0.3, dir: 'v', mood: 'whisper' });
  });

  it('sourceIndex 越界：安全丢弃', () => {
    const out = reconcileDialogueWithSource([{ text: 'x', sourceIndex: 999 } as never], lines);
    expect(out).toHaveLength(0);
  });
});

describe('sourceDialogueBlock — 注入 LLM 的原文清单', () => {
  it('列出带序号的原文，并禁止改写', () => {
    const block = sourceDialogueBlock(resolveSourceDialogue(SEGMENT));
    expect(block).toContain('本页可选台词原文');
    expect(block).toContain('0:');
    expect(block).toContain('sourceIndex');
    expect(block).toContain('禁止改写');
  });

  it('没有候选时返回空串（不注入噪音）', () => {
    expect(sourceDialogueBlock([])).toBe('');
  });
});
