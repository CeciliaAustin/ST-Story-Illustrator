/**
 * 内置提示词：五套模板的默认值、覆盖、以及「管线里真的用上了」。
 *
 * 这里抓两类回归：
 * 1. 模板改坏——字段名被写丢，解析器就什么都拿不到；
 * 2. 覆盖没生效——用户在标签页里改完，实际请求还是旧文本。
 */

import { describe, it, expect } from 'vitest';
import {
  PROMPT_DOCS,
  defaultTemplate,
  isCustomized,
  overrideKey,
  renderPromptDoc,
  resolveTemplate,
} from '../src/prompt/presets';
import { buildIllustrationSystemPrompt, buildComicSystemPrompt } from '../src/manga/planPrompts';
import { buildTheaterPrompt } from '../src/theater/prompts';

describe('内置提示词目录', () => {
  it('五套都在，且 id 唯一', () => {
    expect(PROMPT_DOCS.map(d => d.id)).toEqual(['illustration', 'comic', 'status', 'bonus', 'manga']);
    expect(new Set(PROMPT_DOCS.map(d => d.id)).size).toBe(PROMPT_DOCS.length);
  });

  it('默认模板非空，且不含未声明的变量', () => {
    for (const doc of PROMPT_DOCS) {
      for (const text of [doc.defaults.single, doc.defaults.many].filter(Boolean) as string[]) {
        expect(text.trim().length).toBeGreaterThan(50);
        const used = [...text.matchAll(/\{\{([#^]?)([a-zA-Z0-9_-]+)\}\}/g)].map(m => m[2]);
        for (const name of used) expect(doc.vars).toContain(name);
      }
    }
  });

  it('覆盖后才算「已自定义」，空串等于没改', () => {
    expect(isCustomized('status', 'single')).toBe(false);
    expect(isCustomized('status', 'single', { status: '  ' })).toBe(false);
    expect(isCustomized('status', 'single', { status: '自定义' })).toBe(true);
    expect(isCustomized('status', 'many', { status: '自定义' })).toBe(false);
    expect(overrideKey('status', 'many')).toBe('status@many');
  });

  it('覆盖生效；清空回落默认', () => {
    const overrides = { status: '我的提示词 {{count}}' };
    expect(resolveTemplate('status', 'single', overrides)).toBe('我的提示词 {{count}}');
    expect(renderPromptDoc('status', 'single', { count: 2 }, overrides)).toBe('我的提示词 2');
    expect(resolveTemplate('status', 'single', { status: '' })).toBe(defaultTemplate('status', 'single'));
  });
});

describe('三套 theater 提示词', () => {
  it('状态栏单格带 cast 与 characters 契约', () => {
    const { system } = buildTheaterPrompt({ kind: 'status', characterName: '甲', body: '正文', shots: 1 });
    expect(system).toContain('"cast"');
    expect(system).toContain('"characters"');
    expect(system).not.toContain('{{');
  });

  it('状态栏多格把格数填进去', () => {
    const { system } = buildTheaterPrompt({ kind: 'status', characterName: '甲', body: '正文', shots: 3 });
    expect(system).toContain('3 个先后画面');
    expect(system).toContain('"panels"');
  });

  it('黑白漫：安全模式与台词各是一个条件段', () => {
    const safe = buildTheaterPrompt({
      kind: 'manga', characterName: '甲', body: '正文', shots: 1, mangaSafe: true, dialogue: true,
    }).system;
    expect(safe).toContain('必须能公开发布');
    expect(safe).toContain('"lines"');

    const unsafe = buildTheaterPrompt({
      kind: 'manga', characterName: '甲', body: '正文', shots: 1, mangaSafe: false, dialogue: false,
    }).system;
    expect(unsafe).not.toContain('必须能公开发布');
    expect(unsafe).not.toContain('"lines"');
  });

  it('覆盖值真的进 system', () => {
    const { system } = buildTheaterPrompt({
      kind: 'bonus', characterName: '甲', body: '正文', shots: 1,
      promptOverrides: { bonus: '【我的彩蛋提示词】' },
    });
    expect(system.startsWith('【我的彩蛋提示词】')).toBe(true);
  });

  it('角色库与「谁是谁」仍然追加在 system 末尾', () => {
    const { system } = buildTheaterPrompt({
      kind: 'status', characterName: '甲', body: '正文', shots: 1,
      libraryBlock: '【库】甲：golden hair', castBlock: '【谁是谁】你=Sissy',
    });
    expect(system).toContain('【库】甲：golden hair');
    expect(system).toContain('【谁是谁】你=Sissy');
  });
});

describe('插画 / 漫画提示词', () => {
  it('插画：关掉中文辅助才出现对应约束', () => {
    const withCn = buildIllustrationSystemPrompt({ includeChinese: true, includeNl: true, includeNegative: true });
    const withoutCn = buildIllustrationSystemPrompt({ includeChinese: false, includeNl: true, includeNegative: true });
    expect(withCn).not.toContain('不要生成 chinese 字段');
    expect(withoutCn).toContain('不要生成 chinese 字段');
  });

  it('漫画：分镜规则为空时整段不出现', () => {
    const p = buildComicSystemPrompt({
      panelMode: false, panelLayout: 'regular', pageType: 'auto', dialogue: true,
      dialoguePolicy: 'auto', dialogueMode: 'json', nl: true, backend: 'nai', charPrompts: false,
      includeChinese: true, maxPages: 1,
    });
    expect(p).not.toContain('【分镜规则（必须遵守）】');
    expect(p).toContain('【输出约束】');
  });

  it('漫画：指定 4 格时提示词与构图词一起变', () => {
    const p = buildComicSystemPrompt({
      panelMode: true, panelLayout: 'regular', pageType: 'auto', dialogue: true,
      dialoguePolicy: 'auto', dialogueMode: 'json', nl: true, backend: 'nai', charPrompts: false,
      includeChinese: true, maxPages: 1, panelsPerPage: 4,
    });
    expect(p).toContain('每页固定 4 格');
    expect(p).toContain('4koma');
    expect(p).not.toContain('2koma');
  });
});
