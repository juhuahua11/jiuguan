import { createHash } from 'crypto';
import { getDatabase, execQuery, runAndPersist } from './db.js';
import { Fact, FactSource, FactType } from '../types/fact.js';

function dedupKey(session_id: string, subject_id: string, predicate: string, object_id: string | null): string {
  const raw = `${subject_id}|${predicate}|${object_id || ''}|${session_id}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

interface InsertFactInput {
  session_id: string;
  subject_id: string;
  predicate: string;
  object_id: string | null;
  statement: string;
  confidence: number;
  source: FactSource;
  fact_type?: string;
  valid_from: number;
  valid_to: number | null;
  trace_id: string;
}

export function insertFact(input: InsertFactInput): Fact {
  const dk = dedupKey(input.session_id, input.subject_id, input.predicate, input.object_id);
  const now = Date.now();

  // Check for existing active fact with same S-P-O
  const existing = execQuery(
    'SELECT id, occurrence_count, version FROM facts WHERE id = ? AND tombstone_deleted = 0',
    [dk]
  );

  if (existing.length > 0) {
    const row = existing[0];
    runAndPersist(
      `UPDATE facts SET statement = ?, confidence = ?, source = ?,
        fact_type = COALESCE(?, fact_type),
        occurrence_count = occurrence_count + 1, valid_from = ?, valid_to = ?,
        trace_id = ?, version = version + 1, updated_at = ?
       WHERE id = ?`,
      [input.statement, input.confidence, input.source,
       input.fact_type || null,
       input.valid_from, input.valid_to, input.trace_id, now, row.id]
    );
    return getFact(row.id)!;
  }

  // Insert new fact
  runAndPersist(
    `INSERT INTO facts (id, session_id, subject_id, predicate, object_id,
      statement, confidence, source, fact_type, occurrence_count, valid_from, valid_to,
      trace_id, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 1, ?, ?)`,
    [dk, input.session_id, input.subject_id, input.predicate, input.object_id,
     input.statement, input.confidence, input.source, input.fact_type || 'general',
     input.valid_from, input.valid_to, input.trace_id, now, now]
  );

  return getFact(dk)!;
}

export function getFact(id: string): Fact | null {
  const rows = execQuery(
    'SELECT * FROM facts WHERE id = ? AND tombstone_deleted = 0', [id]
  );
  return rows.length ? rowToFact(rows[0]) : null;
}

export function getFactsBySubject(session_id: string, subject_id: string): Fact[] {
  const rows = execQuery(
    'SELECT * FROM facts WHERE session_id = ? AND subject_id = ? AND tombstone_deleted = 0',
    [session_id, subject_id]
  );
  return rows.map(rowToFact);
}

export function getActiveFacts(session_id: string): Fact[] {
  const rows = execQuery(
    'SELECT * FROM facts WHERE session_id = ? AND valid_to IS NULL AND tombstone_deleted = 0',
    [session_id]
  );
  return rows.map(rowToFact);
}

export function expireFact(id: string, atRound: number): void {
  runAndPersist(
    'UPDATE facts SET valid_to = ?, updated_at = ?, version = version + 1 WHERE id = ?',
    [atRound, Date.now(), id]
  );
}

export function markTombstone(id: string, reason: string): void {
  const now = Date.now();
  runAndPersist(
    `UPDATE facts SET tombstone_deleted = 1, tombstone_deleted_at = ?,
      tombstone_deletion_reason = ?, updated_at = ?
     WHERE id = ?`,
    [now, reason, now, id]
  );
}

function rowToFact(row: any): Fact {
  const tombstone = row.tombstone_deleted ? {
    deleted: true,
    deleted_at: row.tombstone_deleted_at,
    deletion_reason: row.tombstone_deletion_reason || '',
  } : undefined;

  return {
    id: row.id,
    session_id: row.session_id,
    subject_id: row.subject_id,
    predicate: row.predicate,
    object_id: row.object_id,
    statement: row.statement,
    confidence: row.confidence,
    source: row.source as FactSource,
    fact_type: row.fact_type as FactType,
    occurrence_count: row.occurrence_count,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    embedding_id: row.embedding_id,
    trace_id: row.trace_id,
    tombstone,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
