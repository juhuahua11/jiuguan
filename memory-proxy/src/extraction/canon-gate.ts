import { execQuery } from '../storage/db.js';
import type { Fact } from '../types/fact.js';
import { embedText } from '../retrieval/semantic-search.js';

export interface CanonGateResult {
  action: 'BLOCK' | 'WARN' | 'ALLOW';
  by: 'rule' | 'embedding' | 'llm_semantic';
  matchedCanonId?: string;
  detail?: string;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Layer 2: Embedding similarity check for semantic conflict detection.
 * In V2: add LLM-based semantic check.
 */
async function checkSemanticConflict(
  factStatement: string,
  canonEntry: any
): Promise<boolean> {
  try {
    const factEmbedding = await embedText(factStatement);
    const canonEmbedding = await embedText(canonEntry.statement);
    const similarity = cosineSimilarity(factEmbedding, canonEmbedding);
    return similarity > 0.85;
  } catch {
    return false;
  }
}

/**
 * Canon Gate: multi-layer check of a candidate Fact against Core Canon entries.
 * Layer 1: Keyword-based detection.
 * Layer 2: Embedding similarity (V1.5).
 * Layer 3: LLM semantic check (stub for V2).
 */
export async function checkFactAgainstCanon(
  sessionId: string,
  fact: Partial<Fact>
): Promise<CanonGateResult> {
  // Load Core Canon entries
  const canonEntries = execQuery(
    `SELECT * FROM canon_entries WHERE tier = 'CORE' AND (session_id = ? OR session_id IS NULL) AND archived_at IS NULL`,
    [sessionId]
  );

  const factText = (fact.statement || '').toLowerCase();

  // Layer 1: Keyword matching
  for (const canon of canonEntries) {
    const keywords: string[] = JSON.parse(canon.keywords || '[]');
    const triggers: string[] = JSON.parse(canon.implicit_triggers || '[]');
    const allTerms = [...keywords, ...triggers];

    // Check if any keyword/trigger appears in the fact statement
    const hasConflict = allTerms.some((term: string) =>
      factText.includes(term.toLowerCase())
    );

    if (hasConflict) {
      if (canon.conflict_policy === 'BLOCK') {
        return {
          action: 'BLOCK',
          by: 'rule',
          matchedCanonId: canon.id,
          detail: `Fact "${fact.statement}" conflicts with Canon "${canon.statement}"`,
        };
      }
      if (canon.conflict_policy === 'WARN') {
        return {
          action: 'WARN',
          by: 'rule',
          matchedCanonId: canon.id,
          detail: `Fact "${fact.statement}" may conflict with Canon "${canon.statement}"`,
        };
      }
    }
  }

  // Layer 2: Embedding similarity check (V1.5)
  if (fact.statement) {
    for (const canon of canonEntries) {
      const isConflict = await checkSemanticConflict(fact.statement, canon);
      if (isConflict && canon.conflict_policy !== 'ALLOW') {
        return {
          action: 'WARN',
          by: 'embedding',
          matchedCanonId: canon.id,
          detail: `Fact "${fact.statement}" is semantically similar to Canon "${canon.statement}"`,
        };
      }
    }
  }

  return { action: 'ALLOW', by: 'rule' };
}
