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
}
main().catch(e => { console.error(e); process.exit(1); });
