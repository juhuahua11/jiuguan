import { describe, it, expect, beforeEach } from 'vitest';
import { nextVersion, getCurrentVersion, isStaleVersion, resetVersion } from '../../../src/worker/version-lock.js';

describe('VersionLock', () => {
  beforeEach(() => {
    resetVersion('s1');
    resetVersion('s2');
  });

  it('should start at 0', () => {
    expect(getCurrentVersion('s1')).toBe(0);
  });

  it('should increment monotonically', () => {
    expect(nextVersion('s1')).toBe(1);
    expect(nextVersion('s1')).toBe(2);
    expect(getCurrentVersion('s1')).toBe(2);
  });

  it('should detect stale versions', () => {
    nextVersion('s1'); // 1
    nextVersion('s1'); // 2
    nextVersion('s1'); // 3
    expect(isStaleVersion('s1', 1)).toBe(true);
    expect(isStaleVersion('s1', 3)).toBe(false);
    expect(isStaleVersion('s1', 5)).toBe(false);
  });

  it('should isolate sessions', () => {
    nextVersion('s1'); // 1
    nextVersion('s2'); // 1
    expect(getCurrentVersion('s1')).toBe(1);
    expect(getCurrentVersion('s2')).toBe(1);
  });

  it('should reset', () => {
    nextVersion('s1');
    resetVersion('s1');
    expect(getCurrentVersion('s1')).toBe(0);
  });
});
