import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, closeDatabase } from '../../../src/storage/db.js';
import { createSession } from '../../../src/storage/session-store.js';
import { buildQueryContext } from '../../../src/retrieval/query-builder.js';
import { ChatMessage } from '../../../src/types/provider.js';
import { execQuery } from '../../../src/storage/db.js';

describe('QueryBuilder', () => {
  let sessionId: string;

  beforeEach(async () => {
    closeDatabase();
    await initDatabase(':memory:');
    sessionId = createSession('char1', 'chat1', 'main').id;
  });

  it('should detect mentioned entities', () => {
    // Register entities
    execQuery("INSERT INTO entities (id, session_id, name, aliases, type, first_seen_round, last_seen_round, version, created_at, updated_at) VALUES ('e_zhangsan', ?, '张三', '[]', 'CHARACTER', 1, 10, 1, 1, 1)", [sessionId]);
    execQuery("INSERT INTO entities (id, session_id, name, aliases, type, first_seen_round, last_seen_round, version, created_at, updated_at) VALUES ('e_inn', ?, '客栈', '[]', 'LOCATION', 1, 10, 1, 1, 1)", [sessionId]);

    const messages: ChatMessage[] = [
      { role: 'user', content: '我去客栈找张三' },
    ];

    const ctx = buildQueryContext(sessionId, messages);
    expect(ctx.entities).toContain('e_zhangsan');
    expect(ctx.locations).toContain('e_inn');
  });

  it('should detect intents', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: '我想调查一下王五的事情，问问他关于刺客的事' },
    ];
    const ctx = buildQueryContext(sessionId, messages);
    expect(ctx.intents).toContain('调查');
    expect(ctx.intents).toContain('询问');
  });

  it('should detect narrative hooks', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: '继续之前的话题，上次张三答应帮我调查' },
    ];
    const ctx = buildQueryContext(sessionId, messages);
    expect(ctx.narrativeHooks.length).toBeGreaterThan(0);
  });
});
