# jiuguan

`jiuguan` 是一个面向 AI 互动小说 / 酒馆式角色扮演的本地 Web 应用。

它的核心目标不是做普通聊天，而是支持长篇 RP、小说续写、世界书参考、长期记忆、剧情连续性和固定章节输出格式。

当前项目已经接入：

- 本地 Node.js Web 服务；
- DeepSeek 风格 Chat Completions API；
- `memory-proxy` / `memory-proxy-plugin` 长期记忆系统；
- Prompt Compiler，用于稳定世界书、记忆、系统提示词之间的优先级；
- 流式输出 watchdog，用于修复剧情分支格式；
- 前端原生 `replace_branch` 支持，用于在流式输出结束时替换错误分支区；
- 可选 quick AIdraw 本地配图能力。

---

## 当前项目定位

`jiuguan` 适合以下场景：

- 把整本小说、世界书、角色设定或长篇背景资料作为参考；
- 让模型在原文世界观和文风基础上进行二创；
- 进行酒馆式角色扮演、互动小说、长线剧情推进；
- 希望模型在每章末尾稳定输出四个剧情发展选项；
- 希望长期记忆记录角色状态、关系、事件、伏笔和世界设定。

它不是一个纯前端聊天 Demo，而是一个本地长期运行型 AI RP 系统。

---

## 当前架构

```text
浏览器前端
  ↓
Node.js server.js
  ↓
memory/adapter.js
  ↓
memory-proxy-plugin
  ↓
memory-proxy core
  ↓
上游 Chat Completions API
```

主要链路说明：

- `server.js`：本地 HTTP 服务入口，默认端口 `3111`。
- `server-start.js`：默认启动入口，会加载 watchdog bootstrap 后再启动服务。
- `server-watchdog-bootstrap.js`：运行时兜底注入前端 stream watchdog patch。
- `src/app.js`：前端主逻辑，当前已原生支持 `replace_branch` 控制事件。
- `memory/adapter.js`：jiuguan 与 memory-proxy-plugin 的桥接层，包含 Prompt Compiler、worldbook 预算、输出 watchdog。
- `memory-proxy-plugin/`：长期记忆插件层，负责 session、关键词、continuity、提取调度和上游请求。
- `memory-proxy/`：长期记忆核心，包括事实、事件、关系、图检索、预算分配等。

---

## 快速开始

### 1. 拉取并安装依赖

```bash
git pull
npm install
```

### 2. 构建前端

```bash
npm run build
```

`npm run build` 会执行 `node build.js`，把 `src/style.css`、`src/body.html`、`src/system-prompt.js`、`src/memory.js`、`src/app.js` 等文件合并到 `index.html`。

### 3. 启动服务

```bash
npm start
```

默认访问：

```text
http://localhost:3111
```

当前 `package.json` 中的脚本为：

```json
{
  "start": "node scripts/patch-app-stream-watchdog.js && node server-start.js",
  "build": "node build.js"
}
```

说明：

- `scripts/patch-app-stream-watchdog.js` 是幂等补丁脚本；如果 `src/app.js` 已经包含原生 stream watchdog，会直接跳过。
- 当前远端 `src/app.js` 已经包含 `JIUGUAN_NATIVE_STREAM_WATCHDOG_V1`，因此补丁脚本主要作为兜底。
- 正常启动请优先使用 `npm start`，不要直接绕过默认启动链路。

---

## API Key 与隐私说明

仓库不应提交任何 API Key、token、私有对话数据或本地运行数据。

当前 `.gitignore` 已忽略：

```text
.env
data/
memory/plugin-config.json
memory-proxy-plugin/plugin-config.json
memory-proxy/.env
memory-proxy/data/
node_modules/
```

建议：

- API Key 只在本地前端设置面板、`.env` 或本地运行配置中填写；
- 不要把 `.env`、`data/`、`plugin-config.json`、运行日志、对话记录提交到 GitHub；
- 公开仓库前，建议再次搜索 `sk-`、`api_key`、`Authorization`、`token` 等关键词；
- 如果误提交过真实密钥，应立即在供应商控制台撤销并重新生成。

README 中不会给出真实 key 示例。需要配置时，请使用本地私有配置。

---

## 常用环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `PORT` | 本地服务端口 | `3111` |
| `JIUGUAN_DATA_DIR` | 运行时数据目录 | `./data` |
| `JIUGUAN_WORLDBOOK_MAX_CHARS` | 上传世界书最大注入字符数 | `48000` |
| `JIUGUAN_OUTPUT_WATCHDOG` | 是否启用输出格式 watchdog | `true` |
| `JIUGUAN_LLM_REPAIR_WATCHDOG` | 是否启用 LLM 二次修复分支 | `true` |
| `JIUGUAN_REPAIR_MAX_TOKENS` | repair 请求最大输出 token | `1200` |
| `MEMPROXY_CONTEXT_WINDOW` | memory-proxy 上下文预算 | `128000` |
| `MEMPROXY_MAX_OUTPUT_TOKENS` | memory-proxy 输出预算 | `32000` |
| `AIDRAW_DIR` | quick AIdraw 目录 | `../quick AIdraw` |
| `AIDRAW_TIMEOUT_MS` | 本地绘图超时 | `600000` |

具体模型地址、模型名、API Key 可以通过前端设置面板或本地环境变量管理，避免写死在源码中。

---

## 输出格式约束

jiuguan 默认要求模型以小说章节形式输出，并在结尾给出固定四类剧情发展推荐选项。

目标格式：

```text
[章节序号 + 章节标题]

[叙事正文]

---
---

【下一步剧情发展推荐选项】
选项 A：[保守/原著型]...
选项 B：[戏谑/博弈型]...
选项 C：[规则/修改型]...
选项 D：[创新/xp增加型]...
```

当前修复重点：

- `src/system-prompt.js` 定义原始四类选项标签；
- `memory/adapter.js` 会读取并校验这些选项标签；
- 如果模型输出的分支不合格，watchdog 会触发 repair 或 fallback；
- 后端会发送 `replace_branch` 控制事件；
- 前端 `src/app.js` 会用 `replaceBranchSection()` 替换尾部 `【下一步剧情发展推荐选项】` 区域，而不是追加第二份分支。

---

## replace_branch 流式修复

旧问题：

```text
模型先流式输出错误分支
最后又追加一个正确分支
```

用户会看到两份分支，体验很差。

当前方案：

```text
正文继续正常流式输出
↓
后端最终校验分支格式
↓
如果不合格，生成替换分支
↓
发送 replace_branch 控制事件
↓
前端只替换尾部分支区
```

当前 `src/app.js` 已原生支持：

```js
{ type: "replace_branch", content: "..." }
```

收到后会执行：

```js
fc = replaceBranchSection(fc, event.content);
```

这意味着正文流式体验保留，尾部分支仍可被最终修正。

---

## Prompt Compiler

Prompt Compiler 是 jiuguan 的提示词优先级控制层。

它的目标是防止：

```text
世界书太长
+ 记忆注入
+ 历史消息过多
→ System Prompt 被稀释
→ 输出格式漂移
```

当前优先级设计：

```text
Level 0：输出格式与创作规则
  > 当前玩家任务
  > 世界书参考
  > memory-proxy 记忆 / continuity
  > 历史对话
```

原则：

- 世界书是 reference，不是高优先级命令；
- 长期记忆是 reference，不得覆盖输出格式；
- 当前玩家任务优先于世界书背景；
- 四个剧情选项格式必须保持稳定。

---

## 世界书 / 整本小说参考

jiuguan 支持开局上传长文本，例如：

- 整本小说；
- 世界观文档；
- 角色设定；
- 原著剧情；
- 长篇背景资料。

为了避免长文本覆盖系统输出规则，Prompt Compiler 会把超长输入包装为 reference-only worldbook，并按预算裁剪。

默认预算：

```text
JIUGUAN_WORLDBOOK_MAX_CHARS = 48000
```

超过预算时采用头尾保留：

```text
保留开头
+
保留结尾
+
省略中间
```

原因：

- 开头通常包含世界观、人物、设定基调；
- 结尾通常包含最近剧情、状态和文风；
- 中间全文逐字注入成本高，且容易稀释系统提示词。

---

## 长期记忆系统

长期记忆由 `memory-proxy-plugin` 与 `memory-proxy` 共同负责。

当前记忆能力包括：

- facts：事实与设定；
- events：剧情事件；
- relationships：人物关系；
- continuity snapshot：连续性快照；
- keyword cache：关键词缓存；
- graph retrieval：图检索；
- token budget：记忆注入预算。

记忆注入目标：

```text
提供剧情连续性
但不覆盖 System Prompt
也不挤占输出格式规则
```

健康状态下，日志中可能看到：

```text
[MemoryProxy] Memory context: ~367 tokens injected
```

这类几百 token 的注入通常是健康范围。

---

## 前端记忆面板说明

`src/memory.js` 当前定位为前端记忆宫殿 / 展示面板 / 摘要辅助逻辑。

注意：

```text
真正注入模型上下文的长期记忆由 memory-proxy 负责。
```

`src/memory.js` 中的 `buildMemoryPrompt()` 当前是备用方案，不是主注入链路。

---

## 记忆抽取与当前已知风险

memory extraction 是后台异步任务。

正常流程：

```text
对话完成
→ 捕获模型回复
→ scheduleExtraction()
→ 提取 facts / events / relationships
→ 写入 memory DB
```

为了避免并发写库，当前实现使用 `__PROCESSING__` sentinel。

如果一个 extraction 正在运行，新一轮 extraction 会看到：

```text
Extraction already in-progress (sentinel is fresh), skipping extraction to avoid concurrency
```

这不代表聊天坏了，也不代表已有记忆不可用。

但如果长期持续出现，说明新记忆写入可能追不上对话速度。

---

## [FIX: memory-extraction-backlog] 待修复项

这是当前下一阶段建议重点处理的问题。

### 问题

当前逻辑是：

```text
extraction running
→ 新 extraction 触发
→ sentinel fresh
→ skip
```

这能避免并发，但被 skip 的新内容没有进入明确队列。

如果用户聊得很快，可能出现：

```text
抽取慢
→ 新内容跳过
→ backlog 变大
→ 下次抽取更慢
→ 长期记忆逐渐滞后
```

### 建议方案

把：

```text
running → skip
```

改成：

```text
running → mark pending
running finished → run catch-up extraction
```

也就是增加一个 pending extraction 机制：

```text
idle + new extraction → running
running + new extraction → pending = true
running complete + pending = false → idle
running complete + pending = true → pending = false → run latest diff again
```

同时，watchdog repair 这类内部格式修复请求不应进入 memory extraction，避免增加抽取压力或污染记忆。

一句话总结：

```text
[FIX: memory-extraction-backlog]
把 memory extraction 从“正在运行就 skip”改成“正在运行就标记 pending，当前任务完成后自动补跑最新差量”，并让 watchdog repair 等内部请求绕过 extraction。
```

当前 README 将该项标记为“待修复 / 下一阶段重点”，不要误认为已经完成。

---

## Keyword Cache 与 Graph Retrieval

当前 memory-proxy-plugin 会为每个 session 维护关键词缓存，减少每轮重新抽取关键词的成本。

典型日志：

```text
getCachedOrRegexKeywords: hasMergedData=false ...
Keyword async refresh: entities=96 keywords=5
refreshKeywordCache: wrote merged data to cache
getCachedOrRegexKeywords: hasMergedData=true ...
```

Graph retrieval 会把 facts、events、relationships 等记忆组织成可检索结构，用于更好地恢复角色关系、事件和状态。

---

## AI 配图

项目可选对接本地 `quick AIdraw`：

- 通过 Node.js 调用 Python 子进程；
- 支持从 AI 回复中提炼绘图 prompt；
- 支持本地绘图引擎；
- 输出图片保存到数据目录下的 `illustrations/`。

默认路径：

```text
../quick AIdraw
```

可通过环境变量指定：

```text
AIDRAW_DIR=本地 quick AIdraw 目录
AIDRAW_TIMEOUT_MS=600000
```

不要把本地模型、私有素材或生成结果提交到仓库。

---

## 项目结构

```text
jiuguan/
├── server.js                         # Node.js 服务入口
├── server-start.js                   # 默认启动入口
├── server-watchdog-bootstrap.js       # 运行时注入 stream watchdog patch 的兜底层
├── build.js                          # 前端打包脚本
├── index.html                        # 已构建前端页面
├── package.json
├── scripts/
│   └── patch-app-stream-watchdog.js   # 幂等前端 stream watchdog 源码补丁
├── src/
│   ├── app.js                         # 前端主逻辑，已原生支持 replace_branch
│   ├── body.html                      # 前端 HTML 主体
│   ├── memory.js                      # 前端记忆宫殿 / 摘要辅助逻辑
│   ├── stream-watchdog-patch.js       # 运行时 stream watchdog patch 兜底
│   ├── style.css                      # 前端样式
│   └── system-prompt.js               # jiuguan 小说输出模板
├── memory/
│   ├── adapter.js                     # jiuguan 与 memory-proxy-plugin 的桥接层
│   └── plugin-config.json             # 本地插件配置，已 gitignore
├── memory-proxy-plugin/               # 长期记忆插件层
├── memory-proxy/                      # 长期记忆核心
└── data/                              # 运行时数据目录，已 gitignore
```

---

## 前端开发

前端源码位于 `src/`。

修改以下文件后：

- `src/style.css`
- `src/body.html`
- `src/system-prompt.js`
- `src/memory.js`
- `src/app.js`
- `src/stream-watchdog-patch.js`

请重新构建：

```bash
npm run build
```

然后重启服务或刷新页面。

---

## 数据存储

默认运行数据写入：

```text
./data
```

其中可能包括：

- 本地设置；
- API 配置；
- 对话记录；
- 记忆数据；
- memory caps；
- 配图结果。

`data/` 已在 `.gitignore` 中忽略，不应提交到 GitHub。

可通过环境变量指定数据目录：

```text
JIUGUAN_DATA_DIR=本地数据目录
```

---

## 常见日志说明

### `Chat request intercepted`

```text
[MemoryProxy] Chat request intercepted — model: deepseek-v4-pro, messages: 92, stream: true
```

说明请求正常进入 memory-proxy。

### `Memory context: ~xxx tokens injected`

说明长期记忆已注入。几百 tokens 通常是健康范围。

### `LLM repair produced replacement branch block`

说明 watchdog 发现原始分支不合格，并生成了替换分支。

### `sent branch replace event`

说明后端已经发送 `replace_branch` 控制事件。当前前端应能原生处理该事件。

### `Extraction already in-progress`

说明已有记忆抽取任务正在运行，新 extraction 为避免并发被跳过。

偶尔出现正常；如果长时间连续出现，则关注 `[FIX: memory-extraction-backlog]`。

---

## 常见问题

### 启动后提示未配置模型

请在前端设置面板中填写模型地址、模型名和 API Key，或使用本地私有环境变量配置。

不要把 API Key 写进源码或提交到 GitHub。

### 修改前端后页面没变化

运行：

```bash
npm run build
```

然后刷新页面。

### 直接 `node server.js` 可以吗？

不推荐。

建议使用：

```bash
npm start
```

因为默认启动链路会先执行幂等补丁，并通过 `server-start.js` / `server-watchdog-bootstrap.js` 加载运行时兜底逻辑。

### 模型还是没有输出四个剧情选项怎么办？

检查日志中是否出现：

```text
[jiuguan-watchdog] stream output failed original option-type check; sent branch replace event
```

如果出现，说明后端已发出替换事件；前端应替换尾部分支。

如果页面仍不替换，请确认：

- 已拉取最新远端；
- 已运行 `npm run build`；
- 使用 `npm start` 启动；
- 浏览器已刷新，不是旧页面缓存。

### 记忆提取一直追不上怎么办？

如果日志长时间连续出现：

```text
Extraction already in-progress (sentinel is fresh), skipping extraction to avoid concurrency
```

说明 extraction 可能落后于对话速度。

这属于当前已知风险，对应待修复项：

```text
[FIX: memory-extraction-backlog]
```

建议后续实现 pending extraction / catch-up runner。

---

## 当前优先级

当前项目已经完成的核心稳定性修复：

1. Prompt Compiler；
2. worldbook reference-only 与预算裁剪；
3. memory token budget；
4. 原始四类剧情分支标签校验；
5. LLM repair + deterministic fallback；
6. 流式 `replace_branch`；
7. 前端原生 `replace_branch` 支持；
8. API Key 与运行时数据从仓库中移除并 gitignore。

下一阶段建议重点：

```text
[FIX: memory-extraction-backlog]
```

也就是让 memory extraction 从“抽取中就 skip”升级为“抽取中标记 pending，完成后自动补跑最新差量”。

---

## 安全提醒

本项目可能处理：

- API Key；
- 私有小说文本；
- 用户对话记录；
- 长期记忆数据库；
- 本地绘图输出；
- 运行日志。

公开仓库前务必确认：

```text
.env 未提交
data/ 未提交
plugin-config.json 未提交
memory-proxy/data/ 未提交
日志未提交
真实 API Key 未提交
```

如果仓库曾经提交过真实密钥，应以“已泄露”处理，立即撤销并重置。
