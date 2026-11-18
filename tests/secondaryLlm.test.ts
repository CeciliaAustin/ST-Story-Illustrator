import { describe, it, expect } from 'vitest';
import {
  normalizeChannel,
  parseSharedChannels,
  resolveChannelId,
  buildChannelRequestBody,
  extractCompletionText,
  type ApiChannel,
} from '../src/baibai/secondaryLlm';

const base: ApiChannel = {
  id: 'ch_nai5',
  name: 'NAI5',
  url: 'https://example.com/v1',
  key: 'sk-test',
  model: 'nai5',
  temperature: 0.7,
  maxTokens: 2048,
  timeoutSec: 120,
  stream: false,
  excludeParams: [],
  reasoningEffort: '',
};

describe('normalizeChannel', () => {
  it('fills defaults for missing fields', () => {
    const ch = normalizeChannel({ id: 'x', url: 'https://a/v1' })!;
    expect(ch.name).toBe('x');
    expect(ch.temperature).toBe(1);
    expect(ch.maxTokens).toBe(65535);
    expect(ch.timeoutSec).toBe(180);
    expect(ch.excludeParams).toEqual([]);
    expect(ch.reasoningEffort).toBe('');
  });

  it('rejects entries without id or url', () => {
    expect(normalizeChannel({ url: 'https://a' })).toBeNull();
    expect(normalizeChannel({ id: 'x' })).toBeNull();
    expect(normalizeChannel(null)).toBeNull();
  });

  it('keeps BaiBai-specific fields', () => {
    const ch = normalizeChannel({ ...base, reasoningEffort: 'high', excludeParams: [' temperature '] })!;
    expect(ch.reasoningEffort).toBe('high');
    expect(ch.excludeParams).toEqual(['temperature']);
  });
});

describe('parseSharedChannels', () => {
  it('reads wrapped store and bare array', () => {
    expect(parseSharedChannels({ channels: [base] }).map(c => c.id)).toEqual(['ch_nai5']);
    expect(parseSharedChannels([base]).map(c => c.id)).toEqual(['ch_nai5']);
  });

  it('deduplicates and skips invalid entries', () => {
    const list = parseSharedChannels({ channels: [base, base, { id: '', url: '' }, null] });
    expect(list).toHaveLength(1);
  });

  it('returns empty for junk', () => {
    expect(parseSharedChannels(undefined)).toEqual([]);
    expect(parseSharedChannels('nope')).toEqual([]);
  });
});

describe('resolveChannelId', () => {
  it('prefers per-mode mapping', () => {
    expect(resolveChannelId('comic', { comic: 'ch_nai45' }, 'main')).toBe('ch_nai45');
  });

  it('falls back to global source', () => {
    expect(resolveChannelId('comic', {}, 'main')).toBe('main');
    expect(resolveChannelId('comic', {}, 'auto')).toBe('tagGen');
    expect(resolveChannelId('comic', undefined, undefined)).toBe('tagGen');
  });

  it('honors explicit main and tagGen', () => {
    expect(resolveChannelId('illustration', { illustration: 'main' }, 'auto')).toBe('main');
    expect(resolveChannelId('illustration', { illustration: 'tagGen' }, 'main')).toBe('tagGen');
  });
});

describe('buildChannelRequestBody', () => {
  const messages = [{ role: 'system', content: 's' }];

  it('uses BaiBai openai source with reverse_proxy by default', () => {
    const body = buildChannelRequestBody(base, messages);
    expect(body.chat_completion_source).toBe('openai');
    expect(body.reverse_proxy).toBe('https://example.com/v1');
    expect(body.proxy_password).toBe('sk-test');
    expect(body).not.toHaveProperty('custom_url');
    expect(body).toMatchObject({ model: 'nai5', max_tokens: 2048, temperature: 0.7 });
  });

  it('switches to custom source when reasoning effort is set', () => {
    const body = buildChannelRequestBody({ ...base, reasoningEffort: 'high' }, messages);
    expect(body.chat_completion_source).toBe('custom');
    expect(body.custom_url).toBe('https://example.com/v1');
    expect(JSON.parse(String(body.custom_include_body))).toEqual({ reasoning_effort: 'high' });
    expect(JSON.parse(String(body.custom_include_headers))).toEqual({ Authorization: 'Bearer sk-test' });
  });

  it('removes excluded params', () => {
    const body = buildChannelRequestBody(
      { ...base, excludeParams: ['temperature', ' max_tokens '] },
      messages,
    );
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('max_tokens');
  });
});

describe('extractCompletionText', () => {
  it('reads message content', () => {
    expect(extractCompletionText({ choices: [{ message: { content: ' 你好 ' } }] })).toBe('你好');
  });

  it('reads legacy text field', () => {
    expect(extractCompletionText({ choices: [{ text: 'legacy' }] })).toBe('legacy');
  });

  it('reads multimodal parts', () => {
    expect(extractCompletionText({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }] })).toBe('ab');
  });

  it('returns null on error or empty', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(extractCompletionText({ error: { message: 'bad' } })).toBeNull();
    spy.mockRestore();
    expect(extractCompletionText({})).toBeNull();
    expect(extractCompletionText(null)).toBeNull();
  });
});
