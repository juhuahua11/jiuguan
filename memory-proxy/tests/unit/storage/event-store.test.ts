import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, closeDatabase } from '../../../src/storage/db.js';
import { createSession } from '../../../src/storage/session-store.js';
import { insertEvent, getEventById, getEventsBySession } from '../../../src/storage/event-store.js';

describe('Event Store', () => {
  let sessionId: string;

  beforeEach(async () => {
    closeDatabase();
    await initDatabase(':memory:');
    sessionId = createSession('char1', 'chat1', 'main').id;
  });

  it('should insert an event and retrieve it', () => {
    const event = insertEvent({
      session_id: sessionId,
      description: 'Alice met Bob at the market',
      participants: '["alice","bob"]',
      significance: 'MEDIUM',
      timestamp_round: 5,
      trace_id: 'trace-001',
    });
    expect(event).toBeDefined();
    expect(event.id).toBeTruthy();
    expect(event.description).toBe('Alice met Bob at the market');

    const retrieved = getEventById(event.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.description).toBe('Alice met Bob at the market');
  });

  it('should insert multiple events for the same session', () => {
    insertEvent({
      session_id: sessionId,
      description: 'Event A',
      participants: '[]',
      significance: 'LOW',
      timestamp_round: 1,
      trace_id: 'trace-002',
    });
    insertEvent({
      session_id: sessionId,
      description: 'Event B',
      participants: '["alice"]',
      significance: 'HIGH',
      timestamp_round: 2,
      trace_id: 'trace-003',
    });

    const events = getEventsBySession(sessionId);
    expect(events.length).toBe(2);
    expect(events[0].timestamp_round).toBeLessThan(events[1].timestamp_round);
  });

  it('should return empty array for session with no events', () => {
    const emptySessionId = createSession('char2', 'chat2', 'main').id;
    const events = getEventsBySession(emptySessionId);
    expect(events).toEqual([]);
  });

  it('should store and retrieve caused_by and causes', () => {
    const event = insertEvent({
      session_id: sessionId,
      description: 'Battle broke out',
      participants: '["army_a","army_b"]',
      significance: 'CRITICAL',
      timestamp_round: 10,
      caused_by: '["provocation"]',
      causes: '["war_declaration"]',
      trace_id: 'trace-004',
    });
    expect(event.caused_by).toBe('["provocation"]');
    expect(event.causes).toBe('["war_declaration"]');

    const retrieved = getEventById(event.id);
    expect(retrieved!.caused_by).toBe('["provocation"]');
    expect(retrieved!.causes).toBe('["war_declaration"]');
  });

  it('should store location_id when provided', () => {
    const event = insertEvent({
      session_id: sessionId,
      description: 'Meeting at the castle',
      participants: '["king","advisor"]',
      location_id: 'loc_castle',
      significance: 'HIGH',
      timestamp_round: 7,
      trace_id: 'trace-005',
    });
    expect(event.location_id).toBe('loc_castle');

    const retrieved = getEventById(event.id);
    expect(retrieved!.location_id).toBe('loc_castle');
  });
});
