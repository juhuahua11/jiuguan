import { runAndPersist } from './db.js';

const STOP_WORDS = new Set([
  '的', '了', '吗', '啊', '呢', '吧', '很', '都', '也',
  '就', '还', '又', '在', '和', '与', '把', '被', '让',
  '给', '从', '对', '向', '往', '是', '有', '不', '这',
  '那', '我', '你', '他', '她', '它', '们', '什么', '怎么',
  '一个', '一下', '这个', '那个', '可以', '已经', '没有',
]);

/**
 * Chinese n-gram tokenizer: generates all n-grams from length 1 to min(6, textLen).
 * "青龙剑" → 青,龙,剑,青龙,龙剑,青龙剑
 * "张三拥有一把青龙剑" → 张三,三拥,拥有,有一,一把,把青,青龙,龙剑, ..., 张,三,拥,有,一,把,青,龙,剑
 */
function tokenize(text: string): string[] {
  const cleaned = text.replace(/[^\p{Script=Han}a-zA-Z0-9]/gu, '');
  if (!cleaned) return [];

  const tokens: string[] = [];
  const maxN = Math.min(6, cleaned.length);

  for (let n = 1; n <= maxN; n++) {
    for (let i = 0; i <= cleaned.length - n; i++) {
      const ngram = cleaned.slice(i, i + n);
      if (!STOP_WORDS.has(ngram)) {
        tokens.push(ngram);
      }
    }
  }

  return [...new Set(tokens)];
}

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
