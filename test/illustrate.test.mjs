import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn as spawnProc, execSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { resolveAidrawDir } from "./_aidraw_path.mjs";

const SERVER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function spawnServer(env = {}) {
  return spawnProc("node", ["server.js"], {
    cwd: SERVER_DIR,
    env: { ...process.env, ...env },
    stdio: "ignore",
  });
}

function waitForPort(port, host = "127.0.0.1", timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server start timeout")), timeoutMs);
    const tryConn = () => {
      const s = net.connect(port, host);
      s.on("connect", () => { clearTimeout(t); s.destroy(); resolve(); });
      s.on("error", () => setTimeout(tryConn, 100));
    };
    tryConn();
  });
}

async function makeTmpDataDir() {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "jiuguan-"));
  const dataDir = path.join(tmpRoot, "data");
  await fs.mkdir(path.join(dataDir, "illustrations"), { recursive: true });
  return { tmpRoot, dataDir };
}

async function killServer(proc) {
  if (!proc) return;
  const exited = new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", resolve);
  });
  try { proc.kill(); } catch {}
  // Give the OS a moment to actually release the listening socket.
  await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  if (proc.exitCode === null && proc.signalCode === null) {
    // Still alive — force kill. Windows needs /T to walk the process tree.
    try {
      if (process.platform === "win32") {
        execSync("taskkill /PID " + proc.pid + " /T /F", {
          stdio: "ignore",
          windowsHide: true,
        });
      } else {
        process.kill(proc.pid, "SIGKILL");
      }
    } catch {}
    await exited.catch(() => {});
  }
}

test("aidrawDir resolves to sibling quick AIdraw by default", () => {
  const d = resolveAidrawDir("/some/jiuguan", "");
  assert.match(d, /quick AIdraw$/);
});

test("aidrawDir honors AIDRAW_DIR env override", () => {
  const d = resolveAidrawDir("/some/jiuguan", "/custom/aidraw");
  assert.equal(d, "/custom/aidraw");
});

test("GET /api/illustration returns png and 404 when missing", async () => {
  const PORT = 3199;
  const { tmpRoot, dataDir } = await makeTmpDataDir();
  const illDir = path.join(dataDir, "illustrations");
  await fs.writeFile(path.join(illDir, "c_1_2.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const proc = spawnServer({ JIUGUAN_DATA_DIR: dataDir, PORT: String(PORT) });
  try {
    await waitForPort(PORT);
    let r = await fetch(`http://127.0.0.1:${PORT}/api/illustration?conv=c_1&idx=2`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "image/png");
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(buf[0], 0x89);

    r = await fetch(`http://127.0.0.1:${PORT}/api/illustration?conv=c_1&idx=99`);
    assert.equal(r.status, 404);

    // 非法 conv（路径遍历）
    r = await fetch(`http://127.0.0.1:${PORT}/api/illustration?conv=..%2F..&idx=0`);
    assert.equal(r.status, 400);

    // 非法 idx
    r = await fetch(`http://127.0.0.1:${PORT}/api/illustration?conv=c_1&idx=abc`);
    assert.equal(r.status, 400);
  } finally {
    await killServer(proc);
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
