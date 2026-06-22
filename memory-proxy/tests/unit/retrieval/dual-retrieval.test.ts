import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, closeDatabase, runAndPersist } from '../../../src/storage/db.js';
import { createSession } from '../../../src/storage/session-store.js';
import { dualRetrieve } from '../../../src/retrieval/dual-retrieval.js';
import { insertFact } from '../../../src/storage/fact-store.js';
import { FactSource } from '../../../src/types/fact.js';
import { getSessionGraph, invalidateGraph } from '../../../src/extraction/graph-builder.js';
import { indexFactKeywords } from '../../../src/storage/fact-keyword-indexer.js';
import { v4 as uuid } from 'uuid';

describe('Dual Retrieval', () => {
  let sessionId: string;

  beforeEach(async () => {
    closeDatabase();
    await initDatabase(':memory:');
    sessionId = createSession('char1', 'chat1', 'main').id;
    invalidateGraph(sessionId);
  });

  it('should retrieve facts via semantic search', async () => {
    const fact1 = insertFact({
      session_id: sessionId, subject_id: 'e_zhangsan', predicate: 'owns',
      object_id: 'e_sword', statement: '张三拥有青龙剑',
      confidence: 0.95, source: FactSource.USER,
      valid_from: 1, valid_to: null, trace_id: 't1',
    });
    indexFactKeywords(fact1.id, fact1.statement);

    const keywordCtx = { entities: [], keywords: [], search_terms: ['张三'], implicit_topics: [] };
    const results = await dualRetrieve(sessionId, {
      entities: ['张三'], locations: [], intents: [], narrativeHooks: [], implicitRules: [],
    }, keywordCtx);

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].type).toBe('fact');
  });

  it('should return empty for empty query', async () => {
    const emptyKeywordCtx = { entities: [], keywords: [], search_terms: [], implicit_topics: [] };
    const results = await dualRetrieve(sessionId, {
      entities: [], locations: [], intents: [], narrativeHooks: [], implicitRules: [],
    }, emptyKeywordCtx);
    expect(results).toHaveLength(0);
  });

  it('should retrieve facts via graph search', async () => {
    // Insert entity so graph builder can create nodes
    runAndPersist(
      'INSERT INTO entities (id, session_id, name, aliases, type, first_seen_round, last_seen_round, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['e_zhangsan', sessionId, '张三', '[]', 'CHARACTER', 1, 1, 1, Date.now(), Date.now()]
    );
    runAndPersist(
      'INSERT INTO entities (id, session_id, name, aliases, type, first_seen_round, last_seen_round, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['e_sword', sessionId, '青龙剑', '[]', 'ITEM', 1, 1, 1, Date.now(), Date.now()]
    );

    insertFact({
      session_id: sessionId, subject_id: 'e_zhangsan', predicate: 'owns',
      object_id: 'e_sword', statement: '张三拥有青龙剑',
      confidence: 0.95, source: FactSource.USER,
      valid_from: 1, valid_to: null, trace_id: 't2',
    });

    // Invalidate graph cache so it rebuilds with the new entities
    invalidateGraph(sessionId);

    const emptyKeywordCtx = { entities: [], keywords: [], search_terms: [], implicit_topics: [] };
    const results = await dualRetrieve(sessionId, {
      entities: ['e_zhangsan'], locations: [], intents: [], narrativeHooks: [], implicitRules: [],
    }, emptyKeywordCtx);

    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('should assign tiers based on score', async () => {
    const fact3 = insertFact({
      session_id: sessionId, subject_id: 'e_zhangsan', predicate: 'owns',
      object_id: 'e_sword', statement: '张三拥有青龙剑',
      confidence: 0.95, source: FactSource.USER,
      valid_from: 1, valid_to: null, trace_id: 't3',
    });
    indexFactKeywords(fact3.id, fact3.statement);

    const keywordCtx = { entities: [], keywords: [], search_terms: ['张三'], implicit_topics: [] };
    const results = await dualRetrieve(sessionId, {
      entities: ['张三'], locations: [], intents: [], narrativeHooks: [], implicitRules: [],
    }, keywordCtx);

    for (const item of results) {
      expect([1, 2, 3]).toContain(item.tier);
    }
  });
});
