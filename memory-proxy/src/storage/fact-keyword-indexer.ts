import { runAndPersist } from './db.js';
import { tokenize } from './keyword-tokenizer.js';

/**
 * Index a fact's statement into fact_keywords.
 * Called after a fact is inserted/updated.
 */
export function indexFactKeywords(factId: string, statement: string): void {
  const keywords = tokenize(statement).filter(k => k.length >= 1 && k.length <= 20);
  if (keywords.length === 0) return;

  const placeholders = keywords.map(() => '(?, ?)').join(', ');
  const params: (string | null)[] = [];
  for (const kw of keywords) {
    params.push(factId, kw);
  }

  runAndPersist(
    `INSERT OR IGNORE INTO fact_keywords (fact_id, keyword) VALUES ${placeholders}`,
    params
  );
}

/**
 * Remove all keyword entries for a fact.
 * Called when a fact is expired or tombstoned.
 */
export function deleteFactKeywords(factId: string): void {
  runAndPersist('DELETE FROM fact_keywords WHERE fact_id = ?', [factId]);
}

/**
 * Re-index a fact (delete old keywords + insert new ones).
 */
export function reindexFact(factId: string, statement: string): void {
  deleteFactKeywords(factId);
  indexFactKeywords(factId, statement);
}
