import type { ContinuitySnapshot, ContinuitySnapshotBuildInput } from '../types/continuity.js';
import { execQuery } from '../storage/db.js';

function parseArray<T>(value: string | null | undefined): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function descriptions(items: Array<{ description?: string }>): string[] {
  return items.map(item => item.description || '').filter(Boolean);
}

type SnapshotBody = Omit<ContinuitySnapshot, 'compact_text' | 'medium_text' | 'full_text'>;

export async function buildContinuitySnapshot(
  sessionId: string,
  input: ContinuitySnapshotBuildInput
): Promise<ContinuitySnapshot> {
  const state = execQuery('SELECT * FROM current_states WHERE session_id = ?', [sessionId])[0];
  const eventsDesc = execQuery(
    'SELECT * FROM events WHERE session_id = ? ORDER BY timestamp_round DESC LIMIT 12',
    [sessionId]
  );
  const events = [...eventsDesc].reverse();
  const relationships = execQuery(
    'SELECT * FROM relationships WHERE session_id = ? ORDER BY updated_at DESC LIMIT 12',
    [sessionId]
  );
  const protagonistFacts = execQuery(
    `SELECT statement FROM facts
     WHERE session_id = ? AND tombstone_deleted = 0 AND valid_to IS NULL
       AND (subject_id = 'user' OR subject_id = 'User' OR subject_id = 'protagonist')
     ORDER BY updated_at DESC LIMIT 8`,
    [sessionId]
  );
  const canon = execQuery(
    `SELECT statement FROM canon_entries
     WHERE (session_id = ? OR session_id IS NULL) AND archived_at IS NULL
     ORDER BY updated_at DESC LIMIT 8`,
    [sessionId]
  );

  const pendingQuestions = descriptions(parseArray(state?.pending_questions));
  const pendingPromises = descriptions(parseArray(state?.pending_promises));
  const activeQuests = descriptions(parseArray(state?.active_quests));
  const unresolvedHooks = descriptions(parseArray(state?.unresolved_hooks));
  const recentMessages = input.recentMessages || [];
  const latestMessage = recentMessages.length ? recentMessages[recentMessages.length - 1].content : null;

  const timeline = events.map((event: any) => ({
    id: event.id,
    description: event.description,
    round: event.timestamp_round,
    significance: event.significance,
  }));

  const relationshipContinuity = relationships.map((rel: any) => ({
    subject_id: rel.subject_id,
    object_id: rel.object_id,
    relation_type: rel.relation_type,
    intensity: Number(rel.intensity || 0),
    description: rel.description || `${rel.subject_id} ${rel.relation_type} ${rel.object_id}`,
  }));

  // Build id→name map so the snapshot shows human-readable names for characters_present
  // (which stores stable entity ids). New models接手时看到名字而非 hash id，更易理解。
  const entityRows = execQuery('SELECT id, name FROM entities WHERE session_id = ?', [sessionId]);
  const nameById = new Map<string, string>();
  for (const r of entityRows) nameById.set(r.id, r.name);
  const charactersPresent = parseArray<string>(state?.characters_present).map(
    id => nameById.get(id) || id
  );

  const snapshotBody: SnapshotBody = {
    session_id: sessionId,
    version: 1,
    source_round: input.sourceRound,
    scene: {
      location: state?.location_value || null,
      characters_present: charactersPresent,
      current_action: latestMessage,
    },
    plot: {
      active_quests: activeQuests,
      recent_progress: eventsDesc.slice(0, 5).map((event: any) => event.description),
    },
    unresolved: {
      pending_questions: pendingQuestions,
      pending_promises: pendingPromises,
      unresolved_hooks: unresolvedHooks,
    },
    relationships: relationshipContinuity,
    characters: relationshipContinuity.map(rel => ({ id: rel.subject_id, notes: [rel.description] })),
    protagonist: {
      assets: protagonistFacts.map((fact: any) => fact.statement),
      goals: activeQuests,
    },
    timeline,
    world: {
      notes: canon.map((entry: any) => entry.statement),
    },
    interaction_contract: {
      notes: ['保持已经建立的称呼、相处模式、情绪温度和角色边界。'],
    },
    continuity_constraints: [
      ...canon.map((entry: any) => ({ statement: entry.statement, source: 'canon' as const })),
      ...relationshipContinuity.map(rel => ({ statement: rel.description, source: 'relationship' as const })),
      ...timeline.slice(-5).map(event => ({ statement: event.description, source: 'event' as const })),
    ],
  };

  const compact_text = renderCompact(snapshotBody);
  const medium_text = renderMedium(snapshotBody);
  const full_text = renderFull(snapshotBody);
  return { ...snapshotBody, compact_text, medium_text, full_text };
}

function joinOrNone(items: string[]): string {
  return items.length ? items.join('; ') : '无';
}

function renderCompact(snapshot: SnapshotBody): string {
  return [
    '[当前场景]',
    `地点: ${snapshot.scene.location || '未知'}`,
    `在场人物: ${snapshot.scene.characters_present.join('、') || '未知'}`,
    '[未解决事项]',
    joinOrNone([
      ...snapshot.unresolved.pending_questions,
      ...snapshot.unresolved.pending_promises,
      ...snapshot.unresolved.unresolved_hooks,
    ].slice(0, 6)),
    '[核心关系]',
    joinOrNone(snapshot.relationships.slice(0, 6).map(rel => rel.description)),
    '[最近关键事件]',
    joinOrNone(snapshot.timeline.slice(-5).map(event => event.description)),
  ].join('\n');
}

function renderMedium(snapshot: SnapshotBody): string {
  return [
    renderCompact(snapshot),
    '[当前目标]',
    joinOrNone(snapshot.plot.active_quests),
    '[主角状态]',
    joinOrNone(snapshot.protagonist.assets),
    '[连续性约束]',
    joinOrNone(snapshot.continuity_constraints.slice(0, 10).map(item => item.statement)),
  ].join('\n');
}

function renderFull(snapshot: SnapshotBody): string {
  return [
    '[模型接手用完整连续性]',
    renderMedium(snapshot),
    '[完整事件链]',
    snapshot.timeline.length
      ? snapshot.timeline.map(event => `第${event.round}轮: ${event.description}`).join('\n')
      : '无',
    '[互动契约]',
    joinOrNone(snapshot.interaction_contract.notes),
  ].join('\n');
}
