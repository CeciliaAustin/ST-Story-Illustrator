/**
 * 逐格出图的「角色块兜底」——用户实测那一楼（正文漫画，角色库一栏全空）。
 *
 * 现场证据：正向词只有场景与服装
 *   `room interior, ceiling vent, ..., 1girl, white shearling coat, ..., 1boy, grey charcoal striped shirt, ...`
 * 一个发色、瞳色、发型都没有。柏宝绘的日志直接写了「这次没有带上任何角色外貌」。
 *
 * 根因：模型的 `panels[].characters` 常是空的（它把「谁在格子里」写进了中文 subject）。
 * 页级出图有 `ensurePageCast` 兜底，逐格出图没有——格上没名字，这一格就建不出角色块。
 */

import { describe, it, expect } from 'vitest';
import { buildPanelShots } from '../src/manga/panelShot';
import { pageSlotsFor } from '../src/manga/pageSlots';
import type { BaiBaiCharacter, ComicPagePlan, ComicPanelPlan } from '../src/types';

const YJ: BaiBaiCharacter = {
  name: '叶均',
  tag: '1boy, asian, short silver white hair, grey eyes',
  fields: { outfit: 'charcoal striped shirt, sleeves rolled' },
};
const LZM: BaiBaiCharacter = {
  name: '陆子慕',
  tag: '1girl, wavy brown hair, wine red eyes',
  fields: { outfit: 'white shearling coat, black turtleneck' },
};

function panel(partial: Partial<ComicPanelPlan>): ComicPanelPlan {
  return {
    index: 0,
    title: '',
    characters: [],
    mood: '',
    tags: '',
    ...partial,
  };
}

function page(panels: ComicPanelPlan[], tags = '1girl, 1boy, living room, sofa, warm light'): ComicPagePlan {
  return {
    pageIndex: 0,
    title: '耳语',
    layout: 'regular',
    tags,
    panels,
    cast: [],
    outfits: [
      { name: '叶均', outfit: 'charcoal striped shirt, sleeves rolled' },
      { name: '陆子慕', outfit: 'white shearling coat, black turtleneck' },
    ],
  };
}

const SLOTS = pageSlotsFor('regular', 2);

describe('逐格出图：模型漏写 characters 时的角色块兜底', () => {
  it('整页一格都没点名 → 每格都带上角色库外貌（不再是只有场景+衣服）', () => {
    const shots = buildPanelShots(
      page([
        panel({ index: 0, shot: 'medium shot', nl: 'he whispers behind her' }),
        panel({ index: 1, shot: 'extreme close-up', nl: 'two fingers on a ribbon handle' }),
      ]),
      SLOTS,
      [YJ, LZM],
      { selectedText: '叶均的指腹在你后颈打着圈，陆子慕低着头。', personaName: '陆子慕' },
    );

    expect(shots).toHaveLength(2);
    for (const shot of shots) {
      expect(shot.characters.length).toBeGreaterThan(0);
      const tags = shot.characters.map(c => c.tag).join(' | ');
      expect(tags).toMatch(/silver white hair|wavy brown hair/);
    }
  });

  it('纯物件格 / 环境细节格仍然留空（空镜是合法的，不该硬塞人）', () => {
    const shots = buildPanelShots(
      page([
        panel({ index: 0, shot: 'medium shot', nl: 'he sits back' }),
        panel({ index: 1, composition: 'object', shot: 'extreme close-up', nl: 'the paper bag on the table' }),
      ]),
      SLOTS,
      [YJ, LZM],
    );

    expect(shots[0]?.characters.length).toBeGreaterThan(0);
    expect(shots[1]?.characters).toHaveLength(0);
  });

  it('只要有一格点了名，其余空格按「空镜」处理，不拿页级阵容去填', () => {
    const shots = buildPanelShots(
      page([
        panel({ index: 0, shot: 'medium shot', characters: [{ name: '叶均', act: 'speaking' }] }),
        panel({ index: 1, shot: 'extreme close-up' }),
      ]),
      SLOTS,
      [YJ, LZM],
    );

    expect(shots[0]?.characters.map(c => c.name)).toEqual(['叶均']);
    expect(shots[1]?.characters).toHaveLength(0);
  });

  it('角色库是空的时候不瞎编：一个人也不补', () => {
    const shots = buildPanelShots(
      page([panel({ index: 0, nl: 'a hand on a bag' })]),
      pageSlotsFor('regular', 1),
      [],
    );
    expect(shots[0]?.characters).toHaveLength(0);
  });

  it('库条目只有分字段、没有整串 tag 时，外貌照样带得上', () => {
    const fieldsOnly: BaiBaiCharacter = {
      name: '叶均',
      tag: '',
      fields: {
        sex: '1boy',
        hair: 'short silver white hair',
        eyes: 'grey eyes',
        body: 'tall, broad shoulders',
      },
    };
    const shots = buildPanelShots(
      page([panel({ index: 0, characters: [{ name: '叶均', act: 'speaking' }] })]),
      pageSlotsFor('regular', 1),
      [fieldsOnly],
    );
    expect(shots[0]?.characters[0]?.tag).toContain('short silver white hair');
    expect(shots[0]?.characters[0]?.tag).toContain('grey eyes');
  });
});
