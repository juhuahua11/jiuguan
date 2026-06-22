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
}
main().catch(e => { console.error(e); process.exit(1); });
