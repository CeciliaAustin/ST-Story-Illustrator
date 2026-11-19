/**
 * LLM 提示词构建与响应解析纯函数测试
 */

import { describe, it, expect } from 'vitest';
import {
  extractJson,
  safeParseJson,
  characterToSegment,
  buildIllustrationSystemPrompt,
  buildIllustrationUserPrompt,
  ensureCharacterSegments,
  parseIllustrationResponse,
  buildComicSystemPrompt,
  buildComicUserPrompt,
} from '../src/manga/planPrompts';

describe('extractJson', () => {
  it('extracts a bare object', () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });

  it('extracts from markdown fence', () => {
    expect(extractJson('here:\n```json\n{"a":1}\n```\nthanks')).toBe('{"a":1}');
  });

  it('extracts object embedded in prose', () => {
    expect(extractJson('Sure! {"a":1} Hope that helps.')).toBe('{"a":1}');
  });

  it('handles braces inside strings', () => {
    expect(extractJson('{"text":"a } b","n":2} trailing')).toBe('{"text":"a } b","n":2}');
  });

  it('handles arrays', () => {
    expect(extractJson('[{"a":1},{"b":2}]')).toBe('[{"a":1},{"b":2}]');
  });

  it('returns null for no json', () => {
    expect(extractJson('no json here')).toBeNull();
    expect(extractJson('')).toBeNull();
  });
});

describe('safeParseJson', () => {
  it('parses valid json', () => {
    expect(safeParseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('returns null on invalid json', () => {
    expect(safeParseJson('{ bad }')).toBeNull();
  });
});

describe('characterToSegment', () => {
  const character = {
    name: 'Alice', tag: 'blonde, blue eyes', nl: 'a kind girl', source: 'manual' as const, scope: 'chat' as const,
  };

  it('builds a character segment with english tags', () => {
    const seg = characterToSegment(character, 0, true);
    expect(seg).not.toBeNull();
    expect(seg!.source).toBe('character');
    expect(seg!.english).toEqual(['blonde', 'blue eyes']);
    expect(seg!.chinese).toEqual(['a kind girl']);
    expect(seg!.order).toBe(0);
  });

  it('omits chinese when disabled', () => {
    const seg = characterToSegment(character, 1, false);
    expect(seg!.chinese).toBeUndefined();
  });

  it('returns null when no tag', () => {
    expect(characterToSegment({ name: 'X', tag: '' }, 0, true)).toBeNull();
  });
});

describe('buildIllustrationSystemPrompt', () => {
  it('includes the json schema', () => {
    const p = buildIllustrationSystemPrompt({ includeChinese: true, includeNl: true, includeNegative: true });
    expect(p).toContain('"segments"');
    expect(p).toContain('纯英文');
    // nl 是柏宝绘的画面细节通道：开启时不许出现「不要生成 nl」
    expect(p).not.toContain('不要生成 nl');
    // 外貌与在场人物必须齐全（「人物都没填」的直接对策）
    expect(p).toContain('每一个人');
  });

  it('reflects disabled fields', () => {
    const p = buildIllustrationSystemPrompt({ includeChinese: false, includeNl: false, includeNegative: false, size: 'portrait' });
    expect(p).toContain('不要生成 chinese');
    expect(p).toContain('不要生成 nl');
    expect(p).toContain('不要生成 negative');
    expect(p).toContain('portrait');
  });
});

describe('buildIllustrationUserPrompt', () => {
  it('contains scene and characters', () => {
    const p = buildIllustrationUserPrompt(
      { selectedText: '她笑了', floorText: '全文', previousText: '前文', nextText: '后文' },
      [{ name: 'Alice', tag: 'blonde' }],
    );
    expect(p).toContain('她笑了');
    expect(p).toContain('前文');
    expect(p).toContain('Alice: blonde');
  });

  it('角色条目只有字段没有 tag 时，明确标注「没有外貌数据」而不是留空', () => {
    const p = buildIllustrationUserPrompt(
      { selectedText: '她笑了' },
      [{ name: 'Alice', tag: '', fields: { hair: 'long black' } }],
    );
    expect(p).toContain('Alice: （没有外貌数据，请按正文写具体）');
  });

  it('有角色库全文时优先用它（按字段渲染，含发色瞳色与固定着装）', () => {
    const p = buildIllustrationUserPrompt(
      { selectedText: '她笑了' },
      [{ name: 'Alice', tag: '' }],
      { libraryBlock: '【角色固定外貌库】\n- Alice: 头发=long black, 眼睛=red' },
    );
    expect(p).toContain('头发=long black');
    expect(p).not.toContain('Alice: （没有外貌数据');
  });

  it('带上「谁是谁」（用户人设 / 角色卡）', () => {
    const p = buildIllustrationUserPrompt(
      { selectedText: '她笑了' },
      [],
      { castBlock: '【本聊天的人物对应】\n- 用户扮演：Sissy' },
    );
    expect(p).toContain('用户扮演：Sissy');
  });
});

describe('ensureCharacterSegments：模型漏写时由代码补外貌', () => {
  const scene = { selectedText: 'Elias 把她按在桌上', source: 'scene' as const, english: ['1boy', 'leaning over'], chinese: [], enabled: true, order: 0 };

  it('一个 character 段都没有时补上出场角色（排在 scene 之前）', () => {
    const out = ensureCharacterSegments(
      { segments: [scene] },
      [{ name: 'Elias', tag: '1boy, short black hair' }],
      scene.selectedText,
      false,
    );
    expect(out.segments[0]).toMatchObject({ source: 'character', characterName: 'Elias' });
    expect(out.segments[0].english).toContain('short black hair');
    expect(out.segments[0].order).toBeLessThan(0);
  });

  it('模型已经写了 character 段就不重复补', () => {
    const own = { ...scene, id: 'c1', source: 'character' as const, characterName: 'Elias', english: ['short black hair'] };
    const out = ensureCharacterSegments({ segments: [own] }, [{ name: 'Elias', tag: '1boy, short black hair' }], scene.selectedText, false);
    expect(out.segments).toHaveLength(1);
  });

  it('选段没提到、且库里超过 2 人时不乱补（避免把无关的人画进来）', () => {
    const out = ensureCharacterSegments(
      { segments: [scene] },
      [
        { name: 'A', tag: '1girl' },
        { name: 'B', tag: '1boy' },
        { name: 'C', tag: '1boy' },
      ],
      '桌子上放着一封信',
      false,
    );
    expect(out.segments).toHaveLength(1);
  });

  it('库里条目没外貌时不补空段', () => {
    const out = ensureCharacterSegments({ segments: [scene] }, [{ name: 'Elias', tag: '' }], scene.selectedText, false);
    expect(out.segments).toHaveLength(1);
  });
});

describe('parseIllustrationResponse', () => {
  const valid = {
    segments: [
      { id: 'c1', source: 'character', characterName: 'Alice', english: ['blonde'], chinese: ['金发'], order: 0 },
      { id: 's1', source: 'scene', english: ['smiling', 'garden'], chinese: [], order: 1 },
    ],
    nl: 'A girl smiles in the garden.',
    negative: 'blurry',
    size: 'portrait',
  };

  it('parses valid response', () => {
    const r = parseIllustrationResponse(JSON.stringify(valid));
    expect(r).not.toBeNull();
    expect(r!.segments).toHaveLength(2);
    expect(r!.nl).toBe('A girl smiles in the garden.');
    expect(r!.negative).toBe('blurry');
  });

  it('parses fenced response', () => {
    const r = parseIllustrationResponse('```json\n' + JSON.stringify(valid) + '\n```');
    expect(r!.segments).toHaveLength(2);
  });

  it('drops invalid segments', () => {
    const r = parseIllustrationResponse(JSON.stringify({
      segments: [{ english: ['ok'] }, { english: [] }, null, 'x'],
    }));
    expect(r!.segments).toHaveLength(1);
    expect(r!.segments[0].english).toEqual(['ok']);
  });

  it('returns null when no valid segments', () => {
    expect(parseIllustrationResponse('{ "segments": [] }')).toBeNull();
    expect(parseIllustrationResponse('garbage')).toBeNull();
  });

  it('defaults source to scene and order to index', () => {
    const r = parseIllustrationResponse(JSON.stringify({ segments: [{ english: ['x'] }] }));
    expect(r!.segments[0].source).toBe('scene');
    expect(r!.segments[0].order).toBe(0);
  });
});

describe('buildComicSystemPrompt', () => {
  const base = {
    panelMode: true, panelLayout: 'regular' as const, pageType: 'auto' as const,
    dialogue: true, dialoguePolicy: 'auto' as const, dialogueMode: 'json' as const,
    nl: true, backend: 'nai' as const, charPrompts: false, includeChinese: true, maxPages: 3,
  };

  it('includes schema and the panel rule when enabled', () => {
    const p = buildComicSystemPrompt(base);
    expect(p).toContain('"pages"');
    expect(p).toContain('【分镜规则（必须遵守）】');
    expect(p).toContain('multiple views');
  });

  it('omits panel rule when mode disabled', () => {
    const p = buildComicSystemPrompt({ ...base, panelMode: false });
    expect(p).not.toContain('【分镜规则（必须遵守）】');
  });

  it('clamps maxPages in output constraint', () => {
    const p = buildComicSystemPrompt({ ...base, maxPages: 99 });
    expect(p).toContain('最多 8 页');
  });

  it('tells model not to emit dialogue when disabled', () => {
    const p = buildComicSystemPrompt({ ...base, dialogue: false });
    expect(p).toContain('不要输出 dialogue 字段');
  });
});

describe('buildComicUserPrompt', () => {
  it('contains scene and characters', () => {
    const p = buildComicUserPrompt(
      { selectedText: '两人对视', previousText: '前文' },
      [{ name: 'Bob', tag: 'black hair' }],
    );
    expect(p).toContain('两人对视');
    expect(p).toContain('Bob: black hair');
  });
});
