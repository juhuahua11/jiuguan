import { describe, it, expect } from 'vitest';
import { buildRelationshipStatePrompt, parseRelationshipStateResponse } from '../../../src/extraction/relationship-state-extraction.js';
import { Salient } from '../../../src/types/extraction.js';

const salients: Salient[] = [
  { type: 'relationship_change', statement: '方消向Seraphina表白', entities_involved: ['方消', 'Seraphina'], round: 5 },
  { type: 'state_change', statement: '两人来到麦田', entities_involved: ['方消', 'Seraphina'], round: 5 },
];

const entities = [
  { id: 'e_fx', name: '方消' },
  { id: 'e_sera', name: 'Seraphina' },
];

describe('buildRelationshipStatePrompt', () => {
  it('contains salient text, entity map, and pending list', () => {
    const prompt = buildRelationshipStatePrompt(
      salients, entities,
      [{ kind: 'promise', description: '教她写字', round: 3 }],
      []
    );
    expect(prompt).toContain('方消向Seraphina表白');
    expect(prompt).toContain('方消: e_fx');
    expect(prompt).toContain('教她写字');
  });

  it('lists all 15 signal types and 11 ops', () => {
    const prompt = buildRelationshipStatePrompt(salients, entities, [], []);
    const signalTypes = ['protective_action','saved_life','betrayal','shared_secret','verbal_insult','gift_exchange','romantic_gesture','confession','helped_in_battle','kept_promise','broke_promise','deception','mentor_teaching','showing_mercy','intimidation'];
    for (const t of signalTypes) expect(prompt).toContain(t);
    const ops = ['set_location','add_character','remove_character','add_question','add_promise','add_quest','add_hook','resolve_question','resolve_promise','resolve_quest','resolve_hook'];
    for (const op of ops) expect(prompt).toContain(op);
  });

  it('injects recent signals for cross-round dedup', () => {
    const prompt = buildRelationshipStatePrompt(
      salients, entities, [],
      [{ actor: 'e_fx', target: 'e_sera', type: 'confession', round: 5, description: '表白' }]
    );
    expect(prompt).toContain('已记录');
    expect(prompt).toContain('confession');
  });
});

describe('parseRelationshipStateResponse', () => {
  it('parses standard JSON', () => {
    const resp = '{"relationship_signals":[{"type":"confession","actor":"e_fx","target":"e_sera","description":"表白","round":5}],"state_patches":[{"op":"set_location","value":"麦田"}]}';
    const { signals, statePatches } = parseRelationshipStateResponse(resp, 5);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('confession');
    expect(signals[0].actor).toBe('e_fx');
    expect(statePatches).toHaveLength(1);
    expect(statePatches[0].op).toBe('set_location');
    expect(statePatches[0].value).toBe('麦田');
  });

  it('strips markdown fences', () => {
    const resp = '```json\n{"relationship_signals":[],"state_patches":[]}\n```';
    const { signals, statePatches } = parseRelationshipStateResponse(resp, 5);
    expect(signals).toHaveLength(0);
    expect(statePatches).toHaveLength(0);
  });

  it('slices prose+JSON mixed (reasoning_content fallback scenario)', () => {
    const resp = '我来分析这段对话的关系变化。\n{"relationship_signals":[{"type":"gift_exchange","actor":"e_fx","target":"e_sera","description":"送礼","round":5}],"state_patches":[]}\n以上就是分析。';
    const { signals } = parseRelationshipStateResponse(resp, 5);
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('gift_exchange');
  });

  it('returns empty arrays on malformed JSON', () => {
    const resp = 'totally not json at all';
    const { signals, statePatches } = parseRelationshipStateResponse(resp, 5);
    expect(signals).toHaveLength(0);
    expect(statePatches).toHaveLength(0);
  });

  it('falls back to defaultRound when round missing', () => {
    const resp = '{"relationship_signals":[{"type":"confession","actor":"e_fx","target":"e_sera","description":"表白"}],"state_patches":[]}';
    const { signals } = parseRelationshipStateResponse(resp, 9);
    expect(signals[0].round).toBe(9);
  });
});
