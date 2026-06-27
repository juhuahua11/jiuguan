const STOP_WORDS = new Set([
  '的', '了', '吗', '啊', '呢', '吧', '很', '都', '也',
  '就', '还', '又', '在', '和', '与', '把', '被', '让',
  '给', '从', '对', '向', '往', '是', '有', '不', '这',
  '那', '我', '你', '他', '她', '它', '们', '什么', '怎么',
  '一个', '一下', '这个', '那个', '可以', '已经', '没有',
]);

/**
 * Chinese n-gram tokenizer: generates all n-grams from length 1 to min(6, textLen).
 * Shared by fact-keyword-indexer and event-keyword-indexer.
 */
export function tokenize(text: string): string[] {
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
