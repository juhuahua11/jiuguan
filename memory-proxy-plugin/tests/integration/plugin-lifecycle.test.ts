import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';

// The internal server starts with HTTPS (self-signed cert). Use Node's https
// module with an agent that accepts self-signed certs, mirroring the real
// CustomHttpAgent → localAgent (rejectUnauthorized: false) path. (We avoid
// `undici`'s dispatcher here because vite's resolver can't resolve the
// built-in undici module by bare name.)
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

function requestHttps(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; json: () => Promise<any> }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: init?.method || 'GET',
        headers: init?.headers || {},
        agent: insecureAgent,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          const status = res.statusCode || 0;
          resolve({ status, json: async () => JSON.parse(data) });
        });
      }
    );
    req.on('error', reject);
    if (init?.body) req.write(init.body);
    req.end();
  });
}

describe('Plugin Lifecycle', () => {
  let cleanup: Function;
  let tmpDir: string;
  let internalPort: number;
  // Capture the /set-chat-id handler so we can exercise it directly.
  let setChatIdHandler: ((req: any, res: any) => void) | null = null;

  beforeAll(async () => {
    // Create a minimal ST-like directory structure
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-test-'));

    // Create plugins/memory-proxy directory
    const pluginDir = path.join(tmpDir, 'plugins', 'memory-proxy');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'data', 'default-user'), { recursive: true });

    // Create a minimal ST settings.json (standard ST layout: {ST}/data/default-user)
    fs.writeFileSync(
      path.join(tmpDir, 'data', 'default-user', 'settings.json'),
      JSON.stringify({
        oai_settings: {
          chat_completion_source: 'deepseek',
          deepseek_model: 'deepseek-chat',
          openai_max_tokens: 4096,
          temp_openai: 1,
          stream_openai: true,
          reverse_proxy: '',
        },
      }, null, 2)
    );
  });

  afterAll(async () => {
    if (cleanup) await cleanup();
    // Cleanup temp dir
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should import initPlugin without errors', async () => {
    const mod = await import('../../src/plugin.js');
    expect(mod.initPlugin).toBeDefined();
    expect(typeof mod.initPlugin).toBe('function');
  });

  it('should initialize plugin and return cleanup function', async () => {
    const { initPlugin } = await import('../../src/plugin.js');

    // Create plugin dir with config
    const pluginDir = path.join(tmpDir, 'plugins', 'memory-proxy');
    fs.writeFileSync(
      path.join(pluginDir, 'plugin-config.json'),
      JSON.stringify({ workingMemoryTokens: 16000, enabledModules: { facts: true } })
    );

    // Pass a mock Express-like app (real ST passes a full Express app; production
    // code null-guards _app, but we pass a stub so the /set-chat-id route mounts
    // and we can exercise it).
    const mockApp = {
      post: vi.fn((route: string, handler: (req: any, res: any) => void) => {
        if (route === '/set-chat-id') setChatIdHandler = handler;
      }),
    };

    cleanup = await initPlugin(mockApp, pluginDir);
    expect(cleanup).toBeTypeOf('function');
    expect(setChatIdHandler).not.toBeNull();
  });

  it('should replace https.globalAgent with CustomHttpAgent', () => {
    // After init, globalAgent should be a CustomHttpAgent (not the default)
    expect(https.globalAgent).not.toBeNull();
    // CustomHttpAgent has an 'interceptHosts' property
    expect((https.globalAgent as any).interceptHosts).toBeDefined();
    expect((https.globalAgent as any).interceptHosts).toContain('api.deepseek.com');
    expect((https.globalAgent as any).interceptHosts).toContain('api.xiaomimimo.com');
  });

  it('should have internal server running on localhost (HTTPS)', async () => {
    // The internal server port should have been recorded. We can find it
    // from the CustomHttpAgent's redirectPort
    const port = (https.globalAgent as any).redirectPort;
    expect(port).toBeGreaterThan(0);
    internalPort = port;

    // Health check the internal server over HTTPS (it starts with a self-signed cert)
    const res = await requestHttps(`https://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  it('should proxy chat completions through internal server', async () => {
    // The internal server should accept POST /v1/chat/completions
    // and return an error for missing auth (not 404)
    const res = await requestHttps(`https://127.0.0.1:${internalPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [],
      }),
    });
    // Should return 400 for empty messages, not 404
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it('should accept chatId via the /set-chat-id route handler', () => {
    // Exercise the captured route handler directly with mock req/res.
    const req = { body: { chatId: 'test-chat-123' } };
    let sent: any = null;
    const res = {
      json: (payload: any) => { sent = { status: 200, body: payload }; },
      status: (code: number) => ({ json: (payload: any) => { sent = { status: code, body: payload }; } }),
    };
    setChatIdHandler!(req as any, res as any);
    expect(sent).not.toBeNull();
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ ok: true });
  });

  it('should not log when the same chatId is notified repeatedly', () => {
    const req = { body: { chatId: 'stable-chat-log-test' } };
    const res = {
      json: vi.fn(),
      status: vi.fn((code: number) => ({ json: vi.fn() })),
    };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      setChatIdHandler!(req as any, res as any);
      logSpy.mockClear();

      setChatIdHandler!(req as any, res as any);

      const logs = logSpy.mock.calls.map(call => call.join(' '));
      expect(logs.some(line => line.includes('notifyChatId: same chat'))).toBe(false);
      expect(logs.some(line => line.includes('Chat ID updated'))).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('should reject invalid chatId via the /set-chat-id route handler', () => {
    const req = { body: { chatId: 12345 } }; // non-string
    let sent: any = null;
    const res = {
      json: (payload: any) => { sent = { status: 200, body: payload }; },
      status: (code: number) => ({ json: (payload: any) => { sent = { status: code, body: payload }; } }),
    };
    setChatIdHandler!(req as any, res as any);
    expect(sent.status).toBe(400);
    expect(sent.body.error).toBeDefined();
  });

  it('should cleanup without errors', async () => {
    await cleanup();
    // Should not throw
    expect(true).toBe(true);
  });

  it('should restore https.globalAgent after cleanup', () => {
    // After cleanup, globalAgent should no longer be the CustomHttpAgent
    // It should be a default https.Agent (either the previous or a new one)
    expect((https.globalAgent as any).interceptHosts).toBeUndefined();
  });
});
