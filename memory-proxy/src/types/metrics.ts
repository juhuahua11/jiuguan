export interface QualityMetrics {
  total_facts: number;
  total_events: number;
  total_relationships: number;
  total_entities: number;
  total_canon_entries: number;
  storage_bytes: number;
  active_conflict_count: number;
  duplicate_entity_candidates: number;
  orphan_graph_nodes: number;
  tombstone_count: number;
  facts_expiring_soon: number;
  extraction_success_rate: number;
  avg_salients_per_cycle: number;
  facts_blocked_by_canon_rate: number;
  retrieval_cache_hit_rate: number;
  avg_retrieval_latency_ms: number;
  overall_quality_score: number;
  warnings: QualityWarning[];
}

export interface QualityWarning {
  severity: 'info' | 'warning' | 'critical';
  category: 'conflict' | 'duplicate' | 'orphan' | 'latency' | 'extraction' | 'storage';
  message: string;
  raised_at: number;
}

export interface QualityProfile {
  name: string;
  weights: {
    extraction_success: number;
    conflict_rate: number;
    retrieval_performance: number;
    storage_health: number;
  };
}
