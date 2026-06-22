import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, closeDatabase } from '../../../src/storage/db.js';
import { SessionManager } from '../../../src/session/session-manager.js';

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(async () => {
    closeDatabase();
    await initDatabase(':memory:');
    manager = new SessionManager();
  });

  it('should resolve or create a session', () => {
    const session = manager.resolve('charA', 'chat1', 'main');
    expect(session.character_id).toBe('charA');
    expect(session.branch_id).toBe('main');
  });

  it('should return same session for same IDs', () => {
    const s1 = manager.resolve('charA', 'chat1', 'main');
    const s2 = manager.resolve('charA', 'chat1', 'main');
    expect(s1.id).toBe(s2.id);
  });

  it('should isolate sessions by branch', () => {
    const main = manager.resolve('charA', 'chat1', 'main');
    const alt = manager.resolve('charA', 'chat1', 'altRoute');
    expect(main.id).not.toBe(alt.id);
  });

  it('should track and increment round', () => {
    const session = manager.resolve('charA', 'chat1', 'main');
    expect(session.round).toBe(0);
    manager.incrementRound(session.id);
    const updated = manager.resolve('charA', 'chat1', 'main');
    expect(updated.round).toBe(1);
  });
});
