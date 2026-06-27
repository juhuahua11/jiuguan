const fs = require('fs');
const path = require('path');

const APP_PATH = path.join(__dirname, '..', 'src', 'app.js');
const MARK = 'JIUGUAN_NATIVE_STREAM_WATCHDOG_V1';

function patchAppSource() {
  let src = fs.readFileSync(APP_PATH, 'utf8');
  if (src.includes(MARK)) {
    console.log('[jiuguan-watchdog] src/app.js native stream patch already present');
    return false;
  }

  const oldStreamContent = `// Step 4s: 流式内容生成器
async function* streamContent(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      const t = line.trim();
      if (!t || !t.startsWith("data: ")) continue;
      const d = t.slice(6);
      if (d === "[DONE]") continue;
      try {
        const p = JSON.parse(d);
        const delta = p.choices?.[0]?.delta?.content || "";
        if (delta) yield delta;
      } catch (e) {}
    }
  }
}
`;

  const newStreamContent = `// ${MARK}
const JIUGUAN_BRANCH_HEADER_RE = /【\\s*下一步剧情发展推荐选项\\s*】/;

function replaceBranchSection(output, branchBlock) {
  const source = String(output || "").trimEnd();
  const block = String(branchBlock || "").trim();
  if (!block) return source;
  const m = source.match(JIUGUAN_BRANCH_HEADER_RE);
  if (!m || m.index == null) return source + "\\n\\n" + block;
  return source.slice(0, m.index).trimEnd() + "\\n\\n" + block;
}

// Step 4s: 流式内容生成器
async function* streamContent(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      const t = line.trim();
      if (!t || !t.startsWith("data: ")) continue;
      const d = t.slice(6).trim();
      if (d === "[DONE]") continue;
      try {
        const p = JSON.parse(d);
        const control = p && p.jiuguan;
        if (control && control.event === "replace_branch") {
          yield { type: "replace_branch", content: control.content || "" };
          continue;
        }
        const delta = p.choices?.[0]?.delta?.content || "";
        if (delta) yield { type: "delta", content: delta };
      } catch (e) {}
    }
  }
}
`;

  if (!src.includes(oldStreamContent)) {
    throw new Error('streamContent block not found; src/app.js changed unexpectedly');
  }
  src = src.replace(oldStreamContent, newStreamContent);

  const oldLoop = `  let fc = "";
  for await (const delta of streamContent(response)) {
    fc += delta;
    conv.messages[aiIdx].content = fc;
    updateMsgContent(aiIdx, fc, true);
  }
`;

  const newLoop = `  let fc = "";
  for await (const event of streamContent(response)) {
    if (typeof event === "string") {
      fc += event;
    } else if (event && event.type === "replace_branch") {
      fc = replaceBranchSection(fc, event.content);
    } else if (event && event.type === "delta") {
      fc += event.content;
    }
    conv.messages[aiIdx].content = fc;
    updateMsgContent(aiIdx, fc, true);
  }
`;

  if (!src.includes(oldLoop)) {
    throw new Error('streamCall loop block not found; src/app.js changed unexpectedly');
  }
  src = src.replace(oldLoop, newLoop);

  fs.writeFileSync(APP_PATH, src, 'utf8');
  console.log('[jiuguan-watchdog] patched src/app.js with native replace_branch stream handling');
  return true;
}

if (require.main === module) {
  patchAppSource();
}

module.exports = patchAppSource;
