import { describe, it, expect, vi } from 'vitest';
import { ChatMessage } from '../../src/types/provider.js';
import { createExtractionCache, extractKeywords, refreshKeywordCache } from '../../src/retrieval/keyword-extractor.js';

const msgs1: ChatMessage[] = [
  { role: 'user', content: '张三答应帮我去城南取剑' },
  { role: 'assistant', content: '他看起来很有诚意' },
];

describe('extractKeywords', () => {
  it('calls LLM when cache is cold', async () => {
    const cache = createExtractionCache();
    let called = false;
    const llm = async () => { called = true; return '{"entities":["张三"],"keywords":["取剑"],"search_terms":["张三","取剑","取武器"],"implicit_topics":["委托"]}'; };
    const result = await extractKeywords(msgs1, llm, cache);
    expect(called).toBe(true);
    expect(result.entities).toContain('张三');
    expect(result.search_terms).toContain('取武器');
  });

  it('cache hit returns previous result without LLM call', async () => {
    const cache = createExtractionCache();
    let callCount = 0;
    const llm = async () => { callCount++; return '{"entities":["张三"],"keywords":[],"search_terms":["张三"],"implicit_topics":[]}'; };

    const r1 = await extractKeywords(msgs1, llm, cache);
    expect(callCount).toBe(1);

    const r2 = await extractKeywords(msgs1, llm, cache);
    expect(callCount).toBe(1); // cached
    expect(r2.entities).toEqual(r1.entities);
  });

  it('falls back to regex when LLM returns garbage', async () => {
    const cache = createExtractionCache();
    // Messages where "张三" appears twice — regex fallback should catch it
    const msgs: ChatMessage[] = [
      { role: 'user', content: '张三来了' },
      { role: 'assistant', content: '张三看起来很好' },
    ];
    const llm = async () => 'not json at all';
    const result = await extractKeywords(msgs, llm, cache);
    // regex fallback should find "张三" (appears twice in clean CJK text)
    expect(result.entities).toContain('张三');
  });
});

describe('refreshKeywordCache — generation guard', () => {
  it('discards the result if generation changed mid-flight (chat switched)', async () => {
    const cache = createExtractionCache();
    // A deferred LLM call we resolve manually so we can bump generation while it's in flight.
    let resolveLlm!: (v: string) => void;
    const llmPromise = new Promise<string>(r => { resolveLlm = r; });
    const llm = () => llmPromise;

    const refreshPromise = refreshKeywordCache(msgs1, llm, cache);
    // Let refreshKeywordCache run up to its first await (the LLM call).
    await Promise.resolve();
    // Simulate a chat switch invalidating the cache while the refresh is in flight.
    cache.generation++;
    // Now resolve the LLM with valid data — it must be discarded, not written.
    resolveLlm('{"entities":["张三"],"keywords":["取剑"],"search_terms":["张三"],"implicit_topics":[]}');
    await refreshPromise;

    expect(cache.keywordCtx.entities).toEqual([]);
    expect(cache.keywordCtxHash).toBe('');
    expect(cache.refreshPending).toBe(false);
  });

  it('writes the result when generation is unchanged', async () => {
    const cache = createExtractionCache();
    const llm = async () => '{"entities":["张三"],"keywords":["取剑"],"search_terms":["张三"],"implicit_topics":[]}';
    await refreshKeywordCache(msgs1, llm, cache);

    expect(cache.keywordCtx.entities).toContain('张三');
    expect(cache.keywordCtxHash).toBe('merged');
    expect(cache.refreshPending).toBe(false);
  });
});
