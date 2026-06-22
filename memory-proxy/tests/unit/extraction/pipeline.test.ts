import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, closeDatabase, execQuery } from '../../../src/storage/db.js';
import { createSession } from '../../../src/storage/session-store.js';
import { runExtractionPipeline } from '../../../src/extraction/pipeline.js';
import { getRelationshipsByEntity } from '../../../src/storage/relationship-store.js';
import { getCurrentState } from '../../../src/storage/current-state-store.js';

describe('Pipeline relationship-state stage', () => {
  let sessionId: string;

  beforeEach(async () => {
    closeDatabase();
    await initDatabase(':memory:');
    sessionId = createSession('char1', 'chat1', 'main').id;
    // Seed two entities so the resolver can map names→ids.
    execQuery("INSERT INTO entities (id, session_id, name, aliases, type, first_seen_round, last_seen_round, version, created_at, updated_at) VALUES ('e_fx', ?, '方消', '[]', 'CHARACTER', 0, 0, 1, 0, 0)", [sessionId]);
    execQuery("INSERT INTO entities (id, session_id, name, aliases, type, first_seen_round, last_seen_round, version, created_at, updated_at) VALUES ('e_sera', ?, 'Seraphina', '[]', 'CHARACTER', 0, 0, 1, 0, 0)", [sessionId]);
  });

  it('extracts a relationship signal and accumulates intensity', async () => {
    // Mock LLM: salient stage returns a relationship_change; fact-event returns empty;
    // relationship-state returns a confession signal + state patches.
    const llmCall = async (prompt: string) => {
      if (prompt.includes('relationship_signals')) {
        return '{"relationship_signals":[{"type":"confession","actor":"方消","target":"Seraphina","description":"表白","round":5}],"state_patches":[{"op":"set_location","value":"麦田"},{"op":"add_character","item":"e_fx"}]}';
      }
      if (prompt.includes('salients')) {
        return '{"salients":[{"type":"relationship_change","statement":"方消向Seraphina表白","entities_involved":["方消","Seraphina"],"round":5}]}';
      }
      // fact-event
      return '{"facts":[],"events":[]}';
    };

    const report = await runExtractionPipeline({
      sessionId,
      round: 5,
      overflowMessages: [{ role: 'user', content: '方消向Seraphina表白' }, { role: 'assistant', content: '我也心动已久' }],
      llmCall,
    });

    expect(report.relationships_extracted).toBe(1);
    const rels = getRelationshipsByEntity(sessionId, 'e_fx');
    expect(rels.length).toBeGreaterThanOrEqual(1);
    const rel = rels.find(r => r.subject_id === 'e_fx' && r.object_id === 'e_sera');
    expect(rel).toBeDefined();
    expect(rel!.intensity).toBeGreaterThan(0);

    // current_states row created + location set + character recorded
    const state = getCurrentState(sessionId);
    expect(state).not.toBeNull();
    expect(state!.location.value).toBe('麦田');
    // add_character item=e_fx should be stored (resolved to the stable entity id)
    expect(state!.characters_present.value).toContain('e_fx');
  });

  it('skips relationship-state when salients is empty', async () => {
    const llmCall = async (prompt: string) => {
      if (prompt.includes('salients')) return '{"salients":[]}';
      return '{"facts":[],"events":[]}';
    };
    const report = await runExtractionPipeline({
      sessionId,
      round: 5,
      overflowMessages: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好' }],
      llmCall,
    });
    expect(report.relationships_extracted).toBe(0);
    expect(getCurrentState(sessionId)).toBeNull();
  });

  it('same-round duplicate (actor,target,type) deduped to one', async () => {
    const llmCall = async (prompt: string) => {
      if (prompt.includes('relationship_signals')) {
        return '{"relationship_signals":[{"type":"confession","actor":"方消","target":"Seraphina","description":"表白1","round":5},{"type":"confession","actor":"方消","target":"Seraphina","description":"表白2","round":5}],"state_patches":[]}';
      }
      if (prompt.includes('salients')) {
        return '{"salients":[{"type":"relationship_change","statement":"表白","entities_involved":["方消","Seraphina"],"round":5}]}';
      }
      return '{"facts":[],"events":[]}';
    };
    const report = await runExtractionPipeline({
      sessionId,
      round: 5,
      overflowMessages: [{ role: 'user', content: '表白' }, { role: 'assistant', content: '心动' }],
      llmCall,
    });
    expect(report.relationships_extracted).toBe(1);  // deduped from 2
  });

  it('unknown signal type is skipped with a warning', async () => {
    const llmCall = async (prompt: string) => {
      if (prompt.includes('relationship_signals')) {
        return '{"relationship_signals":[{"type":"not_a_real_signal","actor":"方消","target":"Seraphina","description":"x","round":5}],"state_patches":[]}';
      }
      if (prompt.includes('salients')) {
        return '{"salients":[{"type":"relationship_change","statement":"x","entities_involved":["方消"],"round":5}]}';
      }
      return '{"facts":[],"events":[]}';
    };
    const report = await runExtractionPipeline({
      sessionId,
      round: 5,
      overflowMessages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }],
      llmCall,
    });
    expect(report.relationships_extracted).toBe(0);
    expect(report.warnings.some(w => w.includes('not_a_real_signal'))).toBe(true);
  });

  it('registers unseen actor/target names as entities for stable relationship ids', async () => {
    // Actor "方消" is NOT in the seeded entities (only e_fx/e_sera are). The RS stage
    // should register it and use the resulting stable id, not the raw name.
    const llmCall = async (prompt: string) => {
      if (prompt.includes('relationship_signals')) {
        return '{"relationship_signals":[{"type":"confession","actor":"新角色","target":"Seraphina","description":"表白","round":5}],"state_patches":[]}';
      }
      if (prompt.includes('salients')) {
        return '{"salients":[{"type":"relationship_change","statement":"新角色向Seraphina表白","entities_involved":["新角色","Seraphina"],"round":5}]}';
      }
      return '{"facts":[],"events":[]}';
    };
    const report = await runExtractionPipeline({
      sessionId,
      round: 5,
      overflowMessages: [{ role: 'user', content: '新角色表白' }, { role: 'assistant', content: '心动' }],
      llmCall,
    });
    expect(report.relationships_extracted).toBe(1);
    // The new entity should have been registered (lookup should now find it).
    const { EntityResolver } = await import('../../../src/extraction/entity-resolution.js');
    const resolver = new EntityResolver();
    const registered = resolver.lookup(sessionId, '新角色');
    expect(registered).not.toBeNull();
    // Relationship subject_id should be the stable hash id, not the raw name.
    const { getRelationshipsByEntity } = await import('../../../src/storage/relationship-store.js');
    const rels = getRelationshipsByEntity(sessionId, registered!.id);
    expect(rels.length).toBeGreaterThanOrEqual(1);
    expect(rels[0].subject_id).toBe(registered!.id);
    // Intensity should be rounded to 2 decimals (confession delta = 0.11 from engine).
    expect(rels[0].intensity).toBe(0.11);
  });

  it('accumulates intensity with 2-decimal rounding across rounds', async () => {
    // Round 1: confession (+0.11). Round 2: romantic_gesture (+0.09).
    // Without rounding, 0.11 + 0.09 = 0.2 but float drift could give 0.19999999.
    const makeLlm = (type: string) => async (prompt: string) => {
      if (prompt.includes('relationship_signals')) {
        return `{"relationship_signals":[{"type":"${type}","actor":"方消","target":"Seraphina","description":"x","round":5}],"state_patches":[]}`;
      }
      if (prompt.includes('salients')) {
        return `{"salients":[{"type":"relationship_change","statement":"x","entities_involved":["方消","Seraphina"],"round":5}]}`;
      }
      return '{"facts":[],"events":[]}';
    };
    await runExtractionPipeline({
      sessionId, round: 5,
      overflowMessages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }],
      llmCall: makeLlm('confession'),
    });
    const report2 = await runExtractionPipeline({
      sessionId, round: 6,
      overflowMessages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }],
      llmCall: makeLlm('romantic_gesture'),
    });
    expect(report2.relationships_extracted).toBe(1);
    const { execQuery } = await import('../../../src/storage/db.js');
    const row = execQuery('SELECT intensity FROM relationships WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1', [sessionId])[0];
    // 0.11 + 0.09 = 0.2, rounded to 2 decimals — no float drift.
    expect(row.intensity).toBe(0.2);
  });

  it('does not re-register when LLM emits an already-known entity id', async () => {
    // Round 1: register an UNSEEDED name "新角色" via confession signal → get its stable id.
    // Round 2: LLM parrots the id back as actor (it saw the id in recent-signals injection).
    // The RS stage must recognize the id, NOT register a second entity under the id-as-name.
    const makeLlm = (actorValue: string) => async (prompt: string) => {
      if (prompt.includes('relationship_signals')) {
        return `{"relationship_signals":[{"type":"confession","actor":"${actorValue}","target":"Seraphina","description":"x","round":5}],"state_patches":[]}`;
      }
      if (prompt.includes('salients')) {
        return `{"salients":[{"type":"relationship_change","statement":"x","entities_involved":["新角色","Seraphina"],"round":5}]}`;
      }
      return '{"facts":[],"events":[]}';
    };
    // Round 1: actor="新角色" (unseeded name) → registers, returns id.
    await runExtractionPipeline({
      sessionId, round: 5,
      overflowMessages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }],
      llmCall: makeLlm('新角色'),
    });
    const { execQuery } = await import('../../../src/storage/db.js');
    const entRows = execQuery('SELECT id, name FROM entities WHERE session_id = ?', [sessionId]);
    // 2 seeded (e_fx/e_sera) + 1 newly registered (新角色)
    expect(entRows.length).toBe(3);
    const newRow = entRows.find((r: any) => r.name === '新角色');
    expect(newRow).toBeDefined();
    const newId = newRow!.id;

    // Round 2: actor = the id from round 1 (LLM parroting the id). Must NOT create a 2nd entity.
    await runExtractionPipeline({
      sessionId, round: 6,
      overflowMessages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }],
      llmCall: makeLlm(newId),
    });
    const entRows2 = execQuery('SELECT id, name FROM entities WHERE session_id = ?', [sessionId]);
    // Still 3 — no extra entity registered under the id-as-name.
    expect(entRows2.length).toBe(3);
    const idAsNameCount = entRows2.filter((r: any) => r.name === newId).length;
    expect(idAsNameCount).toBe(0);

    // The relationship should ACCUMULATE on the same row (same subject_id), not create a new one.
    const relRows = execQuery('SELECT subject_id, intensity FROM relationships WHERE session_id = ?', [sessionId]);
    expect(relRows.length).toBe(1);
    expect((relRows[0] as any).subject_id).toBe(newId);
    // 0.11 (confession) + 0.11 (confession) = 0.22, accumulated.
    expect((relRows[0] as any).intensity).toBe(0.22);
  });

  it('resolves add_character item name to stable entity id', async () => {
    // LLM emits add_character with a NAME ("方消"), not the seeded id (e_fx).
    // The RS stage should resolve it to e_fx so characters_present stores the stable id.
    const llmCall = async (prompt: string) => {
      if (prompt.includes('relationship_signals')) {
        return '{"relationship_signals":[],"state_patches":[{"op":"set_location","value":"小屋"},{"op":"add_character","item":"方消"}]}';
      }
      if (prompt.includes('salients')) {
        return '{"salients":[{"type":"state_change","statement":"方消在小屋","entities_involved":["方消"],"round":5}]}';
      }
      return '{"facts":[],"events":[]}';
    };
    await runExtractionPipeline({
      sessionId, round: 5,
      overflowMessages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }],
      llmCall,
    });
    const state = getCurrentState(sessionId);
    expect(state).not.toBeNull();
    // "方消" should have been resolved to the seeded id e_fx, not stored as the raw name.
    expect(state!.characters_present.value).toContain('e_fx');
    expect(state!.characters_present.value).not.toContain('方消');
  });

  it('resolves fact subject_id and event participants to stable entity ids', async () => {
    // LLM emits facts with NAME subject_id ("方消") and events with NAME participants.
    // The fact-event stage should resolve them to the seeded stable id (e_fx / e_sera).
    const llmCall = async (prompt: string) => {
      if (prompt.includes('relationship_signals')) {
        return '{"relationship_signals":[],"state_patches":[]}';
      }
      if (prompt.includes('salients')) {
        return '{"salients":[{"type":"info","statement":"方消送Seraphina一束花","entities_involved":["方消","Seraphina"],"round":5}]}';
      }
      // fact-event: subject_id is a NAME, object_id is null, participants are NAMES
      return '{"facts":[{"subject_entity_id":"方消","predicate":"carries","object_entity_id":null,"is_negation":false,"confidence":0.8,"fact_type":"profile","source_statement":"方消送花"}],"events":[{"description":"送花事件","participants":["方消","Seraphina"],"location_id":null,"significance":"MEDIUM","round":5}]}';
    };
    await runExtractionPipeline({
      sessionId, round: 5,
      overflowMessages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }],
      llmCall,
    });
    // Fact subject_id should be the stable id e_fx, not the raw name "方消".
    const facts = execQuery('SELECT subject_id FROM facts WHERE session_id = ?', [sessionId]);
    expect(facts.length).toBeGreaterThanOrEqual(1);
    for (const f of facts) {
      // every fact subject_id must be a stable id (e_fx here), never the raw name
      expect(f.subject_id).not.toBe('方消');
    }
    const factWithFx = facts.find((f: any) => f.subject_id === 'e_fx');
    expect(factWithFx).toBeDefined();

    // Event participants should be stable ids, not raw names.
    const events = execQuery('SELECT participants FROM events WHERE session_id = ?', [sessionId]);
    const participants = JSON.parse(events[0].participants);
    expect(participants).toContain('e_fx');
    expect(participants).toContain('e_sera');
    expect(participants).not.toContain('方消');
    expect(participants).not.toContain('Seraphina');
  });
});
