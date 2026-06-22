import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, closeDatabase } from '../../../src/storage/db.js';
import { createSession } from '../../../src/storage/session-store.js';
import {
  insertFact, getFact, getFactsBySubject, expireFact,
  getActiveFacts, markTombstone
} from '../../../src/storage/fact-store.js';
import { FactSource } from '../../../src/types/fact.js';

describe('Fact Store', () => {
  let sessionId: string;

  beforeEach(async () => {
    closeDatabase();
    await initDatabase(':memory:');
    sessionId = createSession('char1', 'chat1', 'main').id;
  });

  it('should insert and retrieve a fact', () => {
    const fact = insertFact({
      session_id: sessionId, subject_id: 'e_zhangsan', predicate: 'owns',
      object_id: 'e_qinglongjian', statement: '张三拥有青龙剑',
      confidence: 0.95, source: FactSource.USER,
      valid_from: 10, valid_to: null, trace_id: 'trace-1',
    });
    expect(fact.id).toBeDefined();
    expect(fact.subject_id).toBe('e_zhangsan');
    expect(fact.predicate).toBe('owns');

    const retrieved = getFact(fact.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.statement).toBe('张三拥有青龙剑');
  });

  it('should find facts by subject', () => {
    insertFact({ session_id: sessionId, subject_id: 'e_zhangsan', predicate: 'owns', object_id: 'e_sword', statement: 'owns sword', confidence: 0.8, source: FactSource.USER, valid_from: 1, valid_to: null, trace_id: 't1' });
    insertFact({ session_id: sessionId, subject_id: 'e_zhangsan', predicate: 'located_at', object_id: 'e_inn', statement: 'at inn', confidence: 0.9, source: FactSource.USER, valid_from: 1, valid_to: null, trace_id: 't2' });
    expect(getFactsBySubject(sessionId, 'e_zhangsan')).toHaveLength(2);
  });

  it('should expire a fact by setting valid_to', () => {
    const fact = insertFact({ session_id: sessionId, subject_id: 'e_zhangsan', predicate: 'located_at', object_id: 'e_inn', statement: 'at inn', confidence: 0.9, source: FactSource.USER, valid_from: 1, valid_to: null, trace_id: 't1' });
    expireFact(fact.id, 50);
    expect(getFact(fact.id)!.valid_to).toBe(50);
  });

  it('should only return active facts', () => {
    insertFact({ session_id: sessionId, subject_id: 'e_a', predicate: 'owns', object_id: 'e_x', statement: 'a owns x', confidence: 0.9, source: FactSource.USER, valid_from: 1, valid_to: null, trace_id: 't1' });
    const f2 = insertFact({ session_id: sessionId, subject_id: 'e_b', predicate: 'owns', object_id: 'e_y', statement: 'b owns y', confidence: 0.9, source: FactSource.USER, valid_from: 1, valid_to: null, trace_id: 't2' });
    expireFact(f2.id, 100);
    expect(getActiveFacts(sessionId)).toHaveLength(1);
  });

  it('should upsert on duplicate S-P-O', () => {
    const f1 = insertFact({ session_id: sessionId, subject_id: 'e_a', predicate: 'owns', object_id: 'e_x', statement: 'a owns x', confidence: 0.5, source: FactSource.ASSISTANT, valid_from: 1, valid_to: null, trace_id: 't1' });
    const f2 = insertFact({ session_id: sessionId, subject_id: 'e_a', predicate: 'owns', object_id: 'e_x', statement: 'a still owns x', confidence: 0.9, source: FactSource.USER, valid_from: 5, valid_to: null, trace_id: 't2' });
    expect(f2.id).toBe(f1.id);
    expect(f2.confidence).toBe(0.9);
    expect(f2.occurrence_count).toBe(2);
  });

  it('should mark tombstone', () => {
    const fact = insertFact({ session_id: sessionId, subject_id: 'e_a', predicate: 'owns', object_id: 'e_x', statement: 'x', confidence: 0.5, source: FactSource.USER, valid_from: 1, valid_to: null, trace_id: 't1' });
    markTombstone(fact.id, 'test deletion');
    expect(getFact(fact.id)).toBeNull();
  });
});
