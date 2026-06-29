import { createHash } from 'crypto';
import { getDatabase, execQuery, runAndPersist } from './db.js';
import { Session } from '../types/session.js';

/**
 * Fire-and-forget wrapper around runAndPersist.
 * Every session-store write is invoked without `await` (callers are synchronous,
 * return `: void`). A bare fire-and-forget runAndPersist would surface any DB/disk
 * error as an unhandled promise rejection — on Node v24 (--unhandled-rejections=throw
 * by default) that crashes the whole SillyTavern process. This wrapper logs the error
 * instead, so a transient persist failure degrades gracefully rather than killing ST.
 *
 * Tests that need to observe write errors can still `await runAndPersist(...)` directly.
 */
function safePersist(sql: string, params?: any[]): void {
  runAndPersist(sql, params).catch(err => {
    console.error('[MemoryProxy] DB write failed:', err instanceof Error ? err.message : String(err));
  });
}

export function createSession(
  character_id: string,
  chat_id: string,
  branch_id: string = 'main'
): Session {
  const raw = `${character_id}|${chat_id}|${branch_id}`;
  const id = createHash('sha256').update(raw).digest('hex').slice(0, 32);
  const now = Date.now();

  // Check if already exists
  const existing = execQuery('SELECT id FROM sessions WHERE id = ?', [id]);
  if (existing.length > 0) {
    return getSession(id)!;
  }

  safePersist(
    'INSERT INTO sessions (id, character_id, chat_id, branch_id, round, created_at, last_active_at, last_fingerprint, last_message_count, last_integrity_hash) VALUES (?, ?, ?, ?, 0, ?, ?, \'\', 0, \'\')',
    [id, character_id, chat_id, branch_id, now, now]
  );

  return { id, character_id, chat_id, branch_id, round: 0, created_at: now, last_active_at: now, last_fingerprint: '', last_message_count: 0, last_integrity_hash: '', extraction_pending: 0 };
}

export function getSession(id: string): Session | null {
  const rows = execQuery('SELECT * FROM sessions WHERE id = ?', [id]);
  if (!rows.length) return null;
  return rowToSession(rows[0]);
}

export function updateSessionRound(id: string, round: number): void {
  safePersist(
    'UPDATE sessions SET round = ?, last_active_at = ? WHERE id = ?',
    [round, Date.now(), id]
  );
}

export function updateSessionExtractionProgress(
  id: string,
  fingerprint: string,
  messageCount: number,
  integrityHash: string
): void {
  safePersist(
    'UPDATE sessions SET last_fingerprint = ?, last_message_count = ?, last_integrity_hash = ?, last_active_at = ? WHERE id = ?',
    [fingerprint, messageCount, integrityHash, Date.now(), id]
  );
}

/** Update integrity hash only — called when extraction fails but we must break infinite re-extraction loops.
 *  Also used as a lightweight heartbeat during long chunked extraction to refresh last_active_at. */
export function updateSessionIntegrityHashOnly(id: string, integrityHash: string): void {
  safePersist(
    'UPDATE sessions SET last_integrity_hash = ?, last_active_at = ? WHERE id = ?',
    [integrityHash, Date.now(), id]
  );
}

/** Mark extraction as in-progress for a session (prevents concurrent re-extraction).
 *  Sets fingerprint to a sentinel value so diffNewMessages returns 0 new messages
 *  for any request that arrives while extraction is running. */
export function markExtractionInProgress(id: string, integrityHash: string): void {
  safePersist(
    'UPDATE sessions SET last_fingerprint = \'__PROCESSING__\', last_integrity_hash = ?, last_active_at = ? WHERE id = ?',
    [integrityHash, Date.now(), id]
  );
}

/** Clear the __PROCESSING__ sentinel on extraction failure/crash.
 *  Keeps integrity hash intact. Restores previous fingerprint if provided
 *  (so incremental extraction can continue from where it left off instead
 *  of resetting to empty and re-extracting everything). */
export function clearExtractionSentinel(id: string, integrityHash: string, restoreFingerprint?: string): void {
  const fp = restoreFingerprint && restoreFingerprint !== '__PROCESSING__' ? restoreFingerprint : '';
  safePersist(
    'UPDATE sessions SET last_fingerprint = ?, last_integrity_hash = ?, last_active_at = ? WHERE id = ?',
    [fp, integrityHash, Date.now(), id]
  );
}

function rowToSession(row: any): Session {
  return {
    id: row.id,
    character_id: row.character_id,
    chat_id: row.chat_id,
    branch_id: row.branch_id,
    round: row.round,
    created_at: row.created_at,
    last_active_at: row.last_active_at,
    last_fingerprint: row.last_fingerprint ?? '',
    last_message_count: row.last_message_count ?? 0,
    last_integrity_hash: row.last_integrity_hash ?? '',
    extraction_pending: row.extraction_pending ?? 0,
  };
}

/** [FIX: memory-extraction-backlog] Mark extraction as pending (sentinel fresh, skip → need catch-up later) */
export function setExtractionPending(id: string, pending: boolean): void {
  safePersist(
    'UPDATE sessions SET extraction_pending = ?, last_active_at = ? WHERE id = ?',
    [pending ? 1 : 0, Date.now(), id]
  );
}

/** [FIX: memory-extraction-backlog] Check if extraction catch-up is pending */
export function getExtractionPending(id: string): boolean {
  const rows = execQuery('SELECT extraction_pending FROM sessions WHERE id = ?', [id]);
  return rows.length > 0 && rows[0].extraction_pending === 1;
}
