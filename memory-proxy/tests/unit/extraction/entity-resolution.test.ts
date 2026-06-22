import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, closeDatabase } from '../../../src/storage/db.js';
import { createSession } from '../../../src/storage/session-store.js';
import { EntityResolver } from '../../../src/extraction/entity-resolution.js';
import { EntityType } from '../../../src/types/entity.js';

describe('EntityResolver', () => {
  let resolver: EntityResolver;
  let sessionId: string;

  beforeEach(async () => {
    closeDatabase();
    await initDatabase(':memory:');
    sessionId = createSession('char1', 'chat1', 'main').id;
    resolver = new EntityResolver();
  });

  it('should resolve known entity by exact name', () => {
    const entity = resolver.register(sessionId, '张三', EntityType.CHARACTER, 1);
    const found = resolver.lookup(sessionId, '张三');
    expect(found).toBeDefined();
    expect(found!.name).toBe('张三');
    expect(found!.id).toBe(entity.id);
  });

  it('should resolve known entity by alias', () => {
    const entity = resolver.register(sessionId, '张三', EntityType.CHARACTER, 1);
    resolver.addAlias(entity.id, '阿三');
    const found = resolver.lookup(sessionId, '阿三');
    expect(found).toBeDefined();
    expect(found!.id).toBe(entity.id);
  });

  it('should return null for unknown entity name', () => {
    expect(resolver.lookup(sessionId, '不存在的人物')).toBeNull();
  });

  it('should register new entities', () => {
    const entity = resolver.register(sessionId, '青龙剑', EntityType.ITEM, 5);
    expect(entity.id).toBeDefined();
    expect(entity.type).toBe(EntityType.ITEM);
    expect(entity.first_seen_round).toBe(5);
  });

  it('should deduplicate by name+type and update last_seen', () => {
    resolver.register(sessionId, '客栈', EntityType.LOCATION, 1);
    const again = resolver.register(sessionId, '客栈', EntityType.LOCATION, 7);
    expect(again.last_seen_round).toBe(7);
  });
});
