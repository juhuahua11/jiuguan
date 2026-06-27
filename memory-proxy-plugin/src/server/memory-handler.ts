import fs from 'fs';
import http from 'http';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { initDatabase } from 'memory-proxy/storage/db';
import { SessionManager } from 'memory-proxy/session/session-manager';
import { WorkingMemory } from 'memory-proxy/session/working-memory';
import { MemoryManager } from 'memory-proxy/memory/memory-manager';
import { TokenBudgetManager } from 'memory-proxy/budget/token-budget';
import { buildContinuitySnapshot } from 'memory-proxy/continuity/snapshot-builder';
import { containsContinuityTrigger, pickSnapshotText, resolveContinuityLevel } from 'memory-proxy/continuity/injection-policy';
import { readStCapabilities, resolveSettingsPath } from '../adapters/st-config.js';
import type { ChatMessage } from 'memory-proxy/types/provider';
import type { ContinuityInjection, ContinuityRuntimeConfig, ModelHandoff } from 'memory-proxy/types/continuity';
import type { KeywordContext } from 'memory-proxy/retrieval/keyword-extractor';
import { createExtractionCache, regexFallbackExtract, refreshKeywordCache, filteredRegexFallback } from 'memory-proxy/retrieval/keyword-extractor';
import type { ExtractionCache } from 'memory-proxy/retrieval/keyword-extractor';
import { computeFingerprint, computeUserAnchor, computeIntegrityHash, diffNewMessages, chunkMessages } from 'memory-proxy/extraction/incremental';
import { getSession, updateSessionExtractionProgress, updateSessionIntegrityHashOnly, markExtractionInProgress, clearExtractionSentinel } from 'memory-proxy/storage/session-store';
import {
  decrementHandoffBoost,
  getActiveModelHandoff,
  getLatestContinuitySnapshot,
  getSessionModelState,
  saveContinuitySnapshot,
  saveModelHandoff,
  updateSessionModelState,
} from 'memory-proxy/storage/continuity-store';

let dbInitializedPath: string | null = null;
let currentChatId: string | null = null;

// Per-chat keyword extraction caches. Keyed by session key (the chat_id when the
// frontend supplies one, else the system-prompt hash) so concurrent ST tabs on
// different chats no longer share or contaminate one another's keyword state.
const cacheByChatId = new Map<string, ExtractionCache>();
const CACHE_MAX_ENTRIES = 16;

function getExtractionCache(key: string): ExtractionCache {
  let cache = cacheByChatId.get(key);
  if (cache) return cache;
  cache = createExtractionCache();
  cacheByChatId.set(key, cache);
  // Bounded eviction: drop the oldest entry past the cap so memory stays finite.
  if (cacheByChatId.size > CACHE_MAX_ENTRIES) {
    const oldest = cacheByChatId.keys().next().value;
    if (oldest !== undefined) cacheByChatId.delete(oldest);
  }
  return cache;
}

/** True stale-while-revalidate keyword extraction:
 *  - Has previous merged result (within TTL): return it, do NOT re-refresh every turn
 *  - Has previous merged result (stale, past TTL): return it AND revalidate in background
 *  - No previous result: return filtered regex
 *  Async LLM refresh runs in background and updates the cache for next request.
 *
 *  The TTL is important: without it, hasMergedData forced needsRefresh=true on EVERY
 *  request, firing one extra upstream LLM call per chat turn. Over a long session those
 *  background calls compounded connection-pool pressure and contributed to "fetch failed"
 *  after extended chatting. Keywords barely change turn-to-turn, so a 5-minute refresh
 *  cadence is plenty.
 */
const KEYWORD_REFRESH_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCachedOrRegexKeywords(
  messages: ChatMessage[],
  cache: ExtractionCache
): { ctx: KeywordContext; needsRefresh: boolean } {
  // Has previous merged LLM+regex result from a prior request?
  // This is the core SWR insight: stale-but-good data beats fresh-but-poor data.
  const hasMergedData = cache.keywordCtx.entities.length > 0 && cache.keywordCtxHash !== '';
  const ageMs = hasMergedData ? Date.now() - (cache.mergedAt || 0) : Infinity;
  const stale = ageMs > KEYWORD_REFRESH_TTL_MS;

  console.log(`[MemoryProxy] getCachedOrRegexKeywords: hasMergedData=${hasMergedData} entities=${cache.keywordCtx.entities.length} ageMs=${ageMs === Infinity ? 'n/a' : ageMs} stale=${stale} refreshPending=${cache.refreshPending}`);

  if (hasMergedData) {
    // Return the (possibly stale) merged data — better than regex-only.
    // Only kick a background revalidation when the data is past TTL, not every turn.
    return { ctx: cache.keywordCtx, needsRefresh: stale };
  }

  // No merged data yet: return filtered regex as best available
  const regexCtx = regexFallbackExtract(messages);
  return { ctx: filteredRegexFallback(regexCtx), needsRefresh: !cache.refreshPending };
}

/** Called by the frontend extension when chat changes. Updates the fallback
 *  currentChatId used when a request doesn't carry body.chat_id. Because caches
 *  are now keyed per-chat, a switch no longer requires wiping a shared cache;
 *  we only bump the (re)activated chat's generation to discard any in-flight
 *  refresh left over from a prior visit to that same chat. */
export function notifyChatId(chatId: string | null): boolean {
  const changed = chatId !== currentChatId;
  if (changed) {
    console.log(`[MemoryProxy] notifyChatId: chat changed (was="${currentChatId?.slice(0, 40)}", now="${chatId?.slice(0, 40)}")`);
    if (chatId) {
      const cache = cacheByChatId.get(chatId);
      if (cache) cache.generation++;
    }
    currentChatId = chatId;
  }
  return changed;
}

async function ensureDb(pluginDir: string): Promise<void> {
  const dbPath = path.join(pluginDir, 'data', 'memory.db');
  if (dbInitializedPath === dbPath) return;
  await initDatabase(dbPath);
  dbInitializedPath = dbPath;
}

export async function handleMemoryRequest(
  body: Record<string, unknown>,
  headers: Record<string, string>,
  pluginDir: string,
  upstreamAgent?: http.Agent
): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
  // 1. Validate messages
  const rawMessages = body.messages as Array<{ role: string; content: string }> | undefined;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return { status: 400, headers: { 'content-type': 'application/json' }, body: { error: 'No messages provided' } };
  }

  const messages: ChatMessage[] = rawMessages
    .filter(m => m.role === 'system' || m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role as 'system' | 'user' | 'assistant', content: m.content }));

  // 2. Extract upstream info from agent-injected headers
  const apiKey = (headers['authorization'] || '').replace('Bearer ', '');
  const upstreamHost = headers['x-upstream-host'] || 'api.deepseek.com';
  const upstreamPort = headers['x-upstream-port'] || '443';
  const upstreamUrl = `https://${upstreamHost}:${upstreamPort}`;
  const upstreamPath = headers['x-upstream-path'] || '/chat/completions';

  // 3. Initialize database
  await ensureDb(pluginDir);
  console.log(`[MemoryProxy] Chat request intercepted — model: ${body.model}, messages: ${messages.length}, stream: ${body.stream}`);

  // 4. Session resolution — prefer chat_id carried in the request body (set by the
  //    frontend extension on every completion), then the last notified chatId, then
  //    a system-prompt hash. Reading body.chat_id per-request is what makes multi-tab
  //    usage safe: each request resolves its own session instead of a shared global.
  const systemMsg = messages.find(m => m.role === 'system');
  const bodyChatId = typeof body.chat_id === 'string' && body.chat_id ? body.chat_id : null;
  const chatId = bodyChatId || currentChatId;
  const sessionKey = chatId
    || (systemMsg
      ? 'char_' + createHash('sha256').update(systemMsg.content).digest('hex').slice(0, 12)
      : 'default');
  const sessionManager = new SessionManager();
  const session = sessionManager.resolve(sessionKey, 'chat_main', 'main');
  const source = bodyChatId ? 'body.chat_id' : (currentChatId ? 'notified' : 'hash');
  console.log(`[MemoryProxy] Session: ${sessionKey.slice(0, 40)} (source: ${source})`);

  // 4.5 Read plugin config (working memory, extraction model/key, chunking)
  const model = (body.model as string) || 'deepseek-chat';
  let extractionModel = model;
  let extractionApiKey = apiKey;
  let extractionUrl = upstreamUrl;
  let extractionPath = upstreamPath;
  let workingMemoryTokens = 32000; // default
  let maxExtractionTokens = 64000;  // 单块提取上限
  let extractionOverlap = 5;        // 块间重叠消息数
  let fallbackMessageCount = 50;    // 指纹未命中时回退提取条数
  let debugInjection = false;       // debug.injectionTrace: write data/last-injection.json
  let continuityRuntime: ContinuityRuntimeConfig = {
    continuity: {
      enabled: true,
      snapshotDetail: 'full',
      normalMaxTokens: 800,
      compactMaxTokens: 1200,
      mediumMaxTokens: 1800,
      fullMaxTokens: 3000,
      refreshEveryTurns: 5,
    },
    handoff: {
      enabled: true,
      triggerOnModelSwitch: true,
      manualRefreshEnabled: true,
      boostTurns: 20,
      fullTurns: 3,
      mediumTurns: 7,
    },
  };
  const configPath = path.join(pluginDir, 'plugin-config.json');
  if (fs.existsSync(configPath)) {
    try {
      // Strip a leading UTF-8 BOM (U+FEFF) if present — the deployed config was
      // merged from a backup that introduced a BOM, and JSON.parse rejects it
      // ("Unexpected token '﻿'"), silently forcing every request onto defaults.
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8').replace(/^﻿/, ''));
      if (cfg.extractionModel) extractionModel = cfg.extractionModel;
      if (cfg.workingMemoryTokens) workingMemoryTokens = cfg.workingMemoryTokens;
      if (cfg.extraction?.maxInputTokens) maxExtractionTokens = cfg.extraction.maxInputTokens;
      if (cfg.extraction?.overlapMessages !== undefined) extractionOverlap = cfg.extraction.overlapMessages;
      if (cfg.extraction?.fallbackMessageCount) fallbackMessageCount = cfg.extraction.fallbackMessageCount;
      if (cfg.debug?.injectionTrace === true) debugInjection = true;
      if (cfg.extractionApiKey) {
        extractionApiKey = cfg.extractionApiKey;
        extractionUrl = 'https://api.deepseek.com:443';
        extractionPath = '/beta/chat/completions';
      }
      continuityRuntime = {
        continuity: {
          enabled: cfg.continuity?.enabled ?? continuityRuntime.continuity.enabled,
          snapshotDetail: 'full',
          normalMaxTokens: cfg.continuity?.normalMaxTokens ?? continuityRuntime.continuity.normalMaxTokens,
          compactMaxTokens: cfg.continuity?.compactMaxTokens ?? continuityRuntime.continuity.compactMaxTokens,
          mediumMaxTokens: cfg.continuity?.mediumMaxTokens ?? continuityRuntime.continuity.mediumMaxTokens,
          fullMaxTokens: cfg.continuity?.fullMaxTokens ?? continuityRuntime.continuity.fullMaxTokens,
          refreshEveryTurns: cfg.continuity?.refreshEveryTurns ?? continuityRuntime.continuity.refreshEveryTurns,
        },
        handoff: {
          enabled: cfg.handoff?.enabled ?? continuityRuntime.handoff.enabled,
          triggerOnModelSwitch: cfg.handoff?.triggerOnModelSwitch ?? continuityRuntime.handoff.triggerOnModelSwitch,
          manualRefreshEnabled: cfg.handoff?.manualRefreshEnabled ?? continuityRuntime.handoff.manualRefreshEnabled,
          boostTurns: cfg.handoff?.boostTurns ?? continuityRuntime.handoff.boostTurns,
          fullTurns: cfg.handoff?.fullTurns ?? continuityRuntime.handoff.fullTurns,
          mediumTurns: cfg.handoff?.mediumTurns ?? continuityRuntime.handoff.mediumTurns,
        },
      };
    } catch (e) { console.warn('[MemoryProxy] plugin-config.json parse error — using defaults:', e instanceof Error ? e.message : String(e)); }
  }

  // 5. Read ST capabilities dynamically
  const settingsPath = resolveSettingsPath(pluginDir);
  const caps = readStCapabilities(settingsPath);

  // 6. Build working memory and trim to window
  const wm = new WorkingMemory(workingMemoryTokens);
  for (const msg of messages) wm.append(msg);
  wm.trimToWindow();

  // 6.5. Keyword extraction — true stale-while-revalidate
  //      Has stale merged data: return it (better than regex). No merged data: return filtered regex.
  //      Async LLM refresh always fires in background to update for next request.
  //      Cache is per-chat (keyed by sessionKey) so concurrent tabs don't contaminate.
  const extractionCache = getExtractionCache(sessionKey);
  const kwResult = getCachedOrRegexKeywords(messages, extractionCache);
  const keywordCtx = kwResult.ctx;
  if (kwResult.needsRefresh && !extractionCache.refreshPending) {
    refreshKeywordCache(messages, async (prompt: string) => {
      const kwApiKey = extractionApiKey || apiKey;
      if (!kwApiKey) return '';
      const kwModel = (extractionModel || model) as string;
      const opts: Record<string, unknown> = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${kwApiKey}` },
        body: JSON.stringify({
          model: kwModel,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 1024,
          temperature: 0,
          // Only set reasoning_effort for v4/reasoning-class models.
          // Non-reasoning APIs may reject the unknown parameter.
          ...(kwModel.includes('v4') || kwModel.includes('reasoning')
            ? { reasoning_effort: 'low' as const }
            : {}),
        }),
      };
      if (upstreamAgent) opts.agent = upstreamAgent;
      const kwUrl = `${extractionUrl}${extractionPath}`;
      const res = await fetch(kwUrl, opts as RequestInit);
      if (!res.ok) {
        const errText = await res.text().catch(function() { return ''; });
        console.log('[MemoryProxy] Keyword refresh FAILED: HTTP ' + res.status + ' ' + errText.slice(0, 200));
        return '';
      }
      const data: any = await res.json();
      const msg = data?.choices?.[0]?.message;
      const result = msg?.content || msg?.reasoning_content || '';
      if (!result) {
        console.log('[MemoryProxy] Keyword refresh: response empty — content=' + (msg?.content ? 'present(' + msg.content.length + ')' : 'empty') + ' reasoning_content=' + (msg?.reasoning_content ? 'present(' + msg.reasoning_content.length + ')' : 'empty'));
      }
      return result;
    }, extractionCache);
  }
  console.log(`[MemoryProxy] Keywords: entities=${keywordCtx.entities.length} keywords=${keywordCtx.keywords.length} search_terms=${keywordCtx.search_terms.length} implicit=${keywordCtx.implicit_topics.length}`);

  const recentText = messages.map(m => m.content).join('\n');
  let continuityInjection: ContinuityInjection | undefined;
  let activeHandoff: ModelHandoff | null = null;
  if (continuityRuntime.continuity.enabled) {
    const modelState = getSessionModelState(session.id);
    const modelChanged = !!modelState.last_chat_model && modelState.last_chat_model !== model;
    if (modelChanged) {
      console.log(`[MemoryProxy] Continuity: model switch detected — last="${modelState.last_chat_model}" → now="${model}" (round ${session.round})`);
    }
    let snapshot = getLatestContinuitySnapshot(session.id);
    const refreshEveryTurns = Math.max(1, continuityRuntime.continuity.refreshEveryTurns);
    if (!snapshot || modelChanged || session.round % refreshEveryTurns === 0) {
      const reason = !snapshot ? 'none-yet' : modelChanged ? 'model-switch' : `round-${session.round}-mod-${refreshEveryTurns}`;
      console.log(`[MemoryProxy] Continuity: rebuilding snapshot (reason=${reason}, round ${session.round})`);
      snapshot = await saveContinuitySnapshot(await buildContinuitySnapshot(session.id, {
        sourceRound: session.round,
        recentMessages: messages,
      }));
    }

    if (modelChanged && continuityRuntime.handoff.enabled && continuityRuntime.handoff.triggerOnModelSwitch) {
      const now = Date.now();
      activeHandoff = {
        id: randomUUID(),
        session_id: session.id,
        from_model: modelState.last_chat_model || null,
        to_model: model,
        snapshot_id: snapshot.id!,
        created_round: session.round,
        boost_turns_total: continuityRuntime.handoff.boostTurns,
        boost_turns_remaining: continuityRuntime.handoff.boostTurns,
        full_turns: continuityRuntime.handoff.fullTurns,
        medium_turns: continuityRuntime.handoff.mediumTurns,
        handoff_text: `[模型接手提示]\n你正在接手一个已经进行很久的对话。请优先保持剧情、人物关系、事件进度、称呼、情绪温度和未解决事项连续。\n\n${snapshot.full_text}`,
        active: true,
        created_at: now,
        updated_at: now,
      };
      await saveModelHandoff(activeHandoff);
      console.log(`[MemoryProxy] Continuity: handoff created — ${activeHandoff.from_model} → ${activeHandoff.to_model}, boost=${activeHandoff.boost_turns_total} (full=${activeHandoff.full_turns} medium=${activeHandoff.medium_turns}) snapshot=${activeHandoff.snapshot_id}`);
    } else {
      activeHandoff = getActiveModelHandoff(session.id);
    }

    const triggerBoost = containsContinuityTrigger(recentText);
    const level = resolveContinuityLevel({
      active: !!activeHandoff,
      boostTurnsRemaining: activeHandoff?.boost_turns_remaining ?? 0,
      boostTurnsTotal: activeHandoff?.boost_turns_total ?? continuityRuntime.handoff.boostTurns,
      fullTurns: activeHandoff?.full_turns ?? continuityRuntime.handoff.fullTurns,
      mediumTurns: activeHandoff?.medium_turns ?? continuityRuntime.handoff.mediumTurns,
      triggerBoost,
    });
    continuityInjection = {
      level,
      text: `${activeHandoff && level === 'full' ? `${activeHandoff.handoff_text}\n\n` : ''}${pickSnapshotText(level, snapshot)}`,
      snapshot_id: snapshot.id || null,
      handoff_id: activeHandoff?.id || null,
      boost_turns_remaining: activeHandoff?.boost_turns_remaining ?? 0,
      trigger: activeHandoff ? 'model-switch' : (triggerBoost ? 'keyword' : 'normal'),
    };
    console.log(`[MemoryProxy] Continuity: inject level=${level} trigger=${continuityInjection.trigger} boost_remaining=${continuityInjection.boost_turns_remaining} snapshot=${continuityInjection.snapshot_id} handoff=${continuityInjection.handoff_id}`);
  }

  // 7. Memory retrieval + context assembly
  const budget = new TokenBudgetManager({
    contextWindow: caps.contextWindow,
    maxOutputTokens: caps.maxOutputTokens,
    supportsSystemRole: caps.supportsSystemRole,
    supportsToolCall: caps.supportsToolCall,
    supportsJsonMode: caps.supportsJsonMode,
    supportsReasoning: caps.supportsReasoning,
  });
  const memManager = new MemoryManager(budget);
  const { messages: enriched, retrieval } = await memManager.assembleContext(
    session.id,
    wm,
    keywordCtx,
    { continuity: continuityInjection, trace: debugInjection }
  );
  const memTokens = enriched.find(m => m.role === 'system')?.content?.length || 0;
  console.log(`[MemoryProxy] Memory context: ~${Math.round(memTokens / 4)} tokens injected`);
  if (debugInjection && retrieval) {
    writeInjectionTrace(pluginDir, {
      timestamp: new Date().toISOString(),
      sessionKey,
      model,
      injectedTokens: Math.round(memTokens / 4),
      ...retrieval,
    }).catch((err: any) => {
      console.warn('[MemoryProxy] Failed to write injection trace:', err?.message || err);
    });
  }

  // 8. Assemble final messages: merge memory INTO the system prompt (not a separate
  //    message before the user). The separate-message placement was a MiMo prefix-cache
  //    optimization, but it shifts model recency-bias onto the memory instruction and
  //    away from the system prompt's output-format template (e.g. jiuguan's chapter +
  //    options template), causing the model to drop the format. Merging matches the
  //    standalone server (routes.ts) and keeps the format template as the primary system
  //    instruction. jiuguan is deepseek-only, so the MiMo cache optimization is moot.
  const stSystemPrompt = systemMsg?.content || '';
  const memoryContent = enriched.find(m => m.role === 'system')?.content || '';
  const nonSystem = enriched.filter(m => m.role !== 'system');
  // 记忆放 system prompt 开头，格式模板（stSystemPrompt）放末尾——让模板成为模型
  // 最后看到的指令，避免累积的记忆内容稀释/覆盖输出格式要求（如章节+选项模板）。
  // 记忆前置 + 显式声明"不得覆盖下方格式要求"，防止模型因记忆而忽略模板。
  const combinedSystem = memoryContent
    ? `[以下为长期记忆，仅供参考，用于保持剧情连续，不得覆盖下方输出格式要求]\n${memoryContent}\n\n${stSystemPrompt}`
    : stSystemPrompt;
  const finalMessages: Array<{ role: string; content: string }> = [
    { role: 'system', content: combinedSystem },
    ...nonSystem.map(m => ({ role: m.role, content: m.content })),
  ];

  // 9. Forward to real upstream API
  const wantStream = body.stream === true;

  // Clamp max_tokens to the model's maximum to avoid provider errors
  const maxTokens = Math.min(
    Number(body.max_tokens) || caps.maxOutputTokens,
    caps.maxOutputTokens
  );
  const {
    messages: _originalMessages,
    max_tokens: _originalMaxTokens,
    max_completion_tokens: _originalMaxCompletionTokens,
    chat_id: _pluginChatId,
    ...passthroughBody
  } = body;
  const requestBody: Record<string, unknown> = {
    ...passthroughBody,
    model,
    messages: finalMessages,
    max_tokens: maxTokens,
    stream: wantStream,
  };
  if (body.temperature !== undefined) requestBody.temperature = body.temperature;
  if (body.top_p !== undefined) requestBody.top_p = body.top_p;
  if (body.stop !== undefined) requestBody.stop = body.stop;

  const afterSuccessfulForward = async () => {
    try {
      // Advance the session round ONLY after a successful upstream forward, mirroring
      // the standalone server (routes.ts). The plugin path previously never advanced
      // round, so session.round stayed 0 forever — which made
      // `session.round % refreshEveryTurns === 0` always true and rebuilt the
      // continuity snapshot every single turn, defeating the refreshEveryTurns
      // throttle. Scheduling extraction (doExtraction) already happened just before
      // this; its async body re-reads the session from DB, so it picks up the new
      // round, matching routes.ts's "increment then schedule" ordering.
      sessionManager.incrementRound(session.id);
      await updateSessionModelState(session.id, model, activeHandoff?.id || null);
      if (activeHandoff?.id) {
        const before = activeHandoff.boost_turns_remaining;
        await decrementHandoffBoost(activeHandoff.id);
        console.log(`[MemoryProxy] Continuity: handoff boost decremented — ${before} → ${Math.max(0, before - 1)} (handoff=${activeHandoff.id})`);
      }
    } catch (err: any) {
      console.warn('[MemoryProxy] Failed to update continuity handoff state:', err?.message || err);
    }
  };

  // Timeouts protect against the "chat too long → fetch failed" failure mode:
  // a hung upstream connection used to await forever, slowly exhausting the
  // shared connection pool until later requests failed with a bare "fetch failed".
  //
  // - First-byte timeout (FIRST_BYTE_TIMEOUT_MS): bounds how long we wait for the
  //   upstream to start responding (connect + first response byte). A hung/semi-dead
  //   upstream is caught here and the connection released promptly.
  // - Non-streaming total timeout (NONSTREAM_TIMEOUT_MS): for non-stream requests the
  //   whole body must arrive in bounded time.
  // - Streaming requests have NO overall timeout once the first byte arrives — RP
  //   generations legitimately run minutes. Idle-during-stream protection is enforced
  //   in internal-server.ts's read loop (STREAM_IDLE_TIMEOUT_MS), which aborts only
  //   when chunks stop flowing, not when total elapsed time is large.
  //
  // Defined OUTSIDE the try block so the catch handler (which builds the error
  // message) can reference them — a const inside try is scoped to try and would
  // throw ReferenceError in catch.
  const FIRST_BYTE_TIMEOUT_MS = 30_000;
  // Non-streaming requests must receive the FULL response in one shot (no chunking),
  // so for large-context RP turns on slow upstreams (e.g. MiMo with 2200+ messages)
  // the server-side generation can legitimately take several minutes. 5 min bounds
  // the worst case without the indefinite hang that exhausted the connection pool,
  // while staying clear of the 30s first-byte guard (which catches a truly dead upstream).
  const NONSTREAM_TIMEOUT_MS = 5 * 60 * 1000;

  // A single upstream attempt: arms the staged timeouts (first-byte + non-stream total)
  // and resolves with the Response once the first byte arrives. `reasonOut` is filled with
  // which timer fired if the attempt is aborted, so the caller's catch can distinguish the
  // two timeout modes. Throws on network failure / abort — the caller decides retry vs fail.
  const reasonOut: { value: 'first-byte' | 'total' | null } = { value: null };
  const fetchOnce = async (): Promise<Response> => {
    reasonOut.value = null;
    const firstByteController = new AbortController();
    const totalController = new AbortController();
    // Which timer actually fired? Tagged so the catch handler can distinguish
    // "upstream never started responding" (first-byte) from "upstream started
    // but didn't finish in time" (total). Without this the two failure modes
    // are indistinguishable in logs and the fix is opposite for each.
    const firstByteTimer = setTimeout(() => {
      reasonOut.value = 'first-byte';
      firstByteController.abort();
    }, FIRST_BYTE_TIMEOUT_MS);
    // For non-streaming, also arm a total timeout (combined with first-byte via a 2nd controller).
    const totalTimer = wantStream
      ? null
      : setTimeout(() => {
        reasonOut.value = 'total';
        totalController.abort();
      }, NONSTREAM_TIMEOUT_MS);
    // Abort if EITHER fires.
    firstByteController.signal.addEventListener('abort', () => totalController.abort());

    const fetchOptions: Record<string, unknown> = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(requestBody),
      signal: totalController.signal,
    };
    if (upstreamAgent) fetchOptions.agent = upstreamAgent;

    try {
      return await fetch(`${upstreamUrl}${upstreamPath}`, fetchOptions as RequestInit);
    } finally {
      clearTimeout(firstByteTimer);
      if (totalTimer) clearTimeout(totalTimer);
    }
  };

  // Connection-class errors that are worth retrying: the upstream was unreachable at that
  // instant (MiMo intermittently drops TCP connects). These are transient — a fresh socket
  // a moment later usually succeeds. We do NOT retry:
  //  - 'total' timeout: that means generation started but was slow; retrying just doubles cost.
  //  - 'first-byte' timeout: borderline; treated as a connection issue and retried, since a
  //    dead/queued connection is also transient and a retry often reaches a healthy backend.
  //  - HTTP error responses (handled below, not thrown): those are deterministic, retry won't help.
  const isRetryableConnectionError = (err: any): boolean => {
    const cause = err?.cause;
    const code = cause?.code || err?.code;
    const name = cause?.name || err?.name;
    return code === 'UND_ERR_CONNECT_TIMEOUT'
      || code === 'ECONNRESET'
      || code === 'ENOTFOUND'
      || code === 'EAI_AGAIN'
      || name === 'ConnectTimeoutError'
      || name === 'HeadersTimeoutError';
  };

  const MAX_RETRIES = 2;
  const RETRY_BACKOFF_MS = 1500;
  let upstreamRes: Response;
  try {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        upstreamRes = await fetchOnce();
        break; // first byte arrived — connection established
      } catch (err: any) {
        // Only retry transient connection-class errors, and only if a timer didn't fire
        // for 'total' (slow generation — retrying is pure waste). first-byte aborts ARE
        // retried: a connection that never sent a byte is the same class as a connect timeout.
        const firedTimer = reasonOut.value;
        const isTotalTimeout = firedTimer === 'total';
        if (isTotalTimeout || !isRetryableConnectionError(err) || attempt >= MAX_RETRIES) {
          throw err;
        }
        attempt++;
        console.warn(`[MemoryProxy] Upstream connection error (attempt ${attempt}/${MAX_RETRIES}), retrying in ${RETRY_BACKOFF_MS}ms:`, err?.cause?.message || err?.message || err);
        await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS));
      }
    }
    // First byte has arrived — connection is established. From here, streaming is
    // bounded only by per-chunk idle (internal-server.ts), not total time.

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      return { status: upstreamRes.status, headers: { 'content-type': 'application/json' }, body: { error: errText } };
    }

    // Helper to invoke extraction with consistent arguments (avoids call-site drift)
    const doExtraction = (responseData: unknown) =>
      scheduleExtraction(session.id, messages, responseData, pluginDir, upstreamAgent, apiKey, upstreamUrl, upstreamPath, model, extractionModel, extractionApiKey, extractionUrl, extractionPath, maxExtractionTokens, extractionOverlap, fallbackMessageCount);

    // Non-streaming
    if (!wantStream || !upstreamRes.body) {
      const data = await upstreamRes.json();
      doExtraction(data);
      await afterSuccessfulForward();
      return { status: 200, headers: { 'content-type': 'application/json' }, body: data };
    }

    // Streaming: wrap body to capture SSE text, then fire extraction after stream ends
    const capturedBody = captureStreamText(upstreamRes.body, doExtraction);
    await afterSuccessfulForward();
    return {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' },
      body: capturedBody,
    };
  } catch (err: any) {
    // Surface the REAL cause. node-fetch/undici wrap network failures as a generic
    // TypeError "fetch failed" with the actual reason (ECONNRESET, UND_ERR_CONNECT_TIMEOUT,
    // ENOTFOUND, TLS error, or our AbortController abort) on err.cause. Logging + returning
    // it makes "chat too long → fetch failed" diagnosable instead of a bare string.
    const cause = err?.cause;
    const causeMsg = cause instanceof Error ? `${cause.name}: ${cause.message}` : (typeof cause === 'string' ? cause : '');
    const aborted = err?.name === 'AbortError' || cause?.name === 'AbortError' || cause?.code === 'ABORT_ERR';
    let reason: string;
    if (aborted) {
      // Distinguish WHICH timer fired — the two mean opposite things:
      //  - 'first-byte': upstream never started responding in 30s (dead/queued connection)
      //  - 'total':      upstream started (first byte arrived) but didn't finish in 5min (slow generation)
      // The fix differs: first-byte ⇒ upstream/network problem; total ⇒ generation too slow, raise the cap.
      const firedTimer = reasonOut.value;
      if (firedTimer === 'total') {
        reason = `upstream timeout: generation exceeded ${NONSTREAM_TIMEOUT_MS}ms total (first byte DID arrive — upstream started but finished too slowly)`;
      } else if (firedTimer === 'first-byte') {
        reason = `upstream timeout: no first byte within ${FIRST_BYTE_TIMEOUT_MS}ms (upstream never started responding — dead/queued connection)`;
      } else {
        // aborted but neither timer tagged it (e.g. signal aborted externally) — fall back to generic
        reason = `upstream timeout (first-byte > ${FIRST_BYTE_TIMEOUT_MS}ms${wantStream ? '' : ` or total > ${NONSTREAM_TIMEOUT_MS}ms`})`;
      }
    } else {
      reason = causeMsg ? `fetch failed: ${causeMsg}` : err.message;
    }
    console.error('[MemoryProxy] Upstream fetch failed:', reason, cause?.code ? `(code=${cause.code})` : '');
    return { status: 502, headers: { 'content-type': 'application/json' }, body: { error: reason } };
  }
}

/** Atomic write of the injection trace to data/last-injection.json. Fire-and-forget;
 *  a write failure must never break a chat turn (caller attaches .catch). */
async function writeInjectionTrace(pluginDir: string, trace: Record<string, unknown>): Promise<void> {
  const dataDir = path.join(pluginDir, 'data');
  await fs.promises.mkdir(dataDir, { recursive: true });
  const finalPath = path.join(dataDir, 'last-injection.json');
  const tmpPath = `${finalPath}.tmp`;
  await fs.promises.writeFile(tmpPath, JSON.stringify(trace, null, 2), 'utf-8');
  await fs.promises.rename(tmpPath, finalPath);
}

/**
 * Wrap a ReadableStream to capture its full text content.
 * Calls onEnd with the accumulated text when the stream finishes.
 */
function captureStreamText(
  stream: ReadableStream<Uint8Array>,
  onEnd: (fullText: string) => void
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let fullText = '';
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          onEnd(fullText);
          controller.close();
          return;
        }
        fullText += decoder.decode(value, { stream: true });
        controller.enqueue(value);
      } catch (err) {
        onEnd(fullText);
        controller.error(err);
      }
    },
    cancel() {
      reader.cancel();
    },
  });
}

/** Extract the assistant's content text from an SSE stream */
function extractStreamContent(sseText: string): string {
  let content = '';
  for (const line of sseText.split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    try {
      const json = JSON.parse(line.slice(6));
      const delta = json?.choices?.[0]?.delta?.content;
      if (delta) content += delta;
    } catch { /* skip malformed lines */ }
  }
  return content;
}

/** Schedule async memory extraction after response is sent */
function scheduleExtraction(
  sessionId: string,
  requestMessages: ChatMessage[],
  responseData: unknown,
  pluginDir: string,
  upstreamAgent: http.Agent | undefined,
  apiKey: string,
  upstreamUrl: string,
  upstreamPath: string,
  model: string,
  extractionModel: string,
  extractionApiKey: string,
  extractionUrl: string,
  extractionPath: string,
  maxExtractionTokens: number,
  extractionOverlap: number,
  fallbackMessageCount: number
): void {
  Promise.resolve().then(async () => {
    let currentIntegrityHash = '';
    try {
      let runExtractionPipeline: any;
      try {
        // Production deploys memory-proxy as CJS-loadable .ts files under node_modules.
        ({ runExtractionPipeline } = require('memory-proxy/extraction/pipeline'));
      } catch {
        // Vitest resolves memory-proxy through Vite aliases, which require() cannot see.
        const moduleName = 'memory-proxy/extraction/pipeline';
        ({ runExtractionPipeline } = await import(moduleName));
      }
      // responseData is JSON for non-streaming, SSE text for streaming
      const content = typeof responseData === 'string'
        ? extractStreamContent(responseData)
        : extractResponseContent(responseData);
      // Exclude overlong reference material (e.g. a 500k-char novel attached as a user
      // message) from extraction entirely. Such a message is world-book/setting anchor
      // for the CHAT forward (kept verbatim in finalMessages), not dialogue to extract
      // from — including it (even truncated) ballooned extraction prompts and triggered
      // hash-mismatch re-extracts. Replace with a short placeholder so the message
      // boundary stays intact for fingerprint/diff logic, but no novel text reaches the
      // extraction LLM. Fingerprints/integrity-hash use the original requestMessages
      // (computed below), so session identity and incremental tracking are unaffected.
      const EXTRACTION_REF_MAX_CHARS = 8000;
      const maskReferenceForExtraction = (msg: ChatMessage): ChatMessage => {
        const c = msg.content || '';
        if (c.length <= EXTRACTION_REF_MAX_CHARS) return msg;
        return {
          role: msg.role,
          content: `[参考材料/世界书，${c.length} 字符，已从记忆抽取中排除]`,
        };
      };
      const allMessages: ChatMessage[] = [...requestMessages, { role: 'assistant', content }].map(maskReferenceForExtraction);

      // === Incremental + Chunked Extraction ===
      // 1. 读取上次提取指纹 + 完整性哈希
      const freshSession = getSession(sessionId);
      const storedFp = freshSession?.last_fingerprint || '';
      // Decode the packed fingerprint + user anchor (see encodeFingerprint).
      // __PROCESSING__ sentinel is preserved as-is for the stale-zombie check below.
      const decoded = decodeFingerprint(storedFp);
      let lastFingerprint = decoded.fp;
      let lastUserAnchor = decoded.anchor;
      const lastIntegrityHash = freshSession?.last_integrity_hash || '';
      const currentRound = freshSession?.round ?? 0;

      // Compute integrity hash on requestMessages (NOT allMessages) so that
      // normal message growth (appending a new assistant response) doesn't
      // create false mismatches at sample boundaries.
      currentIntegrityHash = computeIntegrityHash(requestMessages);
      // Remove the lastIntegrityHash guard — be fully defensive:
      // even on first run (empty stored hash), if current hash differs from '',
      // we want to catch it (computed hash is always non-empty for non-empty messages).
      // Don't reset fingerprint if extraction is already in progress
      // (__PROCESSING__ sentinel set by a concurrent extraction job).
      if (currentIntegrityHash !== lastIntegrityHash && lastFingerprint !== '__PROCESSING__') {
        console.log('[MemoryProxy] Integrity hash mismatch — messages were deleted or modified, resetting fingerprint for full re-extraction');
        lastFingerprint = '';
        lastUserAnchor = '';
      } else if (lastFingerprint === '__PROCESSING__') {
        // __PROCESSING__ sentinel found. Check if it's stale (crashed/zombie extraction).
        // If last_active_at is > 2 min old, the sentinel is a zombie — clear it and proceed.
        const sentinelAge = freshSession?.last_active_at ? Date.now() - freshSession.last_active_at : Infinity;
        // 5 minutes — comfortably exceeds worst-case single-chunk extraction (max_tokens 16384)
        // while still catching genuine zombie/crashed extractions. Multi-chunk extractions
        // additionally heartbeat last_active_at before each chunk (see chunk loop below).
        const SENTINEL_TIMEOUT_MS = 5 * 60 * 1000;
        if (sentinelAge > SENTINEL_TIMEOUT_MS) {
          console.log(`[MemoryProxy] __PROCESSING__ sentinel is stale (${Math.round(sentinelAge / 1000)}s old) — clearing zombie lock and proceeding`);
          clearExtractionSentinel(sessionId, currentIntegrityHash);
          lastFingerprint = '';
          lastUserAnchor = '';
        } else {
          console.log('[MemoryProxy] Extraction already in-progress (sentinel is fresh), skipping extraction to avoid concurrency');
          return;
        }
      }

      // 2. 差量：只取新消息
      const lastMsgCount = freshSession?.last_message_count;
      const diff = diffNewMessages(allMessages, lastFingerprint, fallbackMessageCount, lastUserAnchor, lastMsgCount);
      if (diff.newMessages.length === 0) {
        console.log(`[MemoryProxy] Extraction skipped — no new messages (total: ${allMessages.length}, fingerprint: ${lastFingerprint ? 'matched' : 'first run'})`);
        return;
      }
      console.log(`[MemoryProxy] Extraction diff: ${diff.newMessages.length} new / ${allMessages.length} total (fingerprint ${diff.found ? 'matched at ' + diff.startIndex : 'NOT FOUND, fallback'})`);

      // 3. 分块：如果新消息超限则切块
      const chunks = chunkMessages(diff.newMessages, maxExtractionTokens, extractionOverlap);
      if (chunks.length > 1) {
        console.log(`[MemoryProxy] Extraction chunks: ${chunks.length} (${diff.newMessages.length} messages, max ${maxExtractionTokens} tokens/chunk, overlap ${extractionOverlap})`);
      }

      // 4. Save previous fingerprint before overwriting with sentinel.
      //    If extraction fails, we restore it so incremental extraction can
      //    continue from where it left off (retry the same messages).
      // Preserve the FULL encoded form (fp||anchor) so the anchor survives a retry too.
      const previousFingerprint = storedFp;

      // 5. Mark extraction as in-progress (prevents concurrent re-extraction)
      markExtractionInProgress(sessionId, currentIntegrityHash);

      // 6. 逐块提取 (指纹在提取完成后、有产出时才保存)
      // Compute both the 5-window fingerprint and the user anchor; pack them together
      // so next turn can fall back to the anchor if depth-injection drift breaks the
      // 5-window match.
      const newFingerprint = encodeFingerprint(computeFingerprint(allMessages), computeUserAnchor(allMessages));
      const llmCall = async (prompt: string) => {
        const llmApiKey = extractionApiKey || apiKey;
        if (!llmApiKey) return '';
        const llmModel = (extractionModel || model) as string;
        try {
          const fetchOptions: Record<string, unknown> = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${llmApiKey}` },
            body: JSON.stringify({
              model: llmModel,
              messages: [{ role: 'user', content: prompt }],
              max_tokens: 16384,  // v4 models output reasoning_content, need more headroom
              temperature: 0,
              // Only set reasoning_effort for v4/reasoning-class models.
              // Non-reasoning APIs may reject the unknown parameter with HTTP 400.
              ...(llmModel.includes('v4') || llmModel.includes('reasoning')
                ? { reasoning_effort: 'low' as const }
                : {}),
            }),
          };
          if (upstreamAgent) fetchOptions.agent = upstreamAgent;
          const llmUrl = `${extractionUrl}${extractionPath}`;
          console.log('[MemoryProxy] Extraction LLM call →', llmUrl, 'model:', llmModel, 'promptLen:', prompt.length);
          const res = await fetch(llmUrl, fetchOptions as RequestInit);
          console.log('[MemoryProxy] Extraction LLM status:', res.status, 'contentType:', res.headers.get('content-type'));
          if (!res.ok) {
            const errText = await res.text();
            console.log('[MemoryProxy] Extraction LLM failed:', res.status, errText.slice(0, 500));
            return '';
          }
          const data: any = await res.json();
          // v4 reasoning models often emit the real answer in reasoning_content and
          // leave content empty (especially when the thinking budget eats the cap).
          // Fall back to reasoning_content so the JSON the parsers look for is still
          // recoverable — parseSalientResponse/parseFactEventResponse slice on
          // '{"salients"' / '{"facts"' so they tolerate the surrounding prose.
          const msg = data?.choices?.[0]?.message;
          const reasoning = msg?.reasoning_content || '';
          let result = msg?.content || '';
          if (!result && reasoning) {
            console.log(`[MemoryProxy] Extraction LLM content empty, falling back to reasoning_content (len=${reasoning.length})`);
            result = reasoning;
          }
          if (!result) {
            console.log('[MemoryProxy] Extraction LLM empty response — keys:', Object.keys(data || {}).join(', '), 'choices:', JSON.stringify(data?.choices?.[0]).slice(0, 300));
          }
          if (result.includes('rejected') || result.includes('high risk') || result.includes('content filter')) {
            console.log('[MemoryProxy] Extraction rejected by provider safety filter — skipping extraction');
            return '';
          }
          return result;
        } catch (err: any) {
          console.error('[MemoryProxy] Extraction LLM error:', err.message || err);
          return '';
        }
      };

      let totalFacts = 0;
      let totalEvents = 0;
      let chunksFailed = 0;
      for (let ci = 0; ci < chunks.length; ci++) {
        const chunk = chunks[ci];
        const chunkLabel = chunks.length > 1 ? ` [chunk ${ci + 1}/${chunks.length}]` : '';
        console.log(`[MemoryProxy] Extracting${chunkLabel}: ${chunk.length} messages`);
        // Heartbeat: refresh last_active_at before each chunk so a long multi-chunk
        // extraction is not mistaken for a zombie by the 2-min sentinel timeout
        // (see SENTINEL_TIMEOUT_MS above). updateSessionIntegrityHashOnly is fire-and-forget.
        if (chunks.length > 1) {
          updateSessionIntegrityHashOnly(sessionId, currentIntegrityHash);
        }
        try {
          const report = await runExtractionPipeline({
            sessionId,
            round: currentRound,
            overflowMessages: chunk,
            llmCall,
          });
          totalFacts += report.facts_extracted;
          totalEvents += report.events_extracted;
        } catch (chunkErr) {
          chunksFailed++;
          console.error(`[MemoryProxy] Chunk ${ci + 1}/${chunks.length} extraction failed:`, chunkErr);
        }
      }

      // Decide whether to advance the fingerprint. Three cases:
      //  (1) chunks failed (LLM/network/parse error)  -> restore previous fingerprint so
      //      next turn retries the SAME messages. The extraction genuinely didn't complete.
      //  (2) all chunks succeeded but produced 0 facts/events -> ADVANCE the fingerprint.
      //      DeepSeek returned 200 and judged these messages have nothing extractable
      //      (smalltalk, greetings, pure action beats). Treating 0-output as "retry" caused
      //      an infinite re-extraction loop: the same messages were re-sent every turn and
      //      snowballed (2->4->6 msgs) while burning ~12k tokens/call. Marking them
      //      processed stops the loop; genuinely new content next turn still extracts fine.
      //  (3) produced facts/events and no failures    -> advance (original behavior).
      if (chunksFailed > 0) {
        console.log(`[MemoryProxy] Fingerprint NOT saved — ${chunksFailed} chunk(s) failed, will retry next turn`);
        clearExtractionSentinel(sessionId, currentIntegrityHash, previousFingerprint);
      } else {
        if (totalFacts === 0 && totalEvents === 0) {
          console.log(`[MemoryProxy] Extraction produced nothing (messages processed, no extractable content) — advancing fingerprint to skip re-extraction of these messages`);
        }
        updateSessionExtractionProgress(sessionId, newFingerprint, allMessages.length, currentIntegrityHash);
      }
      console.log(`[MemoryProxy] Extraction complete: ${totalFacts} facts, ${totalEvents} events (${chunks.length} chunk(s))`);
    } catch (err) {
      console.error('[MemoryProxy] Extraction error:', err);
      // Clear __PROCESSING__ sentinel — extraction crashed, don't leave session stuck
      try {
        clearExtractionSentinel(sessionId, currentIntegrityHash);
      } catch { /* best effort — DB may be in bad state */ }
    }
  });
}

function extractResponseContent(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') {
    const d = data as any;
    return d?.choices?.[0]?.message?.content || d?.content || '';
  }
  return '';
}

/**
 * Fingerprint storage encoding. The session's last_fingerprint column holds a single
 * string, so we pack the 5-window fingerprint and the user-anchor together as
 * `${fp}||${anchor}`. The user anchor is a more stable position marker (user messages
 * aren't swiped/regenerated and don't carry ST depth injections) used as a fallback
 * when the 5-window fingerprint drifts due to Author's Note interval / Summary growth /
 * World Info changes — without it, those drifts triggered a 50-message fallback
 * (a ~21k-token re-extraction) on occasional turns.
 *
 * '__PROCESSING__' sentinel is stored bare (no anchor) — handled separately.
 */
const FP_SEPARATOR = '||';

function encodeFingerprint(fp: string, anchor: string): string {
  if (!fp) return '';
  return anchor ? `${fp}${FP_SEPARATOR}${anchor}` : fp;
}

function decodeFingerprint(stored: string): { fp: string; anchor: string } {
  if (!stored || stored === '__PROCESSING__') return { fp: stored, anchor: '' };
  const sep = stored.indexOf(FP_SEPARATOR);
  if (sep < 0) return { fp: stored, anchor: '' };
  return { fp: stored.slice(0, sep), anchor: stored.slice(sep + FP_SEPARATOR.length) };
}
