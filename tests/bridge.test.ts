/**
 * 版本比较测试
 */

import { describe, it, expect } from 'vitest';
import { compareVersions } from '../src/baibai/bridge';

describe('compareVersions', () => {
  it('should compare equal versions', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('should compare higher versions', () => {
    expect(compareVersions('1.1.0', '1.0.0')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.1', '1.0.0')).toBeGreaterThan(0);
  });

  it('should compare lower versions', () => {
    expect(compareVersions('0.9.0', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.1')).toBeLessThan(0);
  });

  it('should handle different segment counts', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0.1', '1.0.0')).toBeGreaterThan(0);
  });

  it('should handle non-numeric parts gracefully', () => {
    expect(compareVersions('1.0.0', '1.0.beta')).toBe(0); // beta parsed as 0
  });
});
