import { v4 as uuid } from 'uuid';
import { execQuery, runAndPersist } from './db.js';
import type {
  ContinuitySnapshot,
  ModelHandoff,
  SceneState,
  PlotState,
  UnresolvedState,
  RelationshipContinuity,
  CharacterContinuity,
  ProtagonistContinuity,
  TimelineEvent,
  WorldContinuity,
  InteractionContract,
  ContinuityConstraint,
} from '../types/continuity.js';

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export async function saveContinuitySnapshot(snapshot: ContinuitySnapshot): Promise<ContinuitySnapshot> {
  const now = Date.now();
  const id = snapshot.id || uuid();
  const createdAt = snapshot.created_at || now;

  await runAndPersist(
    `INSERT INTO continuity_snapshots (
      id, session_id, version, source_round, scene, plot, unresolved, relationships,
      characters, protagonist, timeline, world, interaction_contract, continuity_constraints,
      compact_text, medium_text, full_text, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      snapshot.session_id,
      snapshot.version,
      snapshot.source_round,
      JSON.stringify(snapshot.scene),
      JSON.stringify(snapshot.plot),
      JSON.stringify(snapshot.unresolved),
      JSON.stringify(snapshot.relationships),
      JSON.stringify(snapshot.characters),
      JSON.stringify(snapshot.protagonist),
      JSON.stringify(snapshot.timeline),
      JSON.stringify(snapshot.world),
      JSON.stringify(snapshot.interaction_contract),
      JSON.stringify(snapshot.continuity_constraints),
      snapshot.compact_text,
      snapshot.medium_text,
      snapshot.full_text,
      createdAt,
      now,
    ]
  );

  return { ...snapshot, id, created_at: createdAt, updated_at: now };
}

export function getLatestContinuitySnapshot(sessionId: string): ContinuitySnapshot | null {
  const row = execQuery(
    'SELECT * FROM continuity_snapshots WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1',
    [sessionId]
  )[0];
  return row ? rowToSnapshot(row) : null;
}

export function rowToSnapshot(row: any): ContinuitySnapshot {
  return {
    id: row.id,
    session_id: row.session_id,
    version: row.version,
    source_round: row.source_round,
    scene: parseJson<SceneState>(row.scene, { location: null, characters_present: [], current_action: null }),
    plot: parseJson<PlotState>(row.plot, { active_quests: [], recent_progress: [] }),
    unresolved: parseJson<UnresolvedState>(row.unresolved, { pending_questions: [], pending_promises: [], unresolved_hooks: [] }),
    relationships: parseJson<RelationshipContinuity[]>(row.relationships, []),
    characters: parseJson<CharacterContinuity[]>(row.characters, []),
    protagonist: parseJson<ProtagonistContinuity>(row.protagonist, { assets: [], goals: [] }),
    timeline: parseJson<TimelineEvent[]>(row.timeline, []),
    world: parseJson<WorldContinuity>(row.world, { notes: [] }),
    interaction_contract: parseJson<InteractionContract>(row.interaction_contract, { notes: [] }),
    continuity_constraints: parseJson<ContinuityConstraint[]>(row.continuity_constraints, []),
    compact_text: row.compact_text,
    medium_text: row.medium_text,
    full_text: row.full_text,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function saveModelHandoff(handoff: ModelHandoff): Promise<void> {
  await runAndPersist(
    `INSERT INTO model_handoffs (
      id, session_id, from_model, to_model, snapshot_id, created_round,
      boost_turns_total, boost_turns_remaining, full_turns, medium_turns,
      handoff_text, active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      handoff.id,
      handoff.session_id,
      handoff.from_model,
      handoff.to_model,
      handoff.snapshot_id,
      handoff.created_round,
      handoff.boost_turns_total,
      handoff.boost_turns_remaining,
      handoff.full_turns,
      handoff.medium_turns,
      handoff.handoff_text,
      handoff.active ? 1 : 0,
      handoff.created_at,
      handoff.updated_at,
    ]
  );
}

export function getActiveModelHandoff(sessionId: string): ModelHandoff | null {
  const row = execQuery(
    'SELECT * FROM model_handoffs WHERE session_id = ? AND active = 1 ORDER BY updated_at DESC LIMIT 1',
    [sessionId]
  )[0];
  return row ? rowToHandoff(row) : null;
}

export function rowToHandoff(row: any): ModelHandoff {
  return {
    id: row.id,
    session_id: row.session_id,
    from_model: row.from_model || null,
    to_model: row.to_model,
    snapshot_id: row.snapshot_id,
    created_round: row.created_round,
    boost_turns_total: row.boost_turns_total,
    boost_turns_remaining: row.boost_turns_remaining,
    full_turns: row.full_turns,
    medium_turns: row.medium_turns,
    handoff_text: row.handoff_text,
    active: row.active === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function decrementHandoffBoost(handoffId: string): Promise<void> {
  const row = execQuery('SELECT boost_turns_remaining FROM model_handoffs WHERE id = ?', [handoffId])[0];
  if (!row) return;
  const next = Math.max(0, Number(row.boost_turns_remaining) - 1);
  await runAndPersist(
    'UPDATE model_handoffs SET boost_turns_remaining = ?, active = ?, updated_at = ? WHERE id = ?',
    [next, next > 0 ? 1 : 0, Date.now(), handoffId]
  );
}

export async function updateSessionModelState(
  sessionId: string,
  model: string,
  handoffId: string | null
): Promise<void> {
  await runAndPersist(
    'UPDATE sessions SET last_chat_model = ?, last_model_seen_at = ?, active_handoff_id = ? WHERE id = ?',
    [model, Date.now(), handoffId || '', sessionId]
  );
}

export function getSessionModelState(sessionId: string): {
  last_chat_model: string;
  active_handoff_id: string;
} {
  const row = execQuery(
    'SELECT last_chat_model, active_handoff_id FROM sessions WHERE id = ?',
    [sessionId]
  )[0];
  return {
    last_chat_model: row?.last_chat_model || '',
    active_handoff_id: row?.active_handoff_id || '',
  };
}
