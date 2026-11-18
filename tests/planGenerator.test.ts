/**
 * 分镜/Tag 计划生成器测试（注入 mock LLM caller）
 */

import { describe, it, expect } from 'vitest';
import { generateIllustrationPlan, generateComicPlan } from '../src/manga/planGenerator';
import type { IllustrationPromptOptions, ComicPlanOptions } from '../src/manga/planPrompts';

const illustrationOptions: IllustrationPromptOptions = {
  includeChinese: true, includeNl: true, includeNegative: true, size: 'portrait',
};

const comicOptions: ComicPlanOptions = {
  panelMode: true, panelLayout: 'regular', pageType: 'auto', dialogue: true,
  dialoguePolicy: 'auto', dialogueMode: 'json', nl: true, backend: 'nai',
  charPrompts: false, includeChinese: true, maxPages: 2,
};

const scene = { selectedText: '她走进花园，看到了他。' };

describe('generateIllustrationPlan', () => {
  it('returns parsed plan on success', async () => {
    const caller = async () => JSON.stringify({
      segments: [{ source: 'scene', english: ['garden', 'smile'] }],
      nl: 'A girl smiles.',
    });
    const result = await generateIllustrationPlan({ scene, options: illustrationOptions, caller });
    expect(result.ok).toBe(true);
    expect(result.data!.segments[0].english).toEqual(['garden', 'smile']);
    expect(result.data!.nl).toBe('A girl smiles.');
  });

  it('passes system and user prompts to the caller', async () => {
    let seen = '';
    const caller = async (system: string, user: string) => {
      seen = system + user;
      return JSON.stringify({ segments: [{ english: ['x'] }] });
    };
    await generateIllustrationPlan({ scene, options: illustrationOptions, caller });
    expect(seen).toContain('segments');
    expect(seen).toContain('她走进花园');
  });

  it('returns error on unparseable output', async () => {
    const result = await generateIllustrationPlan({
      scene, options: illustrationOptions, caller: async () => ' nonsense ',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('解析');
  });

  it('returns error when caller throws', async () => {
    const result = await generateIllustrationPlan({
      scene, options: illustrationOptions,
      caller: async () => { throw new Error('network down'); },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('network down');
  });
});

describe('generateComicPlan', () => {
  it('returns parsed pages on success', async () => {
    const caller = async () => JSON.stringify({
      pages: [{ layout: 'irregular', panels: [{ tags: '1girl', dialogue: [{ text: '你好' }] }] }],
    });
    const result = await generateComicPlan({ scene, options: comicOptions, caller });
    expect(result.ok).toBe(true);
    expect(result.data!).toHaveLength(1);
    expect(result.data![0].layout).toBe('irregular');
    expect(result.data![0].panels[0].dialogue?.[0].text).toBe('你好');
  });

  it('returns error with warnings on empty plan', async () => {
    const result = await generateComicPlan({
      scene, options: comicOptions, caller: async () => '{ bad json',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('解析');
    expect(result.warnings).toBeDefined();
  });

  it('passes panel rule into system prompt', async () => {
    let sys = '';
    const caller = async (system: string) => {
      sys = system;
      return JSON.stringify({ pages: [{ panels: [{ tags: 'x' }] }] });
    };
    await generateComicPlan({ scene, options: comicOptions, caller });
    expect(sys).toContain('【分镜规则（必须遵守）】');
  });
});
