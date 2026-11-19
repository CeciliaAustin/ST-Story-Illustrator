import { describe, it, expect } from 'vitest';
import {
  contentTagCount,
  hasStoryContent,
  mergeCharacterTags,
} from '../src/manga/panelRelevance';
import type { ComicPagePlan, BaiBaiCharacter } from '../src/types';

function page(tagsList: string[]): ComicPagePlan {
  return {
    pageIndex: 0,
    title: 'p',
    layout: 'regular',
    panels: tagsList.map((tags, i) => ({
      index: i,
      title: `p${i}`,
      characters: [],
      mood: '',
      tags,
    })),
  };
}

describe('contentTagCount', () => {
  it('只数画面内容词，构图词不算', () => {
    expect(contentTagCount('multiple views, split screen, white background')).toBe(0);
    expect(contentTagCount('1.4::multiple views::, 1.4::2koma::')).toBe(0);
    expect(contentTagCount('multiple views, 1girl, holding a letter')).toBe(2);
  });
});

describe('hasStoryContent', () => {
  it('全是构图词 → false（这时的图必然与剧情无关）', () => {
    expect(hasStoryContent([page(['multiple views, split screen', 'white background'])])).toBe(false);
  });

  it('有一格写出人和动作 → true', () => {
    expect(hasStoryContent([page([
      'multiple views, split screen',
      '1boy, leaning over a desk, holding a letter, classroom',
    ])])).toBe(true);
  });

  it('一格一个内容词不够（像是随手塞的），要 >= 2', () => {
    expect(hasStoryContent([page(['multiple views, 1girl'])])).toBe(false);
  });

  it('空计划 → false', () => {
    expect(hasStoryContent([])).toBe(false);
  });
});

describe('mergeCharacterTags', () => {
  const library: BaiBaiCharacter[] = [
    {
      name: '阿黛尔',
      tag: '1girl, short silver hair, blue eyes, black coat',
      fields: {} as BaiBaiCharacter['fields'],
      nl: '',
      source: 'manual',
      scope: 'chat',
      desc: '',
    } as BaiBaiCharacter,
  ];

  it('模型点名了角色但漏写外观 → 补上角色库那串', () => {
    const merged = mergeCharacterTags('multiple views, holding a letter', ['阿黛尔'], library);
    expect(merged).toContain('short silver hair');
    expect(merged).toContain('black coat');
  });

  it('已有裸词不重复追加（忽略权重写法差异）', () => {
    const merged = mergeCharacterTags('1girl, 1.5::blue eyes::', ['阿黛尔'], library);
    expect(merged.match(/blue eyes/g)?.length).toBe(1);
    expect(merged).toContain('short silver hair');
  });

  it('一个角色都没点名、场上只有一个人 → 补这一个人', () => {
    expect(mergeCharacterTags('classroom', [], library)).toContain('silver hair');
  });

  it('多个角色但都没点名 → 不猜，原样返回', () => {
    const two = [...library, { ...library[0], name: '别人', tag: '1boy, blond hair' }];
    expect(mergeCharacterTags('classroom', [], two)).toBe('classroom');
  });

  it('角色库为空 → 原样返回', () => {
    expect(mergeCharacterTags('classroom', ['阿黛尔'], [])).toBe('classroom');
  });
});
