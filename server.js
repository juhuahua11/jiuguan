const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const zlib = require("zlib");
const crypto = require("crypto");
const { spawn, execSync } = require("child_process");

// ── .env 加载 ──
// NOTE: 必须在读取 PORT / JIUGUAN_DATA_DIR 等配置之前调用，否则 .env 默认值不会生效
// （loadEnv 不覆盖已存在的真实 env，即真实 env 优先于 .env，这是 dotenv 标准行为）。
function loadEnv(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    for (const line of content.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 0) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      // 不覆盖已存在的环境变量：真实 env 优先于 .env 文件（dotenv 标准行为），
      // 这样测试可以用 API_URL 等指向本地 mock，而不被 .env 里的真实值覆盖。
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  } catch {}
}
loadEnv(path.join(__dirname, ".env"));

// ── 路径与端口配置（在 .env 加载之后读取，确保 .env 默认值生效，真实 env 优先） ──
const _portRaw = parseInt(process.env.PORT || "3111", 10);
const PORT =
  Number.isFinite(_portRaw) && _portRaw > 0 && _portRaw < 65536 ? _portRaw : 3111;
const DATA_DIR =
  process.env.JIUGUAN_DATA_DIR && process.env.JIUGUAN_DATA_DIR.trim()
    ? process.env.JIUGUAN_DATA_DIR.trim()
    : path.join(__dirname, "data");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const CONV_DIR = path.join(DATA_DIR, "conversations");
const OLD_DATA_FILE = path.join(__dirname, "data.json");

// ── quick AIdraw 对接 ──
// NOTE: AIDRAW_DIR resolution mirrors test/_aidraw_path.mjs — that file is the
// source of truth for the env-override + sibling-dir fallback; keep in sync.
const _aidrawEnv = process.env.AIDRAW_DIR && process.env.AIDRAW_DIR.trim();
const AIDRAW_DIR = _aidrawEnv || path.join(__dirname, "..", "quick AIdraw");
const AIDRAW_PYTHON = path.join(AIDRAW_DIR, "python", "python.exe");
const AIDRAW_GENERATE = path.join(AIDRAW_DIR, "generate.py");
const ILLUSTR_DIR = path.join(DATA_DIR, "illustrations");
const _aidrawTimeoutRaw = parseInt(process.env.AIDRAW_TIMEOUT_MS || "600000", 10);
const AIDRAW_TIMEOUT_MS =
  Number.isFinite(_aidrawTimeoutRaw) && _aidrawTimeoutRaw > 0 ? _aidrawTimeoutRaw : 600000; // 10 min for local SDXL

// 从 process.env 读取配置默认值
function getEnvDefaults() {
  return {
    apiUrl: process.env.API_URL || "",
    apiKey: process.env.API_KEY || "",
    modelName: process.env.MODEL_NAME || "",
    stream: process.env.STREAM !== "false",
    reasoningEffort: process.env.REASONING_EFFORT || "",
    temperature: process.env.TEMPERATURE || "",
    maxTokens: process.env.MAX_TOKENS || "",
    topP: process.env.TOP_P || "",
    frequencyPenalty: process.env.FREQUENCY_PENALTY || "",
    presencePenalty: process.env.PRESENCE_PENALTY || "",
  };
}

function getLocalIPs() {
  const ips = [];
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const { family, address, internal } of addrs) {
      if (family === "IPv4" && !internal) ips.push({ name, address });
    }
  }
  return ips;
}

async function readJSON(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf-8"));
  } catch {
    return fallback;
  }
}

async function writeJSON(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(data, null, 2), "utf-8");
}

async function fileExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function sendJSON(res, code, data) {
  const raw = JSON.stringify(data);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(raw);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => {
      b += c;
      if (b.length > 5 * 1024 * 1024) {
        req.destroy();
        reject(new Error("too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(b || "{}"));
      } catch {
        reject(new Error("bad"));
      }
    });
    req.on("error", reject);
  });
}

function parseQuery(url) {
  const idx = url.indexOf("?");
  if (idx < 0) return {};
  const q = {};
  new URLSearchParams(url.slice(idx + 1)).forEach((v, k) => {
    q[k] = v;
  });
  return q;
}

function runGenerate(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(AIDRAW_PYTHON, [AIDRAW_GENERATE, ...args], {
      cwd: AIDRAW_DIR,
      detached: process.platform !== "win32",
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
    // Set encoding so Node buffers multi-byte chars internally; per-chunk
    // toString("utf8") would corrupt Chinese paths/errors and emoji split across
    // chunk boundaries (stderr feeds reject messages, stdout carries JSON with
    // ensure_ascii=False).
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let timer = setTimeout(() => {
      // Tree-kill so grandchild processes (local SDXL python) don't orphan on
      // timeout and hold VRAM → GPU OOM on repeated timeouts. Windows spawn has
      // no process groups by default, so walk the tree with taskkill /T.
      if (process.platform === "win32") {
        try {
          execSync("taskkill /PID " + child.pid + " /T /F", {
            stdio: "ignore",
            windowsHide: true,
          });
        } catch (e) {
          child.kill("SIGKILL");
        }
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (e) {
          child.kill("SIGKILL");
        }
      }
      reject(new Error("画图超时"));
    }, AIDRAW_TIMEOUT_MS);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => {
      if (stderr.length < 20000) stderr += c;
      console.error("[aidraw]", c.trim());
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

// 独立调用 DeepSeek（不影响小说生成链路）。cfg 为合并后的配置（env 默认值 +
// settings.json 运行时覆盖，与 GET /api/settings 同一优先级）。返回文本 content 或抛错。
async function callDeepSeek(cfg, systemPrompt, userContent) {
  if (!cfg.apiUrl || !cfg.apiKey || !cfg.modelName) {
    throw new Error("未配置 DeepSeek API");
  }
  let r;
  try {
    r = await fetch(cfg.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + cfg.apiKey,
      },
      body: JSON.stringify({
        model: cfg.modelName,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        stream: false,
      }),
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    // 60s 超时（AbortSignal.timeout 抛 TimeoutError/AbortError）→ 统一为可读消息
    if (e.name === "TimeoutError" || e.name === "AbortError") {
      throw new Error("DeepSeek 请求超时");
    }
    throw e;
  }
  if (!r.ok) {
    let em = "HTTP " + r.status;
    try { em = (await r.json()).error?.message || em; } catch {}
    throw new Error(em);
  }
  const d = await r.json();
  return d.choices?.[0]?.message?.content || "";
}

function etag(buf) {
  return crypto.createHash("sha1").update(buf).digest("hex").slice(0, 12);
}

async function sendStatic(res, filePath, contentType) {
  try {
    const buf = await fsp.readFile(filePath);
    const tag = etag(buf);
    res.setHeader("ETag", '"' + tag + '"');
    res.setHeader("Cache-Control", "public, max-age=300");
    if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");

    const ext = path.extname(filePath);
    if ([".html", ".js", ".css", ".json"].includes(ext) && buf.length > 1024) {
      const gz = zlib.gzipSync(buf);
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Encoding": "gzip",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(gz);
    } else {
      res.writeHead(200, {
        "Content-Type": contentType,
        "Access-Control-Allow-Origin": "*",
      });
      res.end(buf);
    }
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404");
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function migrateFromOld() {
  const oldExists = await fileExists(OLD_DATA_FILE);
  if (!oldExists) return;
  const files = await fsp.readdir(CONV_DIR).catch(() => []);
  if (files.some((f) => f.endsWith(".json"))) return;

  console.log("  [migrate] Found data.json, converting to split storage...");
  const old = await readJSON(OLD_DATA_FILE, {});
  const settings = old.settings || {};
  const conversations = old.conversations || [];

  await writeJSON(SETTINGS_FILE, settings);
  for (const conv of conversations) {
    if (conv && conv.id) {
      await writeJSON(path.join(CONV_DIR, conv.id + ".json"), conv);
    }
  }
  await fsp.rename(OLD_DATA_FILE, OLD_DATA_FILE + ".bak");
  console.log(
    "  [migrate] Done. Migrated " +
      conversations.length +
      " conversations. Backup: data.json.bak",
  );
}

function convMeta(conv) {
  if (!conv) return null;
  return {
    id: conv.id,
    title: conv.title || "新对话",
    createdAt: conv.createdAt || Date.now(),
    updatedAt: conv.updatedAt || conv.createdAt || Date.now(),
    messageCount: (conv.messages || []).filter(
      (m) => m.role === "user" || m.role === "assistant",
    ).length,
  };
}

// 校验会话/文件名只含安全字符，杜绝路径遍历。getConvFile 与 illustration 路由共用。
function safeName(s) {
  return /^[a-zA-Z0-9_-]+$/.test(s);
}

async function getConvFile(id) {
  if (!safeName(id)) return null;
  const fp = path.join(CONV_DIR, id + ".json");
  const exists = await fileExists(fp);
  return exists ? fp : null;
}

const server = http.createServer(async (req, res) => {
  const { url, method } = req;
  const basePath = url.indexOf("?") >= 0 ? url.slice(0, url.indexOf("?")) : url;
  const query = parseQuery(url);

  try {
    if (basePath === "/api/settings" && method === "GET") {
      const env = getEnvDefaults();
      const runtime = await readJSON(SETTINGS_FILE, {});
      sendJSON(res, 200, { ...env, ...runtime });
      return;
    }
    if (basePath === "/api/settings" && method === "POST") {
      const body = await parseBody(req);
      await writeJSON(SETTINGS_FILE, body);
      sendJSON(res, 200, { ok: true });
      return;
    }

    if (basePath === "/api/conversations" && method === "GET") {
      const files = await fsp.readdir(CONV_DIR).catch(() => []);
      const list = [];
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const conv = await readJSON(path.join(CONV_DIR, f), null);
        if (conv && conv.id) list.push(convMeta(conv));
      }
      list.sort((a, b) => b.updatedAt - a.updatedAt);
      sendJSON(res, 200, list);
      return;
    }

    if (basePath === "/api/conv" && method === "GET") {
      const id = query.id;
      if (!id) {
        sendJSON(res, 400, { error: "Missing id" });
        return;
      }
      const fp = await getConvFile(id);
      if (!fp) {
        sendJSON(res, 404, { error: "Not found" });
        return;
      }
      const conv = await readJSON(fp, null);
      sendJSON(res, 200, conv);
      return;
    }

    if (basePath === "/api/conv" && method === "POST") {
      const body = await parseBody(req);
      if (!body.id) {
        sendJSON(res, 400, { error: "Missing id" });
        return;
      }
      await writeJSON(path.join(CONV_DIR, body.id + ".json"), body);
      sendJSON(res, 200, { ok: true });
      return;
    }

    if (basePath === "/api/conv" && method === "DELETE") {
      const id = query.id;
      if (!id) {
        sendJSON(res, 400, { error: "Missing id" });
        return;
      }
      const fp = await getConvFile(id);
      if (fp) await fsp.unlink(fp).catch(() => {});
      sendJSON(res, 200, { ok: true });
      return;
    }

    if (basePath === "/api/conversations/clear" && method === "POST") {
      const files = await fsp.readdir(CONV_DIR).catch(() => []);
      await Promise.all(
        files
          .filter((f) => f.endsWith(".json"))
          .map((f) => fsp.unlink(path.join(CONV_DIR, f)).catch(() => {})),
      );
      sendJSON(res, 200, { ok: true });
      return;
    }

    if (basePath === "/api/illustrate/prompt" && method === "POST") {
      const body = await parseBody(req);
      const convId = (body.convId || "").trim();
      const msgIdxRaw = body.msgIdx;
      const mode = body.mode;
      if (!safeName(convId) || convId.length > 128) {
        sendJSON(res, 400, { error: "bad convId" });
        return;
      }
      if (!/^\d+$/.test(String(msgIdxRaw))) {
        sendJSON(res, 400, { error: "bad msgIdx" });
        return;
      }
      const msgIdx = parseInt(msgIdxRaw, 10);
      if (mode !== "extract" && mode !== "translate") {
        sendJSON(res, 400, { error: "bad mode" });
        return;
      }
      const fp = await getConvFile(convId);
      if (!fp) { sendJSON(res, 404, { error: "conv not found" }); return; }
      const conv = await readJSON(fp, null);
      const msg = conv && Array.isArray(conv.messages) ? conv.messages[msgIdx] : null;
      if (!msg || msg.role !== "assistant") {
        sendJSON(res, 400, { error: "msg must be an assistant message" });
        return;
      }
      const text = (msg.content || "").trim();
      if (!text) { sendJSON(res, 400, { error: "empty content" }); return; }

      const sys = mode === "extract"
        ? "你是画面描述专家。读下面这段小说，提炼成一个适合AI绘画的英文画面描述，只输出英文prompt，包含主体、场景、风格、光影。不要解释。"
        : "把下面这段中文翻译成适合AI绘画的英文提示词，保留所有视觉细节，只输出英文prompt，不要解释。";
      // 合并 env 默认值 + settings.json 运行时覆盖，与 GET /api/settings 同一优先级，
      // 这样 UI 配置的 apiUrl/apiKey/modelName 能生效，而非仅靠 env。
      const runtime = await readJSON(SETTINGS_FILE, {});
      const cfg = { ...getEnvDefaults(), ...runtime };
      try {
        const prompt = (await callDeepSeek(cfg, sys, text)).trim();
        sendJSON(res, 200, { prompt });
      } catch (e) {
        sendJSON(res, 500, { error: e.message || "提示词生成失败" });
      }
      return;
    }

    if (basePath === "/api/illustrate/generate" && method === "POST") {
      const body = await parseBody(req);
      const convId = (body.convId || "").trim();
      const msgIdxRaw = body.msgIdx;
      const prompt = (body.prompt || "").trim();
      const engine = body.engine === "local" ? "local" : "cloud";
      const fallback = body.fallback !== false; // 默认 true
      if (!safeName(convId) || convId.length > 128) {
        sendJSON(res, 400, { error: "bad convId" }); return;
      }
      if (!/^\d+$/.test(String(msgIdxRaw))) {
        sendJSON(res, 400, { error: "bad msgIdx" }); return;
      }
      const msgIdx = parseInt(msgIdxRaw, 10);
      if (!prompt) { sendJSON(res, 400, { error: "empty prompt" }); return; }

      const fp = await getConvFile(convId);
      if (!fp) { sendJSON(res, 404, { error: "conv not found" }); return; }
      const conv = await readJSON(fp, null);
      const msg = conv && Array.isArray(conv.messages) ? conv.messages[msgIdx] : null;
      if (!msg || msg.role !== "assistant") {
        sendJSON(res, 400, { error: "msg must be an assistant message" });
        return;
      }

      // spawn generate.py：--json 让 stdout 只输出 JSON 行，--quiet 抑制引擎日志，
      // --output-dir 指向 illustrations/，-- 后是 prompt（防止 prompt 以 - 开头被 argparse 当 flag）。
      const args = ["--json", "--engine", engine,
                    fallback ? "--fallback" : "--no-fallback",
                    "--output-dir", ILLUSTR_DIR, "--quiet", "--", prompt];
      let result;
      try {
        const out = await runGenerate(args);
        const lines = out.trim().split(/\r?\n/).filter(Boolean);
        if (!lines.length) throw new Error("generate.py 输出为空");
        result = JSON.parse(lines[lines.length - 1]);
      } catch (e) {
        sendJSON(res, 500, { error: e.message || "spawn failed" });
        return;
      }
      if (!result.ok || !result.file) {
        sendJSON(res, 500, { error: result.error || "画图失败" });
        return;
      }

      // 复制到 illustrations/{convId}_{msgIdx}.png，覆盖旧图；删除 generate.py 的中间产物。
      const dest = path.join(ILLUSTR_DIR, convId + "_" + msgIdx + ".png");
      try {
        if (path.resolve(result.file) !== path.resolve(dest)) {
          await fsp.copyFile(result.file, dest);
          await fsp.unlink(result.file).catch(() => {});
        }
      } catch (e) {
        sendJSON(res, 500, { error: "复制图失败：" + e.message });
        return;
      }

      msg.illustration = {
        engine: result.engine,
        prompt: prompt,
        createdAt: Date.now(),
      };
      // 单写者假设：A1111 式单任务串行出图，此处无需 per-conv 写锁。
      await writeJSON(fp, conv);

      sendJSON(res, 200, { illustration: { engine: result.engine } });
      return;
    }

    if (basePath === "/api/illustration" && method === "GET") {
      const conv = (query.conv || "").trim();
      const idxRaw = (query.idx || "").trim();
      if (conv.length === 0 || conv.length > 128 || !safeName(conv)) {
        sendJSON(res, 400, { error: "bad conv" });
        return;
      }
      if (!/^\d+$/.test(idxRaw)) {
        sendJSON(res, 400, { error: "bad idx" });
        return;
      }
      const idx = parseInt(idxRaw, 10);
      const fp = path.join(ILLUSTR_DIR, conv + "_" + idx + ".png");
      try {
        const buf = await fsp.readFile(fp);
        const tag = etag(buf);
        if (req.headers["if-none-match"] === '"' + tag + '"') {
          res.writeHead(304, {
            "ETag": '"' + tag + '"',
            "Cache-Control": "public, max-age=300",
          });
          res.end();
          return;
        }
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=300",
          "ETag": '"' + tag + '"',
          "Access-Control-Allow-Origin": "*",
        });
        res.end(buf);
      } catch {
        sendJSON(res, 404, { error: "Not found" });
      }
      return;
    }

    if (url === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    const fp = path.join(__dirname, url === "/" ? "index.html" : url);
    await sendStatic(
      res,
      fp,
      MIME[path.extname(fp)] || "application/octet-stream",
    );
  } catch (err) {
    sendJSON(res, 500, { error: "Internal error" });
  }
});

(async () => {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(CONV_DIR, { recursive: true });
  await fsp.mkdir(ILLUSTR_DIR, { recursive: true });
  await migrateFromOld();

  server.listen(PORT, "0.0.0.0", () => {
    const ips = getLocalIPs();
    console.log("AI Chat Server  (port " + PORT + ")");
    console.log("  Local:   http://localhost:" + PORT);
    ips.forEach(({ name, address }) =>
      console.log(
        "  Network: http://" + address + ":" + PORT + "  (" + name + ")",
      ),
    );
    console.log("  Data:    " + DATA_DIR);
    console.log("  Build:   node build.js  (run after editing src/)");
  });
})();
