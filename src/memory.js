// 记忆宫殿模块
// 负责：STM 生成、LTM 合并、记忆 prompt 构建、前端面板 HTML

// ── 摘要 API 调用 ──
// maxTokensOverride: LTM merge needs more headroom than STM extraction
async function callSummaryAPI(messages, settings, maxTokensOverride) {
  const { apiUrl, apiKey, modelName } = settings;
  const url = apiUrl.replace(/\/chat\/completions\/?$/, "") + "/chat/completions";
  const body = {
    model: modelName,
    messages: messages,
    stream: false,
    temperature: 0,
    max_tokens: maxTokensOverride || 2000,
    // v4 reasoning models may emit the answer in reasoning_content and
    // leave content empty. Pin to 'low' so the model writes to content.
    reasoning_effort: 'low',
  };
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(url.includes("xiaomimimo")
        ? { "api-key": apiKey }
        : { Authorization: "Bearer " + apiKey }),
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const errText = await r.text().catch(function() { return "unknown"; });
    throw new Error("摘要 API 调用失败: HTTP " + r.status + " " + errText.slice(0, 100));
  }
  const d = await r.json();
  const msg = d.choices?.[0]?.message;
  // #1 v4 compat: log when reasoning_content fallback is triggered
  if (!msg?.content && msg?.reasoning_content) {
    console.log('[memory-palace] v4 fallback: used reasoning_content (len=' + msg.reasoning_content.length + ') instead of empty content');
  }
  return msg?.content || msg?.reasoning_content || "";
}

// ── STM 生成 prompt ──
const STM_SYSTEM_PROMPT = "你是一个记忆归档助手。你的任务是根据一轮对话（用户消息+AI回复），提取结构化的短期记忆。\n\n规则：\n1. 变化描述严格基于对话原文，不夸张、不补充、不推测\n2. 没有发生的维度可以省略对应字段或留空数组\n3. 角色名严格使用对话中出现的名字\n4. 只做客观归纳，不加入主观评价\n\n输出必须是合法的 JSON 对象，格式如下：\n{\n  \"characters\": [\"角色1\", \"角色2\"],\n  \"keyEvent\": \"本轮核心事件（1-2句）\",\n  \"psychologicalChanges\": [\n    { \"character\": \"角色名\", \"from\": \"变化前状态\", \"to\": \"变化后状态\", \"note\": \"补充说明\" }\n  ],\n  \"physiologicalChanges\": [\n    { \"character\": \"角色名\", \"change\": \"变化描述\" }\n  ],\n  \"relationshipChanges\": [\n    { \"from\": \"角色A\", \"to\": \"角色B\", \"fromState\": \"变化前关系\", \"toState\": \"变化后关系\" }\n  ],\n  \"newSettings\": [\"新增设定1\", \"新增设定2\"]\n}";

function buildSTMPrompt(userMsg, assistantMsg) {
  return [
    { role: "system", content: STM_SYSTEM_PROMPT },
    { role: "user", content: "用户消息：\n" + userMsg + "\n\nAI回复：\n" + assistantMsg + "\n\n请提取本轮对话的短期记忆，输出JSON。" },
  ];
}

// ── LTM 合并 prompt ──
const LTM_SYSTEM_PROMPT = "你是一个记忆归档助手。你的任务是将 7 条短期记忆（结构化JSON）合并为1条长期记忆。\n\n规则：\n1. 基于给出的短期记忆内容进行归纳，不要凭空添加信息\n2. 剧情线总结应该连贯叙事，串联这7轮的关键事件\n3. 角色变化汇总应体现这段时间内的整体弧光，包含数值变化和关键转折\n\n输出必须是合法的 JSON 对象，格式如下：\n{\n  \"plotSummary\": \"第N-M轮的剧情线总结（叙事性文字）\",\n  \"characterArcs\": [\n    { \"character\": \"角色名\", \"arc\": \"变化脉络（如：高冷仙子→肉体屈服意志仍在挣扎）\", \"detail\": \"详细说明\" }\n  ]\n}";

function buildLTMPrompt(stms) {
  const stmText = stms.map(function(s, i) {
    return "第 " + s.round + " 轮：\n" + JSON.stringify(s, null, 2);
  }).join("\n\n");
  return [
    { role: "system", content: LTM_SYSTEM_PROMPT },
    { role: "user", content: "以下7条短期记忆：\n\n" + stmText + "\n\n请合并为1条长期记忆，输出JSON。" },
  ];
}

// ── 提取 JSON ──
// Tries multiple strategies to recover valid JSON from an LLM response.
// v4 reasoning models may wrap the JSON in markdown or add trailing prose.
function extractJSON(raw) {
  var strategies = [
    // 1. Raw parse
    function(s) { return JSON.parse(s); },
    // 2. Extract from ```json / ``` fence
    function(s) {
      var m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
      return m ? JSON.parse(m[1].trim()) : null;
    },
    // 3. Extract outermost { … }
    function(s) {
      var start = s.indexOf('{');
      var end = s.lastIndexOf('}');
      if (start !== -1 && end > start) return JSON.parse(s.slice(start, end + 1));
      return null;
    },
    // 4. Fix trailing commas (common LLM mistake)
    function(s) {
      var cleaned = s.replace(/,(\s*[}\]])/g, '$1');
      var start = cleaned.indexOf('{');
      var end = cleaned.lastIndexOf('}');
      if (start !== -1 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
      return null;
    },
    // 5. Truncation repair: auto-close unclosed braces/brackets (model ran out of tokens)
    function(s) {
      var start = s.indexOf('{');
      if (start === -1) return null;
      var slice = s.slice(start);
      var depth = 0;
      var stack = []; // track whether each level is { or [
      var inString = false;
      var escaped = false;
      for (var ci = 0; ci < slice.length; ci++) {
        var ch = slice[ci];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') { depth++; stack.push('}'); }
        if (ch === '[') { depth++; stack.push(']'); }
        if (ch === '}' || ch === ']') { depth--; stack.pop(); }
      }
      if (depth <= 0) return null; // not truncated
      // Close remaining open structures in reverse order
      var repaired = slice;
      if (inString) repaired += '"';
      while (stack.length > 0) repaired += stack.pop();
      console.log('[memory-palace] JSON strategy 5 (truncation repair): auto-closed ' + depth + ' unclosed structures');
      return JSON.parse(repaired);
    },
  ];

  var text = raw.trim();
  for (var i = 0; i < strategies.length; i++) {
    try {
      var result = strategies[i](text);
      if (result && typeof result === 'object') {
        if (i > 0) console.log('[memory-palace] JSON strategy ' + (i + 1) + ' succeeded (fallback from strategy 1)');
        return result;
      }
    } catch (e) {
      // try next strategy
    }
  }

  console.error('[memory-palace] JSON parse FAILED after ' + strategies.length + ' strategies. Raw start:', text.slice(0, 200));
  throw new Error('JSON 解析失败，已尝试 ' + strategies.length + ' 种策略。原始响应前200字: ' + text.slice(0, 200));
}

// ── JSON 提取 + 截断自动重试 ──
// If extractJSON fails (likely truncation), retry once with doubled max_tokens.
// If that also fails, the error propagates — nothing more we can do.
async function extractWithRetry(messages, settings, initialTokens) {
  try {
    var raw = await callSummaryAPI(messages, settings, initialTokens);
    return extractJSON(raw);
  } catch (e) {
    var retryTokens = initialTokens * 2;
    console.log('[memory-palace] extract failed with ' + initialTokens + ' tokens, retrying with ' + retryTokens + '...');
    var retryRaw = await callSummaryAPI(messages, settings, retryTokens);
    return extractJSON(retryRaw);
  }
}

// ── 生成短期记忆 ──
async function generateSTM(conv, round, userContent, assistantContent, settings) {
  const messages = buildSTMPrompt(userContent, assistantContent);
  const data = await extractWithRetry(messages, settings, 3000);
  return {
    id: "stm_" + round,
    round: round,
    characters: data.characters || [],
    keyEvent: data.keyEvent || "",
    psychologicalChanges: data.psychologicalChanges || [],
    physiologicalChanges: data.physiologicalChanges || [],
    relationshipChanges: data.relationshipChanges || [],
    newSettings: data.newSettings || [],
  };
}

// ── 合并长期记忆 ──
async function mergeToLTM(conv, stms, settings) {
  const messages = buildLTMPrompt(stms);
  const data = await extractWithRetry(messages, settings, 4000);
  const firstRound = stms[0].round;
  const lastRound = stms[stms.length - 1].round;
  return {
    id: "ltm_" + (conv.memory.longTerm.length + 1),
    roundsCovered: firstRound + "-" + lastRound,
    plotSummary: data.plotSummary || "",
    characterArcs: data.characterArcs || [],
    mergedFrom: stms.map(function(s) { return s.id; }),
  };
}

// ── 初始化记忆结构 ──
function ensureMemory(conv) {
  if (!conv.memory) {
    conv.memory = { shortTerm: [], longTerm: [], mergedRounds: [] };
  }
  // 迁移旧格式：lastMergedRound → mergedRounds[]
  // 旧版本用单一阈值标记已合并轮次，新版本用显式集合避免断层
  if (conv.memory.lastMergedRound !== undefined && !Array.isArray(conv.memory.mergedRounds)) {
    var migrated = [];
    for (var si = 0; si < conv.memory.shortTerm.length; si++) {
      if (conv.memory.shortTerm[si].round <= conv.memory.lastMergedRound) {
        migrated.push(conv.memory.shortTerm[si].round);
      }
    }
    conv.memory.mergedRounds = migrated;
    console.log('[memory-palace] format migrated: lastMergedRound=' + conv.memory.lastMergedRound + ' → mergedRounds=[' + migrated.join(',') + ']');
    delete conv.memory.lastMergedRound;
  }
  return conv.memory;
}

// ── 简单字符串哈希 ──
function simpleHash(str) {
  var hash = 0;
  for (var i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return String(hash);
}

// ── 主入口：每轮对话后触发 ──
async function triggerMemoryUpdate(conv, settings) {
  if (!conv || !conv.messages) { console.log('[memory-palace] SKIP: no conv or messages'); return; }
  ensureMemory(conv);

  // 找到最新的 user-assistant 配对
  const msgs = conv.messages;
  let lastUserIdx = -1;
  let lastAsstIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "assistant" && lastAsstIdx === -1) lastAsstIdx = i;
    if (msgs[i].role === "user" && lastUserIdx === -1) lastUserIdx = i;
    if (lastUserIdx !== -1 && lastAsstIdx !== -1) break;
  }
  if (lastUserIdx === -1 || lastAsstIdx === -1) {
    console.log('[memory-palace] SKIP: no valid user-assistant pair (total msgs: ' + msgs.length + ', lastUser: ' + lastUserIdx + ', lastAsst: ' + lastAsstIdx + ')');
    return;
  }

  // 计算轮次（user消息数量）
  let round = 0;
  for (let j = 0; j <= lastAsstIdx; j++) {
    if (msgs[j].role === "user") round++;
  }

  const userContent = msgs[lastUserIdx].content;
  const asstContent = msgs[lastAsstIdx].content;
  const contentHash = simpleHash(userContent.slice(0, 200));

  // 检查是否已有此轮 STM，用内容哈希检测 swipe/重生成
  const existing = conv.memory.shortTerm.filter(function(s) { return s.round === round; });
  if (existing.length > 0) {
    if (existing[0]._contentHash === contentHash) {
      console.log('[memory-palace] SKIP: round ' + round + ' already has STM with same content hash');
      return;
    }
    console.log('[memory-palace] swipe detected: round ' + round + ' content changed, clearing old STM (was: "' + (existing[0].keyEvent || '').slice(0, 50) + '")');
    conv.memory.shortTerm = conv.memory.shortTerm.filter(function(s) { return s.round !== round; });
    conv.memory.mergedRounds = conv.memory.mergedRounds.filter(function(r) { return r !== round; });
  }

  // 跳过太短的回复（可能是错误或取消）
  if (asstContent.length < 20) {
    console.log('[memory-palace] SKIP: assistant reply too short (' + asstContent.length + ' chars) for round ' + round);
    return;
  }

  console.log('[memory-palace] processing round ' + round + ' (msgIdx user=' + lastUserIdx + ' asst=' + lastAsstIdx + ', userContent preview: "' + userContent.slice(0, 60) + '")');

  try {
    const stm = await generateSTM(conv, round, userContent, asstContent, settings);
    stm._contentHash = contentHash;
    conv.memory.shortTerm.push(stm);
    console.log('[memory-palace] STM generated: round=' + round + ' chars=' + stm.characters.length + ' event="' + (stm.keyEvent || '').slice(0, 60) + '" | STM pool: ' + conv.memory.shortTerm.length + ' total');

    // 未合并的 STM（用 mergedRounds 集合替代单一 lastMergedRound 阈值，
    // 避免 STM 有失败轮次时 unmerged.slice(-7) 跨断层导致中间轮次永久丢失）
    const mergedSet = {};
    for (var mi = 0; mi < conv.memory.mergedRounds.length; mi++) {
      mergedSet[conv.memory.mergedRounds[mi]] = true;
    }
    const unmerged = conv.memory.shortTerm.filter(function(s) {
      return !mergedSet[s.round];
    });

    // 每 7 条合并一次（取最早的 7 条，不是最后 7 条）
    if (unmerged.length >= 7) {
      const toMerge = unmerged.slice(0, 7);
      try {
        const ltm = await mergeToLTM(conv, toMerge, settings);
        conv.memory.longTerm.push(ltm);
        for (var ti = 0; ti < toMerge.length; ti++) {
          conv.memory.mergedRounds.push(toMerge[ti].round);
        }
        console.log('[memory-palace] LTM merged: rounds [' + toMerge[0].round + '-' + toMerge[toMerge.length-1].round + '] → ' + ltm.id + ' | STM pool: ' + conv.memory.shortTerm.length + ' total, ' + (unmerged.length - toMerge.length) + ' remaining unmerged, ' + conv.memory.longTerm.length + ' LTMs');
      } catch (e) {
        console.error("LTM 合并失败:", e);
      }
    }
  } catch (e) {
    console.error("STM 生成失败:", e);
  }
}

// ── 构建注入 system prompt 的记忆文本 ──
// query: 可选，当前用户消息，用于关键词相关性过滤
// 内置 token 上限防止长会话记忆撑爆上下文
//
// NOTE: 此函数当前不接入 LLM 注入链路。记忆宫殿定位为前端展示面板，
// 实际的记忆注入由 memory-proxy 处理（双路检索 + 预算分配 + 连续性快照），
// 质量更高且避免了去重/冲突问题。如需启用，在 injectSystemPrompt 中调用即可。
var MEMORY_PROMPT_MAX_TOKENS = 2000;
function estimateTokens(text) {
  // 中英文混合粗略估算：约 2 字符 ≈ 1 token
  return Math.ceil(text.length / 2);
}

function buildMemoryPrompt(conv, query) {
  ensureMemory(conv);
  var stms = conv.memory.shortTerm;
  var ltms = conv.memory.longTerm;
  var mergedSet = {};
  for (var mi = 0; mi < conv.memory.mergedRounds.length; mi++) {
    mergedSet[conv.memory.mergedRounds[mi]] = true;
  }

  var unmergedSTMs = stms.filter(function(s) { return !mergedSet[s.round]; });

  if (unmergedSTMs.length === 0 && ltms.length === 0) return "";

  // 提取查询关键词（长度>=2的中文或英文词）
  var keywords = [];
  if (query) {
    keywords = query.split(/[，,。！？!?\s\n…—]+/).filter(function(k) {
      return k.length >= 2;
    });
  }

  // 相关性过滤：有 query 时只保留匹配的短期记忆
  var filteredSTMs = unmergedSTMs;
  if (keywords.length > 0) {
    filteredSTMs = unmergedSTMs.filter(function(s) {
      var text = (s.keyEvent || "") + " " +
        (s.characters || []).join(" ") + " " +
        (s.newSettings || []).join(" ");
      s.psychologicalChanges.forEach(function(p) {
        text += " " + p.character + " " + p.from + " " + p.to + " " + (p.note || "");
      });
      s.physiologicalChanges.forEach(function(p) {
        text += " " + p.character + " " + p.change;
      });
      s.relationshipChanges.forEach(function(r) {
        text += " " + r.from + " " + r.to + " " + r.fromState + " " + r.toState;
      });
      return keywords.some(function(k) { return text.indexOf(k) !== -1; });
    });
  }

  if (filteredSTMs.length === 0 && ltms.length === 0) return "";

  // Token 预算控制：先写 LTM（历史概要更重要），再写近期 STM，超预算时停止
  var header = "\n\n[记忆档案] 据此保持角色一致性与剧情连贯。";
  var budget = MEMORY_PROMPT_MAX_TOKENS - estimateTokens(header);
  var parts = [];
  var truncated = false;

  // LTM 优先（逆序，最近的在前面）
  if (ltms.length > 0 && budget > 0) {
    var ltmText = "\n历史概要：";
    for (var li = ltms.length - 1; li >= 0 && budget > 0; li--) {
      var l = ltms[li];
      var line = "\n[" + l.roundsCovered + "轮] " + l.plotSummary;
      if (l.characterArcs.length > 0) {
        var arcs = l.characterArcs.map(function(c) {
          return c.character + "：" + c.arc;
        });
        line += "（" + arcs.join("；") + "）";
      }
      var t = estimateTokens(line);
      if (t > budget) { truncated = true; break; }
      ltmText += line;
      budget -= t;
    }
    if (ltmText.length > "\n历史概要：".length) parts.push(ltmText);
  }

  // STM（逆序，最近的在前面，但受预算和最大条数限制）
  var MAX_STM_ITEMS = 15;
  if (filteredSTMs.length > 0 && budget > 0) {
    var stmText = "\n近期：";
    var added = 0;
    for (var si = filteredSTMs.length - 1; si >= 0 && budget > 0 && added < MAX_STM_ITEMS; si--) {
      var s = filteredSTMs[si];
      var line = "\nR" + s.round + ": " + (s.keyEvent || "");
      var extras = [];
      s.psychologicalChanges.forEach(function(p) {
        extras.push(p.character + "心理 " + p.from + "→" + p.to + (p.note ? "(" + p.note + ")" : ""));
      });
      s.physiologicalChanges.forEach(function(p) {
        extras.push(p.character + "生理 " + p.change);
      });
      s.relationshipChanges.forEach(function(r) {
        extras.push(r.from + "→" + r.to + "关系 " + r.fromState + "→" + r.toState);
      });
      s.newSettings.forEach(function(ns) {
        extras.push("新设定：" + ns);
      });
      if (extras.length > 0) line += " | " + extras.join("；");
      var t = estimateTokens(line);
      if (t > budget) { truncated = true; break; }
      stmText += line;
      budget -= t;
      added++;
    }
    if (stmText.length > "\n近期：".length) parts.push(stmText);
  }

  if (truncated) {
    parts.push("\n[记忆已达上限，后续已截断]");
    console.log('[memory-palace] prompt truncated: budget=' + MEMORY_PROMPT_MAX_TOKENS + ' tokens, included ' + parts.length + ' sections, remaining budget=' + budget);
  }

  return parts.length > 0 ? header + parts.join("") : "";
}

// ── 构建前端记忆面板 HTML ──
function buildMemoryPanelHTML(conv, round) {
  ensureMemory(conv);
  const stm = conv.memory.shortTerm.filter(function(s) { return s.round === round; })[0];
  if (!stm) return "";

  let html = '<div class="memory-panel">';
  html += '<div class="memory-panel-header" onclick="this.parentElement.classList.toggle(\'expanded\')">';
  html += '<span class="memory-panel-arrow">▼</span> 【记忆宫殿】第 ' + stm.round + ' 轮摘要';
  html += '</div>';
  html += '<div class="memory-panel-body">';

  if (stm.characters.length > 0) {
    html += '<div class="memory-line"><span class="memory-label">涉及：</span>' + h(stm.characters.join("、")) + '</div>';
  }
  if (stm.keyEvent) {
    html += '<div class="memory-line"><span class="memory-label">事件：</span>' + h(stm.keyEvent) + '</div>';
  }
  stm.psychologicalChanges.forEach(function(p) {
    let line = '<div class="memory-line"><span class="memory-label">心理：</span>' + h(p.character + " " + p.from + "→" + p.to);
    if (p.note) line += "（" + h(p.note) + "）";
    line += '</div>';
    html += line;
  });
  stm.physiologicalChanges.forEach(function(p) {
    html += '<div class="memory-line"><span class="memory-label">生理：</span>' + h(p.character + " " + p.change) + '</div>';
  });
  stm.relationshipChanges.forEach(function(r) {
    html += '<div class="memory-line"><span class="memory-label">关系：</span>' + h(r.from + "→" + r.to + " " + r.fromState + "→" + r.toState) + '</div>';
  });
  if (stm.newSettings.length > 0) {
    stm.newSettings.forEach(function(ns) {
      html += '<div class="memory-line"><span class="memory-label">新设定：</span>' + h(ns) + '</div>';
    });
  }

  html += '</div></div>';
  return html;
}
