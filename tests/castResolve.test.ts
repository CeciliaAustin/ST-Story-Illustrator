/**
 * 「Base 说两个人，画面却只有 char」的回归测试。
 *
 * 用户实测：漫画页正向词写着 two people / couple dining，角色块却只有 Elias，
 * 画出来永远只有一个人。根因有三层，这里逐一锁住：
 * 1. 「你 / User」这类写法不在角色库里 → 被当成查不到的人丢掉；
 * 2. Base 的人数词是英文数词或 couple，只认数字时人数体检直接跳过；
 * 3. 人设不给外貌（look）时，代码补不出第二块，只能靠重问模型。
 */

import { describe, it, expect } from 'vitest';
import type { BaiBaiCharacter, ComicPagePlan } from '../src/types';
import { resolveCastNames, characterTagOf } from '../src/manga/tagSplit';
import { declaredPeople } from '../src/manga/peopleCount';
import { composePagePrompt, findCastShortfall, panelNlBody } from '../src/manga/pageCompose';

const elias: BaiBaiCharacter = {
  name: 'Elias',
  tag: '1boy, short messy blond hair, emerald green eyes',
} as BaiBaiCharacter;

const sissy: BaiBaiCharacter = {
  name: 'Sissy',
  tag: '1girl, long black hair, brown eyes',
} as BaiBaiCharacter;

function page(partial: Partial<ComicPagePlan> = {}): ComicPagePlan {
  return {
    pageIndex: 0,
    title: '露台午餐',
    layout: 'regular',
    tags: 'two people at restaurant terrace table, couple dining, cowboy shot',
    panels: [
      {
        index: 0,
        title: '递餐巾',
        characters: [
          { name: 'Elias', act: 'leaning forward, pointing at his own lower lip' },
          { name: '你', act: 'holding a small silver spoon' },
        ],
        mood: '',
        tags: '',
      },
      {
        index: 1,
        title: '擦嘴角',
        characters: [{ name: '你', act: 'wiping the corner of her mouth with a napkin' }],
        mood: '',
        tags: '',
      },
    ],
    ...partial,
  };
}

describe('declaredPeople', () => {
  it('数字写法照旧', () => {
    expect(declaredPeople('1girl, 1boy, cafe')).toBe(2);
    expect(declaredPeople('2people, classroom')).toBe(2);
  });

  it('英文数词与 couple 也要认（用户那张图写的就是 two people / couple dining）', () => {
    expect(declaredPeople('two people at restaurant terrace table')).toBe(2);
    expect(declaredPeople('a couple dining, restaurant terrace')).toBe(2);
    expect(declaredPeople('three people walking')).toBe(3);
  });

  it('没有人数词就是 0（不瞎猜）', () => {
    expect(declaredPeople('cowboy shot, restaurant terrace, warm light')).toBe(0);
  });
});

describe('resolveCastNames', () => {
  it('「你」映射到人设名，并且只留一条', () => {
    const out = resolveCastNames(['Elias', '你'], [elias, sissy], { personaName: 'Sissy' });
    expect(out.cast).toEqual(['Elias', 'Sissy']);
  });

  it('人设名与库条目只差一个后缀时也认（Sissy Hu → Sissy）', () => {
    const out = resolveCastNames(['你'], [sissy], { personaName: 'Sissy Hu' });
    expect(out.cast).toEqual(['Sissy']);
  });

  it('模型只写了 Elias，但 Base 说两人 → 自动补人设', () => {
    const out = resolveCastNames(['Elias'], [elias, sissy], { personaName: 'Sissy', declared: 2 });
    expect(out.cast).toEqual(['Elias', 'Sissy']);
  });

  it('Base 只说 1 人时不硬塞第二个人', () => {
    const out = resolveCastNames(['Elias'], [elias, sissy], { personaName: 'Sissy', declared: 1 });
    expect(out.cast).toEqual(['Elias']);
  });

  it('人设不在库里、但模型给了别名的 look → look 搬到人设名下', () => {
    const out = resolveCastNames(['Elias', '你'], [elias], {
      personaName: 'Sissy',
      declared: 2,
      looks: new Map([['你', '1girl, long black hair']]),
    });
    expect(out.cast).toEqual(['Elias', 'Sissy']);
    expect(out.looks.get('Sissy')).toBe('1girl, long black hair');
  });

  it('库里只有固定两人且 Base 说两人 → 缺的那位补上', () => {
    const out = resolveCastNames(['Elias'], [elias, sissy], { declared: 2 });
    expect(out.cast).toEqual(['Elias', 'Sissy']);
  });
});

describe('composePagePrompt：两个人就要两块角色词', () => {
  it('「你」被换成库里的人设名，Base 不再糊外貌', () => {
    const composed = composePagePrompt(page(), [elias, sissy], { personaName: 'Sissy' });
    expect(composed.characters.map(c => c.name)).toEqual(['Elias', 'Sissy']);
    expect(composed.prompt).not.toContain('blond hair');
    expect(composed.characters[0].tag).toContain('blond hair');
  });

  it('多格页不把各格动作并进角色块（并进去 = 两格拿到同一串动作 = 画出来一样）', () => {
    const composed = composePagePrompt(page(), [elias, sissy], { personaName: 'Sissy' });
    expect(composed.characters[0].tag).not.toContain('pointing at his own lower lip');
    expect(composed.characters[1].tag).not.toContain('holding a small silver spoon');
    // 动作改由各格自己的 nl 承担
    expect(composed.nl).toContain('pointing at his own lower lip');
    expect(composed.nl).toContain('wiping the corner of her mouth');
  });

  it('单格页仍然把动作并进角色块（没有分格 nl 可写）', () => {
    const p = page({
      panels: [
        {
          index: 0,
          title: '',
          characters: [{ name: 'Elias', act: 'leaning across the table' }],
          mood: '',
          tags: '',
        },
      ],
      tags: '1boy, restaurant terrace, leaning across the table',
    });
    const composed = composePagePrompt(p, [elias], { personaName: 'Sissy' });
    expect(composed.characters[0].tag).toContain('leaning across the table');
  });

  it('模型只给一个人时，按 Base 人数补齐（这是「永远只有 char」的正解）', () => {
    const p = page({
      panels: [
        {
          index: 0,
          title: '',
          characters: [{ name: 'Elias', act: 'leaning across the table' }],
          mood: '',
          tags: '',
        },
      ],
    });
    const composed = composePagePrompt(p, [elias, sissy], { personaName: 'Sissy' });
    expect(composed.characters).toHaveLength(2);
  });

  it('同一格明确两人同框、其中一人无外貌 → 体检指到具体页', () => {
    const p = page({
      panels: [
        {
          index: 0,
          title: '',
          // 这一格明确写了 Elias +「你」两人同框
          characters: [
            { name: 'Elias', act: 'leaning across the table' },
            { name: '你', act: 'holding a small silver spoon' },
          ],
          mood: '',
          tags: '',
        },
      ],
    });
    // 库里只有 Elias，人设不在库、也没 look → 同框的第二块补不出来
    const gap = findCastShortfall([p], [elias], { personaName: 'Sissy' });
    expect(gap).toEqual({ pageIndex: 0, title: '露台午餐', declared: 2, blocks: 1 });
  });

  it('单人格 / 局部格即使页级人数词写着两人也不报（任务书 §3.3：不许强制每格同人）', () => {
    const p = page({
      panels: [
        { index: 0, title: '', characters: [{ name: 'Elias', act: 'close-up of his eyes' }], mood: '', tags: '' },
      ],
    });
    expect(findCastShortfall([p], [elias], { personaName: 'Sissy' })).toBeNull();
  });

  it('同框两人都有库条目时体检通过', () => {
    const p = page({
      panels: [
        {
          index: 0,
          title: '',
          characters: [
            { name: 'Elias', act: 'leaning across the table' },
            { name: 'Sissy', act: 'holding a small silver spoon' },
          ],
          mood: '',
          tags: '',
        },
      ],
    });
    expect(findCastShortfall([p], [elias, sissy], { personaName: 'Sissy' })).toBeNull();
  });
});

describe('panelNlBody：每格都要有可画的信息', () => {
  it('模型写了 nl 时保留，并把 shot 补在最前', () => {
    const body = panelNlBody({
      index: 0, title: '', characters: [], mood: '', tags: '',
      shot: 'close-up',
      nl: 'Elias leans across the table, right hand raised.',
    });
    expect(body).toBe('close-up: Elias leans across the table, right hand raised.');
  });

  it('没有 nl 时用 shot + 英文动作兜底（中文 subject 不进 nl）', () => {
    const body = panelNlBody({
      index: 0, title: '', characters: [{ name: 'Elias', act: 'holding the napkin' }], mood: '', tags: '',
      shot: 'wide shot',
      subject: '两人隔着甜点桌对坐，右侧留出空椅',
    });
    expect(body).toBe('wide shot: Elias holding the napkin');
    expect(body).not.toContain('空椅');
  });

  it('只剩景别时也要和上一格区分开', () => {
    expect(panelNlBody({
      index: 0, title: '', characters: [], mood: '', tags: '', shot: 'extreme close-up',
    })).toBe('extreme close-up');
  });
});

describe('characterTagOf 仍然是单一来源', () => {
  it('分字段优先', () => {
    expect(characterTagOf({
      name: 'x',
      tag: 'raw',
      fields: { sex: '1girl', hair: 'long black hair' },
    } as BaiBaiCharacter)).toBe('1girl, long black hair');
  });
});
