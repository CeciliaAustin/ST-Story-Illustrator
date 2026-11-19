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

  it('各格没有 nl 时退回按标题列顺序，不产生空句', () => {
    const nl = buildPageNl(page());
    expect(nl).toContain('勾肩回宿舍 / 门口看见乱床');
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
  it('页级 tags 优先，并补上角色库外貌', () => {
    const p = page({ tags: '2boys, corridor, walking' });
    const out = composePagePrompt(p, library);
    expect(out.prompt).toContain('2boys');
    expect(out.prompt).toContain('white hair');
    expect(out.nl).toContain('A two-panel comic page');
  });

  it('没有页级 tags 时合并各格，且不会把外貌写两遍', () => {
    const p = page({
      panels: [
        { index: 0, title: '', characters: [{ name: '五条悟', act: '' }], mood: '', tags: '1boy, white hair' },
        { index: 1, title: '', characters: [{ name: '五条悟', act: '' }], mood: '', tags: '1boy, smile' },
      ],
    });
    const out = composePagePrompt(p, library);
    expect(out.prompt).toBe('1boy, white hair, smile, sunglasses');
  });

  it('页级 nl 存在时原样使用（不再拼兜底句）', () => {
    const p = page({ nl: 'A custom layout sentence. In the upper panel, something.' });
    expect(composePagePrompt(p, library).nl).toBe('A custom layout sentence. In the upper panel, something.');
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
