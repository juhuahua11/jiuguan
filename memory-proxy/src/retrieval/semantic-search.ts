import { execQuery } from '../storage/db.js';
import { KeywordContext } from './keyword-extractor.js';

export interface ScoredFact {
  id: string;
  type: 'fact';
  content: string;
  score: number;
  tier: number;
  source: 'semantic';
}

/**
 * Search facts by keywords using fact_keywords index.
 * SQL returns hit_count + matched_keywords for scoring without re-scanning.
 */
export async function searchFactsByKeywords(
  sessionId: string,
  keywordCtx: KeywordContext,
  topK: number = 20
): Promise<ScoredFact[]> {
  const allTerms = keywordCtx.search_terms;
  if (allTerms.length === 0) return [];

  const placeholders = allTerms.map(() => '?').join(', ');
  const sql = `
    SELECT f.id, f.statement, f.confidence, f.created_at, f.fact_type,
           COUNT(*) AS hit_count,
           GROUP_CONCAT(fk.keyword) AS matched_keywords
    FROM facts f
    JOIN fact_keywords fk ON fk.fact_id = f.id
    WHERE f.session_id = ?
      AND f.valid_to IS NULL
      AND f.tombstone_deleted = 0
      AND fk.keyword IN (${placeholders})
    GROUP BY f.id
    ORDER BY hit_count DESC
    LIMIT ?
  `;
  const params: (string | number)[] = [sessionId, ...allTerms, topK * 3];
  const rows = execQuery(sql, params);

  const scored: ScoredFact[] = [];
  for (const row of rows) {
    const result = classifyAndScore(row, keywordCtx);
    if (result) scored.push(result);
  }

  // Sort by score, tie-break deterministically
  scored.sort((a, b) => {
    if (Math.abs(a.score - b.score) > 0.01) return b.score - a.score;
    if (a.tier !== b.tier) return a.tier - b.tier;
    return a.id.localeCompare(b.id);
  });

  return scored.slice(0, topK);
}

/**
 * Classify a fact row (with SQL-side hit_count + matched_keywords) into tiers and score.
 *
 * Tier rules (revised per design review):
 *   - search_terms are recall-only — they appear in SQL but do NOT determine tier
 *   - Only entities and keywords (original, not synonyms) determine tier
 *   - implicit_topics do NOT participate — topicBoost is reserved at 1.0 for future embedding re-rank
 */
function classifyAndScore(row: any, ctx: KeywordContext): ScoredFact | null {
  const statement: string = row.statement;

  // Tier classification (entity > keyword only; search_terms not considered)
  let tier = 2;
  const matchedEntities: string[] = [];

  for (const entity of ctx.entities) {
    if (statement.includes(entity)) {
      tier = 1;
      matchedEntities.push(entity);
    }
  }

  // tier weight
  const tierWeight = tier === 1 ? 3.0 : 2.0;

  // Entity hit count bonus (Tier 1 only)
  let entityHitBonus = 1.0;
  if (tier === 1) {
    if (matchedEntities.length >= 3) entityHitBonus = 2.0;
    else if (matchedEntities.length >= 2) entityHitBonus = 1.5;
  }

  // Implicit topic boost — RESERVED at 1.0 for future embedding re-rank
  const topicBoost = 1.0;

  // Confidence
  const confidence = typeof row.confidence === 'number' ? row.confidence : 0.5;

  // Recency decay by fact_type (from LLM extraction)
  const ageDays = (Date.now() - (row.created_at || 0)) / (1000 * 60 * 60 * 24);
  const recency = computeRecency(ageDays, row.fact_type || 'general');

  const score = tierWeight * entityHitBonus * topicBoost * confidence * recency;

  return {
    id: row.id,
    type: 'fact',
    content: statement,
    score,
    tier,
    source: 'semantic',
  };
}

function computeRecency(ageDays: number, factType: string): number {
  switch (factType) {
    case 'identity':
    case 'relationship':
      return 1.0;
    case 'profile':
    case 'preference':
      return 1.0 / (1 + ageDays / 180);
    case 'event':
    case 'general':
    default:
      return 1.0 / (1 + ageDays / 30);
  }
}

// ── Event keyword search (V4.2) ──

export interface ScoredEvent {
  id: string;
  type: 'event';
  content: string;
  score: number;
  tier: number;
  source: 'semantic';
}

/**
 * Search events by keywords using event_keywords index.
 * Mirrors searchFactsByKeywords for the events table.
 */
export function searchEventsByKeywords(
  sessionId: string,
  keywordCtx: KeywordContext,
  topK: number = 20
): ScoredEvent[] {
  const allTerms = keywordCtx.search_terms;
  if (allTerms.length === 0) return [];

  const placeholders = allTerms.map(() => '?').join(', ');
  const sql = `
    SELECT e.id, e.description, e.significance, e.created_at,
           COUNT(*) AS hit_count,
           GROUP_CONCAT(ek.keyword) AS matched_keywords
    FROM events e
    JOIN event_keywords ek ON ek.event_id = e.id
    WHERE e.session_id = ?
      AND ek.keyword IN (${placeholders})
    GROUP BY e.id
    ORDER BY hit_count DESC
    LIMIT ?
  `;
  const params: (string | number)[] = [sessionId, ...allTerms, topK * 3];
  const rows = execQuery(sql, params);

  const scored: ScoredEvent[] = [];
  for (const row of rows) {
    const result = classifyEventScore(row, keywordCtx);
    if (result) scored.push(result);
  }

  scored.sort((a, b) => {
    if (Math.abs(a.score - b.score) > 0.01) return b.score - a.score;
    if (a.tier !== b.tier) return a.tier - b.tier;
    return a.id.localeCompare(b.id);
  });

  return scored.slice(0, topK);
}

function classifyEventScore(row: any, ctx: KeywordContext): ScoredEvent | null {
  const description: string = row.description;

  let tier = 2;
  let matchedEntities = 0;
  for (const entity of ctx.entities) {
    if (description.includes(entity)) {
      tier = 1;
      matchedEntities++;
    }
  }

  const tierWeight = tier === 1 ? 3.0 : 2.0;
  let entityHitBonus = 1.0;
  if (tier === 1) {
    if (matchedEntities >= 3) entityHitBonus = 2.0;
    else if (matchedEntities >= 2) entityHitBonus = 1.5;
  }

  // Significance weighting: CRITICAL events rank higher
  const sigWeight =
    row.significance === 'CRITICAL' ? 1.5 :
    row.significance === 'HIGH' ? 1.2 :
    row.significance === 'MEDIUM' ? 1.0 : 0.8;

  // Recency decay
  const ageDays = (Date.now() - (row.created_at || 0)) / (1000 * 60 * 60 * 24);
  const recency = 1.0 / (1 + ageDays / 30);

  const score = tierWeight * entityHitBonus * sigWeight * recency;

  return {
    id: row.id,
    type: 'event',
    content: description,
    score,
    tier,
    source: 'semantic',
  };
}

// ============================================================
// Deprecated V1 stubs — kept for backward compat, unused in V4.1
// ============================================================

/** @deprecated Use searchFactsByKeywords instead */
export async function embedText(_text: string): Promise<number[]> {
  return [];
}

/** @deprecated Use searchFactsByKeywords instead */
export async function searchFacts(
  _sessionId: string,
  _queryEmbedding: number[],
  _topK: number = 10
): Promise<string[]> {
  return [];
}

/** @deprecated Use fact-keyword-indexer instead */
export async function indexFact(
  _factId: string,
  _embedding: number[],
  _metadata: Record<string, string> = {}
): Promise<void> {}
