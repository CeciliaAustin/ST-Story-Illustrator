/**
 * 小剧场「读剧情」体检 + act 合流 + 模式配置兜底
 *
 * 这几条都是为了不再出现「出了图但跟剧情毫无关系」和「三选一少了彩蛋」：
 * - combinedPanelTags：act 才是动作信息，必须并进出图词
 * - checkReading：不合格就别出图（一张废图比一次重问贵得多）
 * - resolveModeSettings：旧存档缺新模式时不至于 TypeError 把任务炸掉
 */

import { describe, it, expect } from 'vitest';
import { combinedPanelTags, checkReading } from '../src/theater/runtime';
import { makeLookReader } from '../src/tasks/theaterRun';
import { resolveModeSettings, DEFAULT_SETTINGS, type StatusFrame } from '../src/types';

function frame(patch: Partial<StatusFrame> = {}): StatusFrame {
  return {
    title: '标题',
    characters: [],
    roles: [],
    mood: '',
    tags: '',
    nl: '',
    ...patch,
  };
}

describe('combinedPanelTags', () => {
  it('把 act 合进 tags（动作才是画面主体）', () => {
    const panel = frame({
      roles: [{ name: '小明', act: 'holding a broken cup, looking down' }],
      tags: '1boy, expression sad',
    });
    const out = combinedPanelTags(panel);
    expect(out).toContain('holding a broken cup');
    expect(out).toContain('looking down');
    expect(out).toContain('expression sad');
  });

  it('act 与 tags 重复时只留一份', () => {
    const panel = frame({
      roles: [{ name: 'A', act: 'sitting on bed' }],
      tags: 'Sitting On Bed, 1girl',
    });
    const parts = combinedPanelTags(panel).split(',').map(s => s.trim().toLowerCase());
    expect(parts.filter(p => p === 'sitting on bed')).toHaveLength(1);
  });

  it('act 里的中文整条丢掉（NAI 只认英文 tag）', () => {
    const panel = frame({
      roles: [{ name: '小明', act: '抱着杯子，低着头' }],
      tags: '1boy, sitting',
    });
    const out = combinedPanelTags(panel);
    expect(out).not.toContain('抱着杯子');
    expect(out).toBe('1boy, sitting');
  });

  it('没有 act 时等价于 tags', () => {
    const panel = frame({ tags: '1girl, smile' });
    expect(combinedPanelTags(panel)).toBe('1girl, smile');
  });
});

describe('checkReading（出图前的相关性体检）', () => {
  const body = '小明把杯子摔了，蹲下去捡碎片，小红在旁边喊他别动。';

  it('tag 太少判不合格（空景必然与剧情无关）', () => {
    const reading = {
      ...frame(),
      tags: '',
      panels: [frame({ tags: '1girl, solo', characters: ['小明'], roles: [{ name: '小明', act: '' }] })],
    };
    const check = checkReading(reading, body, 'status');
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('tag');
  });

  it('角色不在正文里判不合格（模型自己编人）', () => {
    const reading = {
      ...frame(),
      panels: [
        frame({
          tags: '1boy, 1girl, hugging, crying, sitting on floor, broken glass',
          characters: ['阿强'],
          roles: [{ name: '阿强', act: 'hugging a girl' }],
        }),
      ],
    };
    const check = checkReading(reading, body, 'status');
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('没有出现');
  });

  it('角色在正文里、tag 够多 → 通过', () => {
    const reading = {
      ...frame(),
      panels: [
        frame({
          tags: '1boy, kneeling, picking up glass shards, worried expression',
          characters: ['小明'],
          roles: [{ name: '小明', act: 'kneeling on the floor' }],
        }),
      ],
    };
    expect(checkReading(reading, body, 'status').ok).toBe(true);
  });

  it('act 里的动作也算数（模型把动作全写在 act 里时不误杀）', () => {
    const reading = {
      ...frame(),
      panels: [
        frame({
          tags: '1boy, indoor',
          characters: ['小明'],
          roles: [
            {
              name: '小明',
              act: 'kneeling on the floor, picking up broken shards, crying, looking down, clenched hands',
            },
          ],
        }),
      ],
    };
    expect(checkReading(reading, body, 'status').ok).toBe(true);
  });

  it('彩蛋按设计就是架空：不查角色是否在正文里，但仍要求 tag 够', () => {
    const reading = {
      ...frame(),
      panels: [
        frame({
          tags: '1boy, 1girl, dancing under rain, holding umbrella, laughing',
          characters: ['路人甲'],
        }),
      ],
    };
    expect(checkReading(reading, body, 'bonus').ok).toBe(true);
  });

  it('空格子判不合格', () => {
    expect(checkReading({ ...frame(), panels: [] }, body, 'status').ok).toBe(false);
  });
});

describe('resolveModeSettings（旧存档缺新模式时的兜底）', () => {
  it('缺整个 modes 时回落到默认', () => {
    const conf = resolveModeSettings({}, 'chibi-bonus');
    expect(conf.shots).toBe(1);
    expect(conf.chibiBonusChance).toBe(25);
  });

  it('旧存档只存了几种模式，新模式不能是 undefined', () => {
    const conf = resolveModeSettings(
      { modes: { illustration: { enabled: true, autoTrigger: false, profileId: '', shots: 2 } } } as never,
      'bw-manga',
    );
    expect(conf).toBeTruthy();
    expect(conf.shots).toBe(1);
    expect(conf.bwMangaSafeMode).toBe(true);
  });

  it('存档里的值优先于默认', () => {
    const conf = resolveModeSettings(
      { modes: { 'chibi-status': { enabled: true, autoTrigger: false, profileId: '', shots: 3 } } } as never,
      'chibi-status',
    );
    expect(conf.shots).toBe(3);
    expect(conf.chibiStyle).toBe('card');
  });

  it('DEFAULT_SETTINGS 自带全部五种模式', () => {
    for (const mode of ['illustration', 'comic', 'chibi-status', 'chibi-bonus', 'bw-manga'] as const) {
      expect(resolveModeSettings(DEFAULT_SETTINGS, mode)).toBeTruthy();
    }
  });
});

describe('makeLookReader（角色外貌匹配）', () => {
  const lib = [
    { name: '小明', tag: '1boy, short black hair, school uniform', nl: '' },
    { name: '小红（我）', tag: '1girl, long red hair, ribbon', nl: '' },
  ];

  it('同名直接命中', () => {
    const looks = makeLookReader(lib)(['小明']);
    expect(looks[0].tag).toContain('short black hair');
  });

  it('名字带括号注也能对上（正文里常写「小红」而库里是「小红（我）」）', () => {
    const looks = makeLookReader(lib)(['小红']);
    expect(looks[0].tag).toContain('long red hair');
  });

  it('对不上时回落到主角色，而不是给空串（否则出图就是随便哪个人）', () => {
    const looks = makeLookReader(lib, '小明')(['阿强']);
    expect(looks[0].tag).toContain('short black hair');
  });

  it('库为空时给空 tag，不抛错', () => {
    expect(makeLookReader([])(['谁'])[0].tag).toBe('');
  });
});
