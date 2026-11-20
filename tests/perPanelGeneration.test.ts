import { describe, it, expect } from 'vitest';
import { pageSlotsFor, slotsOverlap, PAGE_HEIGHT, PAGE_WIDTH } from '../src/manga/pageSlots';
import { buildPanelShots, cleanSceneTags, cleanPanelNl } from '../src/manga/panelShot';
import { coverRect } from '../src/manga/pageAssemble';
import { buildPanelRule } from '../src/manga/panelPlan';
import { buildComicSystemPrompt } from '../src/manga/planPrompts';
import { reconcileDialogueDetailed } from '../src/manga/sourceDialogue';
import { artifactSlotsOf } from '../src/manga/bubbleOverlay';
import type { BaiBaiCharacter, ComicPagePlan } from '../src/types';

const YJ: BaiBaiCharacter = {
  name: '叶均',
  tag: '1boy, handsome, asian, short silver white hair, grey eyes',
  fields: { outfit: 'dark charcoal patterned shirt, rolled-up sleeves' },
};
const LZM: BaiBaiCharacter = {
  name: '陆子慕',
  tag: '1girl, very beautiful, wavy brown hair, wine red eyes',
  fields: { outfit: 'cream white wool coat, low-cut knit sweater' },
};

/** 用户这次实测那一页：主图+特写、固定三格、大面积留白 */
const PAGE: ComicPagePlan = {
  pageIndex: 0,
  title: '耳语',
  layout: 'inset',
  // 模型很可能把版面词和场景一起写进来——代码必须把版面词剥掉、把场景留下
  tags: '1.5::multiple views::, 1.4::white background::, 1boy, 1girl, couple, height gap, '
    + 'hand on cheek, cupping face, luxury boutique, fitting room, warm lighting, soft shadow',
  panels: [
    {
      index: 0,
      title: '主图',
      shot: 'upper body',
      nl: 'in the boutique fitting room, he cups her cheek and tilts her chin up',
      characters: [
        { name: '叶均', act: 'hand on her cheek' },
        { name: '陆子慕', act: 'looking up' },
      ],
    },
    {
      index: 1,
      title: '脸',
      shot: 'close-up',
      nl: 'in the main illustration, close-up of her blushing face',
      characters: [{ name: '陆子慕', act: 'blushing, parted lips' }],
    },
    {
      index: 2,
      title: '手',
      shot: 'extreme close-up',
      nl: 'in the small framed panel, his thumb against her lower lip',
      characters: [{ name: '叶均', act: 'thumb on her lip' }],
    },
  ],
  cast: [],
};

const LIB = [YJ, LZM];

function shotsFor(page: ComicPagePlan = PAGE, count = 3) {
  const slots = pageSlotsFor('inset', count, { whitespace: 'airy' });
  return buildPanelShots(page, slots, LIB, { personaName: '' });
}

describe('pageSlotsFor — 格子由代码排，格数不再靠模型', () => {
  it('要三格就一定是三格，且每个格位都在页内', () => {
    for (const layout of ['regular', 'irregular', 'inset', 'unframed'] as const) {
      const slots = pageSlotsFor(layout, 3);
      expect(slots).toHaveLength(3);
      expect(slots.map(s => s.panelIndex)).toEqual([0, 1, 2]);
      for (const slot of slots) {
        expect(slot.x).toBeGreaterThanOrEqual(0);
        expect(slot.y).toBeGreaterThanOrEqual(0);
        expect(slot.x + slot.width).toBeLessThanOrEqual(1.0001);
        expect(slot.y + slot.height).toBeLessThanOrEqual(1.0001);
        expect(slot.width).toBeGreaterThan(0);
        expect(slot.height).toBeGreaterThan(0);
      }
    }
  });

  it('主图 + 特写：主图不贴页边（留白在框外），特写格带框且不与主图重叠', () => {
    const slots = pageSlotsFor('inset', 3, { whitespace: 'airy' });
    const main = slots[0];
    expect(main.border).toBe('none');
    // 框外留白：主图四边都不贴到页面边缘
    expect(main.x).toBeGreaterThan(0.03);
    expect(main.y).toBeGreaterThan(0.02);
    expect(main.x + main.width).toBeLessThan(0.97);
    expect(main.y + main.height).toBeLessThan(0.96);

    const insets = slots.slice(1);
    expect(insets.every(s => s.border === 'thin')).toBe(true);
    for (const inset of insets) {
      expect(slotsOverlap(main, inset)).toBe(false);
      for (const other of insets) {
        if (other === inset) continue;
        expect(slotsOverlap(inset, other)).toBe(false);
      }
    }
  });

  it('主格面积最大（主次分明，不是等分条带）', () => {
    const slots = pageSlotsFor('inset', 3);
    const area = (s: { width: number; height: number }) => s.width * s.height;
    expect(area(slots[0])).toBeGreaterThan(area(slots[1]));
    expect(area(slots[0])).toBeGreaterThan(area(slots[2]));
    // 传统四格的等分是这一档的正常形态，但也不该出现"整页只有一条"
    const regular = pageSlotsFor('regular', 3);
    expect(regular[0].width).toBeGreaterThan(regular[0].height);
  });

  it('格数超过该档容量也不会重叠（多出来的并进最后一格）', () => {
    const slots = pageSlotsFor('inset', 6);
    expect(slots).toHaveLength(6);
    const first = slots[0];
    for (const slot of slots.slice(1)) {
      expect(slotsOverlap(first, slot)).toBe(false);
    }
  });

  it('输出画布尺寸是竖版', () => {
    expect(PAGE_HEIGHT).toBeGreaterThan(PAGE_WIDTH);
  });
});

describe('buildPanelShots — 每格一张完整插画', () => {
  it('逐格词里绝不出现版面词（白底/koma/multiple views）', () => {
    for (const shot of shotsFor()) {
      const text = `${shot.prompt} ${shot.nl}`.toLowerCase();
      expect(text).not.toContain('white background');
      expect(text).not.toContain('multiple views');
      expect(text).not.toContain('split screen');
      expect(text).not.toMatch(/\d+\s*koma/);
      expect(text).not.toContain('comic page');
      expect(text).not.toContain('panel layout');
    }
  });

  it('每格都保留自己的场景（框内不许变成大白底）', () => {
    for (const shot of shotsFor()) {
      expect(shot.prompt).toContain('luxury boutique');
      expect(shot.prompt).toContain('warm lighting');
    }
  });

  it('每格只带这一格入镜的人，人数词按角色块重算', () => {
    const shots = shotsFor();
    expect(shots[0].characters.map(c => c.name)).toEqual(['叶均', '陆子慕']);
    expect(shots[0].prompt).toContain('1boy');
    expect(shots[0].prompt).toContain('1girl');

    // 单人特写格不能因为页级 1boy+1girl 就写两个人
    expect(shots[1].characters.map(c => c.name)).toEqual(['陆子慕']);
    expect(shots[1].prompt).toContain('1girl');
    expect(shots[1].prompt).not.toContain('1boy');
  });

  it('角色块带着装（与柏宝绘同一套衣服）', () => {
    const shots = shotsFor();
    const yj = shots[0].characters.find(c => c.name === '叶均');
    expect(yj?.tag).toContain('dark charcoal patterned shirt');
  });

  it('格 nl 去掉「In the main illustration」这类页级指代', () => {
    const shots = shotsFor();
    expect(shots[1].nl.toLowerCase()).not.toContain('main illustration');
    expect(shots[2].nl.toLowerCase()).not.toContain('framed panel');
    expect(shots[1].nl).toContain('close-up of her blushing face');
  });

  it('没有场景词的页会如实暴露（不偷偷补白底）', () => {
    const bare: ComicPagePlan = {
      ...PAGE,
      tags: '1.4::white background::, 1boy, 1girl',
    };
    const shots = shotsFor(bare);
    expect(shots.every(s => !/background/i.test(s.prompt))).toBe(true);
  });
});

describe('cleanSceneTags / cleanPanelNl', () => {
  it('剥版面词、剥人数词，保留场景与互动', () => {
    const out = cleanSceneTags('3koma, split screen, 1girl, 1boy, couple, boutique, warm lighting');
    expect(out).toEqual(['boutique', 'warm lighting']);
  });

  it('页级指代从句子里删掉，但内容保留', () => {
    expect(cleanPanelNl({ index: 0, title: '', shot: '', nl: 'in the top strip, close-up of his eyes' }))
      .toBe('close-up of his eyes');
  });
});

describe('coverRect — 裁切不切头', () => {
  it('竖图放进横格：从上方锚点裁', () => {
    const rect = coverRect(832, 1216, 400, 200);
    expect(rect.width).toBe(832);
    expect(rect.height).toBeCloseTo(416, 0);
    // 锚点偏上：上方留的余量少于下方
    expect(rect.y).toBeLessThan((1216 - rect.height) / 2);
  });

  it('横图放进竖格：左右对称裁', () => {
    const rect = coverRect(1216, 832, 300, 600);
    expect(rect.height).toBe(832);
    expect(rect.x).toBeCloseTo((1216 - rect.width) / 2, 1);
  });
});

describe('规划层 — 逐格模式不再下发页级构图词', () => {
  const rule = buildPanelRule(true, {
    perPanel: true,
    panelsPerPage: 3,
    nl: true,
    layout: 'auto',
  });

  it('规则里明确禁止版面词，并要求每格自带场景', () => {
    expect(rule).toContain('绝对不要写版面/分格词');
    expect(rule).toContain('每一格都必须自带完整场景');
    expect(rule).toContain('每页固定 3 格');
    // 旧版"必须照抄构图词"的指令必须消失
    expect(rule).not.toContain('构图词必须按');
  });

  it('system prompt 里不再出现 koma / white background 指令词', () => {
    const prompt = buildComicSystemPrompt({
      panelMode: true,
      panelLayout: 'auto',
      pageType: 'auto',
      dialogue: true,
      dialoguePolicy: 'auto',
      dialogueMode: 'json',
      nl: true,
      backend: 'nai',
      charPrompts: true,
      includeChinese: false,
      maxPages: 1,
      panelsPerPage: 3,
      perPanel: true,
    });
    expect(prompt).not.toContain('1.4::multiple views::');
    expect(prompt).not.toContain('1.4::white background::');
    expect(prompt).toContain('每一格由代码**单独出一张图**');
  });
});

describe('台词 — 不能再整页消失', () => {
  it('选段里抽不到引号台词时保留模型稿（总比没有字好）', () => {
    const result = reconcileDialogueDetailed(
      [{ text: '别动。' }, { text: '否则歪了。' }],
      [],
    );
    expect(result.noSource).toBe(true);
    expect(result.dialogue.map(d => d.text)).toEqual(['别动。', '否则歪了。']);
  });

  it('只差标点也认作同一句（回填原文）', () => {
    const result = reconcileDialogueDetailed(
      [{ text: '别动 否则歪了' }],
      [{ index: 0, text: '别动，否则歪了。' }],
    );
    expect(result.restored).toBe(1);
    expect(result.dialogue[0].text).toBe('别动，否则歪了。');
  });

  it('真改写了才丢，并计数', () => {
    const result = reconcileDialogueDetailed(
      [{ text: '你快走' }],
      [{ index: 0, text: '别动，否则歪了。' }],
    );
    expect(result.dialogue).toHaveLength(0);
    expect(result.dropped).toBe(1);
  });
});

describe('显示层 — 气泡按合成用的格位落位', () => {
  it('有 pageSlots 时优先用它，而不是按 layout+count 猜', () => {
    const slots = pageSlotsFor('inset', 3, { whitespace: 'airy' });
    const artifact = {
      id: 'a', taskId: 't', mode: 'comic', chatId: 'c', sourceFloors: [1],
      mountMode: 'inline', pageIndex: 0, imagePath: 'user/images/x.png',
      prompt: '', createdAt: 0,
      metadata: { layout: 'inset', panelCount: 3, pageSlots: slots },
    } as never;
    const got = artifactSlotsOf(artifact);
    expect(got).toHaveLength(3);
    expect(got[0].x).toBeCloseTo(slots[0].x, 5);
    expect(got[2].y).toBeCloseTo(slots[2].y, 5);
  });
});
