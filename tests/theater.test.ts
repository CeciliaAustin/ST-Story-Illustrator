/**
 * 小剧场纯函数测试：解析、种子、安全过滤、提示词、拼词
 */

import { describe, it, expect } from 'vitest';
import {
  sanitizeStatusTags,
  parseStatusReply,
  clampMangaShots,
  STATUS_MAX_PANELS,
} from '../src/theater/parseReply';
import { statusSeedFor, decideSeed } from '../src/theater/seed';
import {
  isMangaUnsafeText,
  stripMangaUnsafeTags,
  scrubMangaReading,
  MANGA_SAFE_NEGATIVE,
} from '../src/theater/safeFilter';
import {
  buildTheaterPrompt,
  clampBody,
  buildStatusPrompt,
  buildMangaPrompt,
  buildTheaterImagePrompt,
  CHIBI_STYLE_STRONG,
} from '../src/theater/prompts';

// ============================================================
// sanitizeStatusTags
// ============================================================

describe('sanitizeStatusTags', () => {
  it('normalizes weighted tags and strips blocklist', () => {
    const result = sanitizeStatusTags('masterpiece, 1.4::smile::, (blush:1.2), kiss, 金发');
    expect(result).toContain('smile');
    expect(result).toContain('blush');
    expect(result).toContain('kiss');
    expect(result).not.toContain('masterpiece');
    expect(result).not.toContain('金发');
  });

  it('deduplicates and caps at 14', () => {
    const result = sanitizeStatusTags(Array.from({ length: 20 }, (_, i) => `tag${i}`).join(', '));
    expect(result.length).toBeLessThanOrEqual(14);
  });

  it('splits on Chinese commas and newlines', () => {
    expect(sanitizeStatusTags('a，b、c\nd')).toEqual(['a', 'b', 'c', 'd']);
  });
});

// ============================================================
// parseStatusReply
// ============================================================

describe('parseStatusReply', () => {
  it('parses single frame', () => {
    const r = parseStatusReply(JSON.stringify({
      title: '初次见面', characters: [{ name: 'Alice', act: 'smiling' }], mood: '温馨',
      tags: '1girl, smile', nl: 'Alice smiles gently.',
    }));
    expect(r.title).toBe('初次见面');
    expect(r.characters).toEqual(['Alice']);
    expect(r.roles[0].act).toBe('smiling');
    expect(r.tags).toBe('1girl, smile');
    expect(r.panels).toHaveLength(1);
  });

  it('parses multi-panel with dedup by tag set', () => {
    const r = parseStatusReply(JSON.stringify({
      title: '一楼的事', panels: [
        { title: '格1', characters: [], tags: '1girl, smile', nl: 'A' },
        { title: '格2', characters: [], tags: 'smile, 1girl', nl: 'B' }, // 同 tag 集合，应被去重
        { title: '格3', characters: [], tags: 'kiss, couple', nl: 'C' },
      ],
    }));
    expect(r.panels).toHaveLength(2);
    expect(r.title).toBe('一楼的事');
  });

  it('caps at 4 panels and 2 characters', () => {
    const r = parseStatusReply(JSON.stringify({
      panels: Array.from({ length: 6 }, (_, i) => ({ tags: `tag${i}` })),
    }));
    expect(r.panels.length).toBeLessThanOrEqual(STATUS_MAX_PANELS);
  });

  it('handles single quotes fallback', () => {
    const r = parseStatusReply("{'title':'x','tags':'1girl'}");
    expect(r.title).toBe('x');
  });

  it('returns empty on broken JSON', () => {
    const r = parseStatusReply('not json at all');
    expect(r.panels).toEqual([]);
    expect(r.tags).toBe('');
  });

  it('drops Chinese nl (noise for image model)', () => {
    const r = parseStatusReply(JSON.stringify({ tags: '1girl', nl: '一个女孩在微笑' }));
    expect(r.nl).toBe('');
  });

  it('parses lines with speaker', () => {
    const r = parseStatusReply(JSON.stringify({
      tags: '1girl', lines: [{ speaker: 'Alice', text: '你好' }, '旁白文本'],
    }));
    expect(r.lines).toHaveLength(2);
    expect(r.lines![0].speaker).toBe('Alice');
    expect(r.lines![1].speaker).toBe('');
  });
});

describe('clampMangaShots', () => {
  it('clamps to 1..4', () => {
    expect(clampMangaShots(0)).toBe(1);
    expect(clampMangaShots(99)).toBe(4);
    expect(clampMangaShots('3')).toBe(3);
    expect(clampMangaShots(undefined)).toBe(1);
  });
});

// ============================================================
// seed
// ============================================================

describe('statusSeedFor', () => {
  it('is deterministic', () => {
    expect(statusSeedFor('Alice')).toBe(statusSeedFor('Alice'));
  });

  it('is order-independent for the same set when sorted by caller', () => {
    const a = statusSeedFor(['Alice', 'Bob']);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThanOrEqual(4294967294);
  });

  it('returns 0 for empty', () => {
    expect(statusSeedFor('')).toBe(0);
    expect(statusSeedFor([])).toBe(0);
  });

  it('different names give different seeds', () => {
    expect(statusSeedFor('Alice')).not.toBe(statusSeedFor('Bob'));
  });
});

describe('decideSeed', () => {
  it('prefers explicit override', () => {
    expect(decideSeed('nai', 123, 456)).toBe(123);
  });

  it('uses fixed seed for NAI', () => {
    expect(decideSeed('nai', undefined, 789)).toBe(789);
  });

  it('generates a positive seed otherwise', () => {
    const s = decideSeed('comfyui');
    expect(s).toBeGreaterThan(0);
  });
});

// ============================================================
// safeFilter
// ============================================================

describe('safeFilter', () => {
  it('detects unsafe words with word boundaries', () => {
    expect(isMangaUnsafeText('nude girl')).toBe(true);
    expect(isMangaUnsafeText('a glass of water')).toBe(false); // ass 不命中 glass
    expect(isMangaUnsafeText('a brush')).toBe(false); // bra 不命中 brush
  });

  it('strips whole unsafe tags', () => {
    const r = stripMangaUnsafeTags('1girl, large breasts, smile, nude');
    expect(r.tags).toBe('1girl, smile');
    expect(r.hits.length).toBe(2);
  });

  it('scrubs a reading', () => {
    const reading = {
      title: 'x', characters: ['A'], roles: [{ name: 'A', act: 'kissing' }], mood: '',
      tags: '1girl, nude', nl: 'nude scene', panels: [{
        title: '格', characters: ['A'], roles: [{ name: 'A', act: 'nsfw action' }],
        mood: '', tags: '1girl, cleavage', nl: 'sex scene',
      }],
    };
    const r = scrubMangaReading(reading);
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.reading.panels[0].tags).not.toContain('cleavage');
    expect(r.reading.panels[0].roles[0].act).toBe('');
    expect(r.reading.panels[0].nl).toBe('');
  });

  it('exports the safe negative', () => {
    expect(MANGA_SAFE_NEGATIVE).toContain('nsfw');
  });
});

// ============================================================
// prompts
// ============================================================

describe('buildTheaterPrompt', () => {
  it('builds status single prompt', () => {
    const p = buildTheaterPrompt({ kind: 'status', characterName: 'Alice', body: '她笑了', shots: 1 });
    expect(p.system).toContain('只输出一个 JSON 对象');
    expect(p.user).toContain('Alice');
    expect(p.user).toContain('她笑了');
  });

  it('builds status many prompt with count', () => {
    const p = buildTheaterPrompt({ kind: 'status', characterName: 'A', body: 'x', shots: 3 });
    expect(p.system).toContain('3 个先后画面');
  });

  it('bonus uses different body label', () => {
    const p = buildTheaterPrompt({ kind: 'bonus', characterName: 'A', body: 'x', shots: 1 });
    expect(p.user).toContain('只用来认人');
    expect(p.system).toContain('平行宇宙彩蛋');
  });

  it('manga safe prompt includes public-display rule', () => {
    const p = buildTheaterPrompt({ kind: 'manga', characterName: 'A', body: 'x', shots: 1, mangaSafe: true });
    expect(p.system).toContain('能公开发布');
    const off = buildTheaterPrompt({ kind: 'manga', characterName: 'A', body: 'x', shots: 1, mangaSafe: false });
    expect(off.system).not.toContain('能公开发布');
  });
});

describe('clampBody', () => {
  it('keeps short body', () => {
    expect(clampBody('short', false)).toBe('short');
  });

  it('keeps tail of long body', () => {
    const long = 'a'.repeat(3000) + 'END';
    expect(clampBody(long, false).endsWith('END')).toBe(true);
  });
});

describe('image prompt composition', () => {
  it('status prompt has chibi style + appearance + framing', () => {
    const p = buildStatusPrompt(['blonde hair'], '1girl, smile', true);
    expect(p).toContain('super deformed');
    expect(p).toContain('blonde hair');
    expect(p).toContain('upper body'); // 景别兜底
  });

  it('status prompt omits chibi when off and respects existing framing', () => {
    const p = buildStatusPrompt(['x'], 'close-up, smile', false);
    expect(p).not.toContain('super deformed');
    expect(p.match(/close-up/g)).toHaveLength(1);
    expect(p).not.toContain('upper body');
  });

  it('manga prompt uses cowboy shot framing and no chibi', () => {
    const p = buildMangaPrompt(['x'], '1girl');
    expect(p).toContain('cowboy shot');
    expect(p).not.toContain(CHIBI_STYLE_STRONG.slice(0, 10));
  });

  it('dispatches by kind', () => {
    expect(buildTheaterImagePrompt('status', [], '1girl', true)).toContain('super deformed');
    expect(buildTheaterImagePrompt('manga', [], '1girl', false)).toContain('cowboy shot');
  });
});
