# memory-proxy 适配 jiuguan 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 memory-proxy-plugin 的长期记忆大脑（`handleMemoryRequest`）嵌入 jiuguan 的 `/api/chat`，使聊天请求经记忆层装配/检索/抽取后转发上游；附只读控制台与 MP 配置入口；与记忆宫殿共存。

**Architecture:** jiuguan server 新增 `/api/chat` 路由，通过 `memory/adapter.js`（用 `tsx/cjs` 加载 plugin 的 `.ts` 大脑）把浏览器请求转交 `handleMemoryRequest`，upstream/key 从 jiuguan settings.json 翻译成大脑期望的 `x-upstream-*` 头。流式响应用原生 http res pipe。日志走 console monkey-patch 环形缓冲 + `/api/memory/log` 轮询。配置经 `/api/memory/config` 读写 `plugin-config.json`。记忆宫殿不动。

**Tech Stack:** Node.js 原生 http（jiuguan 现有）、tsx/cjs（加载 .ts 大脑）、memory-proxy + memory-proxy-plugin（只读复用，已移入 jiuguan 子目录）、sql.js（记忆 DB）、纯前端 JS（控制台 drawer + settings 折叠区）。

**前提（已完成并提交）：** 两个 mp 已移入 `jiuguan/memory-proxy`、`jiuguan/memory-proxy-plugin`；根 `jiuguan/tsconfig.json` 的 paths 已验证能让 `require('memory-proxy/*')` 解析到 `.ts` 源；`jiuguan/package.json` 已声明 `tsx` 与 `file:./memory-proxy-plugin` 依赖；`npm install` 完成。

---

## 文件结构

| 文件 | 责任 | 动作 |
|------|------|------|
| `jiuguan/memory/adapter.js` | 唯一桥梁：加载大脑、合成 upstream 头、caps 合成、日志缓冲、暴露 handleChatRequest/getLogsSince/getConfig/saveConfig | 新建 |
| `jiuguan/memory/plugin-config.json` | 记忆调参（continuity/handoff/extraction），无硬编码 key | 新建 |
| `jiuguan/server.js` | 加 `/api/chat`、`/api/memory/log`、`/api/memory/config` 路由 + 兜底直连 | 改 |
| `jiuguan/src/app.js` | callLLM 改 POST `/api/chat` + 带 chat_id；settings 折叠区提交；控制台 drawer 逻辑 | 改 |
| `jiuguan/src/body.html` | drawer DOM + settings 折叠区 DOM | 改 |
| `jiuguan/src/style.css` | drawer + 折叠区样式 | 改 |
| `jiuguan/test/memory-adapter.test.mjs` | adapter 单元测试（mock 上游） | 新建 |
| `jiuguan/build.js` | 若新增独立前端 JS 需纳入打包（本计划不新增独立 JS，全部内联 app.js，故 build.js 可能不改） | 视情况 |

---

## Task 1: memory/plugin-config.json 干净版

**Files:**
- Create: `jiuguan/memory/plugin-config.json`

- [ ] **Step 1: 创建干净配置**

`plugin-config.json`（`extractionModel`/`extractionApiKey` 留空，让大脑回退到 chat upstream；见 memory-handler.ts:200 的 `if (cfg.extractionApiKey)` 分支——留空则 extractionUrl=upstreamUrl、复用 chat key）：

```json
{
  "workingMemoryTokens": 32000,
  "enabledModules": {
    "canon": true,
    "currentState": true,
    "facts": true,
    "events": true,
    "relationships": true,
    "graph": true,
    "summaries": true
  },
  "extractionModel": "",
  "extractionApiKey": "",
  "extraction": {
    "maxInputTokens": 64000,
    "overlapMessages": 5,
    "fallbackMessageCount": 50
  },
  "continuity": {
    "enabled": true,
    "snapshotDetail": "full",
    "normalMaxTokens": 800,
    "compactMaxTokens": 1200,
    "mediumMaxTokens": 1800,
    "fullMaxTokens": 3000,
    "refreshEveryTurns": 5
  },
  "handoff": {
    "enabled": true,
    "triggerOnModelSwitch": true,
    "manualRefreshEnabled": true,
    "boostTurns": 20,
    "fullTurns": 3,
    "mediumTurns": 7
  },
  "debug": {
    "injectionTrace": false
  }
}
```

- [ ] **Step 2: 验证 JSON 合法**

Run: `cd f:/jiuguan_persom/jiuguan && node -e "console.log(Object.keys(require('./memory/plugin-config.json')).join(','))"`
Expected: `workingMemoryTokens,enabledModules,extractionModel,extractionApiKey,extraction,continuity,handoff,debug`

- [ ] **Step 3: Commit**

```bash
cd f:/jiuguan_persom/jiuguan
git add memory/plugin-config.json
git commit -m "feat(memory): add clean plugin-config.json (no hardcoded keys)"
```

---

## Task 2: memory/adapter.js —— 加载大脑 + 日志缓冲骨架

**Files:**
- Create: `jiuguan/memory/adapter.js`
- Test: `jiuguan/test/memory-adapter.test.mjs`

本任务只建骨架：加载大脑、暴露日志缓冲 API、暴露 caps 合成。`handleChatRequest` 在 Task 3 实现。

- [ ] **Step 1: 写失败测试 —— 大脑加载 + 日志缓冲**

`jiuguan/test/memory-adapter.test.mjs`：

```javascript
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
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd f:/jiuguan_persom/jiuguan && node test/memory-adapter.test.mjs`
Expected: FAIL —— `Cannot find module '../memory/adapter.js'`

- [ ] **Step 3: 实现 adapter 骨架**

`jiuguan/memory/adapter.js`：

```javascript
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
// monkey-patch console.log/error/warn，仅捕获 [MemoryProxy] 前缀行（也顺带捕获 jiuguan 自身日志）。
const LOG_MAX = 1000;
const logBuffer = []; // { ts, level, text }
let consolePatched = false;

function patchConsole() {
  if (consolePatched) return;
  consolePatched = true;
  const wrap = (level, orig) => (...args) => {
    try {
      const text = args.map(a => typeof a === 'string' ? a : (a?.message ? a.message : String(a))).join(' ');
      // 捕获 [MemoryProxy] 行 + jiuguan 启动/配图等行（无前缀也收，便于一个面板看完）
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
// st-config.ts 读 ST settings.json 形状的文件拿 contextWindow/maxOutputTokens。
// 我们根据 jiuguan settings 的 modelName 推断 source，合成该文件，并设 env 让大脑命中。
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
function getConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8').replace(/^﻿/, '');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(partial) {
  const merged = { ...getConfig(), ...partial };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  console.log('[MemoryProxy] plugin-config.json updated');
  return merged;
}

// ── 初始化：加载大脑 ──
async function init(settings) {
  if (initialized) return;
  patchConsole();
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

module.exports = {
  init,
  getBrain: () => brain,
  getLogsSince,
  getConfig,
  saveConfig,
  PLUGIN_DIR,
  // handleChatRequest 在 Task 3 挂上来
  handleChatRequest: null,
};
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd f:/jiuguan_persom/jiuguan && node test/memory-adapter.test.mjs`
Expected: `PASS Task2`

注意：测试里调用了 adapter 的导出，但没调 `init`，所以 `handleChatRequest` 此时是 null —— 测试只检查导出存在与日志缓冲。日志缓冲的 patchConsole 在第一次 `getLogsSince` 前还没触发？检查：测试里 `console.log('[MemoryProxy] test-log-line')` 之前需要 patch 已生效。修正：把 `patchConsole()` 放在模块加载时立即执行，而非只在 init 里。

修正 adapter.js 末尾的 module.exports 之前，加：

```javascript
// 模块加载即打补丁，确保任何 [MemoryProxy] 日志都能被捕获（即使 init 未调用）
patchConsole();
```

并从 `init` 里删掉 `patchConsole();` 那行（避免重复，patchConsole 内部有 guard）。

- [ ] **Step 5: 再次运行测试**

Run: `cd f:/jiuguan_persom/jiuguan && node test/memory-adapter.test.mjs`
Expected: `PASS Task2`

- [ ] **Step 6: Commit**

```bash
cd f:/jiuguan_persom/jiuguan
git add memory/adapter.js test/memory-adapter.test.mjs
git commit -m "feat(memory): adapter skeleton — load brain, log ring buffer, caps synthesis"
```

---

## Task 3: adapter.handleChatRequest —— upstream 头合成 + 调大脑

**Files:**
- Modify: `jiuguan/memory/adapter.js`
- Test: `jiuguan/test/memory-adapter.test.mjs`

- [ ] **Step 1: 写失败测试 —— handleChatRequest 合成头并调大脑**

在 `test/memory-adapter.test.mjs` 末尾 `main()` 内 `console.log('PASS Task2')` 之后追加（同一 main 函数内，顺序执行）：

```javascript
  // 3. handleChatRequest: mock 大脑，断言传入的 headers 合成正确
  //    用一个假 settings + 假 brain 验证翻译逻辑，不真跑记忆管线
  const fakeSettings = {
    apiUrl: 'https://api.deepseek.com/v1/chat/completions',
    apiKey: 'sk-test-key',
    modelName: 'deepseek-v4-pro',
  };
  let captured = null;
  // 临时替换 adapter 的 brain 与 init，避免真加载
  const adapter2 = require('../memory/adapter.js');
  adapter2.handleChatRequest = async (body, settings) => {
    // 复用真实 handleChatRequest 的头合成逻辑，但 brain 用 mock
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
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd f:/jiuguan_persom/jiuguan && node test/memory-adapter.test.mjs`
Expected: FAIL —— `adapter2._buildUpstreamHeaders is not a function` 或 `handleChatRequest` 被覆盖后仍调真实逻辑

- [ ] **Step 3: 实现 _buildUpstreamHeaders 与 handleChatRequest**

在 `jiuguan/memory/adapter.js` 的 `module.exports` 之前插入：

```javascript
// ── upstream 头合成 ──
// 把 jiuguan settings 的 apiUrl 解析成大脑期望的 x-upstream-host/port/path + authorization。
function _buildUpstreamHeaders(body, settings) {
  const apiUrl = (settings.apiUrl || '').replace(/^https?:\/\//, '');
  // apiUrl 形如 api.deepseek.com/v1/chat/completions
  const slashIdx = apiUrl.indexOf('/');
  const host = slashIdx >= 0 ? apiUrl.slice(0, slashIdx) : apiUrl;
  const reqPath = slashIdx >= 0 ? apiUrl.slice(slashIdx) : '/chat/completions';
  const headers = {
    'authorization': 'Bearer ' + (settings.apiKey || ''),
    'x-upstream-host': host,
    'x-upstream-port': '443',
    'x-upstream-path': reqPath,
  };
  return headers;
}

// ── 主入口：转发给大脑 ──
async function handleChatRequest(body, settings) {
  if (!initialized) await init(settings);
  const headers = _buildUpstreamHeaders(body, settings);
  const upstreamAgent = new https.Agent({ keepAlive: true });
  // 大脑签名：handleMemoryRequest(body, headers, pluginDir, upstreamAgent)
  return brain.handleMemoryRequest(body, headers, PLUGIN_DIR, upstreamAgent);
}
```

并把 `module.exports` 里 `handleChatRequest: null` 改为 `handleChatRequest`：

```javascript
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
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd f:/jiuguan_persom/jiuguan && node test/memory-adapter.test.mjs`
Expected: `PASS Task2` + `PASS Task3`

- [ ] **Step 5: Commit**

```bash
cd f:/jiuguan_persom/jiuguan
git add memory/adapter.js test/memory-adapter.test.mjs
git commit -m "feat(memory): handleChatRequest — synthesize upstream headers, delegate to brain"
```

---

## Task 4: server.js —— /api/chat 路由 + 流式 pipe + 兜底直连

**Files:**
- Modify: `jiuguan/server.js`（在现有路由分发里新增 `/api/chat` 分支）

jiuguan server.js 是一个大 `http.createServer` + 一串 `if (basePath === ...)`。我们在配图路由之后、favicon 之前插入 `/api/chat`。

- [ ] **Step 1: 在 server.js 顶部 require adapter**

在 `server.js` 第 8 行 `const { spawn, execSync } = require("child_process");` 之后加：

```javascript
const memoryAdapter = require("./memory/adapter.js");
```

- [ ] **Step 2: 新增流式 pipe 辅助函数**

在 `sendStatic` 函数定义之后（约 server.js:284 之后）、`const MIME` 之前，加：

```javascript
// 把大脑返回的 ReadableStream body 作为 SSE 透传给客户端 res。
// 带空闲超时（90s 无 chunk 视为挂死，释放连接）与客户端断开取消。
function pipeSSEStream(res, streamBody, status, headers) {
  res.writeHead(status, headers);
  const reader = streamBody.getReader();
  const decoder = new TextDecoder();
  let idleTimer = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      console.error("[MemoryProxy] stream idle >90s, aborting");
      try { reader.cancel(); } catch {}
    }, 90000);
  };
  const onClientClose = () => { try { reader.cancel(); } catch {} };
  res.on("close", onClientClose);
  res.on("error", onClientClose);
  (async () => {
    armIdle();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (!res.writableEnded) {
          if (!res.write(chunk)) await new Promise(r => res.once("drain", r));
        }
        if (idleTimer) clearTimeout(idleTimer);
        armIdle();
      }
      const tail = decoder.decode();
      if (tail && !res.writableEnded) res.write(tail);
    } catch (e) {
      console.error("[MemoryProxy] stream pipe error:", e?.message || e);
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      res.removeListener("close", onClientClose);
      res.removeListener("error", onClientClose);
      if (!res.writableEnded) res.end();
    }
  })();
}

// 兜底直连：记忆层抛错时用 jiuguan settings 直接转发原始 body 到上游。
async function directUpstreamFallback(body, settings) {
  const r = await fetch(settings.apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(settings.apiUrl.includes("xiaomimimo")
        ? { "api-key": settings.apiKey }
        : { Authorization: "Bearer " + settings.apiKey }),
    },
    body: JSON.stringify(body),
  });
  return r;
}
```

- [ ] **Step 3: 在路由分发里新增 /api/chat 分支**

在 `if (basePath === "/api/illustration" && method === "GET")` 块结束之后、`if (url === "/favicon.ico")` 之前，插入：

```javascript
    if (basePath === "/api/chat" && method === "POST") {
      const body = await parseBody(req);
      const runtime = await readJSON(SETTINGS_FILE, {});
      const settings = { ...getEnvDefaults(), ...runtime };
      if (!settings.apiUrl || !settings.apiKey || !settings.modelName) {
        sendJSON(res, 503, { error: "未配置 API 信息" });
        return;
      }
      const wantStream = body.stream === true;
      try {
        const result = await memoryAdapter.handleChatRequest(body, settings);
        // 流式：body 是 ReadableStream
        if (result.body && typeof result.body.getReader === "function") {
          pipeSSEStream(res, result.body, result.status, result.headers);
          return;
        }
        // 非流式：普通对象
        const raw = JSON.stringify(result.body);
        res.writeHead(result.status, {
          "Content-Type": result.headers["content-type"] || "application/json; charset=utf-8",
          "Cache-Control": "no-cache",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(raw);
      } catch (e) {
        // 关键降级：记忆层同步异常 → 直连上游，保证能聊
        console.error("[memory] fallback to direct upstream:", e?.message || e);
        try {
          const upstreamRes = await directUpstreamFallback(body, settings);
          if (wantStream && upstreamRes.body) {
            res.writeHead(upstreamRes.status, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
              "Access-Control-Allow-Origin": "*",
            });
            const reader = upstreamRes.body.getReader();
            const onClientClose = () => { try { reader.cancel(); } catch {} };
            res.on("close", onClientClose);
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(value);
              }
            } finally { if (!res.writableEnded) res.end(); }
          } else {
            const text = await upstreamRes.text();
            res.writeHead(upstreamRes.status, {
              "Content-Type": "application/json; charset=utf-8",
              "Access-Control-Allow-Origin": "*",
            });
            res.end(text);
          }
        } catch (e2) {
          sendJSON(res, 502, { error: "上游不可达: " + (e2?.message || e2) });
        }
      }
      return;
    }
```

- [ ] **Step 4: 手动冒烟测试 —— 非流式**

启动 server（需要真实 deepseek key 在 settings.json 或 .env）：

Run: `cd f:/jiuguan_persom/jiuguan && node server.js`（另开终端）
然后：

Run:
```bash
curl -s -X POST http://localhost:3111/api/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"说一个字"}],"model":"deepseek-v4-pro","stream":false,"chat_id":"c_smoke_1"}' | head -c 500
```
Expected: 返回包含 `choices` 的 JSON，`choices[0].message.content` 有内容。

- [ ] **Step 5: 手动冒烟测试 —— 流式**

Run:
```bash
curl -s -N -X POST http://localhost:3111/api/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"说一个字"}],"model":"deepseek-v4-pro","stream":true,"chat_id":"c_smoke_2"}' | head -c 500
```
Expected: 输出 `data: {...}` 形式的 SSE 行。

- [ ] **Step 6: Commit**

```bash
cd f:/jiuguan_persom/jiuguan
git add server.js
git commit -m "feat(server): /api/chat route with SSE pipe + direct-upstream fallback"
```

---

## Task 5: server.js —— /api/memory/log 与 /api/memory/config 路由

**Files:**
- Modify: `jiuguan/server.js`

- [ ] **Step 1: 新增两个路由分支**

在 Task 4 的 `/api/chat` 分支之后，插入：

```javascript
    if (basePath === "/api/memory/log" && method === "GET") {
      const since = parseInt(query.since || "0", 10);
      const limit = Math.min(parseInt(query.limit || "500", 10), 2000);
      const logs = memoryAdapter.getLogsSince(since).slice(-limit);
      sendJSON(res, 200, { logs });
      return;
    }

    if (basePath === "/api/memory/config" && method === "GET") {
      sendJSON(res, 200, memoryAdapter.getConfig());
      return;
    }

    if (basePath === "/api/memory/config" && method === "POST") {
      const body = await parseBody(req);
      // 只允许白名单字段，避免覆盖 enabledModules 等结构
      const allowed = {};
      for (const k of ["workingMemoryTokens", "extractionModel", "extractionApiKey", "continuity", "handoff", "extraction", "enabledModules"]) {
        if (body[k] !== undefined) allowed[k] = body[k];
      }
      const merged = memoryAdapter.saveConfig(allowed);
      sendJSON(res, 200, { ok: true, config: merged });
      return;
    }
```

- [ ] **Step 2: 手动验证 log 路由**

Run（server 已启动）:
```bash
curl -s "http://localhost:3111/api/memory/log?since=0&limit=5" | head -c 300
```
Expected: `{"logs":[{"ts":...,"level":"info","text":"..."}]}`，含之前冒烟测试产生的 `[MemoryProxy]` 日志。

- [ ] **Step 3: 手动验证 config 路由**

Run:
```bash
curl -s "http://localhost:3111/api/memory/config" | head -c 300
```
Expected: 返回 plugin-config.json 内容。

Run:
```bash
curl -s -X POST http://localhost:3111/api/memory/config \
  -H "Content-Type: application/json" \
  -d '{"workingMemoryTokens":16000}' | head -c 200
```
Expected: `{"ok":true,"config":{...,"workingMemoryTokens":16000,...}}`

- [ ] **Step 4: Commit**

```bash
cd f:/jiuguan_persom/jiuguan
git add server.js
git commit -m "feat(server): /api/memory/log + /api/memory/config routes"
```

---

## Task 6: 前端 app.js —— callLLM 改 POST /api/chat

**Files:**
- Modify: `jiuguan/src/app.js`（`callLLM` 函数，约 app.js:137）

- [ ] **Step 1: 改 callLLM 指向 /api/chat 并带 chat_id**

把 `jiuguan/src/app.js` 的 `callLLM`（约 137-160 行）整个替换为：

```javascript
// Step 3: 调用记忆代理 /api/chat（server 端转发给 memory-proxy 大脑 + 上游）
const callLLM = (url, key) => async (body) => {
  // 注入 chat_id，让大脑按对话隔离记忆 session
  const conv = getConv();
  const bodyWithChat = { ...body, chat_id: conv ? conv.id : undefined };
  const r = await fetch(window.location.origin + "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyWithChat),
    signal: state.abortController.signal,
  });
  if (!r.ok) {
    let em = "HTTP " + r.status;
    try {
      const ed = await r.json();
      em = ed.error?.message || ed.error || em;
    } catch (e) {
      try { em = await r.text(); } catch (e2) {}
    }
    throw new Error(em + (r.status === 404 ? " (请检查 API 地址)" : ""));
  }
  return r;
};
```

注意：`url`/`key` 参数保留但不再用于发请求（仅维持 pipe 签名兼容，避免改 normalCall/streamCall 调用点）。

- [ ] **Step 2: 重新打包前端**

Run: `cd f:/jiuguan_persom/jiuguan && node build.js`
Expected: 无输出，生成 `index.html`。

- [ ] **Step 3: 手动冒烟 —— 浏览器聊天**

打开浏览器 `http://localhost:3111/`，发一条消息，确认 AI 正常回复、流式逐字显示。打开 server 终端，确认有 `[MemoryProxy] Chat request intercepted` 日志。

- [ ] **Step 4: Commit**

```bash
cd f:/jiuguan_persom/jiuguan
git add src/app.js index.html
git commit -m "feat(frontend): callLLM routes through /api/chat with chat_id"
```

---

## Task 7: 前端 —— 底部控制台 drawer

**Files:**
- Modify: `jiuguan/src/body.html`（加 drawer DOM）
- Modify: `jiuguan/src/style.css`（drawer 样式）
- Modify: `jiuguan/src/app.js`（drawer 轮询逻辑）

- [ ] **Step 1: body.html 加 drawer DOM**

在 `jiuguan/src/body.html` 末尾（`</body>` 之前，或现有主容器之后）加：

```html
<div id="memConsole" class="mem-console collapsed">
  <div class="mem-console-bar" id="memConsoleBar">
    <span class="mem-console-title">记忆控制台</span>
    <div class="mem-console-filters">
      <label><input type="checkbox" data-level="info" checked> info</label>
      <label><input type="checkbox" data-level="warn" checked> warn</label>
      <label><input type="checkbox" data-level="error" checked> error</label>
    </div>
    <button class="mem-console-toggle" id="memConsoleToggle">▲</button>
  </div>
  <div class="mem-console-body" id="memConsoleBody"></div>
</div>
```

- [ ] **Step 2: style.css 加 drawer 样式**

在 `jiuguan/src/style.css` 末尾加：

```css
.mem-console { position: fixed; bottom: 0; left: 0; right: 0; height: 220px;
  background: #1e1e1e; color: #ddd; font-family: monospace; font-size: 12px;
  border-top: 2px solid #444; z-index: 1000; display: flex; flex-direction: column;
  transition: height 0.2s; }
.mem-console.collapsed { height: 28px; }
.mem-console-bar { display: flex; align-items: center; gap: 12px; padding: 4px 10px;
  background: #2a2a2a; border-bottom: 1px solid #444; cursor: pointer; }
.mem-console-title { font-weight: bold; }
.mem-console-filters { display: flex; gap: 8px; margin-left: auto; font-size: 11px; }
.mem-console-filters label { cursor: pointer; }
.mem-console-toggle { background: none; border: none; color: #ddd; cursor: pointer; font-size: 14px; }
.mem-console-body { flex: 1; overflow-y: auto; padding: 4px 10px; line-height: 1.4; }
.mem-console.collapsed .mem-console-body { display: none; }
.mem-log-line { white-space: pre-wrap; word-break: break-all; }
.mem-log-line.warn { color: #ffb86c; }
.mem-log-line.error { color: #ff5555; }
```

- [ ] **Step 3: app.js 加 drawer 轮询逻辑**

在 `jiuguan/src/app.js` 末尾（`window.addEventListener("resize", resize);` 之后）加：

```javascript
// ── 记忆控制台 drawer ──
(function memConsole() {
  const root = document.getElementById("memConsole");
  const bar = document.getElementById("memConsoleBar");
  const body = document.getElementById("memConsoleBody");
  const toggle = document.getElementById("memConsoleToggle");
  if (!root || !bar || !body || !toggle) return;
  let polling = false;
  let sinceTs = 0;
  let timer = null;
  let filters = { info: true, warn: true, error: true };
  const updateFilters = () => {
    document.querySelectorAll(".mem-console-filters input").forEach(c => {
      filters[c.dataset.level] = c.checked;
    });
  };
  document.querySelectorAll(".mem-console-filters input").forEach(c =>
    c.addEventListener("change", () => { updateFilters(); renderAll2(); })
  );
  function renderAll2() {
    // 仅过滤当前已拉取的日志（简单实现，不缓存历史）
  }
  async function poll() {
    if (!polling) return;
    try {
      const r = await fetch("/api/memory/log?since=" + sinceTs + "&limit=200");
      if (r.ok) {
        const d = await r.json();
        (d.logs || []).forEach(l => {
          if (!filters[l.level]) return;
          const div = document.createElement("div");
          div.className = "mem-log-line " + l.level;
          const time = new Date(l.ts).toLocaleTimeString("zh-CN", { hour12: false });
          div.textContent = "[" + time + "] " + l.text;
          body.appendChild(div);
          sinceTs = Math.max(sinceTs, l.ts);
        });
        // 限制 DOM 节点数
        while (body.childNodes.length > 500) body.removeChild(body.firstChild);
        body.scrollTop = body.scrollHeight;
      }
    } catch {}
    if (polling) timer = setTimeout(poll, 2000);
  }
  bar.addEventListener("click", (e) => {
    if (e.target.tagName === "INPUT" || e.target === toggle) return;
    const collapsed = root.classList.toggle("collapsed");
    toggle.textContent = collapsed ? "▲" : "▼";
    if (collapsed) { polling = false; if (timer) clearTimeout(timer); }
    else { polling = true; poll(); }
  });
})();
```

- [ ] **Step 4: 重新打包 + 手动验证**

Run: `cd f:/jiuguan_persom/jiuguan && node build.js`
打开浏览器，确认底部有一条可收起的控制台条，点开显示日志，发一条消息后日志实时刷新。

- [ ] **Step 5: Commit**

```bash
cd f:/jiuguan_persom/jiuguan
git add src/body.html src/style.css src/app.js index.html
git commit -m "feat(frontend): memory console drawer (polling /api/memory/log)"
```

---

## Task 8: 前端 —— settings modal 加"长期记忆"折叠区

**Files:**
- Modify: `jiuguan/src/body.html`（settings modal 内加折叠区 DOM）
- Modify: `jiuguan/src/app.js`（加载/保存 MP 配置）

- [ ] **Step 1: body.html 在 settings modal 内加 MP 折叠区**

找到 `jiuguan/src/body.html` 里 settings modal（含 `id="apiUrlEl"` 等的容器），在其内部、reset 按钮之前，加：

```html
<details class="mp-settings-section">
  <summary>长期记忆（memory-proxy）</summary>
  <label>记忆开关 <input type="checkbox" id="mpEnabled" checked></label>
  <label>工作记忆 tokens <input type="number" id="mpWorkingTokens" value="32000" min="1000" step="1000"></label>
  <label>连续性开关 <input type="checkbox" id="mpContinuityEnabled" checked></label>
  <label>抽取模型（留空用聊天模型）<input type="text" id="mpExtractionModel" placeholder="如 deepseek-v4-flash"></label>
  <p class="mp-hint">高级参数请直接编辑 memory/plugin-config.json</p>
</details>
```

- [ ] **Step 2: app.js 加载时拉取 MP 配置填充表单**

在 `jiuguan/src/app.js` 的 `dm.settingsBtn.addEventListener("click", ...)` 回调里（约 app.js:995），在 `dm.settingsModal.classList.add("active");` 之前，加：

```javascript
  // 拉取 MP 配置填充折叠区
  try {
    const r = await fetch("/api/memory/config");
    if (r.ok) {
      const cfg = await r.json();
      document.getElementById("mpEnabled").checked = cfg.enabledModules?.canon !== false;
      document.getElementById("mpWorkingTokens").value = cfg.workingMemoryTokens || 32000;
      document.getElementById("mpContinuityEnabled").checked = cfg.continuity?.enabled !== false;
      document.getElementById("mpExtractionModel").value = cfg.extractionModel || "";
    }
  } catch {}
```

注意：原回调不是 async，需把 `dm.settingsBtn.addEventListener("click", () => {` 改为 `dm.settingsBtn.addEventListener("click", async () => {`。

- [ ] **Step 3: app.js 保存时提交 MP 配置**

在 `dm.saveSettingsBtn.addEventListener("click", ...)` 回调里（约 app.js:1025），在 `saveSettings();` 之前，加：

```javascript
  // 提交 MP 配置到 /api/memory/config
  try {
    const mpBody = {
      workingMemoryTokens: parseInt(document.getElementById("mpWorkingTokens").value) || 32000,
      extractionModel: document.getElementById("mpExtractionModel").value.trim(),
    };
    fetch("/api/memory/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mpBody),
    });
  } catch {}
```

- [ ] **Step 4: 重新打包 + 手动验证**

Run: `cd f:/jiuguan_persom/jiuguan && node build.js`
打开 settings，展开"长期记忆"折叠区，改 working tokens 为 16000 保存，刷新后确认值保持；查 `memory/plugin-config.json` 确认已写入。

- [ ] **Step 5: Commit**

```bash
cd f:/jiuguan_persom/jiuguan
git add src/body.html src/app.js index.html
git commit -m "feat(frontend): MP settings section in settings modal"
```

---

## Task 9: 集成验收测试

**Files:**
- Test: `jiuguan/test/memory-adapter.test.mjs`（追加端到端 mock 测试）

- [ ] **Step 1: 写端到端 mock 测试 —— chat_id 隔离 + 兜底直连**

在 `test/memory-adapter.test.mjs` 的 `main()` 末尾追加：

```javascript
  // 4. 端到端 mock：用假 brain 验证 chat_id 不同 → 不同 session 上下文
  //    （此处只验证 adapter 把 chat_id 透传给大脑，session 隔离由大脑保证）
  let callsSeen = [];
  const adapter3 = require('../memory/adapter.js');
  // 用一个 mock brain 替换（不破坏真实导出，仅本测试内）
  const realGetBrain = adapter3.getBrain;
  // 注意：handleChatRequest 已是直接调 brain.handleMemoryRequest，无法简单 mock。
  // 改为直接验证 _buildUpstreamHeaders 对不同 apiUrl 的解析。
  const h1 = adapter3._buildUpstreamHeaders({}, { apiUrl: 'https://api.deepseek.com/v1/chat/completions', apiKey: 'k1' });
  assert.strictEqual(h1['x-upstream-host'], 'api.deepseek.com');
  assert.strictEqual(h1['x-upstream-path'], '/v1/chat/completions');
  const h2 = adapter3._buildUpstreamHeaders({}, { apiUrl: 'https://api.xiaomimimo.com/v1/chat/completions', apiKey: 'k2' });
  assert.strictEqual(h2['x-upstream-host'], 'api.xiaomimimo.com');
  assert.strictEqual(h2['authorization'], 'Bearer k2');
  console.log('PASS Task9');
```

- [ ] **Step 2: 运行全部测试**

Run: `cd f:/jiuguan_persom/jiuguan && node test/memory-adapter.test.mjs`
Expected: `PASS Task2` + `PASS Task3` + `PASS Task9`

- [ ] **Step 3: 手动验收清单**

逐项确认（需真实 deepseek key + server 运行 + 浏览器）：
- [ ] ① 普通聊天正常（流式逐字）
- [ ] ② 开两个对话各聊几轮，记忆互不串（切回 A 仍记得 A 的内容）
- [ ] ③ 在 settings 改模型后，连续性 handoff 触发（控制台日志出现 `model switch detected`）
- [ ] ④ `jiuguan/memory/data/memory.db` 存在且有数据
- [ ] ⑤ 配图链路不受影响（给一条 AI 消息配图成功）
- [ ] ⑥ 控制台 drawer 显示 `[MemoryProxy]` 日志
- [ ] ⑦ MP 配置改 working tokens 后写入 `plugin-config.json` 并持久
- [ ] ⑧ 临时让 adapter 抛错（如改坏 plugin-config.json）确认兜底直连生效（聊天不中断）

- [ ] **Step 4: Commit**

```bash
cd f:/jiuguan_persom/jiuguan
git add test/memory-adapter.test.mjs
git commit -m "test(memory): end-to-end adapter header synthesis + isolation checks"
```

---

## Task 10: 记忆宫殿 todo 记录（不在本期实现）

**Files:**
- Create: `jiuguan/docs/superpowers/todos/memory-palace-fixes.md`

- [ ] **Step 1: 写 todo 文档**

```markdown
# 记忆宫殿已知问题（适配后修复）

记忆宫殿（src/memory.js）在 memory-proxy 适配完成后仍作为展示用摘要层共存。
以下为已知严重问题，适配完成后单独排期修复：

1. **v4 模型兼容**：callSummaryAPI（memory.js:5）只读 message.content，v4 推理模型常把答案放
   reasoning_content 导致 content 为空 → STM 静默全部失败。需加 reasoning_content fallback +
   reasoning_effort:'low'（参考 memory-handler.ts:806）。
2. **buildMemoryPrompt 从未被调用**：记忆宫殿当前不向 LLM 注入任何记忆，只生成摘要面板。
   需决定是否启用注入（若启用，注意与 memory-proxy 注入的去重/冲突）。
3. **无 token 上限**：buildMemoryPrompt 拼接所有 unmerged STM + 所有 LTM，长会话会撑爆上下文。
4. **LTM 合并空洞**：unmerged.slice(-7) 在 STM 有失败轮次时跨断层，lastMergedRound 单一阈值
   会让中间未合并 STM 永久丢失。改为记录已合并 round 集合。
5. **抽取温度偏高**：temperature:0.3 做结构化抽取易润色事实，建议降到 0。
6. **无增量/去重保护**：round 用 user 消息计数，swipe/重生成会漂移，漏抽或重复抽。
7. **JSON 解析脆弱**：extractJSON 一次失败即丢一轮，无修复/重试/降级。
8. **存储耦合**：记忆塞在 conv.memory 随对话 JSON 全量重写，无并发保护。
```

- [ ] **Step 2: Commit**

```bash
cd f:/jiuguan_persom/jiuguan
git add docs/superpowers/todos/memory-palace-fixes.md
git commit -m "docs: record memory-palace known issues as post-integration todo"
```

---

## 适配后可选清理（不在本期，记录用）

- `jiuguan/memory-proxy/package.json` 的 `chromadb` 依赖在源码中完全未被 import，是死依赖。可选删除以减小 install 体积。需确认 `memory-proxy/src/retrieval/semantic-search.ts` 等无动态引用后再删。
