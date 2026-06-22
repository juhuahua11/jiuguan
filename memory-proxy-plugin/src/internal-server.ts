import Fastify, { FastifyInstance } from 'fastify';
import net from 'node:net';
import http from 'node:http';

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export interface ServerOptions {
  handleRequest: (
    body: Record<string, unknown>,
    headers: Record<string, string>
  ) => Promise<{ status: number; headers: Record<string, string>; body: unknown }>;
  upstreamAgent: http.Agent;
  pluginDir: string;
  /** HTTPS key + cert for TLS (required when used behind CustomHttpAgent) */
  https?: { key: string; cert: string };
}

export interface ServerInstance {
  server: FastifyInstance<any>;
  port: number;
}

export async function startInternalServer(opts: ServerOptions): Promise<ServerInstance> {
  const port = await findFreePort();
  // Fastify v4 requires https in constructor, NOT in listen() — otherwise TLS handshake fails
  const app = Fastify({
    logger: false,
    https: opts.https,
    bodyLimit: 50 * 1024 * 1024, // 50MB，防止大请求体被拒绝
  } as any);

  app.get('/health', async () => {
    return { status: 'ok', port };
  });

  // Shared chat-completions handler — invoked for both /v1 and /beta (DeepSeek) paths
  async function handleChatCompletion(request: any, reply: any) {
    let headersSent = false;
    try {
      const headers = request.headers as Record<string, string>;
      // Pass the original request path so memory-handler can forward to the correct upstream endpoint
      headers['x-upstream-path'] = request.url;
      const result = await opts.handleRequest(
        request.body as Record<string, unknown>,
        headers
      );

      // If the result body is a ReadableStream, pipe it as SSE
      if (result.body && typeof (result.body as any).getReader === 'function') {
        reply.raw.writeHead(result.status, result.headers);
        headersSent = true;

        const reader = (result.body as any).getReader();
        const decoder = new TextDecoder();
        // Cancel the upstream reader if the client disconnects, so we stop
        // buffering/pulling a stream nobody is reading.
        const onError = () => { try { reader.cancel(); } catch {} };
        reply.raw.on('error', onError);
        reply.raw.on('close', onError);

        // Idle-during-stream protection: RP generations legitimately run minutes, so we
        // do NOT bound total stream time. But if the upstream stops sending chunks for
        // STREAM_IDLE_TIMEOUT_MS (a hung/semi-dead connection), abort so the underlying
        // socket is released back to the pool instead of hanging forever. Each received
        // chunk resets the idle timer; only true silence trips it.
        const STREAM_IDLE_TIMEOUT_MS = 90_000;
        let idleTimer: NodeJS.Timeout | null = null;
        const armIdle = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            console.error(`[MemoryProxy] Stream idle > ${STREAM_IDLE_TIMEOUT_MS}ms — aborting upstream read to release connection`);
            try { reader.cancel(new Error('stream idle timeout')); } catch {}
          }, STREAM_IDLE_TIMEOUT_MS);
        };
        const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };
        armIdle();
        try {
          while (true) {
            // Race the next chunk against the idle timer. A resolved read resets idle;
            // a timeout rejects via cancel() and breaks the loop.
            const { done, value } = await reader.read();
            clearIdle();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            // Honor backpressure: if the internal buffer is full, wait for drain.
            if (!reply.raw.writableEnded) {
              if (!reply.raw.write(chunk)) {
                await new Promise<void>(r => reply.raw.once('drain', r));
              }
            }
            armIdle();
          }
          // Flush any trailing multi-byte UTF-8 sequence held in the decoder
          // (a CJK char split at the final chunk boundary would otherwise be dropped).
          const tail = decoder.decode();
          if (tail && !reply.raw.writableEnded) {
            reply.raw.write(tail);
          }
        } finally {
          clearIdle();
          reply.raw.removeListener('error', onError);
          reply.raw.removeListener('close', onError);
          try { reader.releaseLock(); } catch {}
          if (!reply.raw.writableEnded) reply.raw.end();
        }
        return;
      }

      return reply
        .status(result.status)
        .headers(result.headers)
        .send(result.body);
    } catch (err: any) {
      // If we already started streaming (headers flushed), we can no longer send
      // a JSON 502 — just log and ensure the socket closes cleanly.
      if (headersSent) {
        console.error('[MemoryProxy] Streaming error after headers sent:', err.message || err);
        if (!reply.raw.writableEnded) {
          try { reply.raw.end(); } catch {}
        }
        return;
      }
      return reply.status(502).send({ error: 'Proxy error', message: err.message });
    }
  }

  // DeepSeek uses both /v1/chat/completions (standard) and /beta/chat/completions (their own)
  app.post('/v1/chat/completions', handleChatCompletion);
  app.post('/beta/chat/completions', handleChatCompletion);

  // Catch-all: proxy unmatched requests (e.g., /models) to the upstream API.
  // Only chat completions are handled locally; everything else passes through.
  // MUST be registered BEFORE app.listen() — Fastify rejects post-listen handler registration.
  app.setNotFoundHandler(async (request, reply) => {
    try {
      const headers = request.headers as Record<string, string>;
      const upstreamHost = headers['x-upstream-host'] || 'api.deepseek.com';
      const upstreamPort = headers['x-upstream-port'] || '443';
      const upstreamUrl = `https://${upstreamHost}:${upstreamPort}`;
      const apiKey = (headers['authorization'] || '').replace('Bearer ', '');

      // Build upstream request — strip internal headers before forwarding
      const upstreamHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(headers)) {
        if (!key.startsWith('x-upstream-') && !['host', 'connection'].includes(key.toLowerCase())) {
          upstreamHeaders[key] = value as string;
        }
      }

      const fetchOpts: Record<string, unknown> = {
        method: request.method,
        headers: upstreamHeaders,
      };
      if (opts.upstreamAgent) fetchOpts.agent = opts.upstreamAgent;

      // Forward body for methods that carry one
      if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
        fetchOpts.body = typeof request.body === 'string'
          ? request.body
          : JSON.stringify(request.body);
      }

      const upstreamRes = await fetch(`${upstreamUrl}${request.url}`, fetchOpts as RequestInit);

      const responseHeaders: Record<string, string> = {};
      upstreamRes.headers.forEach((value, key) => {
        if (!['content-encoding', 'transfer-encoding'].includes(key.toLowerCase())) {
          responseHeaders[key] = value;
        }
      });

      const contentType = upstreamRes.headers.get('content-type') || '';
      let body: unknown;
      if (contentType.includes('application/json')) {
        body = await upstreamRes.json();
      } else {
        body = await upstreamRes.text();
      }

      return reply.status(upstreamRes.status).headers(responseHeaders).send(body);
    } catch (err: any) {
      return reply.status(502).send({ error: 'Upstream proxy error', message: err.message });
    }
  });

  await app.listen({ port, host: '127.0.0.1' });
  const proto = opts.https ? 'https' : 'http';
  console.log(`[MemoryProxy] Internal server: ${proto}://127.0.0.1:${port}`);

  return { server: app as any, port };
}
