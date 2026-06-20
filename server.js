const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const zlib = require("zlib");
const crypto = require("crypto");
const { spawn, execSync } = require("child_process");

const PORT = 3111;
const DATA_DIR = path.join(__dirname, "data");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const CONV_DIR = path.join(DATA_DIR, "conversations");
const OLD_DATA_FILE = path.join(__dirname, "data.json");

// ── .env 加载 ──
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
      if (key) process.env[key] = val;
    }
  } catch {}
}
loadEnv(path.join(__dirname, ".env"));

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

async function getConvFile(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return null;
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
