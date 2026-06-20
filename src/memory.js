// 记忆宫殿模块
// 负责：STM 生成、LTM 合并、记忆 prompt 构建、前端面板 HTML

// ── 摘要 API 调用 ──
async function callSummaryAPI(messages, settings) {
  const { apiUrl, apiKey, modelName } = settings;
  const url = apiUrl.replace(/\/chat\/completions\/?$/, "") + "/chat/completions";
  const body = {
    model: modelName,
    messages: messages,
    stream: false,
    temperature: 0.3,
    max_tokens: 2000,
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
  return d.choices?.[0]?.message?.content || "";
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
function extractJSON(raw) {
  let json = raw.trim();
  const codeMatch = json.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeMatch) json = codeMatch[1].trim();
  return JSON.parse(json);
}

// ── 生成短期记忆 ──
async function generateSTM(conv, round, userContent, assistantContent, settings) {
  const messages = buildSTMPrompt(userContent, assistantContent);
  const raw = await callSummaryAPI(messages, settings);
  const data = extractJSON(raw);
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
  const raw = await callSummaryAPI(messages, settings);
  const data = extractJSON(raw);
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
    conv.memory = { shortTerm: [], longTerm: [], lastMergedRound: 0 };
  }
  return conv.memory;
}

// ── 主入口：每轮对话后触发 ──
async function triggerMemoryUpdate(conv, settings) {
  if (!conv || !conv.messages) return;
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
  if (lastUserIdx === -1 || lastAsstIdx === -1) return;

  // 计算轮次（user消息数量）
  let round = 0;
  for (let j = 0; j <= lastAsstIdx; j++) {
    if (msgs[j].role === "user") round++;
  }

  // 检查是否已有此轮 STM
  const existing = conv.memory.shortTerm.filter(function(s) { return s.round === round; });
  if (existing.length > 0) return;

  const userContent = msgs[lastUserIdx].content;
  const asstContent = msgs[lastAsstIdx].content;

  // 跳过太短的回复（可能是错误或取消）
  if (asstContent.length < 20) return;

  try {
    const stm = await generateSTM(conv, round, userContent, asstContent, settings);
    conv.memory.shortTerm.push(stm);

    // 未合并的 STM
    const unmerged = conv.memory.shortTerm.filter(function(s) {
      return s.round > conv.memory.lastMergedRound;
    });

    // 每 7 条合并一次
    if (unmerged.length >= 7) {
      const toMerge = unmerged.slice(-7);
      try {
        const ltm = await mergeToLTM(conv, toMerge, settings);
        conv.memory.longTerm.push(ltm);
        conv.memory.lastMergedRound = toMerge[6].round;
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
function buildMemoryPrompt(conv, query) {
  ensureMemory(conv);
  const stms = conv.memory.shortTerm;
  const ltms = conv.memory.longTerm;
  const lastMerged = conv.memory.lastMergedRound || 0;

  const unmergedSTMs = stms.filter(function(s) { return s.round > lastMerged; });

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

  // 紧凑格式输出
  var text = "\n\n[记忆档案] 据此保持角色一致性与剧情连贯。";

  if (filteredSTMs.length > 0) {
    text += "\n近期：";
    filteredSTMs.forEach(function(s) {
      text += "\nR" + s.round + ": " + (s.keyEvent || "");
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
      if (extras.length > 0) text += " | " + extras.join("；");
    });
  }

  if (ltms.length > 0) {
    text += "\n历史概要：";
    ltms.forEach(function(l) {
      text += "\n[" + l.roundsCovered + "轮] " + l.plotSummary;
      if (l.characterArcs.length > 0) {
        var arcs = l.characterArcs.map(function(c) {
          return c.character + "：" + c.arc;
        });
        text += "（" + arcs.join("；") + "）";
      }
    });
  }

  return text;
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
