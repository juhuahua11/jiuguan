import { describe, it, expect } from 'vitest';
import { initDatabase, execQuery } from '../../src/storage/db.js';

describe('V4.1 Schema Verification', () => {
  it('fact_type column exists on facts table', async () => {
    await initDatabase(':memory:');
    const cols = execQuery("PRAGMA table_info('facts')") as any[];
    const names = cols.map((c: any) => c.name);
    expect(names).toContain('fact_type');
  });

  it('fact_keywords table exists with both indexes', async () => {
    const tables = execQuery("SELECT name FROM sqlite_master WHERE type='table'") as any[];
    expect(tables.some((t: any) => t.name === 'fact_keywords')).toBe(true);

    const indexes = execQuery("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%fact_keywords%'") as any[];
    console.log('indexes:', indexes.map((i: any) => i.name));
    // 2 created indexes + possibly 1 auto-index from PRIMARY KEY
    expect(indexes.length).toBeGreaterThanOrEqual(2);
  });
});
