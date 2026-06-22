# memory-proxy 适配 jiuguan 设计

- 日期：2026-06-22
- 状态：已确认，待写实现计划
- 范围：把 memory-proxy-plugin 的长期记忆大脑（`handleMemoryRequest`）嵌入 jiuguan，使其成为 jiuguan 聊天链路的记忆层；与现有记忆宫殿共存；附带只读控制台与 MP 配置入口。

## 1. 背景与约束

### 1.1 现状

- **memory-proxy**（独立中间件）：Fastify 代理，OpenAI/DeepSeek/MiMo/Claude 多 provider。其 `server/routes.ts` 的抽取是空壳（`llmCall: async () => ''`，注释 "V1: stub for now"），**不能直接用**。
- **memory-proxy-plugin**（ST 插件）：真正的大脑在 `src/server/memory-handler.ts` 的 `handleMemoryRequest`——约 900 行，含指纹增量、`__PROCESSING__` 僵尸哨兵、SWR 关键词、v4 `reasoning_content` fallback、模型切换 handoff、分级超时+连接重试、流式 SSE 捕获。ST 的"壳"（globalAgent 拦截、HTTPS 内部服务、TLS、custom-agent、manual-routes、`/set-chat-id`）全在 `plugin.ts` 的 init 流程里。
- **jiuguan**：浏览器**直发上游**聊天请求（`src/app.js` `callLLM`），server.js 只管存储/配图，不转发聊天。记忆宫殿（`src/memory.js`）生成 STM/LTM 摘要并在消息下方显示面板，但 `buildMemoryPrompt`（往 prompt 注入记忆的函数）**定义了从未被调用**——记忆宫殿当前不向 LLM 注入任何记忆，只做展示。

### 1.2 关键结论

- ST 的壳在 jiuguan 里**够不着**（请求发生在浏览器，不在 Node 进程），`https.globalAgent` 拦截无效。
- 嵌入 jiuguan server 后，大脑 `handleMemoryRequest` 被**直接 require**，ST 壳文件（plugin.ts/internal-server.ts/custom-agent.ts/manual-routes.ts/TLS）**永不加载**——零运行时臃肿。记忆引擎（memory-proxy/*）与 ST 无关，是我们要的核心。
- 唯一 ST 接缝：大脑调 `readStCapabilities(resolveSettingsPath(pluginDir))` 读 ST settings.json 拿上下文窗口/输出上限。jiuguan 里找不到该文件时走 DeepSeek-class 默认（2M/390k），对 deepseek/mimo 恰好对，但每次请求打一条警告且换小窗模型时预算不准。
- 真实成本在 fork：那 900 行微妙逻辑一旦 fork，断绝与上游同步。故**大脑与引擎只读复用，不 fork**。

### 1.3 约束

- memory-proxy 与 memory-proxy-plugin **只读复用，不改源码**（唯一例外：st-config 接缝用零侵入 env 方式处理，仍不改其源码）。
- 记忆宫殿本期**保持只读不动**，作为适配后的 todo 修复其已知严重问题（v4 兼容、token 上限、LTM 空洞）。
- 单进程、单启动命令（`node server.js`），不跑额外 sidecar。
- 配置单一来源：upstream 归 jiuguan settings.json，记忆调参归 `jiuguan/memory/plugin-config.json`。
- 不引入 dashboard、不暴露记忆管理 UI（不做 manual-routes）、不实现 caps 热更新、不动 provider/registry。

## 2. 架构

### 2.1 拓扑

浏览器 → `POST /api/chat`（jiuguan server.js）→ adapter（翻译+加载大脑）→ `handleMemoryRequest`（plugin 大脑）→ 上游 API。记忆 DB 与 plugin-config 落在 `jiuguan/memory/`，caps 合成文件落在 `jiuguan/data/`。

### 2.2 组件与边界

新增/改动文件（全在 jiuguan 内）：

1. **`jiuguan/memory/adapter.js`**（新）—— 唯一的桥。职责：
   - 用 `tsx/cjs` 加载 `jiuguan/memory-proxy-plugin/src/server/memory-handler.ts` 的 `handleMemoryRequest`（对齐 plugin index.js 的加载方式）。
   - 从 jiuguan settings.json 读 apiUrl/apiKey/modelName，解析出 host/port/path，合成 `x-upstream-host/x-upstream-port/x-upstream-path/authorization` 头。
   - `pluginDir` 指向 `jiuguan/memory/`；启动时合成 caps 文件并设 `process.env.MEMPROXY_ST_SETTINGS`。
   - 暴露 `handleChatRequest(body, convId)` 给 server.js，返回 `{status, headers, body}`（与 handleMemoryRequest 同形），流式时 body 是 ReadableStream。
   - 惰性初始化：首次 `/api/chat` 触发大脑 require + DB init。
   - 暴露 `getLogBuffer()` / `getLogsSince(ts)` 供控制台路由用。

2. **`jiuguan/server.js`**（改）：
   - 新增 `POST /api/chat` 路由：`parseBody` → `adapter.handleChatRequest` → 非流式 `sendJSON` / 流式 `writeHead(text/event-stream)` + 逐块 pipe（带 idle 超时与 backpressure，对齐 internal-server.ts 的 read 循环思路，用原生 http res 实现）。
   - 新增 `GET /api/memory/log?since=<ts>&limit=<n>`：返回增量日志。
   - 新增 `GET/POST /api/memory/config`：读/写 `plugin-config.json`。
   - 启动时安装日志环形缓冲（见 2.4）。
   - 兜底直连：adapter 抛同步异常时，server.js 用 jiuguan settings 直连上游转发原始 body，打 `[memory] fallback to direct upstream`。

3. **`jiuguan/src/app.js`**（改）：
   - `callLLM`（app.js:137）改为 POST `/api/chat`，body = 原 `buildRequestBody` 产物 + `chat_id: conv.id`，去掉 Authorization/api-key 头。
   - `buildRequestBody` 基本不变；流式/非流式链路不变（仍消费 SSE）。

4. **`jiuguan/memory/plugin-config.json`**（新，从 memory-proxy-plugin 拷裁）：
   - 保留 continuity/handoff/keyword/extraction 配置块。
   - `extractionModel`/`extractionApiKey` 留空，让大脑回退到 chat 的 upstream+key（memory-handler.ts:200），不硬编码 deepseek key。
   - upstream（url/key/model）不放这里，仍归 settings.json。

5. **`jiuguan/package.json`**（新建；jiuguan 原本无 package.json，是纯 Node 脚本项目）：声明 `tsx` 与 `"memory-proxy-plugin": "file:./memory-proxy-plugin"`（连带引入 `memory-proxy`）依赖，`start` 脚本保持 `node server.js`。

6. **`jiuguan/tsconfig.json`**（新建）—— **adapter 可行性的前提**。plugin 源码用 `require('memory-proxy/storage/db')` 等裸包子路径，但 `memory-proxy` 的 package.json 无 `exports`/`main` 且源文件是 `.ts`，Node 原生解析不到。在 ST 里靠 plugin 自己的 `tsconfig.json` `paths` 映射，但 tsx register 对从不同目录发起的 require 解析不一致。**根 tsconfig.json 的 `paths`**（`{ "memory-proxy": ["./memory-proxy/src/index.ts"], "memory-proxy/*": ["./memory-proxy/src/*"] }`）对所有 require 路径统一生效，已验证能加载 `handleMemoryRequest` + 完整 import 链。adapter 加载大脑前 `require('tsx/cjs')` 注册，tsx 自动发现根 tsconfig。memory-proxy 与 plugin 两份源码零改动。

### 2.2.1 已验证的运行时事实

- `require('tsx/cjs')` + `require('./memory-proxy-plugin/src/server/memory-handler.ts')` 成功导出 `handleMemoryRequest`（function）、`notifyChatId`（function）。
- `require('memory-proxy/storage/db')`、`memory-proxy/session/session-manager`、`memory-proxy/memory/memory-manager` 等子路径经根 tsconfig paths 全部解析到 `.ts` 源。
- `chromadb` 在 memory-proxy/src 与 plugin/src 源码中**完全未被 import**，是 memory-proxy package.json 的死依赖（可选清理，记为 todo，不在本期）。
- npm install 共 280 包，含 tiktoken（native binding）、sql.js（wasm）、fastify、selfsigned 等。

### 2.2.1 两个 mp 的物理布局（方案A）

- `memory-proxy` → `jiuguan/memory-proxy`，`memory-proxy-plugin` → `jiuguan/memory-proxy-plugin`，**保持平级移入**。
- 因此 `memory-proxy-plugin/package.json` 的 `"memory-proxy": "file:../memory-proxy"` 相对路径**仍然有效，不改**。
- 两个 mp 的 `.gitignore` 随目录移入，自动排除 `node_modules/`、`dist/`、`plugin-config.json`、`*.pem`、`data/`、`*.db`、`.env`。
- jiuguan 根 `.gitignore` 补 `node_modules/`（jiuguan 本身将首次装依赖）。
- 两个 mp 源码纳入 jiuguan git 作为依赖源码，单一版本控制源。

6. **前端**（`src/app.js` + `src/body.html` + `src/style.css`）：
   - 通用 settings modal 加"长期记忆"折叠区：记忆开关、workingMemoryTokens、连续性开关、extraction 模型（可选）。提交时记忆字段写 `plugin-config.json`（经 `/api/memory/config`），upstream 仍写 settings.json。
   - 底部常驻 drawer 控制台：轮询 `/api/memory/log`，倒序显示，级别颜色，info/warn/error 过滤。纯文本流，只读不交互。

**不动的**：memory-proxy/ 全部、memory-proxy-plugin/ 全部、记忆宫殿（memory.js + triggerMemoryUpdate + 面板）、配图链路、callDeepSeek（配图提示词，不走记忆）。

### 2.3 数据流

一次 `sendMsg`：

1. 浏览器 POST `/api/chat`，body = buildRequestBody 产物 + `chat_id: conv.id`，无 auth 头。
2. server.js `parseBody` → `adapter.handleChatRequest(body)`。
3. adapter 读 settings.json 合成 upstream 头，`pluginDir=jiuguan/memory/`，调 `handleMemoryRequest(body, headers, pluginDir, upstreamAgent)`。
4. 大脑：`body.chat_id`（=conv.id）→ session；连续性/关键词/装配/转发上游/流式捕获/异步抽取全走原逻辑。
5. adapter 返回 `{status, headers, body}`；server.js 非流式 `sendJSON`，流式 pipe。
6. 抽取异步发生在大脑 `scheduleExtraction`，不阻塞响应。

**会话键**：`chat_id = conv.id`（`c_<ts>_<rand>`，稳定唯一）。一个 jiuguan 对话 = 一个 memory session；切对话 = 切 session，天然隔离，无需 `/set-chat-id`。

### 2.4 caps 合成

adapter 启动（或首次请求）时，根据 jiuguan settings 的 modelName 推断 source（`deepseek*` → deepseek 类，`mimo*` → custom 类），写 `jiuguan/data/memory-caps.json`（ST settings 形状：`{chat_completion_source, deepseek_max_context, deepseek_max_tokens, ...}`），并 `process.env.MEMPROXY_ST_SETTINGS = <该路径>`。st-config 命中该文件、不警告、caps 跟随 jiuguan 实际模型。memory 两个 repo 源码零改动。

### 2.5 日志环形缓冲

server.js 启动时 monkey-patch `console.log/error/warn`，仅捕获 `[MemoryProxy]` 前缀行（也顺手捕获 jiuguan 自己的启动/配图/迁移日志），维护内存最近 1000 条带时间戳。`/api/memory/log?since=<ts>` 返回增量。前端轮询（2s 间隔，drawer 收起时停轮询）。

## 3. 错误处理与降级

- adapter 加载大脑失败（tsx/模块缺失）→ `/api/chat` 返回 503 + 明确错误，不拖垮 jiuguan 其他路由。
- 大脑返回 502（上游超时/连接错）→ 透传给浏览器，前端已有错误展示。
- 流式中途客户端断开 → server.js `req.on('close')`/`res.on('error')` 取消上游 reader，不泄漏连接。
- 记忆 DB 初始化失败 → adapter 首次请求抛错并打日志，不静默吞。
- **关键降级**：adapter 抛同步异常（require 失败、DB 锁死）时，server.js 兜底直连上游（jiuguan settings 的 url/key 直接转发原始 body），打 `[memory] fallback to direct upstream`。保证记忆系统挂了也能聊。

## 4. 与记忆宫殿共存

- memory-proxy 是**唯一**向 LLM prompt 注入长期记忆的（记忆宫殿的 `buildMemoryPrompt` 从未被调用，本期不改）。
- 记忆宫殿 `triggerMemoryUpdate`/面板照常跑，只生成展示用摘要，与 memory-proxy 零交集。
- UI 上记忆面板继续显示，长期记忆由 memory-proxy 隐式注入。
- **适配后 todo（不在本期）**：修复记忆宫殿已知严重问题——v4 `reasoning_content` 兼容、`buildMemoryPrompt` token 上限、LTM 合并空洞。

## 5. 控制台与配置界面

### 5.1 控制台（底部 drawer）

- 常驻可收起，收起时只留细边，展开显示日志流。
- 轮询 `/api/memory/log?since=<ts>`（2s），倒序显示，info/warn/error 过滤，级别颜色。
- 纯文本流，只读，不交互（无清除/手动触发/重置按钮）。
- 收起时停轮询省资源。

### 5.2 MP 配置（并入通用 settings）

- 通用 settings modal 新增"长期记忆"折叠区：记忆开关、workingMemoryTokens、连续性 enabled、extraction 模型（可选）。
- 提交时：记忆字段 → `POST /api/memory/config` → 写 `plugin-config.json`；upstream 字段仍写 settings.json。
- 一个 modal 管所有，符合 jiuguan 现状。想深调高级参数者直接编辑 plugin-config.json。

## 6. 测试

- `test/memory-adapter.test.mjs`：mock 上游，断言：
  - `/api/chat` 非流式返回内容正确。
  - `chat_id` 不同产生不同 session（隔离）。
  - 流式 SSE 能拼回完整文本。
  - adapter 抛错时直连兜底生效。
- 不测记忆引擎内部（memory-proxy 自己的 vitest 覆盖范围）。
- 手动验收清单：① 普通聊天正常 ② 跨对话记忆隔离 ③ 换模型后连续性 handoff ④ 记忆 DB 路径正确 ⑤ 配图链路不受影响 ⑥ 控制台显示 MP 日志 ⑦ MP 配置写入生效。

## 7. 不做的事（YAGNI）

- 不 fork 大脑；不引入 dashboard；不暴露记忆管理 UI；不做 manual-routes；不做 caps 热更新；不动 provider/registry；不做 WebSocket 日志推送；本期不修记忆宫殿。

## 8. 文件清单

| 文件 | 动作 |
|------|------|
| `jiuguan/memory-proxy/` | 移入（自 `../memory-proxy`，源码不动，纳入 git） |
| `jiuguan/memory-proxy-plugin/` | 移入（自 `../memory-proxy-plugin`，源码不动，纳入 git） |
| `jiuguan/memory/adapter.js` | 新增 |
| `jiuguan/memory/plugin-config.json` | 新增（干净版，无硬编码 key，纳入 git） |
| `jiuguan/server.js` | 改（加 /api/chat、/api/memory/log、/api/memory/config、日志缓冲、兜底） |
| `jiuguan/src/app.js` | 改（callLLM→/api/chat、settings 折叠区、控制台 drawer） |
| `jiuguan/src/body.html` | 改（drawer + settings 折叠区 DOM） |
| `jiuguan/src/style.css` | 改（drawer + 折叠区样式） |
| `jiuguan/package.json` | 新建（jiuguan 原本无） |
| `jiuguan/tsconfig.json` | 新建（paths 映射 memory-proxy/* → .ts，adapter 前提） |
| `jiuguan/.gitignore` | 改（补 node_modules/） |
| `jiuguan/test/memory-adapter.test.mjs` | 新增 |
| `jiuguan/build.js` | 可能改（若新前端文件需纳入打包） |
| `jiuguan/src/memory.js` | 不动（适配后 todo） |
