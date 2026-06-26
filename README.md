# jiuguan

`jiuguan` 是一个面向 AI 互动小说 / 酒馆式角色扮演的本地 Web 应用。它以 Node.js HTTP 服务为入口，提供聊天、小说续写、长期记忆、世界书参考、章节分支选项和可选 AI 配图能力。

项目的核心目标是：

- 支持把长篇小说、设定集或世界书作为参考资料，让模型在其基础上继续创作；
- 通过 `memory-proxy` / `memory-proxy-plugin` 注入长期记忆，维持角色、剧情、关系和事件连续性；
- 用 jiuguan Prompt Compiler 锁定输出格式，降低长上下文和记忆注入导致的提示词漂移；
- 每章输出后稳定生成 4 个剧情发展分支，供玩家继续选择。

---

## 功能概览

### AI 小说 / 酒馆式聊天

- 支持多轮对话与本地会话保存。
- 支持流式输出。
- 默认面向 DeepSeek 风格的 Chat Completions API。
- 内置小说章节输出模板：章节标题、正文、分隔线、四个剧情选项。

### 长期记忆系统

项目通过 `memory/adapter.js` 接入 `memory-proxy-plugin`，再由插件调用 `memory-proxy` 的长期记忆能力。

当前记忆链路大致是：

```text
jiuguan /api/chat
  ↓
memory/adapter.js
  ↓
memory-proxy-plugin
  ↓
memory-proxy core
  ↓
上游模型 API
```

记忆系统用于保持：

- 角色状态；
- 人物关系；
- 重要事件；
- 世界设定；
- 长对话中的连续性。

### 世界书 / 整本小说参考

jiuguan 支持用户在开局上传较长文本，例如：

- 整本小说；
- 世界观文档；
- 角色设定；
- 原著剧情；
- 长篇背景资料。

为了避免长文本覆盖系统输出规则，`memory/adapter.js` 中的 Prompt Compiler 会把长文本包装为 reference-only worldbook，并对超长文本做头尾保留式预算裁剪。

默认世界书预算：

```text
JIUGUAN_WORLDBOOK_MAX_CHARS = 48000
```

低于该预算时全文保留；超过时保留头部和尾部，中间省略，防止模型把整本小说当成高优先级指令。

### Prompt Compiler

Prompt Compiler 是 jiuguan 的提示词优先级控制层。

它会把上下文分成以下优先级：

```text
LEVEL 0 输出格式与创作规则
  > 当前玩家任务
  > 世界书参考
  > memory-proxy 记忆 / 连续性上下文
  > 历史对话
```

LEVEL 0 会强制要求每章输出：

1. 章节标题；
2. 小说正文；
3. 分隔线；
4. `【下一步剧情发展推荐选项】`；
5. 正好四个选项：`选项 A`、`选项 B`、`选项 C`、`选项 D`。

### AI 配图

项目可选对接本地 `quick AIdraw`：

- 通过 Node.js 调用 Python 子进程；
- 支持从 AI 回复中提炼绘图 prompt；
- 支持本地绘图引擎；
- 输出图片保存到数据目录下的 `illustrations`。

---

## 技术栈

- Node.js
- CommonJS
- 原生 `http` 服务
- `tsx` 用于加载 TypeScript 插件代码
- `memory-proxy-plugin`
- `memory-proxy`
- 可选 Python 绘图后端

---

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

可以通过 `.env` 或系统环境变量配置。

最小配置示例：

```env
API_URL=https://api.deepseek.com/v1/chat/completions
API_KEY=你的 API Key
MODEL_NAME=deepseek-v4-pro
PORT=3111
```

### 3. 启动服务

```bash
npm start
```

默认访问：

```text
http://localhost:3111
```

---

## 常用环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `PORT` | 服务端口 | `3111` |
| `API_URL` | 上游 Chat Completions API 地址 | 空 |
| `API_KEY` | 上游 API Key | 空 |
| `MODEL_NAME` | 模型名称 | 空 |
| `STREAM` | 是否流式输出，设为 `false` 可关闭 | `true` |
| `REASONING_EFFORT` | 推理强度参数 | 空 |
| `TEMPERATURE` | 采样温度 | 空 |
| `MAX_TOKENS` | 最大输出 token | 空 |
| `TOP_P` | nucleus sampling 参数 | 空 |
| `FREQUENCY_PENALTY` | 频率惩罚 | 空 |
| `PRESENCE_PENALTY` | 存在惩罚 | 空 |
| `JIUGUAN_DATA_DIR` | 数据目录 | `./data` |
| `AIDRAW_DIR` | quick AIdraw 目录 | `../quick AIdraw` |
| `AIDRAW_TIMEOUT_MS` | 本地绘图超时 | `600000` |
| `MEMPROXY_CONTEXT_WINDOW` | memory-proxy 编排上下文预算 | `128000` |
| `MEMPROXY_MAX_OUTPUT_TOKENS` | memory-proxy 输出预算 | `32000` |
| `JIUGUAN_WORLDBOOK_MAX_CHARS` | 上传世界书最大注入字符数 | `48000` |

---

## 项目结构

```text
jiuguan/
├── server.js                    # Node.js 服务入口
├── build.js                     # 前端打包脚本，将 src/* 合并为 index.html
├── index.html                   # 已构建前端页面
├── package.json
├── src/
│   ├── app.js                   # 前端主逻辑
│   ├── body.html                # 前端 HTML 主体
│   ├── memory.js                # 前端记忆面板 / 摘要辅助逻辑
│   ├── style.css                # 前端样式
│   └── system-prompt.js         # jiuguan 小说输出模板
├── memory/
│   ├── adapter.js               # jiuguan 与 memory-proxy-plugin 的桥接层
│   └── plugin-config.json       # memory-proxy-plugin 配置
├── memory-proxy-plugin/         # 长期记忆插件层
├── memory-proxy/                # 长期记忆核心
└── data/                        # 运行时数据目录，默认自动创建
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

需要重新构建 `index.html`：

```bash
node build.js
```

然后重启或刷新页面。

---

## 数据存储

默认运行数据写入：

```text
./data
```

其中包括：

- `settings.json`：运行时模型配置；
- `conversations/`：对话文件；
- `illustrations/`：配图结果；
- `memory-caps.json`：memory-proxy 能力配置。

可通过 `JIUGUAN_DATA_DIR` 改变数据目录。

---

## memory-proxy 配置

主要配置文件：

```text
memory/plugin-config.json
```

常见字段：

- `workingMemoryTokens`：工作记忆预算；
- `enabledModules`：启用的记忆模块；
- `extraction`：记忆提取输入限制；
- `continuity`：连续性快照策略；
- `handoff`：模型切换接手提示策略；
- `debug.injectionTrace`：是否输出注入调试信息。

---

## 世界书使用建议

### 推荐方式

开局上传小说或设定文档，然后在输入框补一句明确任务，例如：

```text
请基于这本小说的世界观、人物关系和文风，创作一个新的互动章节。
```

### 注意事项

- 世界书会被当作参考资料，不会覆盖 jiuguan 的输出格式。
- 如果上传文本特别长，系统会自动保留头部和尾部，中间省略。
- 如果需要更大世界书预算，可以设置：

```env
JIUGUAN_WORLDBOOK_MAX_CHARS=80000
```

不建议无限增大该值，否则会重新引入提示词稀释问题。

---

## 输出格式约束

jiuguan 默认要求模型按以下格式输出：

```text
[章节序号 + 章节标题]

[叙事正文]

---
---

【下一步剧情发展推荐选项】
选项 A：[保守 / 原著型]
选项 B：[戏谑 / 博弈型]
选项 C：[规则 / 修改型]
选项 D：[创新 / xp 增加型]
```

Prompt Compiler 会把该格式作为最高优先级规则，避免被 memory 或 worldbook 覆盖。

---

## AI 配图配置

默认 quick AIdraw 路径：

```text
../quick AIdraw
```

期望结构：

```text
quick AIdraw/
├── python/
│   └── python.exe
└── generate.py
```

可通过环境变量指定：

```env
AIDRAW_DIR=D:\path\to\quick AIdraw
AIDRAW_TIMEOUT_MS=600000
```

---

## 常见问题

### 1. 启动后提示未配置 API 信息

检查：

- `API_URL`
- `API_KEY`
- `MODEL_NAME`

或者在前端设置面板中填写。

### 2. 修改了前端但页面没变化

运行：

```bash
node build.js
```

然后刷新页面。

### 3. 长文本上传后模型忽略四个选项

当前版本已加入 Prompt Compiler 和 worldbook 降权机制。仍出现时，可以：

- 降低 `JIUGUAN_WORLDBOOK_MAX_CHARS`；
- 降低 `MEMPROXY_CONTEXT_WINDOW`；
- 关闭或降低部分 memory 模块预算；
- 检查上传文本中是否包含强命令式 prompt。

### 4. 本地绘图失败

检查：

- `AIDRAW_DIR` 是否正确；
- `python/python.exe` 是否存在；
- `generate.py` 是否可运行；
- 是否超过 `AIDRAW_TIMEOUT_MS`。

---

## 开发说明

当前项目仍偏向本地实验与个人工作流，建议优先保证：

1. `server.js` 的 `/api/chat` 链路稳定；
2. `memory/adapter.js` 不破坏 memory-proxy-plugin 的调用协议；
3. 长文本世界书只作为 reference，不作为 system instruction；
4. 修改 `src/` 后记得重新运行 `node build.js`。

---

## 许可证

当前仓库未声明开源许可证。默认情况下，除非后续补充 LICENSE 文件，否则请按私有项目处理。
