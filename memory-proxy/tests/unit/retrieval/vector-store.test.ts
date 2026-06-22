import { describe, it, expect } from 'vitest';
import { VectorStore } from '../../../src/storage/vector-store.js';

describe('VectorStore', () => {
  it('should start empty', async () => {
    const store = new VectorStore();
    expect(await store.count()).toBe(0);
  });

  it('should add and query vectors', async () => {
    const store = new VectorStore();
    await store.add('a', [1, 0, 0]);
    await store.add('b', [0, 1, 0]);
    await store.add('c', [0.9, 0.1, 0]);

    const results = await store.query([1, 0, 0], 2);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('a'); // Most similar
    expect(results[0].score).toBeGreaterThan(0.9);
  });

  it('should replace entries with same ID', async () => {
    const store = new VectorStore();
    await store.add('x', [1, 0, 0]);
    await store.add('x', [0, 1, 0]);
    expect(await store.count()).toBe(1);

    const results = await store.query([0, 1, 0], 1);
    expect(results[0].id).toBe('x');
  });

  it('should delete entries', async () => {
    const store = new VectorStore();
    await store.add('a', [1, 0, 0]);
    await store.delete('a');
    expect(await store.count()).toBe(0);
  });

  it('should handle empty store queries', async () => {
    const store = new VectorStore();
    const results = await store.query([1, 0, 0], 5);
    expect(results).toHaveLength(0);
  });

  it('should batch add entries', async () => {
    const store = new VectorStore();
    await store.addBatch([
      { id: 'a', vector: [1, 0, 0] },
      { id: 'b', vector: [0, 1, 0] },
    ]);
    expect(await store.count()).toBe(2);
  });

  it('should clear all entries', async () => {
    const store = new VectorStore();
    await store.add('a', [1, 0, 0]);
    await store.add('b', [0, 1, 0]);
    await store.clear();
    expect(await store.count()).toBe(0);
  });

  it('should return score of 0 for different-length vectors', async () => {
    const store = new VectorStore();
    await store.add('a', [1, 0, 0]);
    const results = await store.query([1, 0], 1);
    expect(results[0].score).toBe(0);
  });
});
