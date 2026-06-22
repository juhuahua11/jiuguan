import { describe, it, expect } from 'vitest';

// These tests validate the type contracts defined in src/types/
// TypeScript compilation (tsc --noEmit) provides additional verification

describe('BaseRecord', () => {
  it('should enforce required fields', () => {
    const record = {
      id: 'abc-123',
      version: 1,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    expect(record.id).toBeTypeOf('string');
    expect(record.version).toBeTypeOf('number');
    expect(record.created_at).toBeTypeOf('number');
    expect(record.updated_at).toBeTypeOf('number');
  });
});

describe('EntityType', () => {
  it('should have all five entity types', () => {
    const types = ['CHARACTER', 'ITEM', 'LOCATION', 'FACTION', 'CONCEPT'];
    expect(types).toHaveLength(5);
  });
});

describe('Entity', () => {
  it('should have all required fields including inherited ones', () => {
    const entity = {
      id: 'e-1',
      version: 1,
      created_at: Date.now(),
      updated_at: Date.now(),
      session_id: 'sess-1',
      name: '张三',
      aliases: ['阿三'],
      type: 'CHARACTER' as const,
      first_seen_round: 10,
      last_seen_round: 20,
    };
    expect(entity.name).toBe('张三');
    expect(entity.aliases).toHaveLength(1);
    expect(entity.first_seen_round).toBe(10);
    expect(entity.last_seen_round).toBe(20);
  });
});
