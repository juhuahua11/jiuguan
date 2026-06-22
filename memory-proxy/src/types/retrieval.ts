export interface QueryContext {
  entities: string[];
  locations: string[];
  intents: string[];
  narrativeHooks: string[];
  implicitRules: string[];
}

export interface RetrievalResult {
  facts: string[];
  events: string[];
  relationships: string[];
  canon_entries: string[];
  provenance: Array<{ id: string; source: string; score: number; tier: 1 | 2 | 3 }>;
}

export interface RetrievalCacheEntry {
  cache_key: string;
  facts: string[];
  events: string[];
  relationships: string[];
  canon_entries: string[];
  created_at: number;
  ttl_ms: number;
}
