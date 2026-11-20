/**
 * 漫画专用 tag `<bbi_manwa>`
 *
 * 锁住三件事（都是线上踩过的）：
 * 1. tag 原文能解析回 artifact id（卡片水合全靠它）；
 * 2. 托管正则的两条规则属性正确（显示侧换锚点、提示词侧删干净）；
 * 3. 同一批多页**按写入顺序**排列，后插的不能被顶到前面去。
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

const {
  buildManwaTag,
  parseManwaTags,
  lastManwaTagEnd,
  manwaSlotScript,
  manwaHideScript,
  insertManwaTag,
  MANWA_SLOT_SELECTOR,
} = await import('../src/baibai/manwaTag');

function setMes(mes: string): void {
  host.chat[0] = { mes, swipes: [mes], swipe_id: 0 };
}

describe('tag 组装与解析', () => {
  it('只带 id，且把非法字符洗掉（否则会把 tag 提前截断）', () => {
    expect(buildManwaTag('a1-b2')).toBe('<bbi_manwa><id>a1-b2</id></bbi_manwa>');
    expect(buildManwaTag('x</id><script>')).toBe('<bbi_manwa><id>xidscript</id></bbi_manwa>');
    expect(buildManwaTag('')).toBe('');
  });

  it('按出现顺序解析出 id', () => {
    const mes = `正文\n\n${buildManwaTag('p1')}\n中间\n\n${buildManwaTag('p2')}\n`;
    expect(parseManwaTags(mes).map(t => t.id)).toEqual(['p1', 'p2']);
  });

  it('没有 tag 时返回空数组（不能抛）', () => {
    expect(parseManwaTags('普通正文，带个 <bbi_image> 也不算')).toEqual([]);
    expect(lastManwaTagEnd('普通正文')).toBe(0);
  });
});

describe('托管正则', () => {
  it('显示侧把整条 tag 换成锚点，且只走 markdown 路径', () => {
    const script = manwaSlotScript();
    expect(script.replaceString).toBe(`<div data-sti-manwa-slot=""></div>`);
    expect(script.markdownOnly).toBe(true);
    expect(script.promptOnly).toBe(false);
    // 旁白楼（extra.type='narrator'）的显示 placement 是 3，漏了就等于没注册
    expect(script.placement).toContain(3);
    expect(script.findRegex).toBe(manwaHideScript().findRegex);
  });

  it('提示词侧删成空串，绝不把 tag 喂给模型', () => {
    const script = manwaHideScript();
    expect(script.replaceString).toBe('');
    expect(script.promptOnly).toBe(true);
    expect(script.markdownOnly).toBe(false);
    expect(script.placement).toContain(3);
  });

  it('锚点选择器与柏宝绘的 div[data-bbi-slot] 不重叠', () => {
    expect(MANWA_SLOT_SELECTOR).toBe('div[data-sti-manwa-slot]');
    expect(MANWA_SLOT_SELECTOR).not.toContain('bbi-slot');
  });
});

describe('插入正文', () => {
  it('插在选段所在行之后，不是字中间', async () => {
    setMes('她把灯关了。\n\n然后走到窗边。');
    const tag = buildManwaTag('p1');
    const r = await insertManwaTag({ floor: 0, chatId: 'c1', swipeId: 0, tag, anchorText: '她把灯关了。' });
    expect(r).toEqual({ ok: true, position: 'after-anchor' });
    expect(host.chat[0].mes.startsWith('她把灯关了。\n\n<bbi_manwa>')).toBe(true);
  });

  it('同一段选段连插两页：后插的排在后面（顺序不能反）', async () => {
    setMes('她把灯关了。');
    await insertManwaTag({ floor: 0, chatId: 'c1', swipeId: 0, tag: buildManwaTag('p1'), anchorText: '她把灯关了。' });
    await insertManwaTag({ floor: 0, chatId: 'c1', swipeId: 0, tag: buildManwaTag('p2'), anchorText: '她把灯关了。' });
    expect(parseManwaTags(host.chat[0].mes).map(t => t.id)).toEqual(['p1', 'p2']);
  });

  it('幂等：同一条 tag 不会重复写', async () => {
    setMes('她把灯关了。');
    const tag = buildManwaTag('p1');
    await insertManwaTag({ floor: 0, chatId: 'c1', swipeId: 0, tag, anchorText: '她把灯关了。' });
    await insertManwaTag({ floor: 0, chatId: 'c1', swipeId: 0, tag, anchorText: '她把灯关了。' });
    expect(parseManwaTags(host.chat[0].mes)).toHaveLength(1);
  });

  it('找不到锚点就追加到末尾，并如实返回 appended', async () => {
    setMes('完全无关的一段。');
    const r = await insertManwaTag({ floor: 0, chatId: 'c1', swipeId: 0, tag: buildManwaTag('p1'), anchorText: '不存在的句子' });
    expect(r).toEqual({ ok: true, position: 'appended' });
    expect(host.chat[0].mes).toContain('<bbi_manwa>');
  });

  it('排队期间换了聊天就放弃（不写错聊天）', async () => {
    setMes('她把灯关了。');
    const r = await insertManwaTag({ floor: 0, chatId: 'other', swipeId: 0, tag: buildManwaTag('p1') });
    expect(r).toEqual({ ok: false, reason: 'chat-changed' });
    expect(host.chat[0].mes).toBe('她把灯关了。');
  });

  it('swipe 变了就放弃（写到另一条世界线是更糟的错）', async () => {
    setMes('她把灯关了。');
    const r = await insertManwaTag({ floor: 0, chatId: 'c1', swipeId: 1, tag: buildManwaTag('p1') });
    expect(r).toEqual({ ok: false, reason: 'swipe-changed' });
  });

  it('两页锚到不同台词 → 各插各的位置（任务书 §8：一页一个挂载点）', async () => {
    setMes('「等等。」他拉住她。\n\n她回头看了一眼。\n\n然后门关上了。');
    await insertManwaTag({ floor: 0, chatId: 'c1', swipeId: 0, tag: buildManwaTag('p1'), anchorText: '「等等。」他拉住她。' });
    await insertManwaTag({ floor: 0, chatId: 'c1', swipeId: 0, tag: buildManwaTag('p2'), anchorText: '她回头看了一眼。' });
    const mes = host.chat[0].mes as string;
    const p1 = mes.indexOf('id>p1<');
    const p2 = mes.indexOf('id>p2<');
    const turn = mes.indexOf('她回头看了一眼。');
    const door = mes.indexOf('然后门关上了。');
    expect(p1).toBeGreaterThanOrEqual(0);
    expect(p2).toBeGreaterThanOrEqual(0);
    // p1 在第一句之后、p2 在第二句之后，二者不在同一处
    expect(p1).toBeLessThan(turn);
    expect(p2).toBeGreaterThan(turn);
    expect(p2).toBeLessThan(door);
  });
});
