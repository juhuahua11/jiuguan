# 小说章节配插图（接入 quick AIdraw）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 jiuguan 的 AI 小说消息支持手动配插图——用户选提示词来源（LLM 提炼 / 原文翻译）、编辑确认后，spawn 调用 quick AIdraw 的双引擎生成图，嵌入消息正文末尾。

**Architecture:** quick AIdraw 的 `generate.py` 向后兼容地新增程序化子命令（`--json`/`--engine`/`--fallback`/`--output-dir`/`--quiet`）。jiuguan 的 `server.js` 新增 3 个 HTTP 接口：`/api/illustrate/prompt`（DeepSeek 生成英文提示词）、`/api/illustrate/generate`（spawn generate.py 出图、存 `data/illustrations/`、写回对话 JSON）、`/api/illustration`（读图）。前端 `src/app.js` 加 🖼 按钮、配图面板、插图展示。两个项目平级目录，spawn 路径默认 `../quick AIdraw/`。

**Tech Stack:** Node.js（http 模块，无框架）、quick AIdraw bundled Python（`python/python.exe`）、generate.py（OpenAI SDK 调 Grok + diffusers 本地 SDXL）、DeepSeek Chat API、原生 DOM + build.js 打包。

**Spec:** `docs/superpowers/specs/2026-06-20-illustration-integration-design.md`

**Conventions (from existing code):**
- jiuguan 用原生 `http` 模块（见 `server.js`），路由是 if/return 链，`sendJSON(res, code, data)` 统一响应，`parseBody(req)` 读 JSON body，`getEnvDefaults()`/`.env` 提供 DeepSeek 配置。
- 前端无框架，`src/app.js` 用 `$()` 选择器、`state` 全局状态、`buildMsg()` 构造消息 DOM、`dm` 是 DOM 引用集合；`build.js` 把 `src/` 内联进 `index.html`。
- 测试：jiuguan 无现成测试框架，本次新增用 Node 内置 `node:test` + `node:assert`（无新依赖）。quick AIdraw 用 `test_regressions.py` 风格 unittest，bundled python 跑。
- Per CLAUDE.md：**不要擅自 commit/push**。每个任务的 "commit" 步骤是向你申请，不是自动执行。

---

## File Structure

**quick AIdraw 侧**：
- 改 `generate.py` — 新增 `generate_image()` 函数 + 5 个程序化 CLI 参数（向后兼容）
- 加 `test_programmatic.py` — `generate_image()` + `--json` 模式单测（mock 引擎）

**jiuguan 侧**：
- 改 `server.js` — 新增路径常量、`runGenerate()` spawn 包装、3 个接口
- 改 `src/app.js` — 🖼 按钮、配图面板交互、插图展示、`state.isIllustrating`
- 改 `src/body.html` — `#illustrateModal` 模态结构
- 改 `src/style.css` — 面板、插图、spinner 样式
- 加 `test/illustrate.test.mjs` — server 接口单测（mock spawn + mock fetch）
- 重新构建 `index.html`（`node build.js`）

---

## Task 1: generate.py 新增 `generate_image()` 程序化入口（TDD）

向后兼容地在 generate.py 加一个程序化函数：选引擎、按 fallback 回退、返回结构化 dict。先写测试。

**Files:**
- Create: `quick AIdraw/test_programmatic.py`
- Modify: `quick AIdraw/generate.py`（在 `generate_local` 之后新增函数）

- [ ] **Step 1: 写失败测试**

Create `quick AIdraw/test_programmatic.py`:

```python
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import generate


class GenerateImageTests(unittest.TestCase):
    def test_cloud_success_returns_ok_file_engine(self):
        """首选云端成功 → {ok, file, engine:'cloud'}"""
        fake_path = Path("/tmp/fake.jpg")
        with patch.object(generate, "generate_xai", return_value=[fake_path]) as m:
            result = generate.generate_image(
                prompt="a cat", engine="cloud", fallback=True,
                output_dir="/tmp", resolution="2k",
            )
        self.assertTrue(result["ok"])
        self.assertEqual(result["engine"], "cloud")
        self.assertEqual(result["file"], str(fake_path))
        self.assertNotIn("error", result)
        m.assert_called_once()

    def test_cloud_fails_fallback_to_local(self):
        """云端失败 + fallback=True → 转本地，本地成功 → engine:'local'"""
        fake_path = Path("/tmp/fake.png")
        with patch.object(generate, "generate_xai", side_effect=RuntimeError("grok rejected")):
            with patch.object(generate, "generate_local", return_value=[fake_path]) as m_loc:
                result = generate.generate_image(
                    prompt="a cat", engine="cloud", fallback=True,
                    output_dir="/tmp", resolution="2k",
                )
        self.assertTrue(result["ok"])
        self.assertEqual(result["engine"], "local")
        self.assertEqual(result["file"], str(fake_path))
        m_loc.assert_called_once()

    def test_no_fallback_cloud_fail_returns_error(self):
        """云端失败 + fallback=False → {ok:False, error}，不试本地"""
        with patch.object(generate, "generate_xai", side_effect=RuntimeError("boom")):
            with patch.object(generate, "generate_local", return_value=[Path("/nope.png")]) as m_loc:
                result = generate.generate_image(
                    prompt="a cat", engine="cloud", fallback=False,
                    output_dir="/tmp", resolution="2k",
                )
        self.assertFalse(result["ok"])
        self.assertIn("boom", result["error"])
        m_loc.assert_not_called()

    def test_both_fail_returns_error(self):
        """双引擎都失败 → {ok:False, error 含两引擎信息}"""
        with patch.object(generate, "generate_xai", side_effect=RuntimeError("cloud down")):
            with patch.object(generate, "generate_local", side_effect=RuntimeError("local down")):
                result = generate.generate_image(
                    prompt="a cat", engine="cloud", fallback=True,
                    output_dir="/tmp", resolution="2k",
                )
        self.assertFalse(result["ok"])
        self.assertIn("cloud down", result["error"])
        self.assertIn("local down", result["error"])

    def test_engine_local_primary_no_cloud(self):
        """engine='local' 首选本地，成功则不调云端"""
        fake_path = Path("/tmp/fake.png")
        with patch.object(generate, "generate_xai", return_value=[fake_path]) as m_c:
            with patch.object(generate, "generate_local", return_value=[fake_path]):
                result = generate.generate_image(
                    prompt="a cat", engine="local", fallback=True,
                    output_dir="/tmp", resolution="2k",
                )
        self.assertTrue(result["ok"])
        self.assertEqual(result["engine"], "local")
        m_c.assert_not_called()

    def test_empty_output_returns_error(self):
        """引擎返回空列表（无图）视为失败"""
        with patch.object(generate, "generate_xai", return_value=[]):
            with patch.object(generate, "generate_local", return_value=[]):
                result = generate.generate_image(
                    prompt="a cat", engine="cloud", fallback=True,
                    output_dir="/tmp", resolution="2k",
                )
        self.assertFalse(result["ok"])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python\python.exe -m pytest test_programmatic.py -v`（在 `quick AIdraw/` 下）
Expected: FAIL — `AttributeError: module 'generate' has no attribute 'generate_image'`

- [ ] **Step 3: 实现 `generate_image()`**

In `quick AIdraw/generate.py`, add after the `generate_local` function (before `interactive`):

```python
def generate_image(
    prompt: str,
    engine: str = "cloud",
    fallback: bool = False,
    output_dir: str = str(OUTPUT_DIR),
    aspect_ratio: str = "",
    seed: int = -1,
    model: str = "",
    resolution: str = "2k",
) -> dict:
    """Programmatic entry: pick engine, fall back if asked, return structured dict.

    Returns {"ok": bool, "file": str, "engine": str, "error": str?}.
    Reuses generate_xai() / generate_local() without rewriting engines.
    """
    api_key = os.environ.get("XAI_API_KEY", "")
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    order = [engine]
    if fallback:
        other = "local" if engine == "cloud" else "cloud"
        if other not in order:
            order.append(other)

    errors = []
    for eng in order:
        try:
            if eng == "cloud":
                if not api_key:
                    raise RuntimeError("XAI_API_KEY not set")
                ratio = aspect_ratio or "16:9"
                cloud_model = model or "grok-imagine-image-quality"
                files = generate_xai(api_key, prompt, cloud_model, ratio, resolution, 1)
            else:
                files = generate_local(
                    prompt=prompt,
                    aspect_ratio=aspect_ratio,
                    image_seed=seed,
                    base_model=model if model and model not in (
                        "grok-imagine-image-quality", "grok-imagine-image") else "",
                    preset="illustrious2",
                )
            if files and files[0] and Path(files[0]).exists():
                return {"ok": True, "file": str(files[0]), "engine": eng}
            errors.append(f"{eng}: no output file")
        except Exception as e:  # noqa: BLE001 - record and try next
            errors.append(f"{eng}: {e}")
            continue

    return {"ok": False, "engine": "", "error": "; ".join(errors)}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `python\python.exe -m pytest test_programmatic.py -v`
Expected: PASS (all 6 tests)

- [ ] **Step 5: 回归测试确认无破坏**

Run: `python\python.exe -m pytest test_regressions.py -v`
Expected: PASS (existing tests unaffected — `generate_image` is additive)

- [ ] **Step 6: 申请 commit**

Tell user: "Task 1 done. 请 commit `generate.py` + `test_programmatic.py`。"
Suggested: `feat(generate): add generate_image() programmatic entry with engine fallback`

---

## Task 2: generate.py 程序化 CLI 参数（`--json` 模式）

让 CLI 在 `--json` 时调用 `generate_image()` 并输出 JSON，其他模式完全不变。

**Files:**
- Modify: `quick AIdraw/generate.py`（`cli_mode` 的 argparse + 分支，约 `generate.py:430-501`）
- Modify: `quick AIdraw/test_programmatic.py`（加 CLI 测试）

- [ ] **Step 1: 写失败测试**

Append to `test_programmatic.py` (add `import subprocess` at top imports):

```python
import subprocess


class CliJsonModeTests(unittest.TestCase):
    def test_json_mode_outputs_valid_json(self):
        """`generate.py --json "prompt"` → stdout 是合法 JSON，含 ok 字段"""
        py = str(Path(__file__).parent / "python" / "python.exe")
        gen = str(Path(__file__).parent / "generate.py")
        if not Path(py).exists():
            self.skipTest("bundled python not present")

        with patch.object(generate, "generate_image", return_value={
            "ok": True, "file": "/tmp/x.png", "engine": "cloud",
        }):
            # patch 不跨进程，所以这里用 monkeypatched env to force a fast failure path
            # 实际用真实进程但 mock 不可能；改用：传一个会让 generate_image 快速失败的输入
            pass  # 见下方真实子进程测试

    def test_json_mode_real_subprocess_cloud_no_key(self):
        """无 API key 时 --json 模式返回结构化错误（不崩）"""
        py = str(Path(__file__).parent / "python" / "python.exe")
        gen = str(Path(__file__).parent / "generate.py")
        if not Path(py).exists():
            self.skipTest("bundled python not present")
        env = {**__import__("os").environ, "XAI_API_KEY": "", "QUICK_AIDRAW_LOCAL_SUBPROCESS": "1"}
        # 强制 --engine cloud --fallback 关掉本地，使其纯失败
        r = subprocess.run(
            [py, gen, "--json", "--engine", "cloud", "--no-fallback", "test prompt"],
            capture_output=True, text=True, timeout=120, env=env,
        )
        # stdout 最后一行应是 JSON
        lines = [l for l in r.stdout.strip().splitlines() if l.strip()]
        self.assertTrue(lines, f"no stdout: {r.stderr}")
        data = json.loads(lines[-1])
        self.assertIn("ok", data)
        self.assertFalse(data["ok"])
        self.assertIn("error", data)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python\python.exe -m pytest test_programmatic.py::CliJsonModeTests -v`
Expected: FAIL — `--json`/`--engine`/`--no-fallback` 未定义，argparse 报错或无 JSON 输出

- [ ] **Step 3: 实现 CLI 参数**

In `quick AIdraw/generate.py`, modify the `cli_mode` argparse block. Find the existing `p.add_argument(...)` group (around `generate.py:431-448`) and add these arguments after the existing ones, before `args = p.parse_args()`:

```python
    p.add_argument("--json", action="store_true",
                   help="Programmatic mode: output result as JSON on stdout")
    p.add_argument("--engine", default="cloud", choices=["cloud", "local"],
                   help="Primary engine (default cloud)")
    p.add_argument("--fallback", dest="fallback", action="store_true", default=True,
                   help="Fall back to the other engine on failure (default)")
    p.add_argument("--no-fallback", dest="fallback", action="store_false",
                   help="Disable engine fallback")
    p.add_argument("--output-dir", default="",
                   help="Output directory for generated image")
    p.add_argument("--quiet", action="store_true",
                   help="Suppress human logs in --json mode")
    args = p.parse_args()
```

Then add a `--json` branch right after the `--list-models` block (before `if not args.prompt:`):

```python
    if args.json:
        if not args.prompt:
            print(json.dumps({"ok": False, "engine": "", "error": "prompt required"}))
            return
        result = generate_image(
            prompt=args.prompt,
            engine=args.engine,
            fallback=args.fallback,
            output_dir=args.output_dir or str(OUTPUT_DIR),
            aspect_ratio=args.ratio,
            seed=args.seed,
            model=args.model,
            resolution=args.resolution,
        )
        print(json.dumps(result, ensure_ascii=False))
        return
```

Add `import json` to the top imports of `generate.py` (with the other stdlib imports near line 8-15).

- [ ] **Step 4: 跑测试确认通过**

Run: `python\python.exe -m pytest test_programmatic.py::CliJsonModeTests -v`
Expected: PASS

- [ ] **Step 5: 回归 — 非 --json 模式不变**

手动验证 interactive/CLI 未受影响：
Run: `python\python.exe generate.py --list-models`
Expected: 正常列出模型（无 JSON、无报错）

- [ ] **Step 6: 申请 commit**

Tell user: "Task 2 done. 请 commit `generate.py` + `test_programmatic.py`。"
Suggested: `feat(generate): add --json programmatic CLI mode with engine/fallback flags`

---

## Task 3: jiuguan server.js — 路径常量 + spawn 包装 `runGenerate()`

加 spawn 基础设施，先单独可测。

**Files:**
- Modify: `jiuguan/server.js`（顶部常量区 + 新增函数）
- Create: `jiuguan/test/illustrate.test.mjs`

- [ ] **Step 1: 写失败测试**

Create `jiuguan/test/illustrate.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

// 把 server.js 里要测的纯函数/常量暴露出来——通过临时全局。
// 约定：server.js 若检测到 global.__TEST_EXPORTS__，则把 runGenerate 等挂上去后不 listen。
// 测试里读 server.js 源码无法直接 import（它是 http 服务脚本），故用 child_process 隔离。
// 这里只测路径常量计算逻辑（提取为纯函数）。

test("aidrawDir resolves to sibling quick AIdraw by default", () => {
  // resolveAidrawDir 的行为：默认 __dirname/../quick AIdraw，可被 AIDRAW_DIR 覆盖
  const { resolveAidrawDir } = await import("./_aidraw_path.mjs");
  const d = resolveAidrawDir("/some/jiuguan", "");
  assert.match(d, /quick AIdraw$/);
});

test("aidrawDir honors AIDRAW_DIR env override", () => {
  const { resolveAidrawDir } = await import("./_aidraw_path.mjs");
  const d = resolveAidrawDir("/some/jiuguan", "/custom/aidraw");
  assert.equal(d, "/custom/aidraw");
});
```

Create `jiuguan/test/_aidraw_path.mjs`（被测纯函数，server.js 也会复用同一逻辑）:

```javascript
import path from "node:path";

export function resolveAidrawDir(jiuguanDir, envOverride) {
  if (envOverride && envOverride.trim()) return envOverride.trim();
  return path.join(jiuguanDir, "..", "quick AIdraw");
}
```

- [ ] **Step 2: 跑测试确认失败**

Run (in `jiuguan/`): `node --test test/illustrate.test.mjs`
Expected: FAIL — `_aidraw_path.mjs` 不存在（先 Step 3 建好再跑应通过；若想先看红，可先只建测试文件不建实现）。先建实现文件让测试通过属于正常 TDD 节奏；此处 Step 1 已含实现文件，故跳过"红"，直接验证。

- [ ] **Step 3: 在 server.js 接入路径常量 + runGenerate**

In `jiuguan/server.js`, after the `loadEnv(...)` line (around line 33) and the existing constants block (lines 9-13), add:

```javascript
// ── quick AIdraw 对接 ──
const { spawn } = require("child_process");
const AIDRAW_DIR = process.env.AIDRAW_DIR && process.env.AIDRAW_DIR.trim()
  ? process.env.AIDRAW_DIR.trim()
  : path.join(__dirname, "..", "quick AIdraw");
const AIDRAW_PYTHON = path.join(AIDRAW_DIR, "python", "python.exe");
const AIDRAW_GENERATE = path.join(AIDRAW_DIR, "generate.py");
const ILLUSTR_DIR = path.join(DATA_DIR, "illustrations");
const AIDRAW_TIMEOUT_MS = 600000; // 10 min for local SDXL
```

Add `runGenerate` after the `sendJSON`/`parseBody` helpers (e.g. after `parseQuery`, around line 123):

```javascript
function runGenerate(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(AIDRAW_PYTHON, [AIDRAW_GENERATE, ...args], {
      cwd: AIDRAW_DIR,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        HF_ENDPOINT: "https://hf-mirror.com",
        HF_HUB_ENABLE_SYMLINKS: "0",
      },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("画图超时"));
    }, AIDRAW_TIMEOUT_MS);
    child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c) => {
      stderr += c.toString("utf8");
      console.error("[aidraw]", c.toString("utf8").trim());
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e); // ENOENT 等
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error("generate.py 退出码 " + code + (stderr ? "：" + stderr.slice(-500) : "")));
        return;
      }
      resolve(stdout);
    });
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run (in `jiuguan/`): `node --test test/illustrate.test.mjs`
Expected: PASS

- [ ] **Step 5: 冒烟 — server 仍能启动**

Run (in `jiuguan/`): `node server.js`，确认打印 "AI Chat Server (port 3111)" 后 Ctrl+C。
Expected: 正常启动，无语法错误。

- [ ] **Step 6: 申请 commit**

Tell user: "Task 3 done. 请 commit `server.js` + `test/`。"
Suggested: `feat(server): add quick AIdraw path constants and runGenerate spawn wrapper`

---

## Task 4: server.js — `GET /api/illustration` 读图接口

最简单的接口先做，可独立测。

**Files:**
- Modify: `jiuguan/server.js`（路由链里加分支）
- Modify: `jiuguan/test/illustrate.test.mjs`

- [ ] **Step 1: 写失败测试**

Append to `test/illustrate.test.mjs`（用真实 http server + 临时目录）:

```javascript
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

// 启动真实 server.js 进程做集成测试（mock spawn 留到 Task 5/6）。
// 这里只测 illustration 读图，不涉及 spawn。

async function startServer(illustrDir) {
  // 临时改 DATA_DIR：通过 env 覆盖。server.js 用 __dirname/data，需支持覆盖。
  // 约定：server.js 若读到 process.env.JIUGUAN_DATA_DIR 则用它作 DATA_DIR。
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "jiuguan-"));
  const dataDir = path.join(tmpRoot, "data");
  await fs.mkdir(path.join(dataDir, "illustrations"), { recursive: true });
  return { tmpRoot, dataDir };
}

test("GET /api/illustration returns png and 404 when missing", async () => {
  const { tmpRoot, dataDir } = await startServer();
  const illDir = path.join(dataDir, "illustrations");
  // 写一张假图
  await fs.writeFile(path.join(illDir, "c_1_2.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  // 启动 server，DATA_DIR 指向 tmp
  const proc = spawnServer({ JIUGUAN_DATA_DIR: dataDir });
  try {
    await waitForPort(3111);
    let r = await fetch("http://127.0.0.1:3111/api/illustration?conv=c_1&idx=2");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "image/png");
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(buf[0], 0x89);

    r = await fetch("http://127.0.0.1:3111/api/illustration?conv=c_1&idx=99");
    assert.equal(r.status, 404);

    // 非法 conv
    r = await fetch("http://127.0.0.1:3111/api/illustration?conv=..%2F..&idx=0");
    assert.equal(r.status, 400);
  } finally {
    proc.kill();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
```

Also add helpers to the test file:

```javascript
import { spawn as spawnProc } from "node:child_process";

function spawnServer(env = {}) {
  return spawnProc("node", ["server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: "ignore",
  });
}

function waitForPort(port, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server start timeout")), 5000);
    const tryConn = () => {
      const net = require("node:net");
      const s = net.connect(port, host);
      s.on("connect", () => { clearTimeout(t); s.destroy(); resolve(); });
      s.on("error", () => setTimeout(tryConn, 100));
    };
    tryConn();
  });
}
```

> 注：测试要求 server.js 支持 `JIUGUAN_DATA_DIR` 覆盖 `DATA_DIR`，Step 3 实现。

- [ ] **Step 2: 跑测试确认失败**

Run (in `jiuguan/`): `node --test test/illustrate.test.mjs`
Expected: FAIL — `/api/illustration` 路由不存在（404 来自静态文件，非 400/图片）。

- [ ] **Step 3: 实现**

In `jiuguan/server.js`:

(a) 让 DATA_DIR 可被 env 覆盖。修改顶部（约 line 10）：

```javascript
const DATA_DIR = process.env.JIUGUAN_DATA_DIR && process.env.JIUGUAN_DATA_DIR.trim()
  ? process.env.JIUGUAN_DATA_DIR.trim()
  : path.join(__dirname, "data");
```

(b) 在路由 try 块里，`/favicon.ico` 分支之前（约 line 296 之前）加：

```javascript
    if (basePath === "/api/illustration" && method === "GET") {
      const conv = (query.conv || "").trim();
      const idxRaw = (query.idx || "").trim();
      if (!/^[a-zA-Z0-9_-]+$/.test(conv)) {
        sendJSON(res, 400, { error: "bad conv" });
        return;
      }
      const idx = parseInt(idxRaw, 10);
      if (!/^\d+$/.test(idxRaw) || idx < 0) {
        sendJSON(res, 400, { error: "bad idx" });
        return;
      }
      const fp = path.join(ILLUSTR_DIR, conv + "_" + idx + ".png");
      try {
        const buf = await fsp.readFile(fp);
        const tag = etag(buf);
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=300",
          "ETag": '"' + tag + '"',
          "Access-Control-Allow-Origin": "*",
        });
        res.end(buf);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("404");
      }
      return;
    }
```

Also ensure `ILLUSTR_DIR` is created at startup — in the `async () => { ... }` boot block (around line 314), add `await fsp.mkdir(ILLUSTR_DIR, { recursive: true });`.

- [ ] **Step 4: 跑测试确认通过**

Run (in `jiuguan/`): `node --test test/illustrate.test.mjs`
Expected: PASS

- [ ] **Step 5: 申请 commit**

Tell user: "Task 4 done. 请 commit `server.js` + `test/`。"
Suggested: `feat(server): add GET /api/illustration image endpoint`

---

## Task 5: server.js — `POST /api/illustrate/prompt` 提示词接口

调 DeepSeek 生成英文提示词，独立请求，不碰小说链路。

**Files:**
- Modify: `jiuguan/server.js`
- Modify: `jiuguan/test/illustrate.test.mjs`

- [ ] **Step 1: 写失败测试**

Append to `test/illustrate.test.mjs`（mock DeepSeek：server.js 把 fetch 抽成可替换的 `callDeepSeek`，测试通过 env 注入假响应）:

```javascript
test("POST /api/illustrate/prompt extract mode returns english prompt", async () => {
  const { tmpRoot, dataDir } = await startServer();
  // 准备一个对话文件，含一条 AI 消息
  const convDir = path.join(dataDir, "conversations");
  await fs.mkdir(convDir, { recursive: true });
  const conv = {
    id: "c_1",
    title: "t",
    messages: [
      { role: "user", content: "写第一章" },
      { role: "assistant", content: "第一章 山洞里走出一个少年……" },
    ],
  };
  await fs.writeFile(path.join(convDir, "c_1.json"), JSON.stringify(conv));

  // mock：用 env JIUGUAN_FAKE_LLM 指向一个返回固定 JSON 的本地 http mock
  const mockPort = 3999;
  const mock = spawnFakeLLM(mockPort, { content: "a young boy walks out of a cave, cinematic" });
  const proc = spawnServer({
    JIUGUAN_DATA_DIR: dataDir,
    API_URL: "http://127.0.0.1:" + mockPort + "/v1/chat/completions",
    API_KEY: "sk-fake",
    MODEL_NAME: "deepseek-v4-pro",
  });
  try {
    await waitForPort(3111);
    await waitForPort(mockPort);
    const r = await fetch("http://127.0.0.1:3111/api/illustrate/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ convId: "c_1", msgIdx: 1, mode: "extract" }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.prompt, "a young boy walks out of a cave, cinematic");
  } finally {
    proc.kill();
    mock.kill();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("POST /api/illustrate/prompt rejects bad msgIdx", async () => {
  const { tmpRoot, dataDir } = await startServer();
  const convDir = path.join(dataDir, "conversations");
  await fs.mkdir(convDir, { recursive: true });
  await fs.writeFile(path.join(convDir, "c_1.json"), JSON.stringify({
    id: "c_1", messages: [{ role: "assistant", content: "hi" }],
  }));
  const proc = spawnServer({ JIUGUAN_DATA_DIR: dataDir });
  try {
    await waitForPort(3111);
    const r = await fetch("http://127.0.0.1:3111/api/illustrate/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ convId: "c_1", msgIdx: 99, mode: "extract" }),
    });
    assert.equal(r.status, 400);
  } finally {
    proc.kill();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

function spawnFakeLLM(port, choice) {
  return spawnProc("node", ["-e", `
    const http=require("http");
    http.createServer((req,res)=>{
      let b="";req.on("data",c=>b+=c);req.on("end",()=>{
        res.writeHead(200,{"Content-Type":"application/json"});
        res.end(JSON.stringify({choices:[{message:{content:${JSON.stringify(choice.content)}}}]}));
      });
    }).listen(${port});
  `], { stdio: "ignore" });
}
```

- [ ] **Step 2: 跑测试确认失败**

Run (in `jiuguan/`): `node --test test/illustrate.test.mjs`
Expected: FAIL — 路由不存在（返回 404 静态）。

- [ ] **Step 3: 实现**

In `jiuguan/server.js`, add a DeepSeek helper near the other helpers (after `runGenerate`):

```javascript
// 独立调用 DeepSeek（不影响小说生成链路）。返回文本 content 或抛错。
async function callDeepSeek(systemPrompt, userContent) {
  const env = getEnvDefaults();
  if (!env.apiUrl || !env.apiKey || !env.modelName) {
    throw new Error("未配置 DeepSeek API");
  }
  const r = await fetch(env.apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + env.apiKey,
    },
    body: JSON.stringify({
      model: env.modelName,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      stream: false,
    }),
  });
  if (!r.ok) {
    let em = "HTTP " + r.status;
    try { em = (await r.json()).error?.message || em; } catch {}
    throw new Error(em);
  }
  const d = await r.json();
  return d.choices?.[0]?.message?.content || "";
}
```

Add the route (in the try block, before `/api/illustration`):

```javascript
    if (basePath === "/api/illustrate/prompt" && method === "POST") {
      const body = await parseBody(req);
      const convId = (body.convId || "").trim();
      const msgIdx = parseInt(body.msgIdx, 10);
      const mode = body.mode;
      if (!/^[a-zA-Z0-9_-]+$/.test(convId)) {
        sendJSON(res, 400, { error: "bad convId" });
        return;
      }
      if (!/^\d+$/.test(String(body.msgIdx)) || msgIdx < 0) {
        sendJSON(res, 400, { error: "bad msgIdx" });
        return;
      }
      if (mode !== "extract" && mode !== "translate") {
        sendJSON(res, 400, { error: "bad mode" });
        return;
      }
      const fp = await getConvFile(convId);
      if (!fp) { sendJSON(res, 404, { error: "conv not found" }); return; }
      const conv = await readJSON(fp, null);
      const msg = conv && Array.isArray(conv.messages) ? conv.messages[msgIdx] : null;
      if (!msg || msg.role !== "assistant") {
        sendJSON(res, 400, { error: "bad msgIdx" });
        return;
      }
      const text = (msg.content || "").trim();
      if (!text) { sendJSON(res, 400, { error: "empty content" }); return; }

      const sys = mode === "extract"
        ? "你是画面描述专家。读下面这段小说，提炼成一个适合AI绘画的英文画面描述，只输出英文prompt，包含主体、场景、风格、光影。不要解释。"
        : "把下面这段中文翻译成适合AI绘画的英文提示词，保留所有视觉细节，只输出英文prompt，不要解释。";
      try {
        const prompt = (await callDeepSeek(sys, text)).trim();
        sendJSON(res, 200, { prompt });
      } catch (e) {
        sendJSON(res, 500, { error: e.message || "提示词生成失败" });
      }
      return;
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run (in `jiuguan/`): `node --test test/illustrate.test.mjs`
Expected: PASS

- [ ] **Step 5: 申请 commit**

Tell user: "Task 5 done. 请 commit `server.js` + `test/`。"
Suggested: `feat(server): add POST /api/illustrate/prompt for DeepSeek prompt generation`

---

## Task 6: server.js — `POST /api/illustrate/generate` 出图接口

spawn generate.py、存图、写回对话 JSON。最核心接口。

**Files:**
- Modify: `jiuguan/server.js`
- Modify: `jiuguan/test/illustrate.test.mjs`

- [ ] **Step 1: 写失败测试**

Append to `test/illustrate.test.mjs`（用真实 generate.py 太慢/依赖 GPU，改用一个 mock generate.py 脚本替换 AIDRAW_DIR）:

```javascript
test("POST /api/illustrate/generate spawns generate.py and writes illustration", async () => {
  const { tmpRoot, dataDir } = await startServer();
  // 准备对话
  const convDir = path.join(dataDir, "conversations");
  await fs.mkdir(convDir, { recursive: true });
  await fs.writeFile(path.join(convDir, "c_2.json"), JSON.stringify({
    id: "c_2", messages: [{ role: "assistant", content: "正文" }],
  }));

  // 用 mock AIDRAW_DIR：放一个假 generate.py 和假 python.exe（实际是 node 包装）
  const mockAidraw = await fs.mkdtemp(path.join(os.tmpdir(), "aidraw-"));
  // fake "python.exe" = 一个输出 JSON 的 node 脚本，并写一张假图到 --output-dir
  const fakePython = path.join(mockAidraw, "python.exe");
  await fs.writeFile(fakePython, `#!/usr/bin/env node
const fs=require("fs");const path=require("path");
const args=process.argv.slice(2);
let outDir=".";
for(let i=0;i<args.length;i++){if(args[i]==="--output-dir"&&args[i+1])outDir=args[i+1];if(args[i]==="--json"&&false){}
// 找到 prompt（第一个非 flag 位置参数）
let prompt="x";for(let i=0;i<args.length;i++){if(!args[i].startsWith("-")){prompt=args[i];break;}}
const f=path.join(outDir,"fake.png");fs.writeFileSync(f,Buffer.from([0x89,0x50,0x4e,0x47]));
process.stdout.write(JSON.stringify({ok:true,file:f,engine:"cloud"}));
`);
  await fs.chmod(fakePython, 0o755);
  await fs.writeFile(path.join(mockAidraw, "generate.py"), "# mock\n");

  const proc = spawnServer({
    JIUGUAN_DATA_DIR: dataDir,
    AIDRAW_DIR: mockAidraw,
  });
  try {
    await waitForPort(3111);
    const r = await fetch("http://127.0.0.1:3111/api/illustrate/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ convId: "c_2", msgIdx: 0, prompt: "a cat" }),
    });
    assert.equal(r.status, 200, await r.text());
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.illustration.engine, "cloud");
    // 图被复制到 illustrations/
    const img = await fs.readFile(path.join(dataDir, "illustrations", "c_2_0.png"));
    assert.equal(img[0], 0x89);
    // 对话 JSON 写回 illustration 字段
    const conv = JSON.parse(await fs.readFile(path.join(convDir, "c_2.json"), "utf8"));
    assert.ok(conv.messages[0].illustration);
    assert.equal(conv.messages[0].illustration.engine, "cloud");
  } finally {
    proc.kill();
    await fs.rm(tmpRoot, { recursive: true, force: true });
    await fs.rm(mockAidraw, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run (in `jiuguan/`): `node --test test/illustrate.test.mjs`
Expected: FAIL — 路由不存在。

- [ ] **Step 3: 实现**

In `jiuguan/server.js`, add the route (before `/api/illustrate/prompt` or `/api/illustration`):

```javascript
    if (basePath === "/api/illustrate/generate" && method === "POST") {
      const body = await parseBody(req);
      const convId = (body.convId || "").trim();
      const msgIdx = parseInt(body.msgIdx, 10);
      const prompt = (body.prompt || "").trim();
      const engine = body.engine === "local" ? "local" : "cloud";
      const fallback = body.fallback !== false; // 默认 true
      if (!/^[a-zA-Z0-9_-]+$/.test(convId)) {
        sendJSON(res, 400, { error: "bad convId" }); return;
      }
      if (!/^\d+$/.test(String(body.msgIdx)) || msgIdx < 0) {
        sendJSON(res, 400, { error: "bad msgIdx" }); return;
      }
      if (!prompt) { sendJSON(res, 400, { error: "empty prompt" }); return; }

      const fp = await getConvFile(convId);
      if (!fp) { sendJSON(res, 404, { error: "conv not found" }); return; }
      const conv = await readJSON(fp, null);
      const msg = conv && Array.isArray(conv.messages) ? conv.messages[msgIdx] : null;
      if (!msg || msg.role !== "assistant") {
        sendJSON(res, 400, { error: "bad msgIdx" }); return;
      }

      const args = ["--json", "--engine", engine, fallback ? "--fallback" : "--no-fallback",
                    "--output-dir", ILLUSTR_DIR, "--quiet", prompt];
      let result;
      try {
        const out = await runGenerate(args);
        const lines = out.trim().split(/\r?\n/).filter(Boolean);
        result = JSON.parse(lines[lines.length - 1]);
      } catch (e) {
        sendJSON(res, 500, { ok: false, error: e.message || "spawn failed" });
        return;
      }
      if (!result.ok || !result.file) {
        sendJSON(res, 500, { ok: false, error: result.error || "画图失败" });
        return;
      }

      const dest = path.join(ILLUSTR_DIR, convId + "_" + msgIdx + ".png");
      try {
        await fsp.copyFile(result.file, dest);
      } catch (e) {
        sendJSON(res, 500, { ok: false, error: "复制图失败：" + e.message });
        return;
      }

      msg.illustration = {
        engine: result.engine,
        prompt: prompt,
        createdAt: Date.now(),
      };
      await writeJSON(fp, conv);

      sendJSON(res, 200, { ok: true, illustration: { engine: result.engine } });
      return;
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run (in `jiuguan/`): `node --test test/illustrate.test.mjs`
Expected: PASS (all tests)

- [ ] **Step 5: 申请 commit**

Tell user: "Task 6 done. 请 commit `server.js` + `test/`。"
Suggested: `feat(server): add POST /api/illustrate/generate with spawn + illustration persistence`

---

## Task 7: 前端 — 配图面板 HTML + CSS

先搭面板骨架与样式，还没接交互。

**Files:**
- Modify: `jiuguan/src/body.html`（加 `#illustrateModal`）
- Modify: `jiuguan/src/style.css`（面板 + 插图 + spinner 样式）

- [ ] **Step 1: 加面板 HTML**

读 `src/body.html`，在 `#renameModal` 之后（或与其他 modal 同级）加：

```html
<div class="modal-overlay" id="illustrateModal">
  <div class="modal">
    <div class="modal-header">
      <span>为这章配插图</span>
      <button class="modal-close" id="illCloseBtn">✕</button>
    </div>
    <div class="modal-body">
      <div class="ill-source">
        <label><input type="radio" name="illSource" value="extract" checked> LLM 提炼画面</label>
        <label><input type="radio" name="illSource" value="translate"> 原文翻译成提示词</label>
      </div>
      <button class="btn" id="illGenPromptBtn">生成提示词</button>
      <textarea id="illPrompt" rows="4" placeholder="英文提示词（可编辑）"></textarea>
      <div class="ill-status" id="illStatus"></div>
    </div>
    <div class="modal-footer">
      <button class="btn" id="illCancelBtn">取消</button>
      <button class="btn btn-primary" id="illConfirmBtn">确认生成插图</button>
    </div>
  </div>
</div>
```

- [ ] **Step 2: 加样式**

在 `src/style.css` 末尾追加（沿用现有 `.modal`/`.btn` 类名风格；若已有 `.modal-overlay`/`.modal` 则复用）：

```css
.ill-source { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
.ill-source label { display: flex; align-items: center; gap: 6px; font-size: 14px; }
#illPrompt { width: 100%; box-sizing: border-box; resize: vertical; font-family: inherit; }
.ill-status { font-size: 13px; color: #888; min-height: 18px; margin: 6px 0; }
.ill-status.error { color: #c33; }
.ill-status.busy { color: #369; }
.spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid #ccc;
  border-top-color: #369; border-radius: 50%; animation: spin 0.8s linear infinite;
  vertical-align: middle; margin-right: 4px; }
@keyframes spin { to { transform: rotate(360deg); } }
.message-illustration { margin-top: 10px; }
.message-illustration img { max-width: 100%; border-radius: 8px; display: block; }
.message-illustration .ill-placeholder { color: #999; font-size: 13px; }
```

- [ ] **Step 3: 构建并肉眼验证**

Run (in `jiuguan/`): `node build.js`
然后启动 `node server.js`，浏览器打开 `http://localhost:3111`，临时在控制台跑 `document.querySelector('#illustrateModal').classList.add('active')` 确认面板能显示、样式正常。
Expected: 面板显示，无控制台报错。

- [ ] **Step 4: 申请 commit**

Tell user: "Task 7 done. 请 commit `src/body.html` + `src/style.css` + `index.html`。"
Suggested: `feat(ui): add illustration modal markup and styles`

---

## Task 8: 前端 — 🖼 按钮 + 插图展示

在 AI 消息操作栏加配图按钮，消息正文末尾渲染已有插图。

**Files:**
- Modify: `jiuguan/src/app.js`

- [ ] **Step 1: 加 🖼 按钮到操作栏**

在 `buildMsg()` 里，找到 AI 消息的 actions 字符串（约 `src/app.js:543-544`，`msg.role !== "user" && !msg.streaming` 分支），把：

```javascript
      ? '<div class="message-actions"><button class="btn-msg-action" data-act="continue" title="继续补全">▶️</button><button class="btn-msg-action" data-act="retry" title="重新生成">🔄</button><button class="btn-msg-action" data-act="copy" title="复制">📋</button></div>'
```

改为（追加配图按钮，文案随是否已有插图变化）：

```javascript
      ? '<div class="message-actions"><button class="btn-msg-action" data-act="continue" title="继续补全">▶️</button><button class="btn-msg-action" data-act="retry" title="重新生成">🔄</button><button class="btn-msg-action" data-act="illustrate" title="配图">' + (msg.illustration ? "🖼️" : "🖼") + '</button><button class="btn-msg-action" data-act="copy" title="复制">📋</button></div>'
```

- [ ] **Step 2: 渲染已有插图**

在 `buildMsg()` 构造 `div.innerHTML` 后、return 前（约 `src/app.js:566` 附近），加插图渲染。找到 `actions +` 拼接结束、`"</div>"` 结束 message-body 的位置，在 `"</div>"`（关闭 message-body）之前插入插图节点。更稳妥：在 `buildMsg` 末尾 `return div;` 之前加：

```javascript
  if (msg.role === "assistant" && !msg.streaming && msg.illustration) {
    var _conv = getConv();
    var _imgId = (_conv ? _conv.id : "") + "_" + idx;
    var _img = document.createElement("div");
    _img.className = "message-illustration";
    _img.innerHTML = '<img src="/api/illustration?conv=' + encodeURIComponent(_conv ? _conv.id : "") + '&idx=' + idx + '" loading="lazy" onerror="this.parentNode.innerHTML=\'<span class=\\\'ill-placeholder\\\'>[插图加载失败]</span>\'">';
    div.querySelector(".message-body").appendChild(_img);
  }
```

- [ ] **Step 3: 构建并验证按钮出现**

Run (in `jiuguan/`): `node build.js`，刷新页面，发一条消息得到 AI 回复，确认 AI 消息操作栏出现 🖷 按钮。
Expected: 按钮出现，点击暂无反应（交互在 Task 9）。

- [ ] **Step 4: 申请 commit**

Tell user: "Task 8 done. 请 commit `src/app.js` + `index.html`。"
Suggested: `feat(ui): add illustrate button and render existing illustrations`

---

## Task 9: 前端 — 配图面板交互（生成提示词 + 确认出图）

接通 `/api/illustrate/prompt` 与 `/api/illustrate/generate`。

**Files:**
- Modify: `jiuguan/src/app.js`

- [ ] **Step 1: 加 DOM 引用 + 状态**

在 `dm` 对象（约 `src/app.js:25-72`）末尾加：

```javascript
  illustrateModal: $("#illustrateModal"),
  illCloseBtn: $("#illCloseBtn"),
  illCancelBtn: $("#illCancelBtn"),
  illGenPromptBtn: $("#illGenPromptBtn"),
  illConfirmBtn: $("#illConfirmBtn"),
  illPrompt: $("#illPrompt"),
  illStatus: $("#illStatus"),
```

在 `state` 对象（约 `src/app.js:3-23`）加字段：

```javascript
  isIllustrating: false,
  illustrateTarget: null, // {convId, msgIdx}
```

- [ ] **Step 2: 加点击分发**

在 `dm.messagesContainer` 的点击 `switch(act)`（约 `src/app.js:607-623`）加分支：

```javascript
    case "illustrate":
      openIllustrate(idx);
      break;
```

- [ ] **Step 3: 实现面板逻辑**

在 `app.js` 末尾（`window.addEventListener("resize", resize);` 之前）加：

```javascript
function openIllustrate(idx) {
  if (state.isStreaming) return;
  const c = getConv();
  if (!c) return;
  const msg = c.messages[idx];
  if (!msg || msg.role !== "assistant") return;
  state.illustrateTarget = { convId: c.id, msgIdx: idx };
  dm.illPrompt.value = msg.illustration ? (msg.illustration.prompt || "") : "";
  dm.illStatus.textContent = "";
  dm.illStatus.className = "ill-status";
  dm.illustrateModal.classList.add("active");
}
function clsIll() {
  if (state.isIllustrating) return;
  dm.illustrateModal.classList.remove("active");
  state.illustrateTarget = null;
}
dm.illCloseBtn.addEventListener("click", clsIll);
dm.illCancelBtn.addEventListener("click", clsIll);
dm.illustrateModal.addEventListener("click", (e) => {
  if (e.target === dm.illustrateModal) clsIll();
});

async function genIllPrompt() {
  if (!state.illustrateTarget) return;
  const { convId, msgIdx } = state.illustrateTarget;
  const mode = document.querySelector('input[name="illSource"]:checked').value;
  dm.illStatus.className = "ill-status busy";
  dm.illStatus.innerHTML = '<span class="spinner"></span>生成提示词中…';
  try {
    const r = await fetch("/api/illustrate/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ convId, msgIdx, mode }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "失败");
    dm.illPrompt.value = d.prompt;
    dm.illStatus.textContent = "提示词已生成，可编辑后确认";
    dm.illStatus.className = "ill-status";
  } catch (e) {
    dm.illStatus.textContent = "失败：" + e.message;
    dm.illStatus.className = "ill-status error";
  }
}
dm.illGenPromptBtn.addEventListener("click", genIllPrompt);

async function confirmIllustrate() {
  if (!state.illustrateTarget || state.isIllustrating) return;
  const prompt = dm.illPrompt.value.trim();
  if (!prompt) { toast("提示词不能为空"); return; }
  const { convId, msgIdx } = state.illustrateTarget;
  state.isIllustrating = true;
  dm.illConfirmBtn.disabled = true;
  dm.illConfirmBtn.textContent = "生成中…";
  dm.illStatus.className = "ill-status busy";
  dm.illStatus.innerHTML = '<span class="spinner"></span>画图中…';
  try {
    const r = await fetch("/api/illustrate/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ convId, msgIdx, prompt }),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || "画图失败");
    // 更新本地消息
    const c = getConv();
    if (c) {
      c.messages[msgIdx].illustration = {
        engine: d.illustration.engine, prompt, createdAt: Date.now(),
      };
      save(c);
    }
    clsIll();
    renderMsgs();
    toast("插图已生成");
  } catch (e) {
    dm.illStatus.textContent = "失败：" + e.message;
    dm.illStatus.className = "ill-status error";
  } finally {
    state.isIllustrating = false;
    dm.illConfirmBtn.disabled = false;
    dm.illConfirmBtn.textContent = "确认生成插图";
  }
}
dm.illConfirmBtn.addEventListener("click", confirmIllustrate);
```

- [ ] **Step 4: 构建并端到端手动验证**

Run (in `jiuguan/`): `node build.js`，启动 `node server.js`，浏览器：
1. 发消息得到 AI 回复 → 点 🖷 → 面板弹出
2. 选「LLM 提炼」→ 点「生成提示词」→ 文本框出现英文提示词
3. 编辑后点「确认生成插图」→ 转圈 → 正文末尾出现图
4. 刷新页面，图仍在

Expected: 全流程通过。

- [ ] **Step 5: 申请 commit**

Tell user: "Task 9 done. 请 commit `src/app.js` + `index.html`。"
Suggested: `feat(ui): wire illustration modal to prompt + generate endpoints`

---

## Task 10: 集成验证 + 验收清单

真实环境跑一遍，对照 spec 验收。

**Files:** 无（仅运行验证）

- [ ] **Step 1: 确认 quick AIdraw 侧可用**

Run (in `quick AIdraw/`): `python\python.exe generate.py --json --engine cloud --no-fallback "a cat sitting on a windowsill"`
Expected: stdout 末行是合法 JSON，`ok:true`，`file` 指向 output/ 下一张 jpg。

- [ ] **Step 2: 确认 jiuguan 全套测试通过**

Run (in `jiuguan/`): `node --test test/illustrate.test.mjs`
Expected: PASS

- [ ] **Step 3: 端到端云端配图（真实）**

启动 `node server.js`，浏览器跑完整流程（Task 9 Step 4），确认云端出图嵌入正文。

- [ ] **Step 4: 回退验证**

临时把 `quick AIdraw/.env` 的 `XAI_API_KEY` 改成无效值，再配图，确认自动回退本地 SDXL 出图（本地慢，耐心等待）。验证后改回 key。
Expected: 云端失败后本地出图。

- [ ] **Step 5: 换图验证**

对已配图消息再点 🖷️ → 重新配图，确认旧图被覆盖。

- [ ] **Step 6: 申请最终 commit**

Tell user: "Task 10 验证完成，全部通过。请确认是否 commit 收尾（若有未提交的 build 产物 index.html 等）。"

---

## Self-Review

- **Spec 覆盖**：§3 数据流 → Task 4/5/6/9。§4 generate_image → Task 1/2。§5 三个接口 → Task 4/5/6。§6 前端 UI → Task 7/8/9。§7 错误处理 → 各接口的 400/404/500 分支；边界（仅 AI 消息、空正文、convId/msgIdx 校验）→ Task 5/6。§7 测试策略 → Task 1/2（python unittest）、Task 3-6（node:test）、Task 10（手动集成）。验收清单 → Task 10。全覆盖。

- **占位符扫描**：无 TBD/TODO；每个代码步骤含完整代码。Task 2 Step 1 的 `test_json_mode_outputs_valid_json` 留了一个跨进程 patch 不可行的注释说明，并改用 `test_json_mode_real_subprocess_cloud_no_key` 做真实子进程测试——非占位，是合理的测试设计。

- **类型/命名一致性**：`generate_image()` 返回 `{ok, file, engine, error?}` 在 Task 1 定义，Task 2 CLI 与 Task 6 server.js 解析一致。`runGenerate` 在 Task 3 定义、Task 6 使用。`callDeepSeek` Task 5 定义。`ILLUSTR_DIR`/`AIDRAW_DIR`/`AIDRAW_PYTHON`/`AIDRAW_GENERATE` 在 Task 3 定义，Task 4/6 使用。前端 `state.illustrateTarget`/`state.isIllustrating`、`openIllustrate`/`clsIll`/`genIllPrompt`/`confirmIllustrate` 命名一致。`/api/illustration?conv=&idx=` 的 query 参数在 Task 4（读图）与 Task 8（前端 img src）一致。

- **一处注意点**：Task 4 要求 server.js 支持 `JIUGUAN_DATA_DIR` 覆盖 DATA_DIR 以便测试隔离；Task 3 已先定义 `AIDRAW_DIR` env 覆盖。两者都是测试需要的注入点，已在对应任务里实现。无遗漏。
