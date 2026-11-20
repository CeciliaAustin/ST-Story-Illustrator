import { describe, it, expect } from 'vitest';
import {
  composePagePrompt,
  mergePanelTags,
  buildPageNl,
  collectPageDialogue,
} from '../src/manga/pageCompose';
import { hasStoryContent } from '../src/manga/panelRelevance';
import type { ComicPagePlan, BaiBaiCharacter } from '../src/types';

function page(partial: Partial<ComicPagePlan> = {}): ComicPagePlan {
  return {
    pageIndex: 0,
    title: '换床单',
    layout: 'regular',
    panels: [
      { index: 0, title: '勾肩回宿舍', characters: [{ name: '五条悟', act: '勾肩' }], mood: '', tags: '' },
      { index: 1, title: '门口看见乱床', characters: [{ name: '五条悟', act: '开门' }], mood: '', tags: '' },
    ],
    ...partial,
  };
}

const library: BaiBaiCharacter[] = [
  { name: '五条悟', tag: '1boy, white hair, sunglasses' } as BaiBaiCharacter,
];

describe('mergePanelTags', () => {
  it('按裸词去重，保留第一次出现的权重写法', () => {
    const p = page({
      panels: [
        { index: 0, title: '', characters: [], mood: '', tags: '1.4::multiple views::, 2boys, indoors' },
        { index: 1, title: '', characters: [], mood: '', tags: 'multiple views, 2boys, cowboy shot' },
      ],
    });
    expect(mergePanelTags(p)).toBe('1.4::multiple views::, 2boys, indoors, cowboy shot');
  });
});

describe('buildPageNl', () => {
  it('先总述版面，再按格用上/下格句式分区', () => {
    const p = page();
    p.panels[0].nl = 'two boys walk shoulder to shoulder down a corridor';
    p.panels[1].nl = 'one boy pushes the door open, the room is a mess';
    const nl = buildPageNl(p);
    expect(nl).toContain('A two-panel comic page');
    expect(nl).toContain('In the upper panel, two boys walk shoulder to shoulder');
    expect(nl).toContain('The lower panel shows one boy pushes the door open');
  });

  it('各格没有 nl 时退回标题/动作，并且留白句必须写出来', () => {
    const nl = buildPageNl(page());
    // 没有 nl 也不能空句：用 act / title 兜底，并按分区引导词落到对应格
    expect(nl).toContain('五条悟 勾肩');
    expect(nl).toContain('五条悟 开门');
    // 用户点名过的「空白处没了」：留白必须是独立一句，且用主次+负空间措辞
    //（任务书删掉了旧的「窄 gutter/九成覆盖」满版规则）
    expect(nl).toMatch(/negative space|empty|hero image/i);
  });
});

describe('collectPageDialogue', () => {
  it('页级台词优先', () => {
    const p = page({ dialogue: [{ text: '让开' }] });
    p.panels[0].dialogue = [{ text: '格里的' }];
    expect(collectPageDialogue(p)).toEqual([{ text: '让开' }]);
  });

  it('没有页级台词时从各格合并，最多 4 条', () => {
    const p = page();
    p.panels[0].dialogue = [{ text: 'a' }, { text: 'b' }, { text: 'c' }];
    p.panels[1].dialogue = [{ text: 'd' }, { text: 'e' }];
    expect(collectPageDialogue(p).map(d => d.text)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('composePagePrompt', () => {
  it('页级 tags 只做 Base，角色外貌走 characters（不再并进 Base）', () => {
    const p = page({ tags: '2boys, corridor, walking' });
    const out = composePagePrompt(p, library, { nativeCharacters: true });
    expect(out.prompt).toBe('2boys, corridor, walking');
    // 外貌在各自那一块，Base 里一个外貌词都不该有
    expect(out.prompt).not.toContain('white hair');
    expect(out.characters).toHaveLength(1);
    expect(out.characters[0].name).toBe('五条悟');
    expect(out.characters[0].tag).toContain('white hair');
    expect(out.nl).toContain('A two-panel comic page');
  });

  it('后端不支持原生角色通道时退回合并（否则外貌会整个丢）', () => {
    const p = page({ tags: '2boys, corridor, walking' });
    const out = composePagePrompt(p, library, { nativeCharacters: false });
    expect(out.prompt).toContain('white hair');
    expect(out.characters).toEqual([]);
  });

  it('没有页级 tags 时合并各格，角色外貌仍单独成块', () => {
    const p = page({
      panels: [
        { index: 0, title: '', characters: [{ name: '五条悟', act: '' }], mood: '', tags: '1boy, white hair' },
        { index: 1, title: '', characters: [{ name: '五条悟', act: '' }], mood: '', tags: '1boy, smile' },
      ],
    });
    const out = composePagePrompt(p, library, { nativeCharacters: true });
    expect(out.prompt).toBe('1boy, white hair, smile');
    expect(out.characters[0].tag).toContain('white hair');
    expect(out.characters[0].tag).toContain('sunglasses');
  });

  it('页级 nl 存在时原样用，只在缺留白说法时补一句留白/负空间', () => {
    const p = page({ nl: 'A custom layout sentence. In the upper panel, something.' });
    const nl = composePagePrompt(p, library).nl;
    expect(nl.startsWith('A custom layout sentence. In the upper panel, something.')).toBe(true);
    expect(nl).toMatch(/negative space|empty|hero image/i);
  });

  it('页级 nl 自己写了 gutter 时不重复追加', () => {
    const p = page({ nl: 'Two panels with a thin white gutter between them.' });
    expect(composePagePrompt(p, library).nl).toBe('Two panels with a thin white gutter between them.');
  });

  it('模型漏写 panels[].characters 时也要补出角色块（否则外貌只能并回 Base）', () => {
    // 这就是用户截图那一页：page.tags 里全是外貌词，characters 一个都没写
    const p = page({
      tags: '1girl, 1boy, sitting across from each other, white tablecloth, holding open menu',
      panels: [
        { index: 0, title: '', characters: [], mood: '', tags: '1girl, 1boy, sitting' },
        { index: 1, title: '', characters: [], mood: '', tags: '1girl, smile' },
      ],
    });
    const cast: BaiBaiCharacter[] = [
      { name: '小雪', tag: '1girl, long brown hair, wine red eyes' } as BaiBaiCharacter,
      { name: '柏宝', tag: '1boy, short blond hair, emerald green eyes' } as BaiBaiCharacter,
    ];
    const out = composePagePrompt(p, cast, { nativeCharacters: true, selectedText: '小雪与柏宝对坐' });
    expect(out.characters).toHaveLength(2);
    expect(out.characters.map(c => c.name)).toEqual(['小雪', '柏宝']);
    // Base 一个字都不许动：外貌已经各自归位
    expect(out.prompt).toBe(p.tags);
  });

  it('补人时优先补本页正文里点名的人，而不是库里排在前面的', () => {
    const p = page({ tags: '2boys, corridor', panels: [{ index: 0, title: '', characters: [], mood: '', tags: '' }] });
    const cast: BaiBaiCharacter[] = [
      { name: '路人', tag: '1boy, black hair' } as BaiBaiCharacter,
      { name: '柏宝', tag: '1boy, blond hair' } as BaiBaiCharacter,
      { name: '第三个人', tag: '1boy, red hair' } as BaiBaiCharacter,
    ];
    const out = composePagePrompt(p, cast, { nativeCharacters: true, selectedText: '柏宝推门进来' });
    expect(out.characters.map(c => c.name)).toEqual(['柏宝']);
  });

  it('库里只有一个人（单主角固定阵容）时，即使正文没点名也带上', () => {
    const p = page({ tags: '1girl, classroom, sitting', panels: [{ index: 0, title: '', characters: [], mood: '', tags: '' }] });
    const out = composePagePrompt(p, library, { nativeCharacters: true, selectedText: '' });
    // library 里是五条悟（1boy），页级写的是 1girl——名字对不上就不该硬塞
    expect(out.characters.map(c => c.name)).toEqual(['五条悟']);
  });

  it('模型写了三个人就三个都留着（宁可多一块，也不要有人没外貌）', () => {
    const p = page({
      tags: '3boys, room',
      panels: [
        {
          index: 0,
          title: '',
          characters: [{ name: 'A', act: '' }, { name: 'B', act: '' }, { name: 'C', act: '' }],
          mood: '',
          tags: '',
        },
      ],
    });
    const cast: BaiBaiCharacter[] = ['A', 'B', 'C'].map(name => ({ name, tag: `1boy, ${name} hair` }) as BaiBaiCharacter);
    expect(composePagePrompt(p, cast).characters.map(c => c.name)).toEqual(['A', 'B', 'C']);
  });

  it('代码自己补人时最多补 2 位（不把库里的路人甲乙也塞进画面）', () => {
    const p = page({ tags: '2girls, room', panels: [{ index: 0, title: '', characters: [], mood: '', tags: '' }] });
    const cast: BaiBaiCharacter[] = ['甲', '乙', '丙'].map(name => ({ name, tag: `1girl, ${name} hair` }) as BaiBaiCharacter);
    const out = composePagePrompt(p, cast, { nativeCharacters: true, selectedText: '甲、乙、丙三个人都在' });
    expect(out.characters.map(c => c.name)).toEqual(['甲', '乙']);
  });
});

describe('hasStoryContent（页级）', () => {
  it('页级 tags 有内容即通过', () => {
    expect(hasStoryContent([page({ tags: '2boys, corridor, walking, holding hands' })])).toBe(true);
  });

  it('页级 tags 只有构图词不通过', () => {
    expect(hasStoryContent([page({ tags: '1.4::multiple views::, split screen, white background' })])).toBe(false);
  });
});
