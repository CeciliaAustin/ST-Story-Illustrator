/**
 * 划线处插图：位置必须落在「划线那一段下面」
 *
 * 线上现象：正文划线生成插图后，图跑到整楼最下面。
 * 根因：插入用的是 `mes.indexOf(selectionText)` 逐字匹配，而划线拿到的是**渲染后**的文本：
 * - DOM 里 `*动作*` 的星号不显示；
 * - DOM 里一个换行，mes 里常常是两个；
 * - 引号被排版成 “ ”，mes 里是 "。
 * 逐字匹配必然失败 → 一路落到「追加到本楼末尾」。
 *
 * 这里锁住：
 * 1. 宽松匹配能补上 Markdown / 空行 / 弯引号的差异；
 * 2. 插入点在「选段所在行之后」，不是字中间、也不是楼末；
 * 3. 真的找不到时才追加末尾，并如实返回 position=appended（调用方据此提示用户）。
 */

import { describe, it, expect, vi } from 'vitest';

const host = vi.hoisted(() => ({
  chat: [{ mes: '', swipes: [''], swipe_id: 0 }],
}));

vi.mock('../src/host/sillytavern', () => ({
  getContext: () => ({ chat: host.chat, saveChat: async () => {} }),
  getCurrentChatId: () => 'c1',
  getEventTypes: () => ({ MESSAGE_UPDATED: 'message_updated' }),
}));

const { findAnchorRange, lineEndAfter } = await import('../src/selection/anchor');
const { insertImageTag } = await import('../src/baibai/bbiTag');

const TAG = '<bbi_image>1girl, smile<size>portrait</size></bbi_image>';

function setMes(mes: string): void {
  host.chat[0] = { mes, swipes: [mes], swipe_id: 0 };
}

describe('findAnchorRange：渲染文本 ↔ mes 原文', () => {
  it('忽略 Markdown 强调符', () => {
    const mes = '*她伸手把灯关了。*';
    const range = findAnchorRange(mes, '她伸手把灯关了。');
    expect(range).not.toBeNull();
    expect(mes.slice(range!.start, range!.end)).toBe('她伸手把灯关了。');
  });

  it('忽略空行数量差异（DOM 一个换行 / mes 两个）', () => {
    const mes = '上句\n\n下一句';
    expect(findAnchorRange(mes, '上句\n下一句')).not.toBeNull();
  });

  it('忽略弯引号与全半角差异', () => {
    const mes = '"别动。"他低声说。';
    expect(findAnchorRange(mes, '“别动。”他低声说。')).not.toBeNull();
  });

  it('选段被改过时退到前 24 字仍能定位', () => {
    const mes = '他把她按在桌上，手指沿着她的腰线往下滑，然后停住了。';
    expect(findAnchorRange(mes, '他把她按在桌上，手指沿着她的腰线往下滑，然后忽然笑了')).not.toBeNull();
  });

  it('完全不相干返回 null', () => {
    expect(findAnchorRange('今天天气不错', '他把她按在桌上')).toBeNull();
  });

  it('lineEndAfter 给出整行末尾（不含换行）', () => {
    const text = '第一行\n第二行内容\n第三行';
    expect(lineEndAfter(text, 1)).toBe('第一行'.length);
    expect(lineEndAfter('没有换行的一段', 2)).toBe('没有换行的一段'.length);
  });
});

describe('insertImageTag：插在划线那一段下面', () => {
  it('不追加到楼末，而是插在选段所在行之后', async () => {
    const mes = [
      '他把书合上，抬眼看着她。',
      '',
      '*她伸手把灯关了。*',
      '',
      '“别动。”他低声说。',
      '',
      '最后一段：房间里只剩下呼吸声。',
    ].join('\n');
    setMes(mes);

    const result = await insertImageTag({
      floor: 0,
      chatId: 'c1',
      swipeId: 0,
      tag: TAG,
      anchorText: '她伸手把灯关了。',
    });

    expect(result).toMatchObject({ ok: true, position: 'after-anchor' });
    const next = host.chat[0].mes;
    const at = next.indexOf(TAG);
    expect(at).toBeGreaterThan(next.indexOf('她伸手把灯关了。'));
    expect(at).toBeLessThan(next.indexOf('别动。'));
    // 不能在字中间把这一句劈开
    expect(next).toContain('*她伸手把灯关了。*\n\n' + TAG);
  });

  it('选段带弯引号、mes 是直引号时仍就地插入', async () => {
    setMes('他压低声音。\n\n"别动。"他说。\n\n她没动。');
    const result = await insertImageTag({
      floor: 0,
      chatId: 'c1',
      swipeId: 0,
      tag: TAG,
      anchorText: '“别动。”他说。',
    });
    expect(result).toMatchObject({ ok: true, position: 'after-anchor' });
    const next = host.chat[0].mes;
    expect(next.indexOf(TAG)).toBeLessThan(next.indexOf('她没动。'));
  });

  it('真的找不到才追加末尾，并如实标注 appended', async () => {
    setMes('完全不相干的正文内容。');
    const result = await insertImageTag({
      floor: 0,
      chatId: 'c1',
      swipeId: 0,
      tag: TAG,
      anchorText: '他把她按在桌上',
    });
    expect(result).toMatchObject({ ok: true, position: 'appended' });
    expect(host.chat[0].mes.trimEnd().endsWith('</bbi_image>')).toBe(true);
  });

  it('锚点后面已有图片 tag 时插在选段处，并把旧结果的槽位序号后移', async () => {
    const oldTag = TAG;
    const extra = { bbiImage: { '0': { h1: [{ generationId: 'g1', slotSeq: 0 }] } } };
    host.chat[0] = {
      mes: `他抬头。\n\n${oldTag}\n\n她低头。`,
      swipes: [`他抬头。\n\n${oldTag}\n\n她低头。`],
      swipe_id: 0,
      extra,
    } as (typeof host.chat)[number];

    const nextTag = '<bbi_image>2girls<size>portrait</size></bbi_image>';
    const result = await insertImageTag({
      floor: 0,
      chatId: 'c1',
      swipeId: 0,
      tag: nextTag,
      anchorText: '他抬头。',
    });

    // 位置在选段之后、旧图之前
    expect(result).toMatchObject({ ok: true, position: 'after-anchor', seq: 0 });
    const mes = host.chat[0].mes;
    expect(mes.indexOf(nextTag)).toBeLessThan(mes.indexOf(oldTag));
    // 旧结果的序号后移一位，否则它会被判成「提示词已改」
    expect(extra.bbiImage['0'].h1[0].slotSeq).toBe(1);
  });
});
