import { describe, it, expect } from 'vitest';
import { RetrievalCache } from '../../../src/retrieval/retrieval-cache.js';

describe('RetrievalCache', () => {
  it('should cache and retrieve entries', () => {
    const cache = new RetrievalCache(60000);
    const key = cache.getCacheKey(['e_a'], [], [], [], []);
    cache.set(key, { facts: ['f1'], events: [], relationships: [], canon_entries: [] });

    const entry = cache.get(key);
    expect(entry).toBeDefined();
    expect(entry!.facts).toContain('f1');
  });

  it('should expire entries after TTL', async () => {
    const cache = new RetrievalCache(1); // 1ms TTL
    const key = cache.getCacheKey(['e_a'], [], [], [], []);
    cache.set(key, { facts: ['f1'], events: [], relationships: [], canon_entries: [] });

    // Wait for expiry
    await new Promise(resolve => setTimeout(resolve, 5));

    const entry = cache.get(key);
    expect(entry).toBeNull();
  });

  it('should produce different keys for different inputs', () => {
    const cache = new RetrievalCache();
    const key1 = cache.getCacheKey(['a'], [], [], [], []);
    const key2 = cache.getCacheKey(['b'], [], [], [], []);
    expect(key1).not.toBe(key2);
  });

  it('should return null for nonexistent key', () => {
    const cache = new RetrievalCache();
    expect(cache.get('nonexistent')).toBeNull();
  });

  it('should clear all entries', () => {
    const cache = new RetrievalCache();
    const key = cache.getCacheKey(['x'], [], [], [], []);
    cache.set(key, { facts: ['f1'], events: [], relationships: [], canon_entries: [] });
    cache.clear();
    expect(cache.get(key)).toBeNull();
  });
});
