/**
 * 版面 → 出图词：按柏宝绘原版四档（regular / irregular / inset / unframed）。
 *
 * 用户实测的核心事故：
 * - 选「主图+特写、固定三格、大面积留白」，出图是**三条等宽横带**——
 *   因为提示词里写的是 `3koma`（NAI 把它理解为等分三格漫画条），而这一档
 *   本来就该是白底居中主图 + 两个带框特写格，压根不该出现 koma。
 * - `comic page layout` / `panel layout` 是自造词，danbooru 上是 0 帖空 tag，
 *   写进去等于没写；真正被模型听见的只有那个裸 `3koma`。
 */

import { describe, expect, it } from 'vitest';
import { buildBoardGeneration, resolveBoard, boardTagsFor } from '../src/manga/stylePrompt';
import {
  applyPanelToNl,
  enforcePanelPrompt,
  reconcileHeadcount,
  boardAreaLeads,
  isMostlyChinese,
} from '../src/manga/boardPrompt';

const KOMA = /\b[234]koma\b/i;

describe('resolveBoard：风格 + 格数 + 留白 → 柏宝绘四档', () => {
  it('主图+特写 + 三格 + 大面积留白 → inset（白底居中 + 四周留白 + 特写格）', () => {
    const board = resolveBoard({ style: 'hero_insets', panelCount: 3, whitespace: 'airy' });
    expect(board.layout).toBe('inset');
    expect(board.panelCount).toBe(3);
    // inset 档绝不写 koma：koma 是"等分 N 格"，和"主图 + 特写"直接打架
    expect(board.koma).toBeUndefined();
  });

  it('主图+特写 + 铺满（compact）→ unframed，三格走 A 型页型', () => {
    const board = resolveBoard({ style: 'hero_insets', panelCount: 3, whitespace: 'compact' });
    expect(board.layout).toBe('unframed');
    expect(board.pageType).toBe('a');
  });

  it('主图+特写默认留白（dramatic）也走 inset', () => {
    const board = resolveBoard({ style: 'hero_insets', panelCount: 3, whitespace: 'auto' });
    expect(board.layout).toBe('inset');
  });

  it('主图+特写选四格：降级成三格并给出可读说明（不静默）', () => {
    const board = resolveBoard({ style: 'hero_insets', panelCount: 4, whitespace: 'airy' });
    expect(board.panelCount).toBe(3);
    expect(board.note).toMatch(/三格/);
  });

  it('经典网格 + 三格 → regular + 3koma（等分三格是这一档的语义，不是 bug）', () => {
    const board = resolveBoard({ style: 'classic_grid', panelCount: 3, whitespace: 'compact' });
    expect(board.layout).toBe('regular');
    expect(board.koma).toBe(3);
  });

  it('经典网格 + 四格 → regular + 4koma', () => {
    expect(resolveBoard({ style: 'classic_grid', panelCount: 4, whitespace: 'compact' }).koma).toBe(4);
  });

  it('开放拼版固定三格 → irregular，不写任何 koma', () => {
    const board = resolveBoard({ style: 'open_montage', panelCount: 3, whitespace: 'airy' });
    expect(board.layout).toBe('irregular');
    expect(board.koma).toBeUndefined();
  });

  it('斜切分镜没有专属档，用 irregular 承载并在 nl 里描述斜边', () => {
    const board = resolveBoard({ style: 'diagonal_panels', panelCount: 3, whitespace: 'balanced' });
    expect(board.layout).toBe('irregular');
    expect(board.diagonal).toBe(true);
    const gen = buildBoardGeneration({ style: 'diagonal_panels', panelCount: 3, whitespace: 'balanced' });
    expect(gen.nlHead).toMatch(/slanted diagonal edges/i);
  });
});

describe('boardTagsFor：构图词必须带权重、且档内不冲突', () => {
  it('inset 档：只有 multiple views + white background，没有 koma / split screen', () => {
    const tags = boardTagsFor(resolveBoard({ style: 'hero_insets', panelCount: 3, whitespace: 'airy' }));
    expect(tags).toEqual(['1.5::multiple views::', '1.4::white background::']);
    expect(tags.join(',')).not.toMatch(KOMA);
    expect(tags.join(',')).not.toMatch(/split screen/i);
  });

  it('unframed 档：中文带权重词齐全，且严禁英文分格词', () => {
    const tags = boardTagsFor(resolveBoard({ style: 'hero_insets', panelCount: 3, whitespace: 'compact' }));
    const joined = tags.join(',');
    expect(joined).toContain('3::非对称漫画页面布局::');
    expect(joined).toContain('2::无边框中央插画::');
    expect(joined).toContain('2::人物自然融入白色空间::');
    expect(joined).not.toMatch(KOMA);
    expect(joined).not.toMatch(/multiple views|split screen/i);
  });

  it('regular 三格：补 3koma，不给 2koma', () => {
    const tags = boardTagsFor(resolveBoard({ style: 'classic_grid', panelCount: 3, whitespace: 'compact' }));
    const joined = tags.join(',');
    expect(joined).toContain('1.4::3koma::');
    expect(joined).not.toContain('2koma');
    // 构图词必须带权重——裸词会被画师串淹没
    expect(joined).toMatch(/\d\.\d::/);
  });

  it('不再出现自造的空 tag', () => {
    for (const style of ['classic_grid', 'open_montage', 'diagonal_panels', 'hero_insets', 'freeform'] as const) {
      for (const whitespace of ['compact', 'airy'] as const) {
        const joined = boardTagsFor(resolveBoard({ style, panelCount: 3, whitespace })).join(',');
        expect(joined).not.toContain('comic page layout');
        expect(joined).not.toContain('panel layout');
      }
    }
  });
});

describe('enforcePanelPrompt：发送侧确定性纠偏', () => {
  it('实测 A：把 3koma 与空 tag 剥掉，保留这一档必需的 split screen', () => {
    const raw = '3koma, split screen, comic page layout, 1girl, 1boy, cowboy shot, indoors, hugging';
    const out = enforcePanelPrompt(raw, 'irregular');
    const joined = out.prompt;
    // irregular 档的合成词就是 multiple views + split screen（原版实测有效），
    // 真正要删的是与"不等格拼版"打架的 3koma
    expect(joined).not.toMatch(KOMA);
    expect(joined).not.toContain('comic page layout');
    expect(joined).toContain('1girl');
    expect(joined).toContain('cowboy shot');
    expect(joined).toContain('hugging');
    // 缺的必需词补到最前面（越靠前权重越高）
    expect(joined.startsWith('1.4::multiple views::')).toBe(true);
  });

  it('主图+特写档：模型写的 3koma 与场景词都被清掉，补 white background', () => {
    const raw = '3koma, 2girls, cowboy shot, window, sunlight from window, warm colors, leaning in';
    const out = enforcePanelPrompt(raw, 'inset');
    expect(out.prompt).not.toMatch(KOMA);
    expect(out.prompt).not.toContain('window');
    expect(out.prompt).not.toContain('sunlight from window');
    expect(out.prompt).not.toContain('warm colors');
    expect(out.prompt).toContain('1.4::white background::');
    expect(out.prompt).toContain('leaning in');
  });

  it('正则档三格：删 2koma 补 3koma', () => {
    const out = enforcePanelPrompt('1.4::2koma::, 1girl, standing', 'regular', { koma: 3 });
    expect(out.prompt).toContain('1.4::3koma::');
    expect(out.prompt).not.toContain('2koma');
    expect(out.removed.join(',')).toContain('2koma');
  });

  it('跨逗号的权重块一律保留，不撕坏提示词', () => {
    const raw = '2::大型电影式相拥构图, 富有表现力::, 1girl';
    const out = enforcePanelPrompt(raw, 'irregular');
    expect(out.prompt).toContain('2::大型电影式相拥构图, 富有表现力::');
  });

  it('空提示词不造词', () => {
    expect(enforcePanelPrompt('', 'inset').prompt).toBe('');
  });
});

describe('nl 版面句：原版措辞，且与档位一致', () => {
  it('inset 说「四周大量留白」，绝不说 narrow white margins', () => {
    const gen = buildBoardGeneration({ style: 'hero_insets', panelCount: 3, whitespace: 'airy' });
    expect(gen.nlHead).toMatch(/generous empty white space/i);
    expect(gen.nlHead).not.toMatch(/narrow white margins/i);
  });

  it('inset 说清两个特写格的位置（否则模型只画一个）', () => {
    const gen = buildBoardGeneration({ style: 'hero_insets', panelCount: 3, whitespace: 'airy' });
    expect(gen.nlHead).toMatch(/across the top/i);
    expect(gen.nlHead).toMatch(/bottom right corner/i);
    expect(gen.nlHead).not.toMatch(/one or two/i);
  });

  it('unframed A 型：顶条 20% + 主画 + 右下浮格', () => {
    const gen = buildBoardGeneration({ style: 'hero_insets', panelCount: 3, whitespace: 'compact' });
    expect(gen.panelCount).toBe(3);
    expect(gen.nlHead).toMatch(/top 20%/i);
    expect(gen.nlHead).toMatch(/main illustration fills the rest/i);
    expect(gen.nlHead).toMatch(/bottom right/i);
  });

  it('regular 三格说「一宽上格 + 两小下格」，不是 two-panel', () => {
    const gen = buildBoardGeneration({ style: 'classic_grid', panelCount: 3, whitespace: 'compact' });
    expect(gen.nlHead).toMatch(/three-panel/i);
    expect(gen.nlHead).not.toMatch(/two-panel/i);
  });

  it('irregular 三格明确「不等大」', () => {
    const gen = buildBoardGeneration({ style: 'open_montage', panelCount: 3, whitespace: 'airy' });
    expect(gen.nlHead).toMatch(/unequal size/i);
  });
});

describe('applyPanelToNl：只在模型没交代版面时补一句', () => {
  it('英文 nl 且没提版面 → 补在最前面', () => {
    const out = applyPanelToNl('two people leaning close by the window', 'A two-panel comic page.');
    expect(out.startsWith('A two-panel comic page.')).toBe(true);
  });

  it('中文 nl 不补（中文进 NAI 的 nl 通道等于噪声）', () => {
    expect(applyPanelToNl('两个人在窗边靠得很近', 'A two-panel comic page.')).toBe('两个人在窗边靠得很近');
  });

  it('已经写过 panel 就不重复', () => {
    const nl = 'In the upper panel they lean close.';
    expect(applyPanelToNl(nl, 'A two-panel comic page.')).toBe(nl);
  });

  it('「中文字符数 > 英文字母数」才算中文为主体，英文里带中文人名不误判', () => {
    expect(isMostlyChinese('叶均 and 陆子慕 talking in a corridor with soft light')).toBe(false);
    expect(isMostlyChinese('两个人在走廊里说话')).toBe(true);
  });
});

describe('reconcileHeadcount：人数词以角色块为准', () => {
  it('1boy + 1girl 却写成 2girls → 纠正为 1girl, 1boy', () => {
    const out = reconcileHeadcount('2girls, cowboy shot, indoors', ['1boy, silver hair', '1girl, brown hair']);
    expect(out).toContain('1girl');
    expect(out).toContain('1boy');
    expect(out).not.toContain('2girls');
    expect(out).toContain('cowboy shot');
  });

  it('角色块覆盖不住 Base 声称的人数时不动（否则真的会少画一个人）', () => {
    expect(reconcileHeadcount('2boys, corridor', ['1boy, white hair'])).toBe('2boys, corridor');
  });

  it('Base 没人数字时补到最前面', () => {
    expect(reconcileHeadcount('corridor, walking', ['1girl, brown hair'])).toBe('1girl, corridor, walking');
  });

  it('没有性别信息时原样返回', () => {
    expect(reconcileHeadcount('2girls, indoors', ['silver hair'])).toBe('2girls, indoors');
  });
});

describe('区域引导词：每格落在自己那一区', () => {
  it('inset 三格的顺序是 主图 → 顶部条 → 右下格', () => {
    const leads = boardAreaLeads('inset', 'auto', 3);
    expect(leads[0]).toMatch(/main illustration/i);
    expect(leads[1]).toMatch(/top/i);
    expect(leads[2]).toMatch(/bottom right/i);
  });

  it('regular 两格是上格 / 下格', () => {
    expect(boardAreaLeads('regular', 'auto', 2)).toEqual(['In the upper panel', 'The lower panel shows']);
  });
});

describe('端到端：用户这次的选择（主图+特写、固定三格、大面积留白）', () => {
  const gen = buildBoardGeneration({ style: 'hero_insets', panelCount: 3, whitespace: 'airy' });

  it('出的词里没有任何 koma / split screen，杜绝「三条等宽横带」', () => {
    const joined = gen.tags.join(',');
    expect(joined).not.toMatch(KOMA);
    expect(joined).not.toMatch(/split screen/i);
    expect(joined).not.toMatch(/comic page layout|panel layout/i);
  });

  it('构图词带权重，且锁定白底 + 多视角', () => {
    expect(gen.tags).toContain('1.5::multiple views::');
    expect(gen.tags).toContain('1.4::white background::');
  });

  it('nl 说清「白底居中主图 + 四周留白 + 顶部条 + 右下格」', () => {
    expect(gen.nlHead).toMatch(/white background/i);
    expect(gen.nlHead).toMatch(/generous empty white space/i);
    expect(gen.nlHead).toMatch(/center/i);
    expect(gen.nlHead).toMatch(/across the top/i);
    expect(gen.nlHead).toMatch(/bottom right corner/i);
  });
});
