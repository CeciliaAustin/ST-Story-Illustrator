import { describe, it, expect } from 'vitest';
import {
  detectModelFamily,
  parseEndpoints,
  parsePlans,
  parseOutConfig,
  moneySavingHint,
} from '../src/baibai/planConfig';

const settings = {
  defaultBackend: 'nai',
  nai: {
    endpoints: [
      { id: 'ep1', name: '拼车', url: 'https://nai.tiaoshu.de', key: 'sk-1' },
      { id: 'ep2', name: '官方', url: 'https://image.novelai.net', key: '' },
      { id: '', name: 'bad', url: 'x' },
    ],
    plans: [
      { id: 'p1', name: '风乎', model: 'nai-diffusion-5-full', endpointId: 'ep1', portraitSize: '832×1216' },
      { id: 'p2', name: '省钱', model: 'nai-diffusion-4-5-full', endpointId: 'ep2', portraitSize: '1024×1024' },
      { id: '', name: 'bad', model: 'x', endpointId: 'ep1' },
    ],
    activePlanId: 'p1',
  },
};

describe('detectModelFamily', () => {
  it('detects NAI5 / 4.5 / 4', () => {
    expect(detectModelFamily('nai-diffusion-5-full')).toBe('5');
    expect(detectModelFamily('nai-diffusion-4-5-full')).toBe('4.5');
    expect(detectModelFamily('nai-diffusion-4-full')).toBe('4');
    expect(detectModelFamily('something-weird')).toBe('unknown');
  });
});

describe('parseEndpoints', () => {
  it('parses and hides keys', () => {
    const eps = parseEndpoints(settings.nai.endpoints);
    expect(eps).toHaveLength(2);
    expect(eps[0]).toMatchObject({ id: 'ep1', name: '拼车', hasKey: true });
    expect(eps[1]).toMatchObject({ id: 'ep2', hasKey: false });
    expect(eps[0]).not.toHaveProperty('key');
  });

  it('tolerates junk', () => {
    expect(parseEndpoints(undefined)).toEqual([]);
    expect(parseEndpoints('x')).toEqual([]);
  });
});

describe('parsePlans', () => {
  it('joins endpoint names and sizes', () => {
    const eps = parseEndpoints(settings.nai.endpoints);
    const plans = parsePlans(settings.nai.plans, eps);
    expect(plans).toHaveLength(2);
    expect(plans[0]).toMatchObject({
      name: '风乎', model: 'nai-diffusion-5-full', endpointName: '拼车',
      modelFamily: '5', portraitSize: '832×1216',
    });
    expect(plans[1].endpointName).toBe('官方');
  });
});

describe('parseOutConfig', () => {
  it('resolves active plan with fallback', () => {
    const snap = parseOutConfig(settings);
    expect(snap.activePlanId).toBe('p1');
    expect(snap.activePlanName).toBe('风乎');
    expect(snap.activeEndpointConfigured).toBe(true);
    expect(snap.plans).toHaveLength(2);
    expect(snap.endpoints).toHaveLength(2);
  });

  it('falls back to first plan on dangling id', () => {
    const snap = parseOutConfig({ ...settings, nai: { ...settings.nai, activePlanId: 'gone' } });
    expect(snap.activePlanName).toBe('风乎');
  });

  it('handles empty settings', () => {
    const snap = parseOutConfig(undefined);
    expect(snap.plans).toEqual([]);
    expect(snap.activePlanName).toBe('');
  });
});

describe('moneySavingHint', () => {
  it('warns when on NAI5 but cheaper plan exists', () => {
    const snap = parseOutConfig(settings);
    expect(moneySavingHint(snap)).toContain('NAI5');
  });

  it('silent when no cheaper option', () => {
    const only5 = parseOutConfig({
      nai: { ...settings.nai, plans: [settings.nai.plans[0]] },
    });
    expect(moneySavingHint(only5)).toBe('');
  });
});
