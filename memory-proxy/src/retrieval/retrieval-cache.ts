import { RetrievalCacheEntry } from '../types/retrieval.js';
import { createHash } from 'crypto';

export class RetrievalCache {
  private entries: Map<string, RetrievalCacheEntry> = new Map();
  private defaultTtl: number;

  constructor(ttlMs: number = 30000) {
    this.defaultTtl = ttlMs;
  }

  getCacheKey(entities: string[], locations: string[], intents: string[], narrativeHooks: string[], canonTriggers: string[]): string {
    const raw = JSON.stringify({ entities: entities.sort(), locations: locations.sort(), intents, narrativeHooks, canonTriggers });
    return createHash('sha256').update(raw).digest('hex').slice(0, 16);
  }

  get(key: string): RetrievalCacheEntry | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() - entry.created_at > entry.ttl_ms) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }

  set(key: string, entry: Omit<RetrievalCacheEntry, 'cache_key' | 'created_at' | 'ttl_ms'>): void {
    this.entries.set(key, {
      cache_key: key,
      ...entry,
      created_at: Date.now(),
      ttl_ms: this.defaultTtl,
    });
  }

  clear(): void {
    this.entries.clear();
  }
}
