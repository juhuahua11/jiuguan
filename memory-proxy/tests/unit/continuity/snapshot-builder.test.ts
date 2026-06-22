import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, closeDatabase, runAndPersist } from '../../../src/storage/db.js';
import { createSession } from '../../../src/storage/session-store.js';
import { ensureCurrentState, applyStatePatches } from '../../../src/storage/current-state-store.js';
import { insertEvent } from '../../../src/storage/event-store.js';
import { insertFact } from '../../../src/storage/fact-store.js';
import { insertRelationship } from '../../../src/storage/relationship-store.js';
import { FactSource } from '../../../src/types/fact.js';
import { RelationType } from '../../../src/types/relationship.js';
import { buildContinuitySnapshot } from '../../../src/continuity/snapshot-builder.js';

describe('Continuity snapshot builder', () => {
  let sessionId: string;

  beforeEach(async () => {
    closeDatabase();
    await initDatabase(':memory:');
    sessionId = createSession('char1', 'chat1', 'main').id;
  });

  it('builds a continuity snapshot from current DB state', async () => {
    ensureCurrentState(sessionId);
    applyStatePatches(sessionId, [
      { op: 'set_location', value: 'Moon Gate' },
      { op: 'add_character', item: 'Seraphina' },
      { op: 'add_character', item: 'User' },
      { op: 'add_inventory', item: 'silver key' },
      { op: 'add_question', id: 'q1', text: 'Who guards the Moon Gate?' },
      { op: 'add_promise', id: 'p1', text: 'Seraphina promised to reveal the password.' },
      { op: 'add_quest', id: 't1', text: 'Reach the inner sanctum.' },
      { op: 'add_hook', id: 'h1', text: 'The gate hums when the silver key is near.' },
    ], 12);

    insertEvent({
      session_id: sessionId,
      description: 'Seraphina accepted the user as an ally at the Moon Gate.',
      participants: '["Seraphina","User"]',
      location_id: 'Moon Gate',
      significance: 'HIGH',
      timestamp_round: 12,
      trace_id: 'trace-event-1',
    });

    insertFact({
      session_id: sessionId,
      subject_id: 'user',
      predicate: 'carries',
      object_id: null,
      statement: 'The user carries the silver key.',
      confidence: 0.95,
      source: FactSource.USER,
      valid_from: 12,
      valid_to: null,
      trace_id: 'trace-fact-1',
    });

    insertRelationship({
      session_id: sessionId,
      subject_id: 'Seraphina',
      object_id: 'User',
      relation_type: RelationType.ALLIANCE,
      description: 'Seraphina treats the user as a trusted ally.',
      intensity: 0.8,
      trace_id: 'trace-rel-1',
    });

    await runAndPersist(
      `INSERT INTO canon_entries (id, session_id, tier, category, statement, keywords, implicit_triggers, created_by, is_locked, conflict_policy, created_at, updated_at)
       VALUES (?, ?, 'CORE', 'WORLD_RULE', ?, '["Moon Gate"]', '["silver key"]', 'USER', 1, 'BLOCK', ?, ?)`,
      ['canon-1', sessionId, 'The Moon Gate opens only for those carrying the silver key.', Date.now(), Date.now()]
    );

    const snapshot = await buildContinuitySnapshot(sessionId, {
      sourceRound: 12,
      recentMessages: [
        { role: 'user', content: 'We should trust Seraphina for now.' },
        { role: 'assistant', content: 'The Moon Gate is finally within reach.' },
      ],
    });

    expect(snapshot.scene.location).toBe('Moon Gate');
    expect(snapshot.unresolved.pending_promises).toContain('Seraphina promised to reveal the password.');
    expect(snapshot.timeline.length).toBeGreaterThan(0);
    expect(snapshot.timeline.some(entry => entry.description.includes('accepted the user as an ally'))).toBe(true);
    expect(snapshot.relationships.some(rel => rel.description.includes('trusted ally'))).toBe(true);
    expect(snapshot.protagonist.assets.some(asset => asset.includes('silver key'))).toBe(true);
    expect(snapshot.compact_text).toContain('[当前场景]');
    expect(snapshot.medium_text.length).toBeGreaterThan(snapshot.compact_text.length);
    expect(snapshot.full_text.length).toBeGreaterThan(snapshot.medium_text.length);
  });

  it('renders characters_present as names not raw entity ids', async () => {
    // Seed an entity so id→name resolution can work.
    await runAndPersist(
      `INSERT INTO entities (id, session_id, name, aliases, type, first_seen_round, last_seen_round, version, created_at, updated_at)
       VALUES ('e_sera', ?, 'Seraphina', '[]', 'CHARACTER', 1, 1, 1, 0, 0)`,
      [sessionId]
    );
    ensureCurrentState(sessionId);
    // Store the id (not the name) in characters_present — this is what the RS stage does.
    applyStatePatches(sessionId, [
      { op: 'add_character', item: 'e_sera' },
    ], 5);

    const snapshot = await buildContinuitySnapshot(sessionId, { sourceRound: 5, recentMessages: [] });
    // The snapshot should show the name, not the raw hash id.
    expect(snapshot.scene.characters_present).toContain('Seraphina');
    expect(snapshot.scene.characters_present).not.toContain('e_sera');
    expect(snapshot.compact_text).toContain('Seraphina');
    expect(snapshot.compact_text).not.toContain('e_sera');
  });
});
