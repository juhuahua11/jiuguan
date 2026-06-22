import { describe, it, expect } from 'vitest';

const STOP_WORDS = new Set([
  '的', '了', '吗', '啊', '呢', '吧', '很', '都', '也',
  '就', '还', '又', '在', '和', '与', '把', '被', '让',
  '给', '从', '对', '向', '往', '是', '有', '不', '这',
  '那', '我', '你', '他', '她', '它', '们', '什么', '怎么',
  '一个', '一下', '这个', '那个', '可以', '已经', '没有',
]);

function tokenize(text: string): string[] {
  const cleaned = text.replace(/[^一-龥a-zA-Z0-9]/g, '');
  if (!cleaned) return [];
  const tokens: string[] = [];
  const maxN = Math.min(6, cleaned.length);
  for (let n = 1; n <= maxN; n++) {
    for (let i = 0; i <= cleaned.length - n; i++) {
      const ngram = cleaned.slice(i, i + n);
      if (!STOP_WORDS.has(ngram)) tokens.push(ngram);
    }
  }
  return [...new Set(tokens)];
}

describe('tokenize (1-6 gram)', () => {
  it('generates trigram for 3-char entity', () => {
    const result = tokenize('青龙剑');
    expect(result).toContain('青龙剑');   // trigram
    expect(result).toContain('青龙');      // bigram
    expect(result).toContain('剑');        // unigram
  });

  it('generates all n-grams up to length 6', () => {
    const result = tokenize('张三拥有一把青龙剑');
    expect(result).toContain('张三');
    expect(result).toContain('青龙剑');
    expect(result).toContain('青龙');
    expect(result).toContain('剑');
  });

  it('filters stop words at unigram level', () => {
    // '的' and '了' are stop words individually, but bigram '的了' is not — it passes through
    const result = tokenize('的了');
    expect(result.length).toBe(1); // only bigram '的了' survives
    // verify that single-char stop words are fully filtered
    const single = tokenize('的');
    expect(single.length).toBe(0);
    const single2 = tokenize('了');
    expect(single2.length).toBe(0);
  });

  it('keeps single-character meaningful entities', () => {
    const result = tokenize('剑');
    expect(result).toContain('剑');
  });

  it('deduplicates tokens', () => {
    const result = tokenize('剑剑剑');
    expect(result.filter(t => t === '剑').length).toBe(1);
  });

  it('handles mixed CJK and alphanumeric', () => {
    const result = tokenize('AK47步枪');
    expect(result).toContain('AK47');
    expect(result).toContain('步枪');
  });
});
