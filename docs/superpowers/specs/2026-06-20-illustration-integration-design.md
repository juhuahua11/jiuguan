# 设计：jiuguan 小说章节配插图（接入 quick AIdraw）

- 日期: 2026-06-20
- 状态: 已批准
- 项目: F:\jiuguan_persom\jiuguan
- 依赖项目: F:\jiuguan_persom\quick AIdraw

## 1. 背景与目标

jiuguan 是一个 AI 小说生成器：Node 服务（`server.js`，端口 3111）serve 由 `src/`（app.js/body.html/style.css/system-prompt.js/memory.js）经 `build.js` 打包的 `index.html`，接 DeepSeek 流式生成小说章节，对话存 `data/conversations/{id}.json`，并有短期/长期记忆系统。

quick AIdraw 是独立便携式 AI 绘画工具，双引擎：云端 XAI Grok（`generate.py` 的 `generate_xai()`）+ 本地 SDXL（`local_gen.py`），自带 Python 运行时（`python/python.exe`）与模型权重。曾为 SillyTavern 做 A1111 桥接（`st_bridge.py`），已移除。

**目标**：AI 生成小说章节后，用户手动决定是否为该章配插图。用户选择提示词来源（LLM 提炼画面 / 原文翻译成英文提示词），可编辑提示词后确认，调用 quick AIdraw 双引擎生成图，嵌入 AI 消息正文末尾。

**非目标**：
- 不做自动配图（每章必配）。
- 不改小说生成链路（`injectSystemPrompt` → `buildRequestBody` → `callLLM`）。
- 不为画图功能单独配 LLM——复用现有 DeepSeek（独立请求，互不污染）。
- 不做实时生成进度反馈（本地 SDXL 慢，仅转圈等待）。

## 2. 方案

采用 **方案 C：generate.py 程序化子命令 + Node spawn**。在 generate.py 向后兼容地新增 `--json` 结构化输出 + 显式引擎选择/回退子命令；jiuguan 的 `server.js` 通过 spawn 调用 quick AIdraw 的 bundled python 执行 generate.py，解析 stdout JSON。

理由：面向 jiuguan 的干净程序化接口；回退逻辑内聚在 Python 侧；generate.py 的交互/CLI 模式完全不受影响（向后兼容）；比 server.js 解析人类可读 stdout 健壮。

否决方案：
- 方案 A（直接复用 generate.py 现有 CLI，靠 stdout 拿路径）——现有 CLI 无自动回退，仍需小改 generate.py，且解析脆弱。
- 方案 B（不改 generate.py，server.js 编排两次 spawn 做回退）——quick AIdraw 零改动，但回退判断靠解析 stdout/退出码，脆弱；本地引擎冷启动慢时回退体验差。

## 3. 架构与数据流

```
jiuguan (Node, :3111)                          quick AIdraw (Python)
┌──────────────────────────────┐               ┌─────────────────────┐
│ index.html (src/app.js 改)   │               │ generate.py (加子命令)│
│  AI消息 🖼按钮 → 弹面板选来源 │               │  --engine/--fallback │
│        ↓                     │               │  --json 结构化输出   │
│  POST /api/illustrate/prompt │──(DeepSeek)──→│ (提炼/翻译提示词)    │
│  POST /api/illustrate/generate│              │                     │
│        │                     │   spawn       │  generate_image()   │
│        └─server.js spawn────→│──────────────→│  cloud→local 回退    │
│                                  ←stdout JSON │  存 --output-dir    │
│  GET /api/illustration?id=…  │               └─────────────────────┘
│   读 data/illustrations/*.png│
└──────────────────────────────┘
```

**一次完整配图流程**：
1. 点 🖼 → 弹面板，选「LLM 提炼」或「原文翻译」
2. `POST /api/illustrate/prompt` `{convId, msgIdx, mode}` → server.js 调 DeepSeek（复用 .env），返回英文提示词
3. 面板显示提示词，用户编辑确认
4. `POST /api/illustrate/generate` `{convId, msgIdx, prompt, engine?, fallback?}` → server.js spawn `generate.py --json --engine cloud --fallback --output-dir <tmp> --quiet "<prompt>"`，stdout 收 JSON `{ok, file, engine, error}`
5. server.js 把图复制到 `data/illustrations/{convId}_{msgIdx}.png`（文件名，convId 与 msgIdx 在文件名中以下划线连接，但读取时通过独立 query 参数传入，不靠切分文件名），对话 JSON 该消息存 `illustration: {path, engine, prompt, createdAt}`
6. 前端正文末尾 `<img src="/api/illustration?conv=convId&idx=msgIdx">` 展示（conv 与 idx 分开传，避免 convId 内置下划线导致切分歧义）

## 4. generate.py 程序化子命令

在 generate.py 现有 CLI 基础上**向后兼容**地新增程序化模式，不碰 interactive/cli_mode 的人类可读逻辑。

**新增 CLI 参数**：
- `--json` — 输出结构化 JSON 到 stdout（取代人类可读 print）
- `--engine cloud|local` — 指定首选引擎（默认 cloud）
- `--fallback` — 首选失败自动转另一个
- `--output-dir <path>` — 输出目录
- `--quiet` — 抑制人类日志，保证 stdout 只有最终 JSON

**新增函数 `generate_image()`**（程序化入口，被 CLI 的 `--json` 分支调用）：
```python
def generate_image(prompt, engine="cloud", fallback=False, output_dir=str(OUTPUT_DIR),
                   aspect_ratio="", seed=-1, model="", resolution="2k") -> dict:
    """返回 {ok:bool, file:str, engine:str, error:str}。首选失败且 fallback 时转另一个。"""
```
- 复用现有 `generate_xai()` 和 `generate_local()`，不重写引擎
- 失败捕获异常，记录 error，按 fallback 决定是否试另一个引擎
- 成功返回文件绝对路径

**CLI 分支**：`cli_mode` 检测 `--json`，走 `generate_image()` 并 `print(json.dumps(result))`。不带 `--json` 时行为完全不变。

**要点**：
- 不引入新依赖
- spawn 时 `PYTHONIOENCODING=utf-8` + `HF_ENDPOINT=hf-mirror.com`（复用 generate_local 已有环境）
- 超时由 server.js 侧控制（本地 SDXL 给 600s）
- generate.py 自行加载 `.env`（XAI_API_KEY），server.js 不需管

## 5. jiuguan server.js 新增接口

spawn 路径常量：默认 `path.join(__dirname, "..", "quick AIdraw", ...)`（python.exe 与 generate.py），可被环境变量 `AIDRAW_DIR` 覆盖。

**`POST /api/illustrate/prompt`** — 生成英文提示词
- body: `{convId, msgIdx, mode}`，mode = `extract`(LLM 提炼) | `translate`(原文翻译)
- 读对话文件，取该条 AI 消息正文；校验 msgIdx 为非负整数且 < 消息数
- 复用 `.env` 的 DeepSeek 配置，发**独立请求**（不碰小说生成链路），非流式：
  - extract: system="你是画面描述专家。读下面这段小说，提炼成一个适合AI绘画的英文画面描述，只输出英文prompt，包含主体、场景、风格、光影。不要解释。" + 正文
  - translate: system="把下面这段中文翻译成适合AI绘画的英文提示词，保留所有视觉细节，只输出英文prompt，不要解释。" + 正文
- 返回 `{prompt}` 或 `{error}`

**`POST /api/illustrate/generate`** — 调画图引擎
- body: `{convId, msgIdx, prompt, engine?, fallback?}`（engine 默认 cloud，fallback 默认 true）
- 校验 convId（`/^[a-zA-Z0-9_-]+$/`）与 msgIdx
- spawn: `python.exe generate.py --json --engine <cloud|local> --fallback --output-dir <tmp> --quiet "<prompt>"`
- 收 stdout，解析 JSON，拿到 `file` 路径
- 先清理该位置旧图（若存在），把图复制到 `data/illustrations/{convId}_{msgIdx}.png`
- 更新对话 JSON：该消息加 `illustration: {path, engine, prompt, createdAt}`
- 返回 `{ok, illustration:{path, engine}}` 或 `{ok:false, error}`

**`GET /api/illustration?conv=...&idx=...`** — 读图
- query: `conv` = convId（校验 `/^[a-zA-Z0-9_-]+$/`），`idx` = msgIdx（非负整数）
- 读 `data/illustrations/{conv}_{idx}.png`，`Content-Type: image/png`，带 ETag 缓存
- 不存在 404

> 注：convId 格式本身含下划线（`c_{时间戳}_{随机}`），文件名虽以 `{convId}_{msgIdx}` 拼接，但读取路径由独立 query 参数 `conv`/`idx` 重新拼出，不靠切分文件名解析。

**spawn 包装**：`runGenerate(args)` Promise，封装 spawn、stdout 收集、stderr 转发到 console、600s 超时、错误退出 reject；prompt 作为参数传递不经 shell。

## 6. 前端 UI（src/app.js + body.html + style.css）

**1. 配图按钮** — `buildMsg()` 里 AI 消息操作按钮组加 🖼：
```js
'<button class="btn-msg-action" data-act="illustrate" title="配图">🖼</button>'
```
点击处理加到现有 `switch(act)`（`src/app.js:607` 附近）。

**2. 配图面板（模态）** — body.html 加 `#illustrateModal`，复用现有模态风格（仿 settingsModal/renameModal）：
- 标题 + 关闭按钮
- 两个单选来源：`○ LLM提炼画面  ○ 原文翻译成提示词`
- 「生成提示词」按钮 → 调 `/api/illustrate/prompt`，结果填入下方文本框
- 提示词文本框（`<textarea>`，可编辑），下方小字显示用了哪种来源
- 「确认生成插图」按钮 → 调 `/api/illustrate/generate`
- 状态文字（生成中…/成功/失败）

**3. 生成中反馈** — 点确认后按钮变「生成中…」禁用 + 转圈 spinner（CSS 动画），简单等待。成功后面板关闭。

**4. 插图展示** — `buildMsg()` 里，若该消息有 `msg.illustration`，在 `.message-content` 后插入：
```html
<div class="message-illustration"><img src="/api/illustration?conv=<convId>&idx=<msgIdx>" loading="lazy"></div>
```
图加载失败显示占位。已有插图的消息，🖼 按钮文案改「换图」（可重配）。

**5. 交互约束**：配图进行中用独立 `state.isIllustrating` 标志禁用配图相关操作，不阻塞小说生成（不同请求，可并行）。

**6. 消息索引**：沿用现有数组 index 作 `msgIdx`。generate 时先清理该位置旧图，避免删/撤回消息导致 index 变化时旧图残留。

**构建**：改完 `src/` 后跑 `node build.js` 重新打包 `index.html`。

## 7. 错误处理、边界与测试

**错误处理**：
- DeepSeek 提示词生成失败 → 面板显示错误，提示词框为空，可重试。不影响小说生成。
- spawn 超时（600s）→ kill 进程，返回 `{ok:false, error:"超时"}`。
- spawn 非零退出 → 解析 generate.py 的 `--json` 错误字段透传。
- 画图引擎双失败 → generate.py 返回 `{ok:false, error:"all engines failed: ..."}`，面板显示。
- 图文件读取 404 → 前端 `<img onerror>` 显示占位。
- bundled python 不存在 → spawn 立即 ENOENT，返回明确错误提示检查 quick AIdraw 路径。

**边界与降级**：
- 仅 AI 消息（`role==="assistant"` 且非 streaming/error）显示配图按钮。
- 提示词来源生成时，若消息正文为空 → 直接报错不调 DeepSeek。
- `convId` 复用现有 `/^[a-zA-Z0-9_-]+$/` 校验；`msgIdx` 必须是非负整数且 < 消息数。
- 路径安全：spawn 的 prompt 作为参数传递（不经 shell）；`--output-dir` 用绝对路径。

**环境假设**：
- jiuguan 与 quick AIdraw 平级目录（`f:/jiuguan_persom/` 下），spawn 路径默认 `../quick AIdraw/`。
- quick AIdraw 的 `.env`（XAI_API_KEY）由 generate.py 自己加载。
- 本地 SDXL 首次冷启动慢（加载 6.5G 模型），转圈等待期间不卡 Node 事件循环（spawn 异步）。

**测试策略**：
- generate.py：`--json` 模式单元测试（mock 引擎，断言回退逻辑、JSON 结构、向后兼容——不带 `--json` 行为不变）。复用 `test_regressions.py` 风格，bundled python 跑。
- server.js：spawn 包装、路径计算、对话 JSON 更新逻辑的单元测试（mock spawn）。
- 前端：手动验收（面板交互、插图展示、换图）。
- 集成：起 jiuguan 服务 + 真实 generate.py，跑一次云端配图（本地 SDXL 视 GPU 情况手动验）。

**验收清单（手动）**：
- [ ] AI 消息显示 🖼 按钮，用户消息不显示。
- [ ] 选「LLM 提炼」生成提示词，可编辑，确认后云端出图嵌入正文末尾。
- [ ] 选「原文翻译」同上。
- [ ] 临时改坏 XAI_API_KEY，确认自动回退本地 SDXL 出图。
- [ ] 刷新页面，已配图的消息仍显示插图。
- [ ] 点「换图」可重新配图覆盖。

## 8. 新增/改动文件

**jiuguan 侧**：
- 改 `server.js` — 新增 3 个接口 + `runGenerate` spawn 包装 + 路径常量
- 改 `src/app.js` — 🖼 按钮、配图面板交互、插图展示、`state.isIllustrating`
- 改 `src/body.html` — `#illustrateModal` 结构
- 改 `src/style.css` — 面板、插图、spinner 样式
- 重新构建 `index.html`（`node build.js`）

**quick AIdraw 侧**：
- 改 `generate.py` — 新增 `generate_image()` + `--json`/`--engine`/`--fallback`/`--output-dir`/`--quiet` CLI 参数（向后兼容）
- 加 `test_programmatic.py`（或并入 `test_regressions.py`）— `--json` 模式单测
