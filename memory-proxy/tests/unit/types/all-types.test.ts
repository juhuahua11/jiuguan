import { describe, it, expect } from 'vitest';

describe('Fact', () => {
  it('should have required fields', () => {
    const fact = {
      id: 'f-1', version: 1, created_at: Date.now(), updated_at: Date.now(),
      session_id: 's-1', subject_id: 'e-zhangsan', predicate: 'owns',
      object_id: 'e-sword', statement: '张三拥有青龙剑',
      confidence: 0.95, source: 'USER', occurrence_count: 1,
      valid_from: 10, valid_to: null, trace_id: 't-1',
    };
    expect(fact.subject_id).toBe('e-zhangsan');
    expect(fact.predicate).toBe('owns');
    expect(fact.valid_to).toBeNull();
  });
});

describe('Event', () => {
  it('should have required fields', () => {
    const event = {
      id: 'ev-1', version: 1, created_at: Date.now(), updated_at: Date.now(),
      session_id: 's-1', description: '张三获得青龙剑',
      participants: ['e-zhangsan'], location_id: 'e-inn',
      timestamp_round: 10, caused_by: [], causes: [],
      significance: 'HIGH', trace_id: 't-1',
    };
    expect(event.description).toBe('张三获得青龙剑');
    expect(event.significance).toBe('HIGH');
  });
});

describe('Relationship', () => {
  it('should support evolution entries', () => {
    const rel = {
      id: 'r-1', version: 1, created_at: Date.now(), updated_at: Date.now(),
      session_id: 's-1', subject_id: 'e-zhangsan', object_id: 'e-wangwu',
      relation_type: 'FRIENDSHIP', intensity: 0.5,
      description: '关系很好', evolution: [], trace_id: 't-1',
    };
    expect(rel.intensity).toBe(0.5);
    expect(rel.evolution).toHaveLength(0);
  });
});

describe('CurrentState', () => {
  it('should support state fields with confidence', () => {
    const state = {
      id: 'cs-1', version: 1, created_at: Date.now(), updated_at: Date.now(),
      session_id: 's-1',
      location: { value: '客栈', confidence: 0.9, source: 'USER', updated_round: 5 },
      characters_present: { value: ['张三'], confidence: 1, source: 'USER', updated_round: 5 },
      inventory: { value: [], confidence: 1, source: 'USER', updated_round: 5 },
      pending_questions: [], pending_promises: [], active_quests: [], unresolved_hooks: [],
      last_updated_round: 5,
    };
    expect(state.location.value).toBe('客栈');
    expect(state.location.confidence).toBe(0.9);
  });
});

describe('CanonEntry', () => {
  it('should support conflict policies', () => {
    const canon = {
      id: 'c-1', version: 1, created_at: Date.now(), updated_at: Date.now(),
      session_id: null, tier: 'CORE', category: 'WORLD_RULE',
      statement: '魔法无法复活死人', keywords: ['魔法', '复活'],
      implicit_triggers: ['龙族'], created_by: 'USER',
      is_locked: true, conflict_policy: 'BLOCK', archived_at: null,
    };
    expect(canon.tier).toBe('CORE');
    expect(canon.conflict_policy).toBe('BLOCK');
  });
});

describe('SummaryBlock', () => {
  it('should have level 1-3', () => {
    const summary = {
      id: 'sm-1', version: 1, created_at: Date.now(), updated_at: Date.now(),
      session_id: 's-1', level: 1 as const,
      content: '摘要内容', source_message_range: { from_round: 1, to_round: 20 },
      parent_ids: [], token_count: 500, importance_score: 0.8,
    };
    expect(summary.level).toBe(1);
    expect(summary.importance_score).toBeGreaterThan(0);
  });
});

describe('Session', () => {
  it('should have character, chat, and branch IDs', () => {
    const session = {
      id: 'abc123', character_id: 'char1', chat_id: 'chat1',
      branch_id: 'main', round: 0,
      created_at: Date.now(), last_active_at: Date.now(),
    };
    expect(session.branch_id).toBe('main');
  });
});

describe('ChatMessage', () => {
  it('should have role and content', () => {
    const msg = { role: 'user' as const, content: 'Hello' };
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('Hello');
  });
});

describe('QueryContext', () => {
  it('should support entities and narrative hooks', () => {
    const ctx = {
      entities: ['张三'], locations: ['客栈'],
      intents: ['调查'], narrativeHooks: ['未完成对话'],
      implicitRules: [],
    };
    expect(ctx.entities).toHaveLength(1);
    expect(ctx.narrativeHooks).toContain('未完成对话');
  });
});

describe('Salient', () => {
  it('should classify by type', () => {
    const salient = {
      type: 'state_change' as const,
      statement: '张三获得青龙剑',
      entities_involved: ['张三', '青龙剑'],
      round: 105,
    };
    expect(salient.type).toBe('state_change');
  });
});

describe('ExtractionReport', () => {
  it('should track extraction stats', () => {
    const report = {
      run_id: 'run-1', session_id: 's-1', round: 100,
      timestamp: Date.now(), duration_ms: 1500,
      entities_found: 3, entities_new: 1, state_operations: 2,
      salients_extracted: 4, facts_extracted: 2, facts_blocked_by_canon: 0,
      events_extracted: 1, writes_succeeded: 3, writes_failed: 0,
      errors: [], warnings: [],
    };
    expect(report.facts_extracted).toBe(2);
    expect(report.writes_succeeded).toBe(3);
  });
});

describe('QualityMetrics', () => {
  it('should track memory health', () => {
    const metrics = {
      total_facts: 100, total_events: 200, total_relationships: 30,
      total_entities: 50, total_canon_entries: 5, storage_bytes: 1024000,
      active_conflict_count: 0, duplicate_entity_candidates: 1,
      orphan_graph_nodes: 0, tombstone_count: 10, facts_expiring_soon: 5,
      extraction_success_rate: 0.98, avg_salients_per_cycle: 3.5,
      facts_blocked_by_canon_rate: 0.02,
      retrieval_cache_hit_rate: 0.73, avg_retrieval_latency_ms: 42,
      overall_quality_score: 0.87, warnings: [],
    };
    expect(metrics.overall_quality_score).toBeGreaterThan(0.5);
    expect(metrics.active_conflict_count).toBe(0);
  });
});
