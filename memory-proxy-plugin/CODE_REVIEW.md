# memory-proxy-plugin Code Review 报告

> **审查日期**：2026-06-18
> **审查方式**：4 维度并行审查（安全 / 正确性 / 架构 / 质量）→ 逐条对抗式验证 → 汇总
> **审查规模**：57 个 agent，~1.68M tokens，53 条原始发现 → 48 条确认 / 5 条驳为误报

---

## 总览

| 严重度 | 数量 |
|--------|------|
| 🔴 Critical | 2（去重后；API key 被 security/quality 两维度各报一次） |
| 🟠 High | 4 |
| 🟡 Medium | 9 |
| 🟢 Low | 28 |
| ⚪ Info（验证为安全/良好实践） | 4 |
| ❌ 误报已驳 | 5 |

---

## 🔴 Critical

### 1. 明文 DeepSeek API Key 已提交进 git
- **位置**：[plugin-config.json:13](plugin-config.json#L13)
- **描述**：含真实可用的 `sk-6e7a599aae0244078408d95f10a98be5`，文件被 git 跟踪（commit 7922cf0）。本地领先 origin/main 36 个提交，一旦 push 永久泄露。验证者确认远端是私有仓库（GitHub 对匿名返回 404），但"私有"不降低严重度。
- **影响**：DeepSeek 账户被冒用、配额耗尽；git 历史即使删除也保留。
- **修复**：① 吊销该 key ② `git rm --cached` + 清洗历史 ③ 加 `.gitignore` ④ 改从环境变量读取。
- **当前处置**：⚠️ 用户已将仓库设为私有且未正式发布，**暂不处理**。

### 2. TLS 私钥被误提交进 `--help/` 目录
- **位置**：[--help/plugins/memory-proxy/key.pem](--help/plugins/memory-proxy/key.pem)
- **描述**：误执行 `node scripts/install-to-st.js --help` 把 `--help` 当成 ST 路径，生成了 key.pem（`-----BEGIN PRIVATE KEY-----`，已被 git 跟踪，commit a238e73）。根因是 [install-to-st.js:11-17](scripts/install-to-st.js#L11-L17) 对 argv 零校验。
- **影响**：私钥泄露；验证者精确指出即便无私钥，`rejectUnauthorized:false`（[plugin.ts:114-117](src/plugin.ts#L114-L117)）本身就允许任何自签证书通过——但私钥提交仍是 critical 级密钥卫生问题。
- **修复**：`git rm -r --help` + 本地重新生成证书（勿提交）+ `*.pem`/`--help/` 加入 `.gitignore` + install 脚本校验 argv 不以 `-` 开头。

---

## 🟠 High

### 3. 插件目录无 `.gitignore`（上述两个 critical 的根因）
- **位置**：[memory-proxy-plugin/](.)
- **描述**：plugin 目录内无 `.gitignore`，`plugin-config.json` 和 `*.pem` 都未被忽略。验证者纠正原发现的夸大：父仓库 `f:/SillyTavern/.gitignore` 已覆盖 `node_modules/` 和 `*.db`（memory.db 安全），**只有 config 和 pem 真正裸露**。
- **修复**：加插件级 `.gitignore`（`plugin-config.json`、`*.pem`、`data/`、`node_modules/`、`--help/`）+ 提供 `plugin-config.example.json` 模板。

### 4. 2 分钟僵尸哨兵短于分块提取时长 → 并发提取
- **位置**：[src/server/memory-handler.ts:364-373, 443-460](src/server/memory-handler.ts#L364-L373)
- **描述**：`__PROCESSING__` 哨兵超时设 2 分钟，但 `last_active_at` 只在 `markExtractionInProgress` 时设一次，分块提取循环（每块 max_tokens 16384）期间**从不心跳**。长对话多块提取轻松超 120s，下一轮消息进来时会误判哨兵为僵尸、清掉并启动**第二个并发提取**，导致重复 facts/events、浪费 token、fingerprint 写竞争。git log 的 469060b 只加了超时，没加心跳。
- **修复**：分块循环里心跳 `last_active_at`（`updateSessionIntegrityHashOnly` 已 import 但未用），或抬高超时阈值，或用内存 JobId 跟踪活任务。

### 5. settings 路径解析错误 → 静默降级到 openai 默认（4096 max_tokens）
- **位置**：[src/adapters/st-config.ts:85-88, 24-31](src/adapters/st-config.ts#L85-L88)
- **描述**：用 `../../../../st_data/...` 强耦合 ST Launcher 布局，非 Launcher 安装会读不到文件；catch（28-30）**无任何告警**地返回 openai 默认。后果：[memory-handler.ts:213-216](src/server/memory-handler.ts#L213-L216) 把用户配置的 max_tokens 静默夹到 4096，DeepSeek 2M 上下文被当 128k 预算——用户看到短回复却以为模型差。
- **修复**：文件缺失时打 warning；搜索多个候选路径；默认能力值用 DeepSeek 级而非 openai 4096。

### 6. 测试套件是红的（6/26 失败）且未覆盖最危险路径
- **位置**：[tests/integration/plugin-lifecycle.test.ts:61-115](tests/integration/plugin-lifecycle.test.ts#L61-L115)
- **描述**：`npx vitest run` 6 失败。验证者纠正根因：真正崩在 [plugin.ts:96](src/plugin.ts#L96) `_app.post(...)` 对 null `_app` 调用（测试传了 `initPlugin(null, ...)`）。更严重的是：哨兵超时逻辑（358-374）、流式捕获（269-297）、真实 https.globalAgent 拦截端到端——**这些最近频繁修的代码零覆盖**。
- **修复**：测试传 mock `_app`（`vi.fn()`）+ 防御性 null-guard `_app`；补哨兵/流式/拦截端到端测试。

---

## 🟡 Medium

### 7. `initPlugin(null)` 在 `_app.post` 崩溃
- **位置**：[src/plugin.ts:96](src/plugin.ts#L96)
- **描述**：生产有真实 Express app 不受影响，但集成测试全红。
- **修复**：测试传 mock `_app`；防御性 `if (_app?.post)`。

### 8. fire-and-forget 异步 DB 调用可在 Node v24 崩溃 ST
- **位置**：[src/server/memory-handler.ts:396, 466, 472, 479](src/server/memory-handler.ts#L396)
- **描述**：`markExtractionInProgress`/`updateSessionExtractionProgress`/`clearExtractionSentinel` 内部 `runAndPersist`（async）未 await，磁盘错误变 unhandled rejection，v24 默认 `--unhandled-rejections=throw` 杀进程。验证者指出 `.catch` 必须加在 session-store 内部（call site 拿不到 promise）。try/catch（478-480）catch 不到 async 的 rejected promise。
- **修复**：在 memory-proxy 的 session-store 内部给 `runAndPersist` 调用加 `.catch` 并 log。

### 9. 流式中途出错时 headers 已发还尝试 502
- **位置**：[src/internal-server.ts:60, 82-84](src/internal-server.ts#L60)
- **描述**：writeHead 后 catch 里 `reply.status(502).send` 失败（headers 已 flush），客户端只收到截断 SSE，Fastify 还报 spurious reply-already-sent。
- **修复**：跟踪 `headersSent`，已发时只 log + `reply.raw.end()`。

### 10. 跨聊天关键词缓存污染
- **位置**：[src/server/memory-handler.ts:50-62](src/server/memory-handler.ts#L50-L62)
- **描述**：`notifyChatId` 清了 keywordCtx 但没清 `refreshPending`，旧聊天的在途 refresh 完成后无条件写回，下一轮把 A 的关键词当 B 的检索查询。验证者精确化：是检索查询被污染（用 A 的关键词查 B 的记忆库），不是字面注入 A 的记忆。自愈需一轮。
- **修复**：加 generation 计数器，refresh 完成前比对 generation，变了就丢弃写回；至少把 `refreshPending` 也置 false。

### 11. 模块级可变单例跨多标签竞态
- **位置**：[src/server/memory-handler.ts:19-20, 50-62](src/server/memory-handler.ts#L19-L20)
- **描述**：`currentChatId`/`extractionCache` 全局共享，多 ST 标签会串聊天。前端已经在发 `generate_data.chat_id`（[frontend/index.js:32](frontend/index.js#L32)），服务器却完全没读它（grep `body.chat_id` 零命中）。
- **修复**：key 所有 session/cache 状态 by chatId（`Map<chatId, ...>`）；服务器读 `body.chat_id` 逐请求解析；去掉模块级 currentChatId。

### 12. memory-handler.ts 492 行上帝函数
- **位置**：[src/server/memory-handler.ts:71-263, 314-483](src/server/memory-handler.ts#L71-L263)
- **描述**：6+ 职责揉在一起，提取状态机（最近 bug 集中区）埋在请求处理器里，难单测。
- **修复**：拆 ConfigService / SessionResolver / KeywordService / ExtractionScheduler。

### 13. 兄弟包耦合在 dev/install 间分裂
- **位置**：[scripts/install-to-st.js:84-112](scripts/install-to-st.js#L84-L112)（also tsconfig.json:13-15; memory-handler.ts:334-335）
- **描述**：dev 用 `file:`+tsconfig paths，install 用内联 `.ts`+合成 `exports`（`'./*': './*.ts'` 硬编码 `.ts`）。memory-proxy 一改导出形状就在首次提取时才崩（而非安装时）。
- **修复**：memory-proxy 出真构建（tsc dist + 正确 exports）；或加 post-install smoke require 所有 specifier。

### 14. 生产用 tsx/cjs 运行时加载 .ts
- **位置**：[index.js:10-18](index.js#L10-L18)
- **描述**：加载失败静默返回 no-op 插件，用户看到聊天正常但零记忆、ST UI 无任何错误。
- **修复**：出 dist 构建并在失败时 throw（而非 no-op）。

### 15. 前端静默吞掉 /set-chat-id 失败
- **位置**：[frontend/index.js:11](frontend/index.js#L11)
- **描述**：catch 无日志无重试，notify 失败时 currentChatId 停在旧聊天，下条请求解析到错误 session。
- **修复**：至少 log 失败；更好重试一次；服务器用 `body.chat_id` 交叉校验 currentChatId。

---

## 🟢 Low（28 条，按主题归纳）

### 安全
- **SSRF**（验证者从 medium 下调）：`x-upstream-host/port/path` 头未校验（[memory-handler.ts:89-92](src/server/memory-handler.ts#L89-L92)、[internal-server.ts:97-99](src/internal-server.ts#L97-L99)），但仅绑 127.0.0.1 + scheme 固定 https，远端不可达。建议加 TARGET_HOSTS 白名单。
- **`/set-chat-id` 无鉴权 + chatId 无校验**：[plugin.ts:96-105](src/plugin.ts#L96-L105) ST 暴露 LAN 时可被远程劫持 sessionKey。验证者驳掉 SQL 注入部分（SHA-256 + 参数化）。建议加长度/字符集校验。
- **install 脚本 shell 注入**：[install-to-st.js:50-53](scripts/install-to-st.js#L50-L53) `execSync` 字符串插值，建议 `execFileSync`+argv。同样适用于 [plugin.ts:36-38](src/plugin.ts#L36-L38)。
- **rejectUnauthorized:false + CN-only 无 SAN 证书 + 端口竞态**：[plugin.ts:114-117](src/plugin.ts#L114-L117)。建议 pin 自签证书（自定义 checkServerIdentity），证书加 SAN IP:127.0.0.1。
- **resolveSettingsPath 4 级父遍历脆弱**：[st-config.ts:87](src/adapters/st-config.ts#L87)，建议向上找 ST marker 或接受 ST_ROOT env。

### 正确性 / 性能
- **流式忽略 backpressure + 无 AbortSignal**：[internal-server.ts:69](src/internal-server.ts#L69)、[memory-handler.ts:235](src/server/memory-handler.ts#L235)。客户端断开仍拉完整上游流浪费 token。建议 `await drain` + AbortController on close。
- **TextDecoder 结尾未 flush**：[internal-server.ts:63-68](src/internal-server.ts#L63-L68) 丢末尾 CJK 字符。建议循环后 `decoder.decode()` flush。
- **findFreePort TOCTOU**（出现 3 次）：[internal-server.ts:5-16](src/internal-server.ts#L5-L16)。建议直接 `app.listen({port:0})` 读绑定端口。
- **findFingerprintPosition 返回最后匹配窗口**：兄弟包 incremental.ts:36-42，重复 5 消息窗口会导致漏提取。建议结合 last_message_count 约束搜索。
- **资源泄漏**：cleanup 未 `destroy()` keepAlive agents（[plugin.ts:144-152](src/plugin.ts#L144-L152)）。

### 架构 / 质量
- **浅 spread 合并破坏嵌套配置**：[plugin.ts:88](src/plugin.ts#L88) `keywordRetrieval`/`enabledModules` 被整体替换。
- **死配置**：`enabledModules` 和 `keywordRetrieval` 声明持久化但从不消费（[plugin.ts:61-83](src/plugin.ts#L61-L83)）。
- **config schema 漂移**：plugin.ts 默认值没含 `extraction` 子对象，memory-handler 读 `cfg.extraction.*`（[plugin.ts:59-88](src/plugin.ts#L59-L88)）。
- **每次请求同步重读两个配置文件**：[memory-handler.ts:118-137](src/server/memory-handler.ts#L118-L137)。建议 init 时加载 + 文件 watch/TTL。
- **catch-all 缓冲整个上游响应**：[internal-server.ts:94-144](src/internal-server.ts#L94-L144) 不流式 + 默认 host fallback 可能误路由。
- **fetch `agent` 选项是死代码**：Node v24 原生 fetch（undici）忽略 `agent`，keepAlive 意图落空（但 undici 自带连接池，无功能退化）。
- **bare catch 吞 config 解析错误**：[plugin.ts:87-89](src/plugin.ts#L87-L89) 无日志，与 memory-handler:132 不一致。
- **loadOrGenerateCert 丢弃 openssl 原始错误**：[plugin.ts:45-51](src/plugin.ts#L45-L51)。
- **`any` 泛滥于处理器签名**：internal-server.ts:48 等。建议用 `FastifyRequest`/`FastifyReply` + 窄类型。
- **console.log 热路径刷屏无日志级别**：[memory-handler.ts](src/server/memory-handler.ts) 多处。建议 env-gated logger。
- **magic numbers**：[memory-handler.ts:115-117,159](src/server/memory-handler.ts#L115)、[st-config.ts:40-71](src/adapters/st-config.ts#L40) 缺注释。

---

## ⚪ Info（验证为良好实践，无需改）

- ✅ **globalAgent 劫持范围正确**：[custom-agent.ts:50-64](src/agent/custom-agent.ts#L50-L64) 严格限定 TARGET_HOSTS，非目标主机走原 agent，不会吞其他 API 凭证（有单测验证 api.openai.com 不被拦截）。
- ✅ **无 API key 日志泄露**：grep 确认 console 从不打印 Authorization/apiKey/Bearer，chatId/sessionKey 都截断到 40-50 字符。
- ✅ 真实上游调用用独立 agent 做正常 TLS 校验。

---

## ❌ 5 条误报（对抗验证驳回）

1. **"证书文件无权限硬化"** — 驳：实际是 `execSync('openssl')` 生成，非 fs.write；OpenSSL 3.x 对私钥已 chmod 0600。
2. **"成功提取后 progress 写抛异常会丢指纹触发全量重提"** — 驳：`runAndPersist` 是 async，同步 throw 变 rejected promise 不会被外层 catch 捕获；因果链错误。
3. **"globalAgent 劫持对 fetch/undici 无效，插件静默失效"** — 驳：ST 1.18.0 用 node-fetch v3，它包装 `https.request` 且不传 agent → 落到 globalAgent；拦截实际有效（近期 commit 也证明）。
4. **"流式中断不触发提取"** — 驳：服务器手动 `reader.read()` 循环不调 cancel()，上游跑完仍触发 onEnd。
5. **"getUpstreamAgent 零调用点"** — 驳：单测 custom-agent.test.ts:34 调用了它。

---

## 🔍 审查者补充（workflow 未捕捉）

### `extractionApiKey` 一旦设置就硬编码指向 DeepSeek
- **位置**：[src/server/memory-handler.ts:127-131](src/server/memory-handler.ts#L127-L131)
```ts
if (cfg.extractionApiKey) {
  extractionApiKey = cfg.extractionApiKey;
  extractionUrl = 'https://api.deepseek.com:443';   // 硬编码！
  extractionPath = '/beta/chat/completions';
}
```
- **描述**：MiMo 用户若想用独立提取 key，提取请求仍被强制发往 DeepSeek，且 `extractionModel` 必须是 deepseek 模型。配置项暗示可自由指定，实则与 DeepSeek 强绑定——文档与行为不符。

---

## 处置优先级

1. **立刻**：Critical #2 删 `--help/` + `.gitignore` + install argv 校验（Critical #1 用户暂不处理）
2. **本周**：High #4 哨兵心跳、High #5 settings 路径静默降级、Medium #8 fire-and-forget DB `.catch`、Medium #9 流式 headers-sent
3. **下一步**：High #6 修红测试 + 补危险路径测试、Medium #11 读 `body.chat_id` 解决多标签竞态、Medium #12 拆 memory-handler 上帝函数
