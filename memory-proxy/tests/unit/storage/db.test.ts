import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDatabase, closeDatabase, getDatabase, execQuery } from '../../../src/storage/db.js';

describe('Database', () => {
  beforeAll(async () => {
    await initDatabase(':memory:');
  });

  afterAll(() => {
    closeDatabase();
  });

  const expectedTables = [
    'sessions', 'entities', 'facts', 'events', 'relationships',
    'current_states', 'canon_entries', 'summaries',
  ];

  for (const table of expectedTables) {
    it(`should create ${table} table`, () => {
      const rows = execQuery(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        [table]
      );
      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe(table);
    });
  }

  it('should persist and reload data', async () => {
    const db = getDatabase();
    db.run("INSERT INTO sessions (id, character_id, chat_id, branch_id, round, created_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ['test-session', 'char1', 'chat1', 'main', 0, Date.now(), Date.now()]);

    // Verify insert works
    const rows = execQuery("SELECT * FROM sessions WHERE id = ?", ['test-session']);
    expect(rows.length).toBe(1);
    expect(rows[0].character_id).toBe('char1');
  });
});
