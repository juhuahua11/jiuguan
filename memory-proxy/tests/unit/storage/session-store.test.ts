import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, closeDatabase } from '../../../src/storage/db.js';
import { createSession, getSession, updateSessionRound } from '../../../src/storage/session-store.js';

describe('Session Store', () => {
  beforeEach(async () => {
    closeDatabase();
    await initDatabase(':memory:');
  });

  it('should create and retrieve a session', () => {
    const session = createSession('char1', 'chat1', 'main');
    expect(session.character_id).toBe('char1');
    expect(session.chat_id).toBe('chat1');
    expect(session.branch_id).toBe('main');
    expect(session.round).toBe(0);

    const retrieved = getSession(session.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.character_id).toBe('char1');
  });

  it('should create sessions with different branches isolated', () => {
    const s1 = createSession('char1', 'chat1', 'main');
    const s2 = createSession('char1', 'chat1', 'routeB');
    expect(s1.id).not.toBe(s2.id);
    expect(getSession(s1.id)!.branch_id).toBe('main');
    expect(getSession(s2.id)!.branch_id).toBe('routeB');
  });

  it('should update session round', () => {
    const session = createSession('char1', 'chat1', 'main');
    updateSessionRound(session.id, 42);
    const updated = getSession(session.id);
    expect(updated!.round).toBe(42);
  });

  it('should return null for unknown session', () => {
    expect(getSession('nonexistent')).toBeNull();
  });
});
