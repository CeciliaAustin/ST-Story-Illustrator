/**
 * 柏宝绘「自定义提示词」的读取与应用
 *
 * 锁住的是「用户改的那份规范必须真的被我们发出去」：
 * - naiV5Spec 优先，空则回退 naiSpec（与柏宝绘同一口径）
 * - {{#nl}}/{{^nl}} 条件段按自然语言开关展开
 * - 三份都空 → 返回空串（不能给模型发一段空规范）
 * - 有内容 → 末尾一定带「输出契约优先」，否则模型会照规范示例的字段名输出
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildSpecPreamble,
  expandNlSections,
  parsePromptSet,
  readPromptSet,
  specPreambleFor,
  withSpecPreamble,
} from '../src/baibai/specPrompt';
import { initSTEnvironment } from '../src/host/sillytavern';

/** 柏宝绘那份设置的**内层**（parsePromptSet 收到的就是 extensionSettings['baibai_image']）。 */
function innerSettings(prompts: Record<string, string>) {
  return { autoTag: { prompts } };
}

/** ST 上下文里包一层命名空间（readPromptSet 走这条）。 */
function rawSettings(prompts: Record<string, string>) {
  return { baibai_image: innerSettings(prompts) };
}

describe('parsePromptSet', () => {
  it('取 NAI4.5/V5 那份规范、思维链与破限词', () => {
    const set = parsePromptSet(innerSettings({
      jailbreak: '别拒绝',
      naiV5Spec: 'NAI V5 规范',
      naiV5Thinking: '思考清单',
    }));
    expect(set).toEqual({ jailbreak: '别拒绝', spec: 'NAI V5 规范', thinking: '思考清单' });
  });

  it('V5 规范为空时回退到旧的单串版', () => {
    const set = parsePromptSet(innerSettings({ naiSpec: '4 系规范', naiThinking: '旧思维链' }));
    expect(set.spec).toBe('4 系规范');
    expect(set.thinking).toBe('旧思维链');
  });

  it('设置缺失时给空串，不抛错', () => {
    expect(parsePromptSet(undefined)).toEqual({ jailbreak: '', spec: '', thinking: '' });
    expect(parsePromptSet({})).toEqual({ jailbreak: '', spec: '', thinking: '' });
  });
});

describe('expandNlSections', () => {
  const text = 'A{{#nl}} 有NL {{/nl}}B{{^nl}} 无NL {{/nl}}C';

  it('开启自然语言时留 #nl 段', () => {
    expect(expandNlSections(text, true)).toBe('A 有NL BC');
  });

  it('关闭时留 ^nl 段', () => {
    expect(expandNlSections(text, false)).toBe('AB 无NL C');
  });

  it('没有宏的文本原样返回', () => {
    expect(expandNlSections('纯文本', true)).toBe('纯文本');
  });
});

describe('buildSpecPreamble', () => {
  it('三份全空 → 空串（我们退回自己的紧凑规则）', () => {
    expect(buildSpecPreamble({ jailbreak: '', spec: '', thinking: '' }, { nl: true })).toBe('');
  });

  it('带规范时，末尾必须有「输出契约优先」，防止照抄规范里的示例字段', () => {
    const out = buildSpecPreamble({ jailbreak: '', spec: '规范正文', thinking: '' }, { nl: true });
    expect(out).toContain('规范正文');
    expect(out).toContain('本任务的输出契约优先');
    expect(out).toContain('不要输出 position');
  });

  it('顺序与柏宝绘一致：破限 → 规范 → 思维链', () => {
    const out = buildSpecPreamble(
      { jailbreak: '破限', spec: '规范', thinking: '思维链' },
      { nl: true },
    );
    expect(out.indexOf('破限')).toBeLessThan(out.indexOf('规范'));
    expect(out.indexOf('规范')).toBeLessThan(out.indexOf('思维链'));
  });
});

describe('readPromptSet：真的从柏宝绘设置里读', () => {
  beforeEach(async () => {
    (globalThis as unknown as Record<string, unknown>).getContext = () => ({
      chat: [],
      extensionSettings: rawSettings({
        naiV5Spec: '# NOVELAI V5 — IMAGE PROMPT GENERATION RULES\n### Minimum Sufficient Prompt',
        naiV5Thinking: '【输出前思考清单】',
      }),
    });
    await initSTEnvironment();
  });

  it('读到用户贴的那份 NAI V5 规范', () => {
    expect(readPromptSet().spec).toContain('NOVELAI V5');
  });

  it('拼出来的前言能直接压在 system 前面', () => {
    const text = specPreambleFor(true);
    expect(text.startsWith('# NOVELAI V5')).toBe(true);
    expect(text).toContain('本任务的输出契约优先');
  });

  it('规范在前、任务协议在后（顺序反了模型会只顾格式）', () => {
    const system = withSpecPreamble('【任务协议】只输出 JSON', true);
    expect(system.indexOf('NOVELAI V5')).toBeLessThan(system.indexOf('【任务协议】'));
  });
});

describe('makeModeLlmCaller：五种模式都必须展开规范里的 nl 段', () => {
  it('设置里 includeNl=false（旧默认且没有 UI）也不许把规范砍一半', async () => {
    const seen: string[] = [];
    (globalThis as unknown as Record<string, unknown>).getContext = () => ({
      chat: [],
      extensionSettings: rawSettings({
        naiV5Spec: '{{#nl}}有自然语言时的规范{{/nl}}{{^nl}}没有 nl 时的规范{{/nl}}',
      }),
      generateQuietPrompt: async (prompt: string) => {
        seen.push(prompt);
        return '';
      },
    });
    await initSTEnvironment();
    const { makeModeLlmCaller } = await import('../src/manga/planGenerator');
    const caller = makeModeLlmCaller({ llmSource: 'main', includeNl: false }, 'illustration');
    await caller('【任务协议】只输出 JSON', '正文');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('有自然语言时的规范');
    expect(seen[0]).not.toContain('没有 nl 时的规范');
  });
});
