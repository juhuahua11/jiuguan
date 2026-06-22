import { FastifyInstance } from 'fastify';
import { createHash } from 'crypto';
import { Config } from '../config.js';
import { SessionManager } from '../session/session-manager.js';
import { WorkingMemory } from '../session/working-memory.js';
import { MemoryManager } from '../memory/memory-manager.js';
import { TokenBudgetManager } from '../budget/token-budget.js';
import { getProviderForRequest } from '../provider/registry.js';
import { DeepSeekProvider } from '../provider/deepseek.js';
import { MiMoProvider } from '../provider/mimo.js';
import { ClaudeProvider } from '../provider/claude.js';
import { Provider } from '../types/provider.js';
import { ChatMessage } from '../types/provider.js';
import { KeywordContext } from '../retrieval/keyword-extractor.js';

/**
 * Schedule async memory extraction after response is sent.
 * Fire-and-forget — never blocks the user.
 */
function scheduleMemoryProcessing(
  sessionId: string,
  responseText: string,
  requestMessages: ChatMessage[],
  config: Config,
  provider: Provider
): void {
  Promise.resolve().then(async () => {
    try {
      // Import pipeline lazily to avoid circular deps
      const { runExtractionPipeline } = await import('../extraction/pipeline.js');
      const lastMsg: ChatMessage = { role: 'assistant', content: responseText };
      await runExtractionPipeline({
        sessionId,
        round: 0, // Will be resolved inside pipeline
        overflowMessages: [...requestMessages, lastMsg],
        llmCall: async (prompt: string) => {
          // Use the same provider for extraction (lightweight model)
          return ''; // V1: extraction happens separately; stub for now
        },
      });
    } catch (err) {
      // Fire-and-forget: silently log, never crash
      console.error('[MemoryWorker] background extraction error:', err);
    }
  });
}

/**
 * Auto-detect character identity from the system prompt content.
 * SillyTavern sends the character card as a system message — hashing it
 * gives a stable character ID without needing custom headers.
 */
function detectSessionFromMessages(messages: ChatMessage[]): {
  charId: string;
  chatId: string;
  branchId: string;
} {
  const systemMsg = messages.find(m => m.role === 'system');
  const firstUserMsg = messages.find(m => m.role === 'user');

  // Character ID: hash of system prompt (ST's character card)
  const charId = systemMsg
    ? 'char_' + createHash('sha256').update(systemMsg.content).digest('hex').slice(0, 12)
    : 'default';

  // Chat ID: hash of first user message + timestamp rounded to hour
  // (same chat within an hour → same session)
  const hourBucket = Math.floor(Date.now() / 3600000);
  const chatSeed = firstUserMsg?.content || 'new-chat';
  const chatId = 'chat_' + createHash('sha256').update(chatSeed + hourBucket).digest('hex').slice(0, 12);

  return { charId, chatId, branchId: 'main' };
}

function getUpstreamConfig(
  provider: Provider,
  config: Config,
  isAnthropicPath: boolean = false
): { url: string; apiKey: string } {
  if (provider instanceof DeepSeekProvider) {
    return {
      url: isAnthropicPath
        ? (provider as DeepSeekProvider).getAnthropicBaseURL()
        : (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1'),
      apiKey: process.env.DEEPSEEK_API_KEY || config.apiKey,
    };
  }
  if (provider instanceof MiMoProvider) {
    return {
      url: isAnthropicPath
        ? (provider as MiMoProvider).getAnthropicBaseURL()
        : (process.env.MIMO_BASE_URL || 'https://api.xiaomimimo.com/v1'),
      apiKey: process.env.MIMO_API_KEY || config.apiKey,
    };
  }
  if (provider instanceof ClaudeProvider) {
    return {
      url: process.env.ANTHROPIC_BASE_URL || config.upstreamUrl,
      apiKey: process.env.ANTHROPIC_API_KEY || config.apiKey,
    };
  }
  // Default: OpenAI
  return {
    url: process.env.OPENAI_BASE_URL || config.upstreamUrl,
    apiKey: process.env.OPENAI_API_KEY || config.apiKey,
  };
}

function getDefaultModel(provider: Provider, bodyModel?: string): string {
  if (bodyModel) return bodyModel;
  if (provider instanceof DeepSeekProvider) return process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  if (provider instanceof MiMoProvider) return process.env.MIMO_MODEL || 'mimo-v2-flash';
  if (provider instanceof ClaudeProvider) return process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
  return process.env.OPENAI_MODEL || 'gpt-4o';
}

export async function registerRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const sessionManager = new SessionManager();

  // OpenAI-compatible endpoint (OpenAI, DeepSeek, MiMo all use this)
  app.route({
    method: ['POST'],
    url: '/v1/chat/completions',
    handler: async (request, reply) => {
      const body = request.body as any;
      const headers = request.headers as Record<string, string>;

      const provider = getProviderForRequest(request.url, headers);
      const upstream = getUpstreamConfig(provider, config);
      const messages = provider.parseMessages(body);

      // Session: explicit headers override auto-detection from system prompt
      let charId = headers['x-character-id'] || '';
      let chatId = headers['x-chat-id'] || '';
      const branchId = headers['x-branch-id'] || 'main';
      if (!charId || !chatId) {
        const detected = detectSessionFromMessages(messages);
        if (!charId) charId = detected.charId;
        if (!chatId) chatId = detected.chatId;
      }
      const session = sessionManager.resolve(charId, chatId, branchId);

      const wm = new WorkingMemory(config.workingMemoryTokens);
      for (const msg of messages) {
        wm.append(msg);
      }
      wm.trimToWindow();

      const budget = new TokenBudgetManager(provider.getCapabilities());
      const memManager = new MemoryManager(budget);
      const emptyKeywordCtx: KeywordContext = { entities: [], keywords: [], search_terms: [], implicit_topics: [] };
      const { messages: enriched } = await memManager.assembleContext(session.id, wm, emptyKeywordCtx);

      try {
        // Preserve ST's original system prompt (character card)
        const stSystemPrompt = messages.find(m => m.role === 'system')?.content || '';

        const memoryContent = enriched.find(m => m.role === 'system')?.content || '';
        const nonSystem = enriched.filter(m => m.role !== 'system');

        // Combine: ST角色卡 + 记忆内容
        const combinedSystem = stSystemPrompt
          ? `${stSystemPrompt}\n\n[以下为长期记忆，仅供参考]\n${memoryContent}`
          : memoryContent;

        const finalMessages = provider.injectSystemPrompt(nonSystem, combinedSystem);
        const wantStream = body.stream === true;

        const upstreamBody: Record<string, unknown> = {
          model: getDefaultModel(provider, body.model),
          messages: finalMessages,
          stream: wantStream,
        };
        // 钳制max_tokens：不能小于1 也不能超过Provider上限
        const requestedMax = body.max_tokens || body.max_completion_tokens || provider.getMaxOutputTokens();
        upstreamBody.max_tokens = Math.max(1, Math.min(requestedMax, provider.getMaxOutputTokens()));
        if (body.temperature !== undefined) upstreamBody.temperature = body.temperature;

        const upstreamRes = await fetch(`${upstream.url}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${upstream.apiKey}`,
          },
          body: JSON.stringify(upstreamBody),
        });

        if (!upstreamRes.ok) {
          const errText = await upstreamRes.text();
          return reply.status(upstreamRes.status).send({ error: 'Upstream error', message: errText });
        }

        // --- Streaming path ---
        if (wantStream && upstreamRes.body) {
          reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });

          let fullContent = '';
          const reader = upstreamRes.body.getReader();
          const decoder = new TextDecoder();

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              const chunk = decoder.decode(value, { stream: true });
              reply.raw.write(chunk);

              // Accumulate content from delta chunks
              for (const line of chunk.split('\n')) {
                if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                  try {
                    const json = JSON.parse(line.slice(6));
                    const delta = json.choices?.[0]?.delta?.content;
                    if (delta) fullContent += delta;
                  } catch { /* ignore parse errors in partial chunks */ }
                }
              }
            }
          } finally {
            reader.releaseLock();
            reply.raw.end();
          }

          // Async memory processing
          sessionManager.incrementRound(session.id);
          if (fullContent) {
            scheduleMemoryProcessing(session.id, fullContent, messages, config, provider);
          }
          return;
        }

        // --- Non-streaming path ---
        const data: any = await upstreamRes.json();
        sessionManager.incrementRound(session.id);

        const responseText = provider.extractResponse(data);
        if (responseText) {
          scheduleMemoryProcessing(session.id, responseText, messages, config, provider);
        }

        return reply.send(data);
      } catch (err: any) {
        return reply.status(502).send({ error: 'Upstream error', message: err.message });
      }
    },
  });

  // Anthropic-compatible endpoint
  app.route({
    method: ['POST'],
    url: '/v1/messages',
    handler: async (request, reply) => {
      const body = request.body as any;
      const headers = request.headers as Record<string, string>;

      const provider = getProviderForRequest(request.url, headers);
      const upstream = getUpstreamConfig(provider, config, true);
      const messages = provider.parseMessages(body);

      // Session: explicit headers override auto-detection from system prompt
      let charId = headers['x-character-id'] || '';
      let chatId = headers['x-chat-id'] || '';
      const branchId = headers['x-branch-id'] || 'main';
      if (!charId || !chatId) {
        const detected = detectSessionFromMessages(messages);
        if (!charId) charId = detected.charId;
        if (!chatId) chatId = detected.chatId;
      }
      const session = sessionManager.resolve(charId, chatId, branchId);

      const wm = new WorkingMemory(config.workingMemoryTokens);
      for (const msg of messages) {
        wm.append(msg);
      }
      wm.trimToWindow();

      const budget = new TokenBudgetManager(provider.getCapabilities());
      const memManager = new MemoryManager(budget);
      const emptyKeywordCtx2: KeywordContext = { entities: [], keywords: [], search_terms: [], implicit_topics: [] };
      const { messages: enriched } = await memManager.assembleContext(session.id, wm, emptyKeywordCtx2);

      try {
        // Preserve ST's original system prompt (character card)
        const stSystemPrompt = messages.find(m => m.role === 'system')?.content || '';

        const memoryContent = enriched.find(m => m.role === 'system')?.content || '';
        const nonSystem = enriched.filter(m => m.role !== 'system');

        // Combine: ST角色卡 + 记忆内容 (for Anthropic, system is top-level)
        const combinedSystem = stSystemPrompt
          ? `${stSystemPrompt}\n\n[以下为长期记忆，仅供参考]\n${memoryContent}`
          : memoryContent;

        interface ClaudeUpstream {
          model: string;
          max_tokens: number;
          system?: string;
          messages: { role: string; content: string }[];
        }

        const wantStream = body.stream === true;

        const upstreamBody: Record<string, unknown> = {
          model: getDefaultModel(provider, body.model),
          max_tokens: body.max_tokens || 4096,
          system: combinedSystem,
          messages: nonSystem.map(m => ({ role: m.role, content: m.content })),
          stream: wantStream,
        };

        const upstreamRes = await fetch(`${upstream.url}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': upstream.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(upstreamBody),
        });

        if (!upstreamRes.ok) {
          const errText = await upstreamRes.text();
          return reply.status(upstreamRes.status).send({ error: 'Upstream error', message: errText });
        }

        // --- Streaming path ---
        if (wantStream && upstreamRes.body) {
          reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });

          let fullContent = '';
          const reader = upstreamRes.body.getReader();
          const decoder = new TextDecoder();

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const chunk = decoder.decode(value, { stream: true });
              reply.raw.write(chunk);
              // Accumulate content from Anthropic SSE delta chunks
              for (const line of chunk.split('\n')) {
                if (line.startsWith('data: ')) {
                  try {
                    const json = JSON.parse(line.slice(6));
                    const delta = json.delta?.text || json.content_block?.text || '';
                    if (delta) fullContent += delta;
                  } catch { /* ignore */ }
                }
              }
            }
          } finally {
            reader.releaseLock();
            reply.raw.end();
          }

          sessionManager.incrementRound(session.id);
          if (fullContent) {
            scheduleMemoryProcessing(session.id, fullContent, messages, config, provider);
          }
          return;
        }

        // --- Non-streaming path ---
        const data: any = await upstreamRes.json();
        sessionManager.incrementRound(session.id);

        const responseText = provider.extractResponse(data);
        if (responseText) {
          scheduleMemoryProcessing(session.id, responseText, messages, config, provider);
        }

        return reply.send(data);
      } catch (err: any) {
        return reply.status(502).send({ error: 'Upstream error', message: err.message });
      }
    },
  });

  // Health check
  app.get('/health', async () => {
    return { status: 'ok', uptime: process.uptime() };
  });
}
