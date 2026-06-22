import { QualityMetrics, QualityWarning } from '../types/metrics.js';
import { execQuery } from '../storage/db.js';

export async function collectMetrics(sessionId: string): Promise<QualityMetrics> {
  const facts = execQuery('SELECT COUNT(*) as c FROM facts WHERE session_id = ? AND tombstone_deleted = 0', [sessionId])[0] as any;
  const events = execQuery('SELECT COUNT(*) as c FROM events WHERE session_id = ?', [sessionId])[0] as any;
  const relationships = execQuery('SELECT COUNT(*) as c FROM relationships WHERE session_id = ?', [sessionId])[0] as any;
  const entities = execQuery('SELECT COUNT(*) as c FROM entities WHERE session_id = ?', [sessionId])[0] as any;
  const canon = execQuery('SELECT COUNT(*) as c FROM canon_entries WHERE (session_id = ? OR session_id IS NULL) AND archived_at IS NULL', [sessionId])[0] as any;

  const warnings: QualityWarning[] = [];

  // Check for orphan candidates
  const factsExpiring = execQuery(
    'SELECT COUNT(*) as c FROM facts WHERE session_id = ? AND valid_to IS NOT NULL AND valid_to < ? AND tombstone_deleted = 0',
    [sessionId, Date.now()]
  )[0] as any;

  if (factsExpiring.c > 50) {
    warnings.push({
      severity: 'warning',
      category: 'storage',
      message: `${factsExpiring.c} facts have expired — consider running GC`,
      raised_at: Date.now(),
    });
  }

  const overallScore = calculateOverallScore(
    facts.c, events.c, relationships.c, entities.c
  );

  return {
    total_facts: facts.c,
    total_events: events.c,
    total_relationships: relationships.c,
    total_entities: entities.c,
    total_canon_entries: canon.c,
    storage_bytes: 0, // Not tracked in V1
    active_conflict_count: 0,
    duplicate_entity_candidates: 0,
    orphan_graph_nodes: 0,
    tombstone_count: 0,
    facts_expiring_soon: factsExpiring.c,
    extraction_success_rate: 1.0,
    avg_salients_per_cycle: 0,
    facts_blocked_by_canon_rate: 0,
    retrieval_cache_hit_rate: 0,
    avg_retrieval_latency_ms: 0,
    overall_quality_score: overallScore,
    warnings,
  };
}

function calculateOverallScore(
  facts: number, events: number, relationships: number, entities: number
): number {
  // Simple heuristic: a non-empty memory with facts is healthy
  if (facts === 0 && events === 0) return 0.5; // Barely started
  if (facts > 10 && entities > 5) return 0.85;
  if (facts > 0) return 0.7;
  return 0.5;
}
