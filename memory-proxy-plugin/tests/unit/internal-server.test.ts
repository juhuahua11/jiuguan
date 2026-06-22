import { describe, it, expect, afterAll } from 'vitest';
import http from 'http';
import { findFreePort, startInternalServer, ServerInstance } from '../../src/internal-server.js';

describe('InternalServer', () => {
  it('should find a free port in valid range', async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(1024);
    expect(port).toBeLessThan(65536);
  });

  describe('server lifecycle', () => {
    let instance: ServerInstance;
    const upstreamAgent = new http.Agent();

    afterAll(async () => {
      if (instance) await instance.server.close();
    });

    it('should start and respond to health check', async () => {
      instance = await startInternalServer({
        handleRequest: async () => ({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: { status: 'ok' },
        }),
        upstreamAgent,
        pluginDir: '/tmp',
      });

      const res = await fetch(`http://127.0.0.1:${instance.port}/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
    });

    it('should proxy chat completion requests', async () => {
      const res = await fetch(`http://127.0.0.1:${instance.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res.status).toBe(200);
    });

    it('should return 502 on handler error', async () => {
      const { server, port } = await startInternalServer({
        handleRequest: async () => { throw new Error('upstream down'); },
        upstreamAgent,
        pluginDir: '/tmp',
      });

      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toBe('Proxy error');

      await server.close();
    });
  });
});
