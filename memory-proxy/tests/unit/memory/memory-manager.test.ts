import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, closeDatabase } from '../../../src/storage/db.js';
import { createSession } from '../../../src/storage/session-store.js';
import { WorkingMemory } from '../../../src/session/working-memory.js';
import { MemoryManager } from '../../../src/memory/memory-manager.js';
import { TokenBudgetManager } from '../../../src/budget/token-budget.js';
import { ProviderCapabilities } from '../../../src/types/provider.js';
import { runAndPersist } from '../../../src/storage/db.js';
import { insertEvent } from '../../../src/storage/event-store.js';
import { insertRelationship as upsertRelationship } from '../../../src/storage/relationship-store.js';
import { v4 as uuid } from 'uuid';

const caps: ProviderCapabilities = {
  contextWindow: 100000, maxOutputTokens: 8192, supportsSystemRole: true,
  supportsToolCall: true, supportsJsonMode: true, supportsReasoning: false,
};

const tightCaps: ProviderCapabilities = {
  contextWindow: 60, maxOutputTokens: 4096, supportsSystemRole: true,
  supportsToolCall: true, supportsJsonMode: true, supportsReasoning: false,
};

function buildLongText(prefix: string, count: number): string {
  return Array.from({ length: count }, (_unused, index) => `${prefix}${index}`).join(' ');
}

describe('MemoryManager', () => {
  let manager: MemoryManager;
  let sessionId: string;

async function seedGraphRetrievalMemory(): Promise<void> {
  const now = Date.now();
  await runAndPersist(
    `INSERT INTO entities (id, session_id, name, aliases, type, first_seen_round, last_seen_round, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'CHARACTER', 1, 1, ?, ?)`,
      ['entity-seraphina', sessionId, 'Seraphina', '[]', now, now]
  );
  insertEvent({
    session_id: sessionId,
    description: 'Seraphina promised to guide the user through the moon gate.',
    participants: JSON.stringify(['entity-seraphina']),
    significance: 'HIGH',
    timestamp_round: 12,
    trace_id: 'trace-event-seraphina',
  });
  upsertRelationship({
    session_id: sessionId,
    subject_id: 'entity-seraphina',
    object_id: 'user',
    relation_type: 'TRUST' as any,
    intensity: 0.78,
    description: 'Seraphina trusts the user after they protected her secret.',
    evolution: [],
    metrics: null,
    trace_id: 'trace-rel-seraphina',
  } as any);
}

  beforeEach(async () => {
    closeDatabase();
    await initDatabase(':memory:');
    sessionId = createSession('char1', 'chat1', 'main').id;
    manager = new MemoryManager(new TokenBudgetManager(caps));
  });

  it('should assemble context with working memory', async () => {
    const wm = new WorkingMemory(8000);
    wm.append({ role: 'user', content: '你好' });
    wm.append({ role: 'assistant', content: '你好！' });

    const emptyKeywordCtx = { entities: [], keywords: [], search_terms: [], implicit_topics: [] };
    const context = await manager.assembleContext(sessionId, wm, emptyKeywordCtx);
    expect(context.messages.length).toBeGreaterThanOrEqual(2);
    expect(context.budget_breakdown).toBeDefined();
  });

  it('injects retrieved events and relationships alongside facts', async () => {
    await seedGraphRetrievalMemory();
    const wm = new WorkingMemory(8000);
    wm.append({ role: 'user', content: 'Seraphina wants to continue from the moon gate.' });

    const context = await manager.assembleContext(
      sessionId,
      wm,
      { entities: ['Seraphina'], keywords: [], search_terms: [], implicit_topics: [] },
      { trace: true }
    );

    const systemContent = context.messages[0].content;
    expect(systemContent).toContain('[事件]');
    expect(systemContent).toContain('Seraphina promised to guide the user through the moon gate.');
    expect(systemContent).toContain('[关系]');
    expect(systemContent).toContain('Seraphina trusts the user after they protected her secret.');
    expect(context.budget_breakdown.events).toBeGreaterThan(0);
    expect(context.budget_breakdown.relationships).toBeGreaterThan(0);

    const eventTrace = context.retrieval!.items.find(item => item.type === 'event');
    const relationshipTrace = context.retrieval!.items.find(item => item.type === 'relationship');
    expect(eventTrace?.injected).toBe(true);
    expect(relationshipTrace?.injected).toBe(true);
    expect(context.retrieval?.queryContext.entities).toContain('entity-seraphina');
    expect(context.retrieval?.keywordContext.entities).toContain('Seraphina');
    expect(context.retrieval?.budget).toEqual(context.budget_breakdown);
    expect(context.retrieval?.summary.cache.mode).toBe('fresh');
    expect(context.retrieval?.summary.events.injected).toBeGreaterThan(0);
    expect(context.retrieval?.summary.relationships.injected).toBeGreaterThan(0);

    const cachedContext = await manager.assembleContext(
      sessionId,
      wm,
      { entities: ['Seraphina'], keywords: [], search_terms: [], implicit_topics: [] },
      { trace: true }
    );

    expect(cachedContext.retrieval?.summary.cache.mode).toBe('cache-reconstructed');
    expect(cachedContext.retrieval!.items.some(item => item.source === 'cache-reconstructed')).toBe(true);
  });

  it('does not inject an overlong first event when it exceeds the event budget', async () => {
    const now = Date.now();
    await runAndPersist(
      `INSERT INTO entities (id, session_id, name, aliases, type, first_seen_round, last_seen_round, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'CHARACTER', 1, 1, ?, ?)`,
      ['entity-seraphina', sessionId, 'Seraphina', '[]', now, now]
    );

    const longDescription = buildLongText('eventlong', 120);
    insertEvent({
      session_id: sessionId,
      description: longDescription,
      participants: JSON.stringify(['entity-seraphina']),
      significance: 'CRITICAL',
      timestamp_round: 12,
      trace_id: 'trace-event-long',
    });
    for (let i = 0; i < 5; i++) {
      insertEvent({
        session_id: sessionId,
        description: `short-event-${i}`,
        participants: JSON.stringify(['entity-seraphina']),
        significance: 'LOW',
        timestamp_round: 20 + i,
        trace_id: `trace-event-short-${i}`,
      });
    }

    const wm = new WorkingMemory(8000);
    wm.append({ role: 'user', content: 'Seraphina wants to continue from the moon gate.' });
    const tightManager = new MemoryManager(new TokenBudgetManager(tightCaps));

    const context = await tightManager.assembleContext(
      sessionId,
      wm,
      { entities: ['Seraphina'], keywords: [], search_terms: [], implicit_topics: [] },
      { trace: true }
    );

    const eventTraceItems = context.retrieval!.items.filter(item => item.type === 'event');
    expect(eventTraceItems.length).toBeGreaterThan(1);
    expect(eventTraceItems[0].content).toBe(longDescription);
    expect(eventTraceItems[0].injected).toBe(false);
    expect(eventTraceItems[0].trimReason).toContain('exceeded remaining events budget');
    expect('trim_reason' in eventTraceItems[0]).toBe(false);
    expect(context.retrieval?.summary.events.injected).toBe(0);
    expect(context.messages[0].content).not.toContain(longDescription);
  });

  it('injects continuity before current state and retrieved memory', async () => {
    const wm = new WorkingMemory(8000);
    wm.append({ role: 'user', content: '继续之前的月门剧情' });

    const context = await manager.assembleContext(
      sessionId,
      wm,
      { entities: [], keywords: [], search_terms: [], implicit_topics: [] },
      {
        trace: true,
        continuity: {
          level: 'medium',
          text: '[当前场景]\n地点: Moon Gate\n[核心关系]\nSeraphina trusts the user.',
          snapshot_id: 'snapshot-1',
          handoff_id: 'handoff-1',
          boost_turns_remaining: 7,
          trigger: 'model-switch',
        },
      }
    );

    const systemContent = context.messages[0].content;
    expect(systemContent).toContain('[长期连续性上下文]');
    expect(systemContent).toContain('Moon Gate');
    expect(context.budget_breakdown.continuity).toBeGreaterThan(0);
    expect(context.retrieval?.continuity).toMatchObject({
      level: 'medium',
      snapshot_id: 'snapshot-1',
      handoff_id: 'handoff-1',
      boost_turns_remaining: 7,
      trigger: 'model-switch',
      injected: true,
    });
  });

  it('should include canon in context', async () => {
    await runAndPersist(
      `INSERT INTO canon_entries (id, tier, category, statement, keywords, conflict_policy, created_at, updated_at)
       VALUES (?, 'CORE', 'WORLD_RULE', '魔法无法复活死人', '["魔法","复活"]', 'BLOCK', ?, ?)`,
      [uuid(), Date.now(), Date.now()]
    );

    const wm = new WorkingMemory(8000);
    wm.append({ role: 'user', content: '测试消息' });

    const emptyKeywordCtx2 = { entities: [], keywords: [], search_terms: [], implicit_topics: [] };
    const context = await manager.assembleContext(sessionId, wm, emptyKeywordCtx2);
    const systemContent = context.messages.find(m => m.role === 'system')?.content || '';
    expect(systemContent).toContain('魔法无法复活死人');
  });
});
