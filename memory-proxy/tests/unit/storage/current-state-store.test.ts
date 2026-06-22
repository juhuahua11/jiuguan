import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, closeDatabase } from '../../../src/storage/db.js';
import { createSession } from '../../../src/storage/session-store.js';
import {
  getCurrentState, ensureCurrentState, applyStatePatches
} from '../../../src/storage/current-state-store.js';

describe('Current State Store', () => {
  let sessionId: string;

  beforeEach(async () => {
    closeDatabase();
    await initDatabase(':memory:');
    sessionId = createSession('char1', 'chat1', 'main').id;
  });

  it('should return null when no state exists', () => {
    expect(getCurrentState(sessionId)).toBeNull();
  });

  it('should create default state on ensure', () => {
    const state = ensureCurrentState(sessionId);
    expect(state.session_id).toBe(sessionId);
    expect(state.location.value).toBeNull();
    expect(state.pending_questions).toHaveLength(0);
  });

  it('should apply set_location patch', () => {
    ensureCurrentState(sessionId);
    applyStatePatches(sessionId, [
      { op: 'set_location', value: '京城' },
    ], 10);

    const state = getCurrentState(sessionId)!;
    expect(state.location.value).toBe('京城');
  });

  it('should apply add_inventory patch', () => {
    ensureCurrentState(sessionId);
    applyStatePatches(sessionId, [
      { op: 'add_inventory', item: '青龙剑' },
      { op: 'add_inventory', item: '地图' },
    ], 10);

    const state = getCurrentState(sessionId)!;
    expect(state.inventory.value).toContain('青龙剑');
    expect(state.inventory.value).toContain('地图');
  });

  it('should apply remove_inventory patch', () => {
    ensureCurrentState(sessionId);
    applyStatePatches(sessionId, [
      { op: 'add_inventory', item: '青龙剑' },
    ], 5);
    applyStatePatches(sessionId, [
      { op: 'remove_inventory', item: '青龙剑' },
    ], 10);

    const state = getCurrentState(sessionId)!;
    expect(state.inventory.value).not.toContain('青龙剑');
  });

  it('should add and resolve pending questions', () => {
    ensureCurrentState(sessionId);
    applyStatePatches(sessionId, [
      { op: 'add_question', id: 'q1', text: '青龙剑在哪里？' },
    ], 10);

    let state = getCurrentState(sessionId)!;
    expect(state.pending_questions).toHaveLength(1);
    expect(state.pending_questions[0].description).toBe('青龙剑在哪里？');

    applyStatePatches(sessionId, [
      { op: 'resolve_question', id: 'q1' },
    ], 15);

    state = getCurrentState(sessionId)!;
    expect(state.pending_questions[0].resolved_at_round).toBe(15);
  });

  it('should deduplicate inventory items', () => {
    ensureCurrentState(sessionId);
    applyStatePatches(sessionId, [{ op: 'add_inventory', item: '青龙剑' }], 1);
    applyStatePatches(sessionId, [{ op: 'add_inventory', item: '青龙剑' }], 2);

    const state = getCurrentState(sessionId)!;
    expect(state.inventory.value.filter(i => i === '青龙剑')).toHaveLength(1);
  });
});
