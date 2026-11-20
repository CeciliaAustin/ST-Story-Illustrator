/**
 * 小剧场三套 = 柏宝绘原文 + A→B→D→C 接线
 *
 * 这组用例守的是**一条不变式**：三套读剧情提示词是柏宝绘内置 system 的逐字副本，
 * 且 system 拼接顺序必须是 破限(A) → NAI 规范(B) → 本套原文(D) → 思维链(C)。
 * 任何一环被"优化"掉，模型就不再走柏宝绘那一趟，「人物画错」会立刻复发。
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { buildTheaterPrompt } from '../src/theater/prompts';
import { withSpecPreamble } from '../src/baibai/specPrompt';
import {
  STATUS_SINGLE,
  STATUS_MANY,
  BONUS_SINGLE,
  MANGA_SINGLE,
  MANGA_MANY,
} from '../src/prompt/theaterDocs';

const A_MARK = '<nvwa_standalone_core>';
const B_MARK = '[NovelAI 4.5/V5 Prompt Specification]';
const C_MARK = '【输出前思考清单】';

beforeEach(() => {
  // 空设置 = 三格都留空 = 回落到柏宝绘内置那三份（这才是柏宝绘实际在跑的）
  (globalThis as unknown as Record<string, unknown>).getContext = () => ({
    chat: [],
    extensionSettings: {},
  });
});

describe('三套原文：是柏宝绘那份，不是我们自写的', () => {
  it('状态栏单格只用 characters 契约，不夹带我们自己的 cast/服装规则', () => {
    expect(STATUS_SINGLE).toContain('tags 只写这四类');
    expect(STATUS_SINGLE).not.toContain('"cast"');
    expect(STATUS_SINGLE).not.toContain('本批定妆');
  });

  it('状态栏多格是「按时间顺序的先后画面」，格数用 {{count}} 填', () => {
    expect(STATUS_MANY).toContain('{{count}} 个先后画面');
    expect(STATUS_MANY).toContain('**panels 按正文的时间顺序排列**');
  });

  it('彩蛋要求「忘掉剧情」且必须换花样', () => {
    expect(BONUS_SINGLE).toContain('**忘掉它的剧情**');
    expect(BONUS_SINGLE).toContain('**每次都换花样**');
  });

  it('黑白漫 tags 五类、必须有一个景别（状态栏是四类，两者不能混）', () => {
    expect(MANGA_SINGLE).toContain('tags 只写这五类');
    expect(MANGA_SINGLE).toContain('tags 里**必须有一个景别**');
    expect(MANGA_SINGLE).not.toContain('tags 只写这四类');
    expect(MANGA_MANY).toContain('像一页黑白漫画的分格');
  });
});

describe('A→B→D→C 的顺序', () => {
  it('破限 → 规范 → 本套原文 → 思维链，四段都在且不越位', () => {
    const { system: d } = buildTheaterPrompt({
      kind: 'status', characterName: '甲', body: '正文', shots: 1,
    });
    const full = withSpecPreamble(d, true);

    const iA = full.indexOf(A_MARK);
    const iB = full.indexOf(B_MARK);
    const iD = full.indexOf('把「这一楼最要紧的那一个画面」翻成一张插画');
    const iC = full.indexOf(C_MARK);

    expect(iA).toBeGreaterThanOrEqual(0);
    expect(iB).toBeGreaterThan(iA);
    expect(iD).toBeGreaterThan(iB);
    expect(iC).toBeGreaterThan(iD);
  });

  it('三套（状态栏/彩蛋/黑白漫）都过同一条链，没有一套绕过规范', () => {
    for (const kind of ['status', 'bonus', 'manga'] as const) {
      const { system: d } = buildTheaterPrompt({
        kind, characterName: '甲', body: '正文', shots: 1,
      });
      const full = withSpecPreamble(d, true);
      expect(full).toContain(A_MARK);
      expect(full).toContain(B_MARK);
      expect(full).toContain(C_MARK);
      expect(full.indexOf(C_MARK)).toBeGreaterThan(full.indexOf(B_MARK));
    }
  });

  it('思维链压在最后：它离输出最近，位置错了等于没读', () => {
    const { system: d } = buildTheaterPrompt({
      kind: 'manga', characterName: '甲', body: '正文', shots: 1,
    });
    const full = withSpecPreamble(d, true);
    const lastSection = full.slice(full.indexOf(C_MARK));
    expect(lastSection).toContain('输出前思考清单');
    expect(lastSection).toContain('<thinking>');
  });
});
