import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, closeDatabase, runAndPersist } from '../../../src/storage/db.js';
import { createSession } from '../../../src/storage/session-store.js';
import { insertRelationship, getRelationship, getRelationshipsByEntity, addEvolutionEntry, applyRelationshipSignal, getRecentRelationshipSignals } from '../../../src/storage/relationship-store.js';
import { RelationType } from '../../../src/types/relationship.js';

describe('Relationship Store', () => {
  let sessionId: string;

  beforeEach(async () => {
    closeDatabase();
    await initDatabase(':memory:');
    sessionId = createSession('char1', 'chat1', 'main').id;
  });

  it('should insert and retrieve a relationship', () => {
    const rel = insertRelationship({
      session_id: sessionId, subject_id: 'e_zhangsan', object_id: 'e_wangwu',
      relation_type: RelationType.FRIENDSHIP, intensity: 0.5,
      description: '关系不错', trace_id: 't1',
    });
    expect(rel.id).toBeDefined();
    expect(rel.intensity).toBe(0.5);

    const retrieved = getRelationship(rel.id);
    expect(retrieved!.description).toBe('关系不错');
  });

  it('should find relationships by entity', () => {
    insertRelationship({ session_id: sessionId, subject_id: 'e_zhangsan', object_id: 'e_wangwu', relation_type: RelationType.FRIENDSHIP, trace_id: 't1' });
    insertRelationship({ session_id: sessionId, subject_id: 'e_lisi', object_id: 'e_zhangsan', relation_type: RelationType.HOSTILITY, trace_id: 't2' });

    const rels = getRelationshipsByEntity(sessionId, 'e_zhangsan');
    expect(rels).toHaveLength(2);
  });

  it('should upsert on duplicate subject+object+type', () => {
    const r1 = insertRelationship({ session_id: sessionId, subject_id: 'e_a', object_id: 'e_b', relation_type: RelationType.FRIENDSHIP, intensity: 0.3, trace_id: 't1' });
    const r2 = insertRelationship({ session_id: sessionId, subject_id: 'e_a', object_id: 'e_b', relation_type: RelationType.FRIENDSHIP, intensity: 0.7, trace_id: 't2' });
    expect(r2.id).toBe(r1.id);
    expect(r2.intensity).toBe(0.7);
  });

  it('should append evolution entries', () => {
    const rel = insertRelationship({ session_id: sessionId, subject_id: 'e_a', object_id: 'e_b', relation_type: RelationType.FRIENDSHIP, trace_id: 't1' });
    addEvolutionEntry(rel.id, { round: 10, timestamp: Date.now(), change_desc: '帮了一次忙', intensity_delta: 0.15 });

    const updated = getRelationship(rel.id)!;
    expect(updated.evolution).toHaveLength(1);
    expect(updated.evolution[0].change_desc).toBe('帮了一次忙');
  });

  it('should cap evolution at 50 entries, keeping the latest 50', () => {
    const rel = insertRelationship({ session_id: sessionId, subject_id: 'e_a', object_id: 'e_b', relation_type: RelationType.FRIENDSHIP, trace_id: 't1' });
    for (let i = 0; i < 51; i++) {
      addEvolutionEntry(rel.id, { round: i, timestamp: Date.now(), change_desc: `entry ${i}`, intensity_delta: 0.01 });
    }
    const updated = getRelationship(rel.id)!;
    expect(updated.evolution).toHaveLength(50);
    expect(updated.evolution[0].change_desc).toBe('entry 1');
    expect(updated.evolution[49].change_desc).toBe('entry 50');
  });

  it('should not trim when evolution has exactly 50 entries', () => {
    const rel = insertRelationship({ session_id: sessionId, subject_id: 'e_a', object_id: 'e_b', relation_type: RelationType.FRIENDSHIP, trace_id: 't1' });
    for (let i = 0; i < 50; i++) {
      addEvolutionEntry(rel.id, { round: i, timestamp: Date.now(), change_desc: `entry ${i}`, intensity_delta: 0.01 });
    }
    const updated = getRelationship(rel.id)!;
    expect(updated.evolution).toHaveLength(50);
    expect(updated.evolution[0].change_desc).toBe('entry 0');
  });

  it('should treat corrupted evolution JSON as empty array', () => {
    const rel = insertRelationship({ session_id: sessionId, subject_id: 'e_a', object_id: 'e_b', relation_type: RelationType.FRIENDSHIP, trace_id: 't1' });
    runAndPersist('UPDATE relationships SET evolution = ? WHERE id = ?', ['not valid json{', rel.id]);
    addEvolutionEntry(rel.id, { round: 1, timestamp: Date.now(), change_desc: 'after corrupt', intensity_delta: 0.1 });
    const updated = getRelationship(rel.id)!;
    expect(updated.evolution).toHaveLength(1);
    expect(updated.evolution[0].change_desc).toBe('after corrupt');
  });

  describe('applyRelationshipSignal', () => {
    it('should INSERT on first signal with clamped delta', () => {
      const rel = applyRelationshipSignal({
        session_id: sessionId, subject_id: 'e_a', object_id: 'e_b',
        relation_type: RelationType.ROMANCE, intensityDelta: 0.25,
        description: '表白', signalType: 'confession', round: 5, trace_id: 't1',
      });
      expect(rel.intensity).toBeCloseTo(0.25);
      expect(rel.evolution).toHaveLength(1);
      // change_desc encodes signalType as `[type] description` so getRecentRelationshipSignals can recover the type.
      expect(rel.evolution[0].change_desc).toBe('[confession] 表白');
      expect(rel.evolution[0].intensity_delta).toBeCloseTo(0.25);
    });

    it('should ACCUMULATE delta on subsequent signal (not overwrite)', () => {
      applyRelationshipSignal({
        session_id: sessionId, subject_id: 'e_a', object_id: 'e_b',
        relation_type: RelationType.ROMANCE, intensityDelta: 0.25,
        description: '表白', signalType: 'confession', round: 5, trace_id: 't1',
      });
      const rel2 = applyRelationshipSignal({
        session_id: sessionId, subject_id: 'e_a', object_id: 'e_b',
        relation_type: RelationType.ROMANCE, intensityDelta: 0.10,
        description: '送礼', signalType: 'gift_exchange', round: 7, trace_id: 't2',
      });
      expect(rel2.intensity).toBeCloseTo(0.35);
      expect(rel2.evolution).toHaveLength(2);
    });

    it('should clamp accumulated intensity at +1', () => {
      let rel = applyRelationshipSignal({
        session_id: sessionId, subject_id: 'e_a', object_id: 'e_b',
        relation_type: RelationType.FRIENDSHIP, intensityDelta: 0.6,
        description: 'big', signalType: 'saved_life', round: 1, trace_id: 't1',
      });
      rel = applyRelationshipSignal({
        session_id: sessionId, subject_id: 'e_a', object_id: 'e_b',
        relation_type: RelationType.FRIENDSHIP, intensityDelta: 0.6,
        description: 'big2', signalType: 'saved_life', round: 2, trace_id: 't2',
      });
      expect(rel.intensity).toBe(1);
    });

    it('should clamp accumulated intensity at -1', () => {
      let rel = applyRelationshipSignal({
        session_id: sessionId, subject_id: 'e_a', object_id: 'e_b',
        relation_type: RelationType.HOSTILITY, intensityDelta: -0.6,
        description: 'bad', signalType: 'betrayal', round: 1, trace_id: 't1',
      });
      rel = applyRelationshipSignal({
        session_id: sessionId, subject_id: 'e_a', object_id: 'e_b',
        relation_type: RelationType.HOSTILITY, intensityDelta: -0.6,
        description: 'bad2', signalType: 'betrayal', round: 2, trace_id: 't2',
      });
      expect(rel.intensity).toBe(-1);
    });

    it('should update description on existing relationship', () => {
      applyRelationshipSignal({
        session_id: sessionId, subject_id: 'e_a', object_id: 'e_b',
        relation_type: RelationType.ROMANCE, intensityDelta: 0.25,
        description: '表白', signalType: 'confession', round: 5, trace_id: 't1',
      });
      const rel2 = applyRelationshipSignal({
        session_id: sessionId, subject_id: 'e_a', object_id: 'e_b',
        relation_type: RelationType.ROMANCE, intensityDelta: 0.10,
        description: '最新描述', signalType: 'gift_exchange', round: 7, trace_id: 't2',
      });
      expect(rel2.description).toBe('最新描述');
    });
  });

  describe('getRecentRelationshipSignals', () => {
    it('returns recent evolution entries paired with actor/target, newest first', () => {
      applyRelationshipSignal({
        session_id: sessionId, subject_id: 'e_a', object_id: 'e_b',
        relation_type: RelationType.ROMANCE, intensityDelta: 0.25,
        description: '表白', signalType: 'confession', round: 5, trace_id: 't1',
      });
      applyRelationshipSignal({
        session_id: sessionId, subject_id: 'e_a', object_id: 'e_b',
        relation_type: RelationType.ROMANCE, intensityDelta: 0.10,
        description: '送礼', signalType: 'gift_exchange', round: 7, trace_id: 't2',
      });
      const recent = getRecentRelationshipSignals(sessionId, 10);
      expect(recent).toHaveLength(2);
      // Newest first (round 7 before round 5)
      expect(recent[0].round).toBe(7);
      expect(recent[0].actor).toBe('e_a');
      expect(recent[0].target).toBe('e_b');
      expect(recent[0].type).toBe('gift_exchange');
      expect(recent[1].round).toBe(5);
    });

    it('returns empty array when no relationships exist', () => {
      const recent = getRecentRelationshipSignals(sessionId, 10);
      expect(recent).toEqual([]);
    });
  });
});
