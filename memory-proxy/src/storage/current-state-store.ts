import { v4 as uuid } from 'uuid';
import { execQuery, runAndPersist } from './db.js';
import { CurrentState, StateField, PendingItem, StateSource } from '../types/current-state.js';

export function getCurrentState(sessionId: string): CurrentState | null {
  const rows = execQuery('SELECT * FROM current_states WHERE session_id = ?', [sessionId]);
  if (!rows.length) return null;
  return rowToState(rows[0]);
}

export function ensureCurrentState(sessionId: string): CurrentState {
  const existing = getCurrentState(sessionId);
  if (existing) return existing;

  const id = uuid();
  const now = Date.now();
  runAndPersist(
    `INSERT INTO current_states (id, session_id, location_value, location_confidence, location_source, location_updated_round,
      characters_present, inventory, pending_questions, pending_promises, active_quests, unresolved_hooks,
      last_updated_round, version, created_at, updated_at)
     VALUES (?, ?, NULL, 0, 'INFERRED', 0, '[]', '[]', '[]', '[]', '[]', '[]', 0, 1, ?, ?)`,
    [id, sessionId, now, now]
  );
  return getCurrentState(sessionId)!;
}

const ADD_FIELD_MAP: Record<string, string> = {
  'add_question': 'pending_questions',
  'add_promise': 'pending_promises',
  'add_quest': 'active_quests',
  'add_hook': 'unresolved_hooks',
};

const RESOLVE_FIELD_MAP: Record<string, string> = {
  'resolve_question': 'pending_questions',
  'resolve_promise': 'pending_promises',
  'resolve_quest': 'active_quests',
  'resolve_hook': 'unresolved_hooks',
};

export function applyStatePatches(
  sessionId: string,
  operations: Array<{
    op: string;
    value?: string;
    item?: string;
    id?: string;
    text?: string;
  }>,
  round: number
): CurrentState {
  const state = ensureCurrentState(sessionId);
  const now = Date.now();

  for (const op of operations) {
    switch (op.op) {
      case 'set_location':
        runAndPersist(
          'UPDATE current_states SET location_value = ?, location_confidence = 0.9, location_source = ?, location_updated_round = ?, updated_at = ? WHERE session_id = ?',
          [op.value || null, 'INFERRED', round, now, sessionId]
        );
        break;

      case 'add_inventory': {
        const inv = JSON.parse(execQuery('SELECT inventory FROM current_states WHERE session_id = ?', [sessionId])[0].inventory);
        if (!inv.includes(op.item)) {
          inv.push(op.item);
          runAndPersist('UPDATE current_states SET inventory = ?, updated_at = ? WHERE session_id = ?',
            [JSON.stringify(inv), now, sessionId]);
        }
        break;
      }

      case 'remove_inventory': {
        const inv = JSON.parse(execQuery('SELECT inventory FROM current_states WHERE session_id = ?', [sessionId])[0].inventory);
        const idx = inv.indexOf(op.item);
        if (idx >= 0) {
          inv.splice(idx, 1);
          runAndPersist('UPDATE current_states SET inventory = ?, updated_at = ? WHERE session_id = ?',
            [JSON.stringify(inv), now, sessionId]);
        }
        break;
      }

      case 'add_character': {
        const chars = JSON.parse(execQuery('SELECT characters_present FROM current_states WHERE session_id = ?', [sessionId])[0].characters_present);
        if (!chars.includes(op.item)) {
          chars.push(op.item);
          runAndPersist('UPDATE current_states SET characters_present = ?, updated_at = ? WHERE session_id = ?',
            [JSON.stringify(chars), now, sessionId]);
        }
        break;
      }

      case 'remove_character': {
        const chars = JSON.parse(execQuery('SELECT characters_present FROM current_states WHERE session_id = ?', [sessionId])[0].characters_present);
        const idx = chars.indexOf(op.item);
        if (idx >= 0) {
          chars.splice(idx, 1);
          runAndPersist('UPDATE current_states SET characters_present = ?, updated_at = ? WHERE session_id = ?',
            [JSON.stringify(chars), now, sessionId]);
        }
        break;
      }

      case 'add_question':
      case 'add_promise':
      case 'add_quest':
      case 'add_hook': {
        const field = ADD_FIELD_MAP[op.op];
        const items: PendingItem[] = JSON.parse(execQuery(`SELECT ${field} FROM current_states WHERE session_id = ?`, [sessionId])[0][field]);
        const newItem: PendingItem = {
          id: op.id || uuid(),
          description: op.text || '',
          raised_at_round: round,
          resolved_at_round: null,
          priority: 5,
        };
        items.push(newItem);
        runAndPersist(`UPDATE current_states SET ${field} = ?, updated_at = ? WHERE session_id = ?`,
          [JSON.stringify(items), now, sessionId]);
        break;
      }

      case 'resolve_question':
      case 'resolve_promise':
      case 'resolve_quest':
      case 'resolve_hook': {
        const field = RESOLVE_FIELD_MAP[op.op];
        const items: PendingItem[] = JSON.parse(execQuery(`SELECT ${field} FROM current_states WHERE session_id = ?`, [sessionId])[0][field]);
        const target = items.find(i => i.id === op.id || i.description === op.text);
        if (target) {
          target.resolved_at_round = round;
          runAndPersist(`UPDATE current_states SET ${field} = ?, updated_at = ? WHERE session_id = ?`,
            [JSON.stringify(items), now, sessionId]);
        }
        break;
      }
    }
  }

  runAndPersist(
    'UPDATE current_states SET last_updated_round = ?, updated_at = ? WHERE session_id = ?',
    [round, now, sessionId]
  );

  return getCurrentState(sessionId)!;
}

function rowToState(row: any): CurrentState {
  return {
    id: row.id,
    session_id: row.session_id,
    location: {
      value: row.location_value,
      confidence: row.location_confidence,
      source: row.location_source as StateSource,
      updated_round: row.location_updated_round,
    },
    characters_present: {
      value: JSON.parse(row.characters_present || '[]'),
      confidence: 1,
      source: 'INFERRED' as StateSource,
      updated_round: row.last_updated_round,
    },
    inventory: {
      value: JSON.parse(row.inventory || '[]'),
      confidence: 1,
      source: 'INFERRED' as StateSource,
      updated_round: row.last_updated_round,
    },
    pending_questions: JSON.parse(row.pending_questions || '[]'),
    pending_promises: JSON.parse(row.pending_promises || '[]'),
    active_quests: JSON.parse(row.active_quests || '[]'),
    unresolved_hooks: JSON.parse(row.unresolved_hooks || '[]'),
    last_updated_round: row.last_updated_round,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
