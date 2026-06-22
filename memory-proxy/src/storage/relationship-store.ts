import { createHash } from 'crypto';
import { execQuery, runAndPersist } from './db.js';
import { Relationship, RelationType, RelationshipMetrics, EvolutionEntry } from '../types/relationship.js';

function dedupKey(session_id: string, subject_id: string, object_id: string, relation_type: RelationType): string {
  const raw = `${subject_id}|${object_id}|${relation_type}|${session_id}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

interface InsertRelationshipInput {
  session_id: string;
  subject_id: string;
  object_id: string;
  relation_type: RelationType;
  intensity?: number;
  description?: string;
  trace_id: string;
}

export function insertRelationship(input: InsertRelationshipInput): Relationship {
  const dk = dedupKey(input.session_id, input.subject_id, input.object_id, input.relation_type);
  const now = Date.now();

  const existing = execQuery('SELECT * FROM relationships WHERE id = ?', [dk]);
  if (existing.length > 0) {
    const row = existing[0];
    const newIntensity = input.intensity ?? row.intensity;
    runAndPersist(
      `UPDATE relationships SET intensity = ?, description = ?, trace_id = ?, version = version + 1, updated_at = ? WHERE id = ?`,
      [newIntensity, input.description || row.description, input.trace_id, now, dk]
    );
    return getRelationship(dk)!;
  }

  runAndPersist(
    `INSERT INTO relationships (id, session_id, subject_id, object_id, relation_type, intensity, description, evolution, metrics, trace_id, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '[]', NULL, ?, 1, ?, ?)`,
    [dk, input.session_id, input.subject_id, input.object_id, input.relation_type,
     input.intensity || 0, input.description || '', input.trace_id, now, now]
  );
  return getRelationship(dk)!;
}

function clampIntensity(v: number): number {
  // Clamp to [-1, 1] AND round to 2 decimals — repeated float accumulation
  // (e.g. 0.27 + 0.09 + 0.09) otherwise yields 0.44999999999999996, which is
  // ugly in logs and can drift in comparisons. 2 decimals is enough granularity
  // for relationship intensity (signal deltas are ~0.05-0.30).
  return Math.round(Math.max(-1, Math.min(1, v)) * 100) / 100;
}

export interface ApplyRelationshipSignalInput {
  session_id: string;
  subject_id: string;
  object_id: string;
  relation_type: RelationType;
  intensityDelta: number;
  description: string;
  signalType: string;
  round: number;
  trace_id: string;
}

/**
 * Apply a relationship signal by ACCUMULATING its intensity delta into the
 * matching relationship row (creating it if absent). Unlike insertRelationship
 * (which overwrites intensity), this accumulates: each signal nudges intensity
 * up/down, clamped to [-1, 1]. The signal is also recorded as an evolution
 * entry (capped at EVOLUTION_MAX by addEvolutionEntry).
 */
export function applyRelationshipSignal(input: ApplyRelationshipSignalInput): Relationship {
  const dk = dedupKey(input.session_id, input.subject_id, input.object_id, input.relation_type);
  const now = Date.now();
  const existing = execQuery('SELECT * FROM relationships WHERE id = ?', [dk]);

  const clampedDelta = clampIntensity(input.intensityDelta);
  // Encode signalType into change_desc as `[type] description` so getRecentRelationshipSignals
  // can recover the signal type for cross-round dedup. EvolutionEntry has no `type` field.
  const entry: EvolutionEntry = {
    round: input.round,
    timestamp: now,
    change_desc: `[${input.signalType}] ${input.description}`,
    intensity_delta: clampedDelta,
  };

  if (existing.length > 0) {
    const row = existing[0];
    const currentIntensity = Number(row.intensity) || 0;
    const newIntensity = clampIntensity(currentIntensity + clampedDelta);
    runAndPersist(
      `UPDATE relationships SET intensity = ?, description = ?, trace_id = ?, version = version + 1, updated_at = ? WHERE id = ?`,
      [newIntensity, input.description || row.description, input.trace_id, now, dk]
    );
    addEvolutionEntry(dk, entry);
    return getRelationship(dk)!;
  }

  runAndPersist(
    `INSERT INTO relationships (id, session_id, subject_id, object_id, relation_type, intensity, description, evolution, metrics, trace_id, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '[]', NULL, ?, 1, ?, ?)`,
    [dk, input.session_id, input.subject_id, input.object_id, input.relation_type,
     clampIntensity(clampedDelta), input.description, input.trace_id, now, now]
  );
  addEvolutionEntry(dk, entry);
  return getRelationship(dk)!;
}

export function getRecentRelationshipSignals(
  sessionId: string,
  limit: number
): Array<{ actor: string; target: string; type: string; round: number; description: string }> {
  // Build an id→name map so we can inject human-readable names (not raw hash ids) into the
  // RS prompt's recent-signals section. Injecting ids leaks them back to the LLM, which then
  // parrots them as actor/target — causing duplicate-entity registration. Names are stable
  // and the LLM naturally re-emits them.
  const entityRows = execQuery('SELECT id, name FROM entities WHERE session_id = ?', [sessionId]);
  const nameById = new Map<string, string>();
  for (const r of entityRows) nameById.set(r.id, r.name);

  const rows = execQuery('SELECT subject_id, object_id, evolution FROM relationships WHERE session_id = ?', [sessionId]);
  const all: Array<{ actor: string; target: string; type: string; round: number; description: string }> = [];
  for (const row of rows) {
    let evolution: any[];
    try {
      const parsed = JSON.parse(row.evolution || '[]');
      evolution = Array.isArray(parsed) ? parsed : [];
    } catch {
      evolution = [];
    }
    for (const entry of evolution) {
      const rawDesc: string = entry.change_desc || '';
      // change_desc is stored as `[signalType] description` by applyRelationshipSignal — split it back out.
      const match = rawDesc.match(/^\[([^\]]+)\]\s?(.*)$/);
      all.push({
        actor: nameById.get(row.subject_id) || row.subject_id,
        target: nameById.get(row.object_id) || row.object_id,
        type: match ? match[1] : '',
        round: entry.round || 0,
        description: match ? match[2] : rawDesc,
      });
    }
  }
  // Newest first by round.
  all.sort((a, b) => b.round - a.round);
  return all.slice(0, limit);
}

export function getRelationship(id: string): Relationship | null {
  const rows = execQuery('SELECT * FROM relationships WHERE id = ?', [id]);
  return rows.length ? rowToRelationship(rows[0]) : null;
}

export function getRelationshipsByEntity(session_id: string, entity_id: string): Relationship[] {
  const rows = execQuery(
    'SELECT * FROM relationships WHERE session_id = ? AND (subject_id = ? OR object_id = ?)',
    [session_id, entity_id, entity_id]
  );
  return rows.map(rowToRelationship);
}

const EVOLUTION_MAX = 50;

export function addEvolutionEntry(
  relationshipId: string,
  entry: EvolutionEntry
): void {
  const rows = execQuery('SELECT evolution FROM relationships WHERE id = ?', [relationshipId]);
  if (!rows.length) throw new Error(`Relationship not found: ${relationshipId}`);

  let evolution: EvolutionEntry[];
  try {
    const parsed = JSON.parse(rows[0].evolution || '[]');
    evolution = Array.isArray(parsed) ? parsed : [];
  } catch {
    // Corrupted JSON — reset to empty rather than losing the whole relationship row.
    evolution = [];
  }

  evolution.push(entry);
  // Cap: keep only the most recent EVOLUTION_MAX entries (trim oldest).
  if (evolution.length > EVOLUTION_MAX) {
    evolution = evolution.slice(evolution.length - EVOLUTION_MAX);
  }

  runAndPersist(
    'UPDATE relationships SET evolution = ?, version = version + 1, updated_at = ? WHERE id = ?',
    [JSON.stringify(evolution), Date.now(), relationshipId]
  );
}

export function updateRelationshipIntensity(
  id: string,
  newIntensity: number,
  metrics?: RelationshipMetrics
): void {
  const now = Date.now();
  runAndPersist(
    `UPDATE relationships SET intensity = ?, metrics = ?, version = version + 1, updated_at = ? WHERE id = ?`,
    [newIntensity, metrics ? JSON.stringify(metrics) : null, now, id]
  );
}

function rowToRelationship(row: any): Relationship {
  return {
    id: row.id, session_id: row.session_id,
    subject_id: row.subject_id, object_id: row.object_id,
    relation_type: row.relation_type as RelationType,
    intensity: row.intensity, description: row.description,
    evolution: JSON.parse(row.evolution || '[]'),
    metrics: row.metrics ? JSON.parse(row.metrics) : undefined,
    trace_id: row.trace_id, version: row.version,
    created_at: row.created_at, updated_at: row.updated_at,
  };
}
