/**
 * 出图 adapter 纯函数测试
 */
import { describe, it, expect } from 'vitest';
import { toBaiBaiRequest } from '../src/baibai/imageAdapter';

describe('toBaiBaiRequest', () => {
  it('assembles the required prompt and defaults', () => {
    const req = toBaiBaiRequest({ prompt: '1girl, smile' });
    expect(req.prompt).toBe('1girl, smile');
    expect(req.size).toBe('portrait');
    expect(req.save).toBe(true);
    expect(req).not.toHaveProperty('nl');
    expect(req).not.toHaveProperty('seed');
  });

  it('maps landscape size', () => {
    expect(toBaiBaiRequest({ prompt: 'x', size: 'landscape' }).size).toBe('landscape');
  });

  it('coerces unknown size to portrait', () => {
    expect(toBaiBaiRequest({ prompt: 'x', size: 'square' }).size).toBe('portrait');
  });

  it('passes through optional fields', () => {
    const req = toBaiBaiRequest({
      prompt: 'x', nl: 'a girl', negative: 'blurry', seed: 123, save: false,
      characters: [{ name: 'A', tag: 'blonde' }],
    }, 'profile-name');
    expect(req.nl).toBe('a girl');
    expect(req.negative).toBe('blurry');
    expect(req.seed).toBe(123);
    expect(req.save).toBe(false);
    expect(req.characters).toHaveLength(1);
    expect(req.character).toBe('profile-name');
  });
});
