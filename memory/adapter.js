// jiuguan ↔ memory-proxy-plugin 大脑的桥梁。
// 只做：加载大脑 .ts、合成 upstream 头、caps 合成、日志环形缓冲、配置读写。
// 不含记忆逻辑——大脑全在 memory-proxy-plugin/src/server/memory-handler.ts。

const fs = require('fs');
const path = require('path');
const https = require('https');

const PLUGIN_DIR = path.join(__dirname); // jiuguan/memory/ — plugin-config.json 与 data/ 落在这
const CONFIG_PATH = path.join(PLUGIN_DIR, 'plugin-config.json');
const CAPS_PATH = path.join(__dirname, '..', 'data', 'memory-caps.json');
const DEFAULT_CONFIG = require('./plugin-config.json');

let brain = null;        // handleMemoryRequest + notifyChatId
let initialized = false;

// ── 日志环形缓冲 ──
const LOG_MAX = 1000;
const logBuffer = []; // { ts, level, text }
let consolePatched = false;

function patchConsole() {
  if (consolePatched) return;
  consolePatched = true;
  const wrap = (level, orig) => (...args) => {
    try {
      const text = args.map(a => typeof a === 'string' ? a : (a?.message ? a.message : String(a))).join(' ');
      if (text.includes('[MemoryProxy]') || text.includes('[aidraw]') || text.includes('[migrate]') || text.startsWith('AI Chat Server')) {
        logBuffer.push({ ts: Date.now(), level, text });
        if (logBuffer.length > LOG_MAX) logBuffer.shift();
      }
    } catch {}
    return orig.apply(console, args);
  };
  console.log = wrap('info', console.log.bind(console));
  console.error = wrap('error', console.error.bind(console));
  console.warn = wrap('warn', console.warn.bind(console));
}

function getLogsSince(ts) {
  return logBuffer.filter(l => l.ts > ts);
}

// ── caps 合成 ──
function synthesizeCaps(settings) {
  const model = (settings.modelName || '').toLowerCase();
  let source = 'custom';
  let maxContext = 1000000;
  let maxTokens = 130000;
  if (model.startsWith('deepseek')) {
    source = 'deepseek';
    maxContext = 2000000;
    maxTokens = 390000;
  } else if (model.startsWith('mimo')) {
    source = 'custom';
    maxContext = 1000000;
    maxTokens = 130000;
  }
  const caps = {
    chat_completion_source: source,
    deepseek_max_context: maxContext,
    deepseek_max_tokens: maxTokens,
    custom_max_context: maxContext,
    custom_max_tokens: maxTokens,
  };
  fs.mkdirSync(path.dirname(CAPS_PATH), { recursive: true });
  fs.writeFileSync(CAPS_PATH, JSON.stringify(caps, null, 2));
  process.env.MEMPROXY_ST_SETTINGS = CAPS_PATH;
  console.log(`[MemoryProxy] caps synthesized: source=${source} ctx=${maxContext} maxTokens=${maxTokens} → ${CAPS_PATH}`);
}

// ── 配置读写 ──
// getConfig: 解析失败时打日志并返回默认值，不静默吞错（避免后续 save 用默认值覆盖损坏文件）。
function getConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8').replace(/^﻿/, '');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch (e) {
    console.warn('[MemoryProxy] plugin-config.json parse failed, using defaults:', e?.message || e);
    return { ...DEFAULT_CONFIG };
  }
}

// 对象字段深合并：部分 POST（如 {continuity:{enabled:false}}）不应覆盖整个 continuity 对象。
function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function saveConfig(partial) {
  const merged = deepMerge(getConfig(), partial);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  console.log('[MemoryProxy] plugin-config.json updated');
  return merged;
}

// ── 初始化：加载大脑 ──
async function init(settings) {
  if (initialized) return;
  synthesizeCaps(settings || {});
  require('tsx/cjs'); // 注册 tsx，让其发现根 tsconfig.json 的 paths
  const mod = require('../memory-proxy-plugin/src/server/memory-handler.ts');
  brain = {
    handleMemoryRequest: mod.handleMemoryRequest,
    notifyChatId: mod.notifyChatId,
  };
  initialized = true;
  console.log('[MemoryProxy] brain loaded: handleMemoryRequest ready');
}

// ── upstream 头合成 ──
// 用 new URL 正确解析 apiUrl → host/port/path，避免硬编码 443 导致自定义端口畸形 URL。
// 大脑读 headers['authorization']（strip 'Bearer ' 后以 Bearer 转发）、x-upstream-host/port/path
// 拼 https://${host}:${port}${path}。jiuguan 只用 deepseek（https:443），故 scheme 固定 https。
function _buildUpstreamHeaders(body, settings) {
  let u;
  try { u = new URL(settings.apiUrl || ''); }
  catch { u = new URL('https://api.deepseek.com'); }
  const host = u.hostname;
  const port = u.port || (u.protocol === 'http:' ? '80' : '443');
  const reqPath = (u.pathname && u.pathname !== '/' ? u.pathname : '') + (u.search || '') || '/chat/completions';
  return {
    'authorization': 'Bearer ' + (settings.apiKey || ''),
    'x-upstream-host': host,
    'x-upstream-port': port,
    'x-upstream-path': reqPath,
  };
}

// 模块级复用 agent：keepAlive 池跨请求复用，避免每请求新建导致 socket 泄漏。
const upstreamAgent = new https.Agent({ keepAlive: true, maxSockets: 32 });

// ── 主入口：转发给大脑 ──
async function handleChatRequest(body, settings) {
  if (!initialized) await init(settings);
  const headers = _buildUpstreamHeaders(body, settings);
  // 大脑签名：handleMemoryRequest(body, headers, pluginDir, upstreamAgent)
  return brain.handleMemoryRequest(body, headers, PLUGIN_DIR, upstreamAgent);
}

// 模块加载即打补丁，确保任何 [MemoryProxy] 日志都能被捕获（即使 init 未调用）
patchConsole();

module.exports = {
  init,
  getBrain: () => brain,
  getLogsSince,
  getConfig,
  saveConfig,
  _buildUpstreamHeaders,
  handleChatRequest,
  PLUGIN_DIR,
};
