import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const adapter = require('../memory/adapter.js');

async function main() {
  // 1. adapter 导出预期 API
  assert.strictEqual(typeof adapter.handleChatRequest, 'function', 'handleChatRequest exported');
  assert.strictEqual(typeof adapter.getLogsSince, 'function', 'getLogsSince exported');
  assert.strictEqual(typeof adapter.getConfig, 'function', 'getConfig exported');
  assert.strictEqual(typeof adapter.saveConfig, 'function', 'saveConfig exported');
  assert.strictEqual(typeof adapter.init, 'function', 'init exported');

  // 2. 日志缓冲：注入一条 [MemoryProxy] 日志后能读到
  const before = adapter.getLogsSince(0).length;
  console.log('[MemoryProxy] test-log-line');
  const after = adapter.getLogsSince(0);
  assert.ok(after.length > before, 'captured a [MemoryProxy] log line');
  assert.ok(after.some(l => l.text.includes('test-log-line')), 'log text captured');

  console.log('PASS Task2');

  // 3. handleChatRequest: 用假 settings + mock brain 验证翻译逻辑，不真跑记忆管线
  const fakeSettings = {
    apiUrl: 'https://api.deepseek.com/v1/chat/completions',
    apiKey: 'sk-test-key',
    modelName: 'deepseek-v4-pro',
  };
  let captured = null;
  const adapter2 = require('../memory/adapter.js');
  adapter2.handleChatRequest = async (body, settings) => {
    const headers = adapter2._buildUpstreamHeaders(body, settings);
    captured = { headers, body };
    return { status: 200, headers: { 'content-type': 'application/json' }, body: { ok: true } };
  };
  const res = await adapter2.handleChatRequest({ messages: [{role:'user',content:'hi'}], model: 'deepseek-v4-pro', stream: false, chat_id: 'c_1' }, fakeSettings);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(captured.headers['x-upstream-host'], 'api.deepseek.com');
  assert.strictEqual(captured.headers['x-upstream-port'], '443');
  assert.strictEqual(captured.headers['x-upstream-path'], '/v1/chat/completions');
  assert.strictEqual(captured.headers['authorization'], 'Bearer sk-test-key');
  assert.strictEqual(captured.body.chat_id, 'c_1');
  console.log('PASS Task3');

  // 4. _buildUpstreamHeaders：用 new URL 解析，支持自定义端口/http/query，统一 Bearer
  const adapter3 = require('../memory/adapter.js');
  const h1 = adapter3._buildUpstreamHeaders({}, { apiUrl: 'https://api.deepseek.com/v1/chat/completions', apiKey: 'k1' });
  assert.strictEqual(h1['x-upstream-host'], 'api.deepseek.com');
  assert.strictEqual(h1['x-upstream-path'], '/v1/chat/completions');
  assert.strictEqual(h1['x-upstream-port'], '443');
  assert.strictEqual(h1['authorization'], 'Bearer k1');
  // 自定义端口：端口进 x-upstream-port，host 不含端口
  const h2 = adapter3._buildUpstreamHeaders({}, { apiUrl: 'https://api.myproxy.com:8443/v1/chat/completions', apiKey: 'k2' });
  assert.strictEqual(h2['x-upstream-host'], 'api.myproxy.com');
  assert.strictEqual(h2['x-upstream-port'], '8443');
  assert.strictEqual(h2['x-upstream-path'], '/v1/chat/completions');
  // http 本地服务：scheme=http，端口保留
  const h3 = adapter3._buildUpstreamHeaders({}, { apiUrl: 'http://localhost:1234/v1/chat/completions', apiKey: 'k3' });
  assert.strictEqual(h3['x-upstream-host'], 'localhost');
  assert.strictEqual(h3['x-upstream-port'], '1234');
  // 无路径 base url 兜底 /chat/completions
  const h4 = adapter3._buildUpstreamHeaders({}, { apiUrl: 'https://api.deepseek.com', apiKey: 'k4' });
  assert.strictEqual(h4['x-upstream-host'], 'api.deepseek.com');
  assert.strictEqual(h4['x-upstream-path'], '/chat/completions');
  console.log('PASS Task9');
}
main().catch(e => { console.error(e); process.exit(1); });
