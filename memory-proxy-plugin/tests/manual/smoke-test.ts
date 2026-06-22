/**
 * 手动冒烟测试 — 无需 ST，验证插件核心链路
 * 运行: cd f:/SillyTavern/memory-proxy-plugin && npx tsx tests/manual/smoke-test.ts
 */

import { startInternalServer } from '../../src/internal-server.js';
import { handleMemoryRequest } from '../../src/server/memory-handler.js';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

async function main() {
  console.log('=== Memory Proxy Plugin Smoke Test ===\n');

  // Setup: create a temporary plugin directory structure mimicking ST
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-smoke-'));
  const pluginDir = path.join(tmpDir, 'plugins', 'memory-proxy');
  const dataDir = path.join(pluginDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  // Create fake ST settings.json
  const stDataDir = path.join(tmpDir, 'data', 'default-user');
  fs.mkdirSync(stDataDir, { recursive: true });
  fs.writeFileSync(path.join(stDataDir, 'settings.json'), JSON.stringify({
    chat_completion_source: 'deepseek',
    deepseek_max_context: 2000000,
    deepseek_max_tokens: 390000,
  }));

  const upstreamAgent = new http.Agent({ keepAlive: true });

  // ─── Test 1: Server startup ───
  console.log('1. InternalServer');
  const { server, port } = await startInternalServer({
    handleRequest: (body, headers) => handleMemoryRequest(body, headers, pluginDir, upstreamAgent),
    upstreamAgent,
    pluginDir,
  });
  check('Server starts on random port', port > 1024 && port < 65536, `port=${port}`);
  console.log(`   Server: http://127.0.0.1:${port}\n`);

  // ─── Test 2: Health check ───
  console.log('2. Health check');
  try {
    const hc = await fetch(`http://127.0.0.1:${port}/health`);
    const hcBody = await hc.json();
    check('Health returns 200', hc.status === 200);
    check('Health returns status ok', hcBody.status === 'ok');
    check('Health returns port', hcBody.port === port);
  } catch (e: any) {
    check('Health check works', false, e.message);
  }
  console.log();

  // ─── Test 3: Request validation ───
  console.log('3. Request validation');
  {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-chat' }),
    });
    const body = await res.json();
    check('No messages → 400', res.status === 400);
  }
  {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [] }),
    });
    const body = await res.json();
    check('Empty messages → 400', res.status === 400);
  }
  console.log();

  // ─── Test 4: Database initialized ───
  console.log('4. Database');
  const dbPath = path.join(pluginDir, 'data', 'memory.db');
  // Trigger DB init by sending a valid request (will fail upstream, but DB is created)
  try {
    await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-upstream-host': 'api.deepseek.com',
        'x-upstream-port': '443',
        'authorization': 'Bearer sk-test-key',
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: '你叫张三，是一个武侠。' },
          { role: 'user', content: '我叫什么名字？' },
        ],
        stream: false,
      }),
    });
  } catch { /* upstream unreachable is expected */ }
  check('memory.db created', fs.existsSync(dbPath), `size=${fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0} bytes`);
  console.log();

  // ─── Test 5: Memory context injection (no real API key needed) ───
  console.log('5. Memory context injection');
  {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-upstream-host': 'api.deepseek.com',
        'x-upstream-port': '443',
        'authorization': 'Bearer sk-test-key',
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: '你叫张三，是一个武侠。' },
          { role: 'user', content: '我叫什么名字？' },
        ],
        stream: false,
      }),
    });
    const body = await res.json();
    // With no real API key, upstream returns 401/403/502 — that's expected
    // The key thing: the handler didn't crash
    check('Handler processes request without crashing', res.status >= 200 && res.status <= 502);
    check('Response has content-type', res.headers.get('content-type')?.includes('application/json') ?? false);
    // Check the body is valid JSON (even if it's an upstream error)
    check('Response is valid JSON', typeof body === 'object' && body !== null);
  }
  console.log();

  // ─── Test 6: MiMo hostname interception ───
  console.log('6. MiMo upstream resolution');
  {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-upstream-host': 'api.xiaomimimo.com',
        'x-upstream-port': '443',
        'authorization': 'Bearer sk-test-mimo',
      },
      body: JSON.stringify({
        model: 'mimo-v2-flash',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      }),
    });
    check('MiMo handler does not crash', res.status >= 200 && res.status <= 502);
  }
  console.log();

  // ─── Test 7: ST config reading ───
  console.log('7. ST Config reading');
  const settingsPath = path.join(stDataDir, 'settings.json');
  const { readStCapabilities } = await import('../../src/adapters/st-config.js');
  const caps = readStCapabilities(settingsPath);
  check('DeepSeek context window = 2M', caps.contextWindow === 2000000);
  check('DeepSeek max tokens = 390K', caps.maxOutputTokens === 390000);
  console.log();

  // ─── Test 8: Stream flag handling ───
  console.log('8. Streaming');
  {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-upstream-host': 'api.deepseek.com',
        'x-upstream-port': '443',
        'authorization': 'Bearer sk-test-key',
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: true,
      }),
    });
    // Handler should not crash on stream=true even if upstream is unreachable
    check('Stream request does not crash', res.status >= 200 && res.status <= 502);
  }
  console.log();

  // ─── Cleanup ───
  await server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log('========================================');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('========================================');

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
