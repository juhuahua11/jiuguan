import { runAndPersist, execQuery } from './db.js';

export interface InsertEventInput {
  session_id: string;
  description: string;
  participants: string; // JSON array string
  location_id?: string;
  significance: string; // LOW | MEDIUM | HIGH | CRITICAL
  timestamp_round: number;
  caused_by?: string; // JSON array string
  causes?: string; // JSON array string
  trace_id: string;
}

export interface StoredEvent {
  id: string;
  session_id: string;
  description: string;
  participants: string;
  location_id: string | null;
  significance: string;
  timestamp_round: number;
  caused_by: string;
  causes: string;
  trace_id: string;
  version: number;
  created_at: number;
  updated_at: number;
}

/** Insert a new event into the events table */
export function insertEvent(input: InsertEventInput): StoredEvent {
  const id = `ev_${input.session_id}_${input.timestamp_round}_${Date.now()}`;
  const now = Date.now();
  runAndPersist(
    `INSERT INTO events (id, session_id, description, participants, location_id,
      significance, timestamp_round, caused_by, causes, trace_id, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [id, input.session_id, input.description, input.participants,
     input.location_id || null, input.significance, input.timestamp_round,
     input.caused_by || '[]', input.causes || '[]', input.trace_id, now, now]
  );
  return getEventById(id)!;
}

/** Get a single event by ID */
export function getEventById(id: string): StoredEvent | null {
  const rows = execQuery('SELECT * FROM events WHERE id = ?', [id]);
  return rows.length > 0 ? rowToEvent(rows[0]) : null;
}

/** Get all events for a session */
export function getEventsBySession(sessionId: string): StoredEvent[] {
  return execQuery(
    'SELECT * FROM events WHERE session_id = ? ORDER BY timestamp_round ASC',
    [sessionId]
  ).map(rowToEvent);
}

function rowToEvent(row: any): StoredEvent {
  return {
    id: row.id,
    session_id: row.session_id,
    description: row.description,
    participants: row.participants || '[]',
    location_id: row.location_id,
    significance: row.significance || 'MEDIUM',
    timestamp_round: row.timestamp_round ?? 0,
    caused_by: row.caused_by || '[]',
    causes: row.causes || '[]',
    trace_id: row.trace_id,
    version: row.version ?? 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
