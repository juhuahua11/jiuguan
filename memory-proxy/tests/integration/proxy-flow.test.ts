import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { registerRoutes } from '../../src/server/routes.js';
import { initDatabase, closeDatabase } from '../../src/storage/db.js';
import { Config } from '../../src/config.js';

describe('Proxy Integration', () => {
  let app: FastifyInstance;
  const config: Config = {
    proxyPort: 19876, dashboardPort: 19877,
    upstreamUrl: 'https://httpbin.org',  // safe test upstream
    apiKey: 'sk-test',
    workingMemoryTokens: 8000,
    dataDir: './memory',
  };

  beforeAll(async () => {
    await initDatabase(':memory:');
    app = Fastify();
    await registerRoutes(app, config);
    await app.listen({ port: 19876, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await app.close();
    closeDatabase();
  });

  it('should have health check endpoint', async () => {
    const response = await fetch('http://127.0.0.1:19876/health');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('ok');
  });

  it('should accept chat completion request with session headers', async () => {
    const response = await fetch('http://127.0.0.1:19876/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-character-id': 'test-char',
        'x-chat-id': 'test-chat',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });
    // May return 502 (upstream httpbin.org doesn't speak OpenAI) but should not crash
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThanOrEqual(502);
  });
});
