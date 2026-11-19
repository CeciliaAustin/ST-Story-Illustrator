/**
 * 「图和剧情对不上」的三处根因回归测试
 *
 * 用户看到的症状是「黑白漫四格全是与剧情无关的头像、也没有对白」。拆开来是三件事：
 * 1. 模型挑的景别被状态栏那套清洗表删掉了 → 每格都退化成同一个 cowboy shot；
 * 2. 模型的 nl（唯一写清「谁在哪里做什么」的通道）整段没发给柏宝绘；
 * 3. 黑白漫的 system 里压根没有台词字段。
 */

import { describe, it, expect } from 'vitest';
import { sanitizeStatusTags, parseStatusReply } from '../src/theater/parseReply';
import { buildMangaNl } from '../src/theater/prompts';
import { runStatusText, formatElapsed, type RunStatusSnapshot } from '../src/ui/runStatus';

describe('sanitizeStatusTags：漫画放行景别', () => {
  it('状态栏链路照旧删掉景别（那套的画风由 Q 版串决定）', () => {
    expect(sanitizeStatusTags('1girl, cowboy shot, smile')).not.toContain('cowboy shot');
    expect(sanitizeStatusTags('1girl, wide shot, smile')).not.toContain('wide shot');
  });

  it('漫画链路保留模型挑的景别（交代走位要靠 wide shot / full body）', () => {
    expect(sanitizeStatusTags('1girl, wide shot, smile', { allowFraming: true }))
      .toContain('wide shot');
    expect(sanitizeStatusTags('1boy, full body, kneeling', { allowFraming: true }))
      .toContain('full body');
  });

  it('只留第一个景别（两个景别会把画面折中成半身像）', () => {
    const out = sanitizeStatusTags('close-up, wide shot, smile', { allowFraming: true });
    expect(out).toContain('close-up');
    expect(out).not.toContain('wide shot');
  });

  it('漫画链路仍然要拦画风词（黑白/网点由画师串负责）', () => {
    const out = sanitizeStatusTags('masterpiece, screentone, 1girl', { allowFraming: true });
    expect(out).toEqual(['1girl']);
  });

  it('漫画链路限额更宽（动作+道具+景别塞得下）', () => {
    const raw = Array.from({ length: 25 }, (_, i) => `tag${i}`).join(', ');
    expect(sanitizeStatusTags(raw, { allowFraming: true, maxTags: 20 })).toHaveLength(20);
  });
});

describe('parseStatusReply：按模式决定标签口径', () => {
  const raw = JSON.stringify({
    title: '他替她挡光',
    characters: [{ name: 'Elias', act: 'raising a hand to block the sunlight' }],
    tags: '1boy, wide shot, standing in the doorway, hand above eyes, sunlight',
    nl: 'Elias steps to the sunny side and blocks the light for her.',
  });

  it('漫画模式保住 wide shot（否则每格都是同一张半身像）', () => {
    const r = parseStatusReply(raw, 'manga');
    expect(r.tags).toContain('wide shot');
    expect(r.tags).toContain('standing in the doorway');
  });

  it('状态栏模式沿用旧口径，景别被删', () => {
    const r = parseStatusReply(raw, 'status');
    expect(r.tags).not.toContain('wide shot');
  });

  it('nl 原样保留（要发给柏宝绘，不能丢）', () => {
    expect(parseStatusReply(raw, 'manga').nl).toContain('Elias steps to the sunny side');
  });

  it('台词能解析出来（黑白漫带对白）', () => {
    const withLines = JSON.stringify({
      title: '挡光',
      tags: '1boy, close-up',
      lines: [
        { speaker: 'Elias', text: '站到这边来。' },
        { speaker: '旁白', text: '阳光被他挡在身后。' },
      ],
    });
    const r = parseStatusReply(withLines, 'manga');
    expect(r.lines?.map(l => l.text)).toEqual(['站到这边来。', '阳光被他挡在身后。']);
  });
});

describe('buildMangaNl：每张卡片只画一格', () => {
  it('在前面压一句单格说明（方案画师串带分格词时能纠回来）', () => {
    const nl = buildMangaNl('Elias stands in the doorway.');
    expect(nl.startsWith('One single comic panel')).toBe(true);
    expect(nl).toContain('no panel borders');
    expect(nl).toContain('Elias stands in the doorway.');
  });

  it('没有 nl 时不造句子', () => {
    expect(buildMangaNl('')).toBe('');
  });
});

describe('runStatusText：状态条文案', () => {
  const base: RunStatusSnapshot = {
    level: 'running',
    mode: 'bw-manga',
    stage: 'generating',
    page: 2,
    totalPages: 3,
    startedAt: Date.now() - 12_000,
  };

  it('出图中显示模式、第几格与耗时', () => {
    const text = runStatusText(base);
    expect(text).toContain('黑白漫小剧场');
    expect(text).toContain('第 2/3 格');
    expect(text).toMatch(/\d+s/);
  });

  it('失败时把原因接在后面', () => {
    const text = runStatusText({ ...base, level: 'error', message: '副 API 403' });
    expect(text).toContain('副 API 403');
  });

  it('超过一分钟换成 m/s', () => {
    expect(formatElapsed(75)).toBe('1m15s');
  });
});
