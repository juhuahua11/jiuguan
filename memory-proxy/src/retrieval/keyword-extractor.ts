import { ChatMessage } from '../types/provider.js';

export interface KeywordContext {
  entities: string[];
  keywords: string[];
  search_terms: string[];
  implicit_topics: string[];
}

export interface KeywordLayerOptions {
  maxEntities?: number;
  maxKeywords?: number;
  maxAdditionalSearchTerms?: number;
  maxImplicitTopics?: number;
}

export const DEFAULT_KEYWORD_LAYER_OPTIONS: Required<KeywordLayerOptions> = {
  maxEntities: 96,
  maxKeywords: 24,
  maxAdditionalSearchTerms: 32,
  maxImplicitTopics: 8,
};

export interface ExtractionCache {
  lastMessagesHash: string;
  keywordCtx: KeywordContext;
  /** Whether an async LLM refresh is currently in-flight */
  refreshPending: boolean;
  /** The hash that the current keywordCtx was computed for */
  keywordCtxHash: string;
  /** Monotonic generation counter. Bumped by the caller when the cache should be
   *  invalidated (e.g. chat switch, swipe re-send). A refresh that started under an
   *  older generation must NOT write its results back — see refreshKeywordCache. */
  generation: number;
  /** Timestamp (ms) of the last successful merged refresh write. Used by the caller's
   *  SWR TTL to avoid re-firing a background LLM refresh on every single request —
   *  previously hasMergedData forced needsRefresh=true unconditionally, which meant one
   *  extra upstream LLM call per chat turn, compounding connection-pool pressure. */
  mergedAt: number;
}

const PROMPT_TEMPLATE = `你是一个对话关键词提取器。从对话中提取用于检索相关记忆的关键词。

重要原则：只提取与「用户当前意图」直接相关的词。用户可能在长对话中提到很多人和事，但你只需要关注用户这一刻在问什么、在做什么、在和谁互动。

规则：
1. entities: 用户当前正在交互/询问的人物、地点、物品名称（不要列出对话中所有人名——只列用户此刻关注的对象）
2. keywords: 用户当前动作的核心动词、承诺、决定、关键行为词
   例: 用户说"我答应张三帮他去城南取剑" → keywords=["答应","取剑"]
3. search_terms: 将 keywords 扩展为同义词/近义词，包含原始词本身
   例: keywords=["取剑"] → search_terms=["取剑","取武器","拿回剑","取回"]
4. implicit_topics: 从用户当前意图推断的隐含主题。只输出主题词，不要描述
   例: 用户说"还钱" → implicit_topics=["债务","交易"]

对话：
{dialogue}

只输出一行JSON，不要额外文本：
{"entities":[...],"keywords":[...],"search_terms":[...],"implicit_topics":[...]}`;

// CJK 常见停用词——regex 提取的实体中过滤掉这些无意义高频词
export const CJK_STOP_WORDS = new Set([
  '我们','他们','你们','她们','它们','自己','什么','怎么','为什么',
  '可以','已经','还是','或者','但是','因为','所以','如果','虽然',
  '不过','然后','这个','那个','这些','那些','这里','那里',
  '一个','一下','一切','一样','一起','一直','一定',
  '没有','不是','不会','不能','不要','不用','不敢',
  '知道','觉得','认为','以为','可能','应该','需要',
  '时候','之后','以前','以后','现在','刚才','刚刚',
  '一下','一会','一点','一些','任何','所有','全部',
  '有人','没人','有些','很多','多么','那么',
  '看着','听到','觉得','发现','感觉','想到','说道',
  '它的','他的','我的','你的','她的','他们的',
]);

function limitValue(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined ? Math.max(0, Math.floor(value)) : fallback;
}

function uniqueUsefulTerms(terms: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const term of terms) {
    if (typeof term !== 'string') continue;
    const trimmed = term.trim();
    if (!trimmed || CJK_STOP_WORDS.has(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

export function layerKeywordContext(
  ctx: KeywordContext,
  options: KeywordLayerOptions = {}
): KeywordContext {
  const limits = {
    maxEntities: limitValue(options.maxEntities, DEFAULT_KEYWORD_LAYER_OPTIONS.maxEntities),
    maxKeywords: limitValue(options.maxKeywords, DEFAULT_KEYWORD_LAYER_OPTIONS.maxKeywords),
    maxAdditionalSearchTerms: limitValue(options.maxAdditionalSearchTerms, DEFAULT_KEYWORD_LAYER_OPTIONS.maxAdditionalSearchTerms),
    maxImplicitTopics: limitValue(options.maxImplicitTopics, DEFAULT_KEYWORD_LAYER_OPTIONS.maxImplicitTopics),
  };

  const allEntities = uniqueUsefulTerms(ctx.entities);
  const allKeywords = uniqueUsefulTerms(ctx.keywords);
  const entities = allEntities.slice(0, limits.maxEntities);
  const keywords = allKeywords.slice(0, limits.maxKeywords);
  const originalSignals = new Set([...allEntities, ...allKeywords]);
  const protectedTerms = uniqueUsefulTerms([...entities, ...keywords]);
  const protectedSet = new Set(protectedTerms);
  const additionalSearchTerms = uniqueUsefulTerms(ctx.search_terms)
    .filter(term => !protectedSet.has(term) && !originalSignals.has(term))
    .slice(0, limits.maxAdditionalSearchTerms);

  return {
    entities,
    keywords,
    search_terms: [...protectedTerms, ...additionalSearchTerms],
    implicit_topics: uniqueUsefulTerms(ctx.implicit_topics).slice(0, limits.maxImplicitTopics),
  };
}

/** Merge LLM and regex keyword contexts, filtering stop words from ALL string arrays */
function mergeKeywordContexts(
  llmCtx: KeywordContext,
  regexCtx: KeywordContext
): KeywordContext {
  const filteredRegexEntities = regexCtx.entities.filter(e => !CJK_STOP_WORDS.has(e));
  const filteredRegexKeywords = regexCtx.keywords.filter(k => !CJK_STOP_WORDS.has(k));
  const filteredRegexSearchTerms = regexCtx.search_terms.filter(s => !CJK_STOP_WORDS.has(s));

  return layerKeywordContext({
    entities: [...new Set([...llmCtx.entities, ...filteredRegexEntities])],
    keywords: [...new Set([...llmCtx.keywords, ...filteredRegexKeywords])],
    search_terms: [...new Set([...llmCtx.search_terms, ...filteredRegexSearchTerms])],
    implicit_topics: llmCtx.implicit_topics,
  });
}

/** Filter regex-only context through stop words (for LLM-failure fallback) */
export function filteredRegexFallback(ctx: KeywordContext): KeywordContext {
  return layerKeywordContext({
    entities: ctx.entities.filter(e => !CJK_STOP_WORDS.has(e)),
    keywords: ctx.keywords.filter(k => !CJK_STOP_WORDS.has(k)),
    search_terms: ctx.search_terms.filter(s => !CJK_STOP_WORDS.has(s)),
    implicit_topics: ctx.implicit_topics,
  });
}

export function buildExtractionInput(messages: ChatMessage[]): string {
  const dialogue = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-10)
    .map(m => `[${m.role}] ${m.content}`)
    .join('\n');
  return PROMPT_TEMPLATE.replace('{dialogue}', dialogue);
}

export function hashMessages(messages: ChatMessage[]): string {
  const text = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-20)
    .map(m => m.content)
    .join('|||');
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash = hash & hash;
  }
  return String(Math.abs(hash));
}

/**
 * Regex-based entity extraction — fallback only, NOT primary path.
 * Only returns entities that appear at least twice in the text (reliability filter).
 */
export function regexFallbackExtract(messages: ChatMessage[]): KeywordContext {
  const text = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-20)
    .map(m => m.content)
    .join(' ');

  // Remove non-CJK characters for entity scanning — \p{Script=Han} covers all Han codepoints
  const clean = text.replace(/[^\p{Script=Han}]/gu, '');
  const candidates = new Map<string, number>();

  // Sliding window: collect all 2-3 char spans as entity candidates
  for (const len of [2, 3]) {
    for (let i = 0; i <= clean.length - len; i++) {
      const span = clean.slice(i, i + len);
      candidates.set(span, (candidates.get(span) || 0) + 1);
    }
  }

  // Keep spans that appear 2+ times, sorted by frequency, capped at top 200
  const entities = [...candidates.entries()]
    .filter(([_span, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 200)
    .map(([span]) => span);

  return {
    entities,
    keywords: [],
    search_terms: entities,
    implicit_topics: [],
  };
}

export function parseKeywordResponse(jsonStr: string): KeywordContext | null {
  try {
    let cleaned = jsonStr.trim();
    const braceStart = cleaned.indexOf('{');
    const braceEnd = cleaned.lastIndexOf('}');
    if (braceStart !== -1 && braceEnd > braceStart) {
      cleaned = cleaned.slice(braceStart, braceEnd + 1);
    }
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }
    const parsed = JSON.parse(cleaned);

    const entities: string[] = parsed.entities || [];
    const keywords: string[] = parsed.keywords || [];
    const search_terms: string[] = [...new Set([
      ...entities,
      ...keywords,
      ...(parsed.search_terms || []),
    ])];
    const implicit_topics: string[] = parsed.implicit_topics || [];

    if (entities.length === 0 && keywords.length === 0 && search_terms.length === 0) {
      return { entities: [], keywords: [], search_terms: [], implicit_topics: [] };
    }

    return { entities, keywords, search_terms, implicit_topics };
  } catch {
    return null;
  }
}

/**
 * Main extraction function.
 *
 * Strategy:
 *   1. Cache hit (same message hash) → return cached (0ms)
 *   2. Cache miss → LLM extraction (~500-800ms)
 *   3. LLM fails → regex fallback (with repetition threshold)
 */
export async function extractKeywords(
  messages: ChatMessage[],
  llmCall: (prompt: string) => Promise<string>,
  cache: ExtractionCache
): Promise<KeywordContext> {
  const msgHash = hashMessages(messages);

  // 1. Exact hash cache hit
  if (msgHash === cache.lastMessagesHash && cache.keywordCtx) {
    return cache.keywordCtx;
  }

  cache.lastMessagesHash = msgHash;

  // 2. LLM extraction (primary, with one retry on failure)
  //    Regex fallback is always computed for breadth — merged with LLM results for coverage
  const regexCtx = regexFallbackExtract(messages);
  const prompt = buildExtractionInput(messages);
  let llmCtx: KeywordContext | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const label = attempt > 0 ? ` (retry ${attempt})` : '';
      console.log(`[MemoryProxy] Keyword LLM call${label} → promptLen:`, prompt.length);
      const response = await llmCallWithTimeout(llmCall, prompt, 15000);
      if (!response) {
        console.log(`[MemoryProxy] Keyword LLM${label}: empty/timeout`);
        if (attempt === 0) { await sleep(1000); continue; }
        throw new Error('LLM returned empty');
      }

      const parsed = parseKeywordResponse(response);
      if (!parsed) {
        console.log(`[MemoryProxy] Keyword LLM${label}: parse failed, response preview:`, response.slice(0, 200));
        if (attempt === 0) { await sleep(1000); continue; }
        throw new Error('Failed to parse LLM JSON');
      }

      console.log(`[MemoryProxy] Keyword LLM${label}: entities=`, parsed.entities.length, 'keywords=', parsed.keywords.length);
      llmCtx = parsed;
      break;
    } catch (err: any) {
      if (attempt === 0) { await sleep(1000); continue; }
      console.log('[MemoryProxy] Keyword LLM failed after retry:', err.message);
    }
  }

  // 3. Merge: LLM provides precision, regex provides breadth (stop-word filtered)
  const merged: KeywordContext = llmCtx
    ? mergeKeywordContexts(llmCtx, regexCtx)
    : filteredRegexFallback(regexCtx);

  console.log('[MemoryProxy] Keyword merged: entities=', merged.entities.length, 'keywords=', merged.keywords.length,
    '(LLM', llmCtx ? `${llmCtx.entities.length}e/${llmCtx.keywords.length}k` : 'miss',
    '+ regex', `${regexCtx.entities.length}e/${regexCtx.keywords.length}k`,
    'filtered', `${regexCtx.entities.filter(e => !CJK_STOP_WORDS.has(e)).length}e)`);

  cache.keywordCtx = merged;
  cache.keywordCtxHash = msgHash;
  return merged;
}

async function llmCallWithTimeout(
  llmCall: (prompt: string) => Promise<string>,
  prompt: string,
  timeoutMs: number
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const result = await Promise.race([
      llmCall(prompt),
      new Promise<string>((_, reject) => {
        timer = setTimeout(() => reject(new Error('LLM timeout')), timeoutMs);
      }),
    ]);
    return result;
  } catch {
    return '';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createExtractionCache(): ExtractionCache {
  return {
    lastMessagesHash: '',
    keywordCtx: { entities: [], keywords: [], search_terms: [], implicit_topics: [] },
    refreshPending: false,
    keywordCtxHash: '',
    generation: 0,
    mergedAt: 0,
  };
}

/**
 * Async LLM keyword refresh — bypasses cache, single attempt, merges with regex.
 * Designed for fire-and-forget background refresh after the main request.
 */
export async function refreshKeywordCache(
  messages: ChatMessage[],
  llmCall: (prompt: string) => Promise<string>,
  cache: ExtractionCache
): Promise<void> {
  cache.refreshPending = true;
  // Capture the generation at refresh start. If the caller invalidates the cache
  // (chat switch / swipe) while this LLM call is in flight, generation will have
  // moved on by the time we get here — and we must NOT overwrite the (now-stale)
  // cache with keywords computed from the OLD chat's messages.
  const myGen = cache.generation;
  try {
    const prompt = buildExtractionInput(messages);
    const response = await llmCallWithTimeout(llmCall, prompt, 15000);
    if (!response) {
      console.log('[MemoryProxy] Keyword async refresh: LLM returned empty or timeout');
      return;
    }
    const parsed = parseKeywordResponse(response);
    if (!parsed) {
      console.log('[MemoryProxy] Keyword async refresh: parse failed');
      return;
    }

    // Bail out if the cache was invalidated while we were waiting on the LLM.
    if (myGen !== cache.generation) {
      console.log('[MemoryProxy] Keyword async refresh: generation changed mid-flight (chat switched/swipe), discarding stale result');
      return;
    }

    const regexCtx = regexFallbackExtract(messages);
    const merged = mergeKeywordContexts(parsed, regexCtx);
    console.log('[MemoryProxy] Keyword async refresh: entities=', merged.entities.length, 'keywords=', merged.keywords.length);

    // Update cache — the next request will get this merged data via the SWR stale path
    cache.keywordCtx = merged;
    cache.keywordCtxHash = 'merged';  // Mark that we have valid merged data
    cache.mergedAt = Date.now();       // SWR TTL uses this to skip needless re-refreshes
    console.log('[MemoryProxy] refreshKeywordCache: wrote merged data to cache — entities=', cache.keywordCtx.entities.length, 'keywordCtxHash=', cache.keywordCtxHash);
  } catch (err: any) {
    console.log('[MemoryProxy] Keyword async refresh failed:', err.message);
  } finally {
    cache.refreshPending = false;
  }
}
