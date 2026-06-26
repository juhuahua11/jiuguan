import { v4 as uuid } from 'uuid';
import { ChatMessage } from '../types/provider.js';
import { ExtractionReport } from '../types/extraction.js';
import { EntityResolver } from './entity-resolution.js';
import { EntityType } from '../types/entity.js';
import { execQuery as _execQuery } from '../storage/db.js';

/**
 * Resolve an LLM-emitted entity reference (which may be a name, an already-known id, or
 * a free-form string) to a stable entity id. Used by both fact-event (subject/object/participants)
 * and RS (actor/target) stages so facts/events/relationships share consistent entity ids.
 *
 *  1. lookup by name/alias → use that entity's id
 *  2. matches an existing entity's id OR name (covers the LLM parroting an id back, and
 *     the case where a prior buggy register stored an id-as-name) → reuse it
 *  3. genuinely unseen → register as CHARACTER to get a stable id
 *
 * Returns the resolved id, or the raw input as a last resort (never registers an empty string).
 */
function resolveEntityId(
  resolver: EntityResolver,
  sessionId: string,
  ref: string,
  round: number
): string {
  if (!ref) return ref;
  const lookedUp = resolver.lookup(sessionId, ref);
  if (lookedUp) return lookedUp.id;
  const existing = _execQuery(
    'SELECT id FROM entities WHERE session_id = ? AND (id = ? OR name = ?)',
    [sessionId, ref, ref]
  )[0];
  if (existing) return existing.id;
  return resolver.register(sessionId, ref, EntityType.CHARACTER, round).id;
}
import { buildSalientPrompt, parseSalientResponse } from './salient-extraction.js';
import { buildFactEventPrompt, parseFactEventResponse } from './fact-event-extraction.js';
import { normalizeExtractionResults } from './normalization.js';
import { checkFactAgainstCanon } from './canon-gate.js';
import { FactSource } from '../types/fact.js';
import { insertFact } from '../storage/fact-store.js';
import { applyStatePatches } from '../storage/current-state-store.js';
import { execQuery } from '../storage/db.js';
import { indexFactKeywords } from '../storage/fact-keyword-indexer.js';
import { insertEvent } from '../storage/event-store.js';
import { buildRelationshipStatePrompt, parseRelationshipStateResponse } from './relationship-state-extraction.js';
import { computeIntensityDelta } from './relationship-engine.js';
import { applyRelationshipSignal, getRecentRelationshipSignals } from '../storage/relationship-store.js';
import { getCurrentState } from '../storage/current-state-store.js';
import { invalidateGraph } from './graph-builder.js';

export interface PipelineInput {
  sessionId: string;
  round: number;
  overflowMessages: ChatMessage[];
  statePatches?: Array<{ op: string; value?: string; item?: string; id?: string; text?: string }>;
  /** LLM call function — injected so pipeline is testable without real LLM */
  llmCall: (prompt: string) => Promise<string>;
}

export async function runExtractionPipeline(input: PipelineInput): Promise<ExtractionReport> {
  const runId = uuid();
  const startTime = Date.now();
  const report: ExtractionReport = {
    run_id: runId,
    session_id: input.sessionId,
    round: input.round,
    timestamp: startTime,
    duration_ms: 0,
    entities_found: 0,
    entities_new: 0,
    state_operations: 0,
    salients_extracted: 0,
    facts_extracted: 0,
    facts_blocked_by_canon: 0,
    events_extracted: 0,
    relationships_extracted: 0,
    writes_succeeded: 0,
    writes_failed: 0,
    errors: [],
    warnings: [],
  };

  try {
    // Step 1: Apply state patches if any
    if (input.statePatches && input.statePatches.length > 0) {
      applyStatePatches(input.sessionId, input.statePatches, input.round);
      report.state_operations = input.statePatches.length;
    }

    // Step 3: Salient Extraction (if we have overflow messages)
    if (input.overflowMessages.length > 0) {
      const entityResolver = new EntityResolver();
      const knownEntities = execQuery(
        'SELECT name FROM entities WHERE session_id = ?', [input.sessionId]
      ).map((e: any) => e.name);

      // Query existing facts so the model knows what NOT to re-extract
      const existingFacts = execQuery(
        'SELECT statement FROM facts WHERE session_id = ? AND valid_to IS NULL AND tombstone_deleted = 0',
        [input.sessionId]
      ).map((f: any) => f.statement);

      const salientPrompt = buildSalientPrompt(input.overflowMessages, knownEntities);
      const salientResponse = await input.llmCall(salientPrompt);
      const salients = parseSalientResponse(salientResponse, input.round);
      report.salients_extracted = salients.length;

      // Step 4: Fact + Event Extraction
      if (salients.length > 0) {

        const allEntities = execQuery(
          'SELECT id, name FROM entities WHERE session_id = ?', [input.sessionId]
        ).map((e: any) => ({ id: e.id, name: e.name }));

        // Resolver for fact-event entity ids: LLM-emitted subject_id/object_id/participants
        // may be names, stale ids, or free-form strings. Resolve them to stable entity ids
        // so facts/events share consistent ids with relationships (cross-model stable).
        const factEventResolver = new EntityResolver();

        const factEventPrompt = buildFactEventPrompt(salients, allEntities, existingFacts);
        const factEventResponse = await input.llmCall(factEventPrompt);
        const { facts, events } = parseFactEventResponse(
          factEventResponse, input.sessionId, FactSource.ASSISTANT, runId, input.round
        );

        // Normalize
        const normalized = normalizeExtractionResults(facts, events);

        // Canon Gate + Write for each fact
        for (const fact of normalized.facts) {
          const gateResult = await checkFactAgainstCanon(input.sessionId, fact);
          if (gateResult.action === 'BLOCK') {
            report.facts_blocked_by_canon++;
            continue;
          }
          if (gateResult.action === 'WARN') {
            fact.confidence = (fact.confidence || 0.6) * 0.6;
          }
          try {
            const inserted = insertFact({
              session_id: input.sessionId,
              subject_id: resolveEntityId(factEventResolver, input.sessionId, fact.subject_id || '', input.round),
              predicate: fact.predicate || '',
              object_id: fact.object_id ? resolveEntityId(factEventResolver, input.sessionId, fact.object_id, input.round) : null,
              statement: fact.statement || '',
              confidence: fact.confidence || 0.5,
              source: FactSource.ASSISTANT,
              fact_type: (fact as any).fact_type ?? 'general',
              valid_from: fact.valid_from || input.round,
              valid_to: fact.valid_to || null,
              trace_id: runId,
            });
            report.writes_succeeded++;
            report.facts_extracted++;

            // Index keywords for retrieval (V4.1) — use returned fact, no re-query
            indexFactKeywords(inserted.id, inserted.statement);
          } catch {
            report.writes_failed++;
          }
        }

        // Write events to DB
        report.events_extracted = 0; // Reset counter — will count successful writes
        for (const ev of normalized.events) {
          try {
            const resolvedParticipants = (ev.participants || []).map((p: string) =>
              resolveEntityId(factEventResolver, input.sessionId, p, input.round)
            );
            insertEvent({
              session_id: input.sessionId,
              description: ev.description || '',
              participants: JSON.stringify(resolvedParticipants),
              location_id: ev.location_id || undefined,
              significance: ev.significance || 'MEDIUM',
              timestamp_round: input.round,
              caused_by: ev.caused_by ? JSON.stringify(ev.caused_by) : undefined,
              causes: ev.causes ? JSON.stringify(ev.causes) : undefined,
              trace_id: runId,
            });
            report.events_extracted++;
            report.writes_succeeded++;
          } catch {
            report.writes_failed++;
          }
        }

        // Step 5: Relationship + State Extraction (new stage, reuses salients)
        try {
          const currentState = getCurrentState(input.sessionId);
          const pendingList = currentState
            ? [
                ...currentState.pending_questions.map(i => ({ kind: 'question' as const, description: i.description, round: i.raised_at_round })),
                ...currentState.pending_promises.map(i => ({ kind: 'promise' as const, description: i.description, round: i.raised_at_round })),
                ...currentState.active_quests.map(i => ({ kind: 'quest' as const, description: i.description, round: i.raised_at_round })),
                ...currentState.unresolved_hooks.map(i => ({ kind: 'hook' as const, description: i.description, round: i.raised_at_round })),
              ]
            : [];

          const recentSignals = getRecentRelationshipSignals(input.sessionId, 10);

          console.log(`[MemoryProxy] RS: stage start — salients=${salients.length} pending=${pendingList.length} recent_signals=${recentSignals.length} entities=${allEntities.length} round=${input.round}`);

          const rsPrompt = buildRelationshipStatePrompt(salients, allEntities, pendingList, recentSignals);
          const rsResponse = await input.llmCall(rsPrompt);
          const { signals, statePatches } = parseRelationshipStateResponse(rsResponse, input.round);

          console.log(`[MemoryProxy] RS: parsed — signals=${signals.length} state_patches=${statePatches.length} (raw_response_len=${rsResponse.length})`);

          // Same-round hard dedup on (actor, target, type).
          const seenKeys = new Set<string>();
          let dedupedCount = 0;
          const dedupedSignals = signals.filter(s => {
            const key = `${s.actor}|${s.target}|${s.type}`;
            if (seenKeys.has(key)) { dedupedCount++; return false; }
            seenKeys.add(key);
            return true;
          });

          const resolver = new EntityResolver();
          let signalsApplied = 0;
          let signalsSkipped = 0;
          for (const sig of dedupedSignals) {
            const delta = computeIntensityDelta(sig);
            if (!delta) {
              report.warnings.push(`unknown signal type: ${sig.type}`);
              signalsSkipped++;
              console.log(`[MemoryProxy] RS: signal skipped — type=${sig.type} actor=${sig.actor} target=${sig.target} (not in 15 enums)`);
              continue;
            }
            // Resolve actor/target to stable entity IDs via the shared helper.
            const subjectId = resolveEntityId(resolver, input.sessionId, sig.actor, input.round);
            const objectId = resolveEntityId(resolver, input.sessionId, sig.target, input.round);
            const actorResolved = `${sig.actor}→${subjectId}`;
            const targetResolved = `${sig.target}→${objectId}`;
            try {
              const result = applyRelationshipSignal({
                session_id: input.sessionId,
                subject_id: subjectId,
                object_id: objectId,
                relation_type: delta.primaryType,
                intensityDelta: delta.intensityDelta,
                description: sig.description,
                signalType: sig.type,
                round: input.round,
                trace_id: runId,
              });
              const isNew = result.evolution.length === 1;
              console.log(`[MemoryProxy] RS: signal — type=${sig.type} actor=${actorResolved} target=${targetResolved} delta=${delta.intensityDelta > 0 ? '+' : ''}${delta.intensityDelta} relation=${delta.primaryType} intensity=${result.intensity} (${isNew ? 'new' : 'accumulated, ev=' + result.evolution.length})`);
              report.relationships_extracted++;
              report.writes_succeeded++;
              signalsApplied++;
            } catch (err: any) {
              report.errors.push(`applyRelationshipSignal failed: ${err.message}`);
              report.writes_failed++;
              console.log(`[MemoryProxy] RS: signal error — type=${sig.type} err=${err.message}`);
            }
          }

          // Apply state patches (ensureCurrentState auto-creates the row on first patch).
          // For add_character/remove_character, resolve the item name→stable entity id
          // (same logic as signal actor/target) so characters_present stores stable ids,
          // not free-form names that drift across models.
          let patchesApplied = 0;
          let patchesMissed = 0;
          if (statePatches.length > 0) {
            for (const patch of statePatches) {
              if ((patch.op === 'add_character' || patch.op === 'remove_character') && patch.item) {
                patch.item = resolveEntityId(resolver, input.sessionId, patch.item, input.round);
              }
              const detail = patch.op === 'set_location' ? `value=${patch.value}`
                : (patch.op === 'add_character' || patch.op === 'remove_character') ? `item=${patch.item}`
                : patch.op.startsWith('resolve_') ? `text=${patch.text}`
                : `text=${patch.text}`;
              console.log(`[MemoryProxy] RS: patch — op=${patch.op} ${detail}`);
            }
            try {
              applyStatePatches(input.sessionId, statePatches, input.round);
              report.state_operations += statePatches.length;
              patchesApplied = statePatches.length;
            } catch (err: any) {
              report.errors.push(`applyStatePatches failed: ${err.message}`);
              console.log(`[MemoryProxy] RS: patches error — ${err.message}`);
            }
          }

          console.log(`[MemoryProxy] RS: stage done — signals_in=${signals.length} applied=${signalsApplied} skipped=${signalsSkipped} deduped=${dedupedCount} patches_in=${statePatches.length} patches_applied=${patchesApplied}`);
        } catch (err: any) {
          report.errors.push(`relationship-state stage failed: ${err.message}`);
          console.log(`[MemoryProxy] RS: stage failed — ${err.message}`);
        }
      }
    }
  } catch (err: any) {
    report.errors.push(err.message);
  }

  // Invalidate the in-memory graph cache so the next retrieval picks up
  // newly extracted facts/events/relationships. Without this, the graph
  // is built once and never refreshed — BFS path returns stale data.
  if (report.writes_succeeded > 0) {
    invalidateGraph(input.sessionId);
  }

  report.duration_ms = Date.now() - startTime;
  return report;
}
