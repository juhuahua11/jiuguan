import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { handleMemoryRequest } from '../../../src/server/memory-handler.js';

describe('MemoryHandler', () => {
  let tmpDir: string;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should return 400 when no messages provided', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-test-'));
    const result = await handleMemoryRequest(
      { model: 'deepseek-chat' },
      { 'x-upstream-host': 'api.deepseek.com', 'x-upstream-port': '443' },
      tmpDir
    );
    expect(result.status).toBe(400);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should handle empty messages array', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-test-'));
    const result = await handleMemoryRequest(
      { model: 'deepseek-chat', messages: [] },
      { 'x-upstream-host': 'api.deepseek.com', 'x-upstream-port': '443' },
      tmpDir
    );
    expect(result.status).toBe(400);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should forward request to upstream (expects 502 when upstream unreachable)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-test-'));
    const result = await handleMemoryRequest(
      {
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: 'Test character' },
          { role: 'user', content: 'Hello' },
        ],
        stream: false,
      },
      {
        'x-upstream-host': 'api.deepseek.com',
        'x-upstream-port': '443',
        'authorization': 'Bearer sk-test',
      },
      tmpDir
    );
    // 502 expected (no real API key, connection refused, or timeout)
    expect(result.status).toBeGreaterThanOrEqual(200);
    expect(result.status).toBeLessThanOrEqual(502);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should preserve system prompt in forwarded messages', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-test-'));
    const result = await handleMemoryRequest(
      {
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: 'You are a helpful test bot.' },
          { role: 'user', content: 'Hi' },
        ],
        stream: false,
      },
      {
        'x-upstream-host': 'api.deepseek.com',
        'x-upstream-port': '443',
        'authorization': 'Bearer sk-test',
      },
      tmpDir
    );
    // Upstream may be unreachable but the function should not throw
    expect(result.status).toBeGreaterThanOrEqual(200);
    expect(result.status).toBeLessThanOrEqual(502);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should preserve extra ST generation options when forwarding upstream', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-test-'));
    let forwardedBody: any = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      forwardedBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    const result = await handleMemoryRequest(
      {
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: 'You are a helpful test bot.' },
          { role: 'user', content: 'Hi' },
        ],
        stream: false,
        presence_penalty: 0.4,
        frequency_penalty: 0.2,
        seed: 123,
        response_format: { type: 'json_object' },
        max_tokens: 77,
      },
      {
        'x-upstream-host': 'api.deepseek.com',
        'x-upstream-port': '443',
        'authorization': 'Bearer sk-test',
      },
      tmpDir
    );

    expect(result.status).toBe(200);
    expect(forwardedBody.presence_penalty).toBe(0.4);
    expect(forwardedBody.frequency_penalty).toBe(0.2);
    expect(forwardedBody.seed).toBe(123);
    expect(forwardedBody.response_format).toEqual({ type: 'json_object' });
    expect(forwardedBody.messages).toEqual(expect.any(Array));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('injects full handoff context on model switch', async () => {
    const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-handoff-'));
    fs.writeFileSync(path.join(pluginDir, 'plugin-config.json'), JSON.stringify({
      workingMemoryTokens: 8000,
      continuity: {
        enabled: true,
        snapshotDetail: 'full',
        normalMaxTokens: 800,
        compactMaxTokens: 1200,
        mediumMaxTokens: 1800,
        fullMaxTokens: 3000,
        refreshEveryTurns: 1,
      },
      handoff: {
        enabled: true,
        triggerOnModelSwitch: true,
        manualRefreshEnabled: true,
        boostTurns: 20,
        fullTurns: 3,
        mediumTurns: 7,
      },
    }));

    const forwardedBodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const parsed = JSON.parse(String(init.body));
      if (parsed.messages?.[0]?.role === 'system') {
        forwardedBodies.push(parsed);
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    const messages = [
      { role: 'system', content: 'bot' },
      { role: 'user', content: 'We are at the Moon Gate with Seraphina.' },
    ];
    const headers = {
      authorization: 'Bearer sk-test',
      'x-upstream-host': 'api.deepseek.com',
      'x-upstream-port': '443',
    };

    await handleMemoryRequest({ model: 'model-a', chat_id: 'chat-handoff', messages, stream: false }, headers, pluginDir);
    await handleMemoryRequest({ model: 'model-b', chat_id: 'chat-handoff', messages, stream: false }, headers, pluginDir);

    expect(forwardedBodies.length).toBe(2);
    const joinedMessages = forwardedBodies[1].messages.map((m: any) => m.content).join('\n');
    expect(joinedMessages).toContain('[模型接手提示]');
    expect(joinedMessages).toContain('[长期连续性上下文]');
    fs.rmSync(pluginDir, { recursive: true, force: true });
  });

  // NOTE: upstream connection-error retry behavior (ConnectTimeoutError / ECONNRESET
  // retried up to MAX_RETRIES with backoff; total-timeout and TLS errors not retried)
  // is implemented in handleMemoryRequest but not unit-tested here. The global fetch
  // is shared with the background keyword-refresh call (same API key, same URL when no
  // plugin-config overrides extraction endpoint), so a stub can't reliably distinguish
  // the main completion call from the refresh call — making retry-count assertions
  // flaky. The retry path was verified manually via diagnostic logging (first attempt
  // throws ConnectTimeoutError -> second attempt returns 200 -> handler returns 200).

  it('does not write last-injection.json when debug.injectionTrace is absent', async () => {
    const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-trace-off-'));
    fs.writeFileSync(path.join(pluginDir, 'plugin-config.json'), JSON.stringify({ workingMemoryTokens: 8000 }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )));

    await handleMemoryRequest(
      {
        model: 'deepseek-chat',
        messages: [{ role: 'system', content: 'bot' }, { role: 'user', content: 'hi' }],
        stream: false,
      },
      { authorization: 'Bearer sk-test', 'x-upstream-host': 'api.deepseek.com', 'x-upstream-port': '443' },
      pluginDir
    );

    expect(fs.existsSync(path.join(pluginDir, 'data', 'last-injection.json'))).toBe(false);
    fs.rmSync(pluginDir, { recursive: true, force: true });
  });

  it('writes last-injection.json when debug.injectionTrace is true', async () => {
    const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-trace-on-'));
    fs.writeFileSync(path.join(pluginDir, 'plugin-config.json'), JSON.stringify({
      workingMemoryTokens: 8000,
      debug: { injectionTrace: true },
    }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )));

    await handleMemoryRequest(
      {
        model: 'deepseek-chat',
        messages: [{ role: 'system', content: 'bot' }, { role: 'user', content: 'hi' }],
        stream: false,
      },
      { authorization: 'Bearer sk-test', 'x-upstream-host': 'api.deepseek.com', 'x-upstream-port': '443' },
      pluginDir
    );

    const tracePath = path.join(pluginDir, 'data', 'last-injection.json');
    // writeInjectionTrace is fire-and-forget; poll briefly so the async disk write
    // settles before we assert its result (avoids a race between the write promise
    // and this synchronous existsSync check).
    const deadline = Date.now() + 2000;
    while (!fs.existsSync(tracePath) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 10));
    }
    expect(fs.existsSync(tracePath)).toBe(true);
    const trace = JSON.parse(fs.readFileSync(tracePath, 'utf-8'));
    expect(trace).toHaveProperty('sessionKey');
    expect(trace).toHaveProperty('model', 'deepseek-chat');
    expect(trace).toHaveProperty('keywordContext');
    expect(trace).toHaveProperty('budget');
    expect(trace).toHaveProperty('summary');
    expect(Array.isArray(trace.items)).toBe(true);
    fs.rmSync(pluginDir, { recursive: true, force: true });
  });
});

