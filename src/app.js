const $ = (s) => document.querySelector(s);

const state = {
  conversations: [],
  currentId: null,
  isStreaming: false,
  abortController: null,
  sortMode: 0,
  uploadedFiles: [],
  isIllustrating: false,
  illustrateTarget: null, // {convId, msgIdx}
  settings: {
    apiUrl: "",
    apiKey: "",
    modelName: "",
    stream: true,
    systemPrompt: null,  // 已禁用，只使用 system-prompt.js
    reasoningEffort: "medium",
    temperature: "",
    maxTokens: "",
    topP: "",
    frequencyPenalty: "",
    presencePenalty: "",
  },
};

const dm = {
  sidebar: $("#sidebar"),
  sidebarOverlay: $("#sidebarOverlay"),
  menuBtn: $("#menuBtn"),
  closeSidebarBtn: $("#closeSidebarBtn"),
  conversationList: $("#conversationList"),
  newChatBtn: $("#newChatBtn"),
  totalInfo: $("#totalInfo"),
  clearAllBtn: $("#clearAllBtn"),
  convNameDisplay: $("#convNameDisplay"),
  chatContainer: $("#chatContainer"),
  messagesContainer: $("#messagesContainer"),
  emptyState: $("#emptyState"),
  inputText: $("#inputText"),
  fileInput: $("#fileInput"),
  uploadBtn: $("#uploadBtn"),
  uploadedFiles: $("#uploadedFiles"),
  sendBtn: $("#sendBtn"),
  settingsBtn: $("#settingsBtn"),
  settingsDot: $("#settingsDot"),
  modelBadge: $("#modelBadge"),
  settingsModal: $("#settingsModal"),
  modalCloseBtn: $("#modalCloseBtn"),
  cancelBtn: $("#cancelBtn"),
  saveSettingsBtn: $("#saveSettingsBtn"),
  resetSettingsBtn: $("#resetSettingsBtn"),
  apiUrlEl: $("#apiUrlEl"),
  apiKeyEl: $("#apiKeyEl"),
  modelNameEl: $("#modelNameEl"),
  apiProviderEl: $("#apiProvider"),
  streamToggle: $("#streamToggle"),
  reasoningEffort: $("#reasoningEffort"),
  tempEl: $("#tempEl"),
  maxTokensEl: $("#maxTokensEl"),
  topPEl: $("#topPEl"),
  freqPenaltyEl: $("#freqPenaltyEl"),
  presPenaltyEl: $("#presPenaltyEl"),
  renameBtn: $("#renameBtn"),
  renameModal: $("#renameModal"),
  renameInput: $("#renameInput"),
  renameCloseBtn: $("#renameCloseBtn"),
  renameCancelBtn: $("#renameCancelBtn"),
  renameSaveBtn: $("#renameSaveBtn"),
  sortBtn: $("#sortBtn"),
  toast: $("#toast"),
  clearMemoryBtn: $("#clearMemoryBtn"),
  illustrateModal: $("#illustrateModal"),
  illCloseBtn: $("#illCloseBtn"),
  illCancelBtn: $("#illCancelBtn"),
  illGenPromptBtn: $("#illGenPromptBtn"),
  illConfirmBtn: $("#illConfirmBtn"),
  illPrompt: $("#illPrompt"),
  illStatus: $("#illStatus"),
  // systemPromptEl 已禁用
};

const SORT_MODES = [
  { key: "updated-desc", label: "↓ 最近更新", fn: (a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt) },
  { key: "created-asc", label: "↑ 最早创建", fn: (a, b) => (a.createdAt || a.updatedAt) - (b.createdAt || b.updatedAt) },
  { key: "name-asc",   label: "A→Z 名称",  fn: (a, b) => (a.title || "").localeCompare(b.title || "", "zh-CN") },
  { key: "name-desc",  label: "Z→A 名称",  fn: (a, b) => (b.title || "").localeCompare(a.title || "", "zh-CN") },
];

const PROVIDERS = {
  deepseek: {
    url: "https://api.deepseek.com/v1/chat/completions",
    model: "deepseek-v4-pro",
    keyHint: "sk-...",
    reasoningEffort: "high",
  },
};

// 异步管道：pipe(f, g, h)(x) => h(g(f(x)))
const pipe = (...fns) => (input) =>
  fns.reduce((p, fn) => p.then(fn), Promise.resolve(input));

// Step 1: 注入系统提示词
const injectSystemPrompt = (conv) => (messages) => {
  const basePrompt = SYSTEM_PROMPT;
  return [
    { role: "system", content: basePrompt },
    ...messages.filter(
      (m) => (m.role === "user" || m.role === "assistant") && !m.streaming
    ),
  ];
};

// Step 2: 构建 API 请求体
const buildRequestBody = (model, stream) => (messages) => {
  const body = { model, messages, stream };
  const s = state.settings;
  if (s.reasoningEffort) {
    if (model.startsWith("mimo")) {
      body.chat_template_kwargs = { enable_thinking: true };
    } else {
      body.thinking = { type: "enabled" };
      body.reasoning_effort = s.reasoningEffort;
    }
  }
  if (s.temperature) body.temperature = parseFloat(s.temperature);
  if (s.maxTokens) body.max_tokens = parseInt(s.maxTokens);
  if (s.topP) body.top_p = parseFloat(s.topP);
  if (s.frequencyPenalty)
    body.frequency_penalty = parseFloat(s.frequencyPenalty);
  if (s.presencePenalty)
    body.presence_penalty = parseFloat(s.presencePenalty);
  return body;
};

// Step 3: 调用记忆代理 /api/chat（server 端转发给 memory-proxy 大脑 + 上游）
const callLLM = (url, key) => async (body) => {
  // 注入 chat_id，让大脑按对话隔离记忆 session
  const conv = getConv();
  const bodyWithChat = { ...body, chat_id: conv ? conv.id : undefined };
  const r = await fetch(window.location.origin + "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyWithChat),
    signal: state.abortController.signal,
  });
  if (!r.ok) {
    let em = "HTTP " + r.status;
    try {
      const ed = await r.json();
      em = ed.error?.message || ed.error || em;
    } catch (e) {
      try { em = await r.text(); } catch (e2) {}
    }
    throw new Error(em + (r.status === 404 ? " (请检查 API 地址)" : ""));
  }
  return r;
};

// Step 4: 提取响应内容（非流式）
const extractContent = async (response) => {
  const d = await response.json();
  return d.choices?.[0]?.message?.content || "";
};

// Step 5: 内容格式转换
const formatContent = (content) => content;

// Step 4s: 流式内容生成器
async function* streamContent(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
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

const API_SETTINGS = window.location.origin + "/api/settings";
const API_CONVERSATIONS = window.location.origin + "/api/conversations";
const API_CONV = window.location.origin + "/api/conv";
const API_CONV_CLEAR = window.location.origin + "/api/conversations/clear";

function h(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let settingsTimer = null;
function saveSettings() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(async () => {
    try {
      const r = await fetch(API_SETTINGS, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state.settings),
      });
      if (!r.ok) throw new Error("fail");
    } catch (e) {
      localStorage.setItem(
        "ai-chat-settings-fb",
        JSON.stringify(state.settings),
      );
    }
  }, 200);
}

const convSaveTimers = {};
function saveConv(conv) {
  if (!conv || !conv.id) return;
  clearTimeout(convSaveTimers[conv.id]);
  convSaveTimers[conv.id] = setTimeout(async () => {
    try {
      const r = await fetch(API_CONV, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(conv),
      });
      if (!r.ok) throw new Error("fail");
    } catch (e) {
      localStorage.setItem(
        "ai-chat-fallback-v3",
        JSON.stringify({ id: conv.id, data: conv }),
      );
    }
  }, 200);
}

function save(conv) {
  saveSettings();
  if (conv) saveConv(conv);
}

function mdBadge() {
  const s = state.settings;
  dm.modelBadge.textContent =
    s.apiUrl && s.apiKey && s.modelName ? s.modelName : "未配置模型";
  dm.settingsDot.classList.toggle(
    "active",
    !(s.apiUrl && s.apiKey && s.modelName),
  );
}
function toast(msg) {
  dm.toast.textContent = msg;
  dm.toast.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => dm.toast.classList.remove("show"), 2000);
}
function scrollEnd() {
  requestAnimationFrame(() => {
    dm.chatContainer.scrollTop = dm.chatContainer.scrollHeight;
  });
}
function resize() {
  dm.inputText.style.height = "auto";
  dm.inputText.style.height = Math.min(dm.inputText.scrollHeight, 200) + "px";
}
function hdrTitle() {
  const c = getConv();
  dm.convNameDisplay.textContent = c ? c.title : "新对话";
}

dm.apiProviderEl.addEventListener("change", () => {
  const p = PROVIDERS[dm.apiProviderEl.value];
  if (!p) return;
  dm.apiUrlEl.value = p.url;
  dm.modelNameEl.value = p.model;
  dm.apiKeyEl.placeholder = p.keyHint;
  if (p.keyHint === "无需 Key（留空）") dm.apiKeyEl.value = "";
  dm.reasoningEffort.value = p.reasoningEffort || "";
});

async function load() {
  try {
    const r = await fetch(API_SETTINGS);
    if (r.ok) {
      const d = await r.json();
      if (d && d.apiUrl !== undefined)
        state.settings = { ...state.settings, ...d };
    }
  } catch (e) {}

  let list = [];
  try {
    const r = await fetch(API_CONVERSATIONS);
    if (r.ok) list = await r.json();
  } catch (e) {}

  if (!list.length) {
    try {
      const raw = localStorage.getItem("ai-chat-fallback-v3");
      if (raw) {
        const d = JSON.parse(raw);
        if (d.data) {
          list = [
            {
              id: d.data.id,
              title: d.data.title || "新对话",
              createdAt: d.data.createdAt || Date.now(),
              updatedAt: d.data.updatedAt || Date.now(),
              messageCount: (d.data.messages || []).length,
            },
          ];
        }
      }
    } catch (e) {}
  }

  state.conversations = list.map((m) => ({
    id: m.id,
    title: m.title,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    messageCount: m.messageCount,
    messages: null,
    _loaded: false,
  }));

  if (!state.conversations.length) {
    const c = addConvLocal();
    await saveConv(c);
    state.conversations[0]._loaded = true;
  }

  const lid = localStorage.getItem("ai-chat-current-id");
  let targetConv = state.conversations.find((c) => c.id === lid);
  if (!targetConv) targetConv = state.conversations[0];

  await loadConv(targetConv.id);
  switchConv(targetConv.id);

  const fbSettings = localStorage.getItem("ai-chat-settings-fb");
  if (fbSettings) {
    try {
      state.settings = { ...state.settings, ...JSON.parse(fbSettings) };
      saveSettings();
      localStorage.removeItem("ai-chat-settings-fb");
    } catch (e) {}
  }
}

async function loadConv(id) {
  const conv = state.conversations.find((c) => c.id === id);
  if (!conv || conv._loaded) return;
  try {
    const r = await fetch(API_CONV + "?id=" + encodeURIComponent(id));
    if (r.ok) {
      const d = await r.json();
      Object.assign(conv, d);
    }
  } catch (e) {}
  conv._loaded = true;
}

function addConvLocal(title) {
  const c = {
    id: "c_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
    title: title || "新对话",
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    _loaded: true,
  };
  state.conversations.unshift(c);
  return c;
}

function addConv(title) {
  const c = addConvLocal(title);
  saveConv(c);
  return c;
}

function getConv() {
  return state.conversations.find((c) => c.id === state.currentId) || null;
}

async function switchConv(id) {
  if (state.isStreaming) return;
  const c = state.conversations.find((x) => x.id === id);
  if (!c) return;
  state.currentId = id;
  localStorage.setItem("ai-chat-current-id", id);
  if (!c._loaded) await loadConv(id);
  renderAll();
  scrollEnd();
}

function delConv(id) {
  if (state.isStreaming || state.conversations.length <= 1) {
    toast("至少保留一个对话");
    return;
  }
  const i = state.conversations.findIndex((c) => c.id === id);
  if (i < 0) return;
  state.conversations.splice(i, 1);
  fetch(API_CONV + "?id=" + encodeURIComponent(id), { method: "DELETE" }).catch(
    () => {},
  );
  clearTimeout(convSaveTimers[id]);
  delete convSaveTimers[id];
  if (state.currentId === id) {
    const n = state.conversations[Math.min(i, state.conversations.length - 1)];
    state.currentId = n.id;
    localStorage.setItem("ai-chat-current-id", n.id);
    if (!n._loaded) loadConv(n.id).then(() => renderAll());
    else renderAll();
  } else {
    renderAll();
  }
  toast("已删除");
}

function newChat() {
  if (state.isStreaming) return;
  const c = addConv();
  switchConv(c.id);
  renderAll();
  dm.inputText.focus();
  clsSidebar();
}

function delAllChats() {
  if (state.isStreaming || state.conversations.length === 0) return;
  if (!confirm("确定清空所有对话？")) return;
  state.conversations = [];
  for (const k of Object.keys(convSaveTimers)) {
    clearTimeout(convSaveTimers[k]);
    delete convSaveTimers[k];
  }
  fetch(API_CONV_CLEAR, { method: "POST" }).catch(() => {});
  const c = addConv();
  switchConv(c.id);
  renderAll();
  toast("已清空");
}

function clearMemory() {
  if (state.isStreaming) return;
  const c = getConv();
  if (!c) return;
  if (!c.memory || (c.memory.shortTerm.length === 0 && c.memory.longTerm.length === 0)) {
    toast("当前对话无记忆数据");
    return;
  }
  c.memory = { shortTerm: [], longTerm: [], lastMergedRound: 0 };
  save(c);
  renderMsgs();
  toast("记忆已清除");
}

function mtTitle(convId) {
  const c = state.conversations.find((x) => x.id === convId);
  if (!c || !c.messages || !c.messages.length) return;
  const um = c.messages.find((m) => m.role === "user");
  if (!um) return;
  let t = um.content.trim().replace(/\n/g, " ");
  c.title = t.length > 30 ? t.slice(0, 30) + "..." : t;
  c.updatedAt = Date.now();
  saveConv(c);
  renderAll();
}

function renderAll() {
  renderSidebar();
  renderMsgs();
  hdrTitle();
  mdBadge();
  dm.totalInfo.textContent = state.conversations.length + " 个对话";
}

function renderSidebar() {
  const sorted = [...state.conversations].sort(SORT_MODES[state.sortMode].fn);
  const df = document.createDocumentFragment();
  sorted.forEach((conv) => {
    const el = document.createElement("div");
    el.className =
      "conversation-item" + (conv.id === state.currentId ? " active" : "");
    el.dataset.id = conv.id;
    const ts = new Date(conv.updatedAt || conv.createdAt).toLocaleDateString(
      "zh-CN",
      { month: "short", day: "numeric" },
    );
    const delDisabled = state.isStreaming ? " disabled" : "";
    el.innerHTML =
      '<span class="conv-icon">💬</span><span class="conv-title">' +
      h(conv.title) +
      '</span><span class="conv-time">' +
      ts +
      '</span><button class="conv-delete" title="删除"' + delDisabled + '>✕</button>';
    df.appendChild(el);
  });
  dm.conversationList.innerHTML = "";
  dm.conversationList.appendChild(df);
}

function renderMsgs() {
  const container = dm.chatContainer;
  const prevDist = container.scrollHeight - container.scrollTop - container.clientHeight;
  dm.messagesContainer.querySelectorAll(".message").forEach((m) => m.remove());
  const conv = getConv(),
    msgs = conv && conv.messages ? conv.messages : [];
  if (!msgs.length) {
    dm.emptyState.style.display = "flex";
    return;
  }
  dm.emptyState.style.display = "none";
  const df = document.createDocumentFragment();
  msgs.forEach((msg, i) => {
    df.appendChild(buildMsg(msg, i, i === msgs.length - 1));
  });
  dm.messagesContainer.appendChild(df);
  container.scrollTop = container.scrollHeight - container.clientHeight - prevDist;
}

const COLLAPSE_LEN = 500;
function buildMsg(msg, idx, isLast) {
  const div = document.createElement("div");
  div.className =
    "message " +
    msg.role +
    (msg.streaming ? " streaming" : "") +
    (msg.error ? " error" : "");
  div.dataset.index = idx;
  const av = msg.role === "user" ? "U" : msg.role === "assistant" ? "AI" : "!";
  const rn =
    msg.role === "user" ? "你" : msg.role === "assistant" ? "AI" : "错误";
  const content = msg.content || "";
  const long = !msg.streaming && !isLast && content.length > COLLAPSE_LEN;
  const actions =
    msg.role !== "user" && !msg.streaming
      ? '<div class="message-actions"><button class="btn-msg-action" data-act="continue" title="继续补全">▶️</button><button class="btn-msg-action" data-act="retry" title="重新生成">🔄</button><button class="btn-msg-action" data-act="illustrate" title="配图">' + (msg.illustration ? "🖼️" : "🖼") + '</button><button class="btn-msg-action" data-act="copy" title="复制">📋</button></div>'
      : msg.role === "user"
        ? '<div class="message-actions"><button class="btn-msg-action" data-act="recall" title="撤回">↩️</button><button class="btn-msg-action" data-act="retry-user" title="重新发送">🔄</button><button class="btn-msg-action" data-act="copy" title="复制">📋</button></div>'
        : "";
  div.innerHTML =
    '<div class="message-avatar">' +
    av +
    '</div><div class="message-body"><div class="message-header"><span class="message-role">' +
    rn +
    '</span><span class="message-time">' +
    (msg.time || "") +
    "</span>" +
    (msg.streaming
      ? '<span class="status-badge streaming">生成中</span>'
      : "") +
    '</div><div class="message-content' +
    (long ? " collapsed" : "") +
    '">' +
    h(content) +
    "</div>" +
    (long ? '<div class="expand-bar"><button class="btn-expand">展开全部 ↓</button></div>' : "") +
    actions +
    "</div>";
  // 如果是 AI 回复且存在对应轮次的 STM，附加记忆面板
  if (msg.role === "assistant" && !msg.streaming && !msg.error) {
    var _conv = getConv();
    if (_conv && _conv.memory) {
      var _round = 0;
      var _msgs = _conv.messages;
      for (var _j = 0; _j <= idx; _j++) {
        if (_msgs[_j].role === "user") _round++;
      }
      var _panelHTML = typeof buildMemoryPanelHTML === "function" ? buildMemoryPanelHTML(_conv, _round) : "";
      if (_panelHTML) {
        div.querySelector(".message-body").insertAdjacentHTML("beforeend", _panelHTML);
      }
    }
  }
  if (msg.role === "assistant" && !msg.streaming && msg.illustration) {
    var _conv = getConv();
    var _convId = _conv ? _conv.id : "";
    var _img = document.createElement("div");
    _img.className = "message-illustration";
    // t=createdAt 作 cache buster：每次重新生成 createdAt 变 → URL 变 → 浏览器重新加载新图，
    // 避免同 URL 命中缓存显示旧图。图未变时 createdAt 不变，仍可享缓存。
    var _t = msg.illustration.createdAt || "";
    _img.innerHTML = '<img src="/api/illustration?conv=' + encodeURIComponent(_convId) + '&idx=' + idx + '&t=' + _t + '" loading="lazy" onerror="this.parentNode.innerHTML=\'<span class=\\\'ill-placeholder\\\'>[插图加载失败]</span>\'">';
    div.querySelector(".message-body").appendChild(_img);
  }
  return div;
}

dm.messagesContainer.addEventListener("click", (e) => {
  const expandBtn = e.target.closest(".btn-expand");
  if (expandBtn) {
    e.stopPropagation();
    const contentEl = expandBtn.closest(".message-body").querySelector(".message-content");
    if (contentEl.classList.contains("collapsed")) {
      contentEl.classList.remove("collapsed");
      expandBtn.textContent = "收起 ↑";
    } else {
      contentEl.classList.add("collapsed");
      expandBtn.textContent = "展开全部 ↓";
      contentEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    return;
  }
  const btn = e.target.closest(".btn-msg-action");
  if (!btn) return;
  e.stopPropagation();
  const msgEl = btn.closest(".message");
  if (!msgEl) return;
  const idx = parseInt(msgEl.dataset.index);
  const act = btn.dataset.act;
  switch (act) {
    case "continue":
      contMsg(idx);
      break;
    case "recall":
      recallMsg(idx);
      break;
    case "retry":
      retryMsg(idx);
      break;
    case "retry-user":
      retryUserMsg(idx);
      break;
    case "copy":
      copyMsg(idx);
      break;
    case "illustrate":
      openIllustrate(idx);
      break;
  }
});

dm.conversationList.addEventListener("click", (e) => {
  const del = e.target.closest(".conv-delete");
  if (del) {
    e.stopPropagation();
    delConv(del.closest(".conversation-item").dataset.id);
    return;
  }
  const item = e.target.closest(".conversation-item");
  if (!item) return;
  if (item.dataset.id !== state.currentId) {
    switchConv(item.dataset.id);
    clsSidebar();
  }
});

function updateMsgContent(idx, content, streaming) {
  const el = dm.messagesContainer.querySelector(
    '.message[data-index="' + idx + '"]',
  );
  if (!el) return;
  el.querySelector(".message-content").textContent = content;
  if (streaming) {
    el.classList.add("streaming");
    if (!el.querySelector(".status-badge")) {
      const b = document.createElement("span");
      b.className = "status-badge streaming";
      b.textContent = "生成中";
      el.querySelector(".message-header").appendChild(b);
    }
  } else {
    el.classList.remove("streaming");
    const b = el.querySelector(".status-badge");
    if (b) b.remove();
  }
}

function recallMsg(i) {
  if (state.isStreaming) return;
  const c = getConv();
  if (!c) return;
  c.messages.splice(i, i < c.messages.length - 1 ? 2 : 1);
  // 清理被撤回轮次对应的记忆数据
  if (c.memory) {
    const totalRounds = c.messages.filter(function(m) { return m.role === "user"; }).length;
    c.memory.shortTerm = c.memory.shortTerm.filter(function(s) { return s.round <= totalRounds; });
    if (c.memory.lastMergedRound > totalRounds) {
      c.memory.lastMergedRound = totalRounds;
      c.memory.longTerm = c.memory.longTerm.filter(function(l) {
        var parts = l.roundsCovered.split("-");
        return parseInt(parts[parts.length - 1]) <= totalRounds;
      });
    }
  }
  c.updatedAt = Date.now();
  save(c);
  renderMsgs();
  hdrTitle();
  toast("已撤回");
}
function retryMsg(i) {
  if (state.isStreaming) return;
  const c = getConv();
  if (!c) return;
  let ui = -1;
  for (let j = i - 1; j >= 0; j--) {
    if (c.messages[j].role === "user") {
      ui = j;
      break;
    }
  }
  if (ui >= 0) {
    const uc = c.messages[ui].content;
    c.messages.splice(ui);
    // 清理被移除轮次对应的记忆数据
    if (c.memory) {
      var tr2 = c.messages.filter(function(m) { return m.role === "user"; }).length;
      c.memory.shortTerm = c.memory.shortTerm.filter(function(s) { return s.round <= tr2; });
      if (c.memory.lastMergedRound > tr2) c.memory.lastMergedRound = tr2;
      c.memory.longTerm = c.memory.longTerm.filter(function(l) {
        var parts = l.roundsCovered.split("-");
        return parseInt(parts[parts.length - 1]) <= tr2;
      });
    }
    c.updatedAt = Date.now();
    save(c);
    renderMsgs();
    sendMsg(uc);
  }
}
function retryUserMsg(i) {
  if (state.isStreaming) return;
  const c = getConv();
  if (!c) return;
  const uc = c.messages[i].content;
  c.messages.splice(i);
  // 清理被移除轮次对应的记忆数据
  if (c.memory) {
    var tr3 = c.messages.filter(function(m) { return m.role === "user"; }).length;
    c.memory.shortTerm = c.memory.shortTerm.filter(function(s) { return s.round <= tr3; });
    if (c.memory.lastMergedRound > tr3) c.memory.lastMergedRound = tr3;
    c.memory.longTerm = c.memory.longTerm.filter(function(l) {
      var parts = l.roundsCovered.split("-");
      return parseInt(parts[parts.length - 1]) <= tr3;
    });
  }
  c.updatedAt = Date.now();
  save(c);
  renderMsgs();
  sendMsg(uc);
}
function contMsg(i) {
  if (state.isStreaming) return;
  const c = getConv();
  if (!c) return;
  const am = c.messages[i];
  if (!am || am.role !== "assistant") return;
  const ll = am.content.trim().split("\n").pop().slice(-60);
  c.updatedAt = Date.now();
  save(c);
  renderMsgs();
  sendMsg("继续，请直接从「" + ll + "」后面续写完整，不要重复已有内容。");
}
function copyMsg(i) {
  const c = getConv();
  if (!c) return;
  const t = c.messages[i].content;
  navigator.clipboard
    .writeText(t)
    .then(() => toast("已复制"))
    .catch(() => {
      const ta = document.createElement("textarea");
      ta.value = t;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      toast("已复制");
    });
}

async function sendMsg(content) {
  if (!content.trim() || state.isStreaming) return;
  const { apiUrl, apiKey, modelName: model, stream } = state.settings;
  if (!apiUrl || !apiKey || !model) {
    toast("请先配置 API 信息");
    dm.settingsBtn.click();
    return;
  }
  let conv = getConv();
  if (!conv) return;
  state.isStreaming = true;
  renderSidebar();
  dm.sendBtn.className = "btn-stop";
  dm.sendBtn.textContent = "■";
  dm.sendBtn.title = "停止生成";
  dm.sendBtn.disabled = false;
  dm.inputText.disabled = true;
  const time = new Date().toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
  let fullContent = content.trim();
  if (state.uploadedFiles.length) {
    const fileTexts = state.uploadedFiles.map((f) => "【" + f.name + "】\n" + f.content).join("\n\n");
    fullContent = fullContent ? fileTexts + "\n\n" + fullContent : fileTexts;
    state.uploadedFiles = [];
    dm.uploadedFiles.innerHTML = "";
  }
  conv.messages.push({
    role: "user",
    content: fullContent,
    time,
    id: Date.now() + "_" + Math.random().toString(36).slice(2, 6),
  });
  const first = conv.messages.filter((m) => m.role === "user").length === 1;
  conv.messages.push({
    role: "assistant",
    content: "",
    time: "",
    streaming: true,
    id: Date.now() + "_" + Math.random().toString(36).slice(2, 6),
  });
  conv.updatedAt = Date.now();
  save(conv);
  dm.inputText.value = "";
  resize();
  renderMsgs();
  scrollEnd();
  if (first) mtTitle(conv.id);
  const aiIdx = conv.messages.length - 1;
  try {
    state.abortController = new AbortController();
    if (stream) await streamCall(model, aiIdx, conv);
    else await normalCall(model, aiIdx, conv);
  } catch (err) {
    const ct =
      err.name === "AbortError" ? "[已取消]" : err.message || "请求失败";
    conv.messages[aiIdx] = {
      ...conv.messages[aiIdx],
      content: ct,
      streaming: false,
      error: err.name !== "AbortError",
    };
    if (err.name === "AbortError") toast("已取消");
    else toast("请求失败: " + err.message);
    save(conv);
    renderMsgs();
  } finally {
    state.isStreaming = false;
    renderSidebar();
    state.abortController = null;
    dm.sendBtn.className = "btn-send";
    dm.sendBtn.textContent = "➤";
    dm.sendBtn.title = "";
    dm.inputText.disabled = false;
    // 触发记忆更新（异步，不影响用户体验）
    var _convForMemory = conv;
    var _convIdForMemory = conv.id;
    var _settingsForMemory = { ...state.settings };
    setTimeout(function() {
      triggerMemoryUpdate(_convForMemory, _settingsForMemory).then(function() {
        save(_convForMemory);
        if (state.currentId === _convIdForMemory) renderMsgs();
      });
    }, 500);
    dm.inputText.focus();
  }
}

// 非流式调用链: messages → injectSystemPrompt → buildBody → callLLM → extractContent → formatContent
async function normalCall(model, aiIdx, conv) {
  const { apiUrl, apiKey } = state.settings;
  const chain = pipe(
    injectSystemPrompt(conv),
    buildRequestBody(model, false),
    callLLM(apiUrl, apiKey),
    extractContent,
    formatContent
  );
  const content = await chain(conv.messages);
  const time = new Date().toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
  conv.messages[aiIdx] = {
    ...conv.messages[aiIdx],
    content,
    streaming: false,
    time,
  };
  conv.updatedAt = Date.now();
  save(conv);
  renderMsgs();
}

// 流式调用: 前半段用 pipe，后半段用异步生成器逐块输出
async function streamCall(model, aiIdx, conv) {
  const { apiUrl, apiKey } = state.settings;
  const prepareBody = pipe(injectSystemPrompt(conv), buildRequestBody(model, true));
  const body = await prepareBody(conv.messages);
  const response = await callLLM(apiUrl, apiKey)(body);

  let fc = "";
  for await (const delta of streamContent(response)) {
    fc += delta;
    conv.messages[aiIdx].content = fc;
    updateMsgContent(aiIdx, fc, true);
  }
  const time = new Date().toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
  conv.messages[aiIdx] = {
    ...conv.messages[aiIdx],
    content: fc,
    streaming: false,
    time,
  };
  conv.updatedAt = Date.now();
  save(conv);
  renderMsgs();
}

dm.uploadBtn.addEventListener("click", () => dm.fileInput.click());
dm.fileInput.addEventListener("change", () => {
  const files = [...dm.fileInput.files];
  if (!files.length) return;
  let loaded = 0;
  files.forEach((f) => {
    const reader = new FileReader();
    reader.onload = () => {
      state.uploadedFiles.push({ name: f.name, content: reader.result });
      loaded++;
      if (loaded === files.length) {
        renderUploadedFiles();
        dm.sendBtn.disabled = !(dm.inputText.value.trim() || state.uploadedFiles.length);
        toast("已添加 " + files.length + " 个文件");
      }
    };
    reader.onerror = () => { loaded++; toast("读取失败: " + f.name); };
    reader.readAsText(f);
  });
  dm.fileInput.value = "";
});
function renderUploadedFiles() {
  dm.uploadedFiles.innerHTML = "";
  if (!state.uploadedFiles.length) return;
  const df = document.createDocumentFragment();
  state.uploadedFiles.forEach((f, i) => {
    const chip = document.createElement("span");
    chip.className = "file-chip";
    chip.dataset.index = i;
    chip.innerHTML = '<span class="file-name">' + h(f.name) + '</span><button class="file-remove" title="移除">✕</button>';
    df.appendChild(chip);
  });
  dm.uploadedFiles.appendChild(df);
}
dm.uploadedFiles.addEventListener("click", (e) => {
  const btn = e.target.closest(".file-remove");
  if (!btn) return;
  const chip = btn.closest(".file-chip");
  const i = parseInt(chip.dataset.index);
  state.uploadedFiles.splice(i, 1);
  renderUploadedFiles();
  dm.sendBtn.disabled = !(dm.inputText.value.trim() || state.uploadedFiles.length);
});
dm.inputText.addEventListener("input", () => {
  resize();
  dm.sendBtn.disabled = !(dm.inputText.value.trim() || state.uploadedFiles.length);
});
dm.inputText.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if ((dm.inputText.value.trim() || state.uploadedFiles.length) && !state.isStreaming)
      sendMsg(dm.inputText.value);
  }
});
dm.sendBtn.addEventListener("click", () => {
  if (state.isStreaming) {
    state.abortController && state.abortController.abort();
    return;
  }
  if ((dm.inputText.value.trim() || state.uploadedFiles.length) && !state.isStreaming)
    sendMsg(dm.inputText.value);
});

dm.settingsBtn.addEventListener("click", async () => {
  // 拉取 MP 配置填充折叠区
  try {
    const r = await fetch("/api/memory/config");
    if (r.ok) {
      const cfg = await r.json();
      document.getElementById("mpEnabled").checked = cfg.enabledModules?.canon !== false;
      document.getElementById("mpWorkingTokens").value = cfg.workingMemoryTokens || 32000;
      document.getElementById("mpContinuityEnabled").checked = cfg.continuity?.enabled !== false;
      document.getElementById("mpExtractionModel").value = cfg.extractionModel || "";
    }
  } catch {}
  dm.apiUrlEl.value = state.settings.apiUrl || "";
  dm.apiKeyEl.value = state.settings.apiKey || "";
  dm.modelNameEl.value = state.settings.modelName || "";
  dm.streamToggle.checked = state.settings.stream !== false;
  dm.reasoningEffort.value = state.settings.reasoningEffort || "";
  dm.tempEl.value = state.settings.temperature || "";
  dm.maxTokensEl.value = state.settings.maxTokens || "";
  dm.topPEl.value = state.settings.topP || "";
  dm.freqPenaltyEl.value = state.settings.frequencyPenalty || "";
  dm.presPenaltyEl.value = state.settings.presencePenalty || "";
  const su = state.settings.apiUrl || "";
  const m = Object.entries(PROVIDERS).find(([, p]) =>
    su.startsWith(
      p.url
        .replace("/v1/chat/completions", "")
        .replace("/chat/completions", ""),
    ),
  );
  dm.apiProviderEl.value = m ? m[0] : "";
  dm.settingsModal.classList.add("active");
});
function clsSet() {
  dm.settingsModal.classList.remove("active");
}
dm.modalCloseBtn.addEventListener("click", clsSet);
dm.cancelBtn.addEventListener("click", clsSet);
dm.settingsModal.addEventListener("click", (e) => {
  if (e.target === dm.settingsModal) clsSet();
});
dm.saveSettingsBtn.addEventListener("click", () => {
  let u = dm.apiUrlEl.value.trim();
  if (u && !/\/chat\/completions\/?$/.test(u)) {
    // 只对没有具体路径的 base URL 自动补全，已有自定义路径的不动
    const match = u.match(/^https?:\/\/[^\/]+(\/.*)?$/);
    const path = match ? (match[1] || "") : "";
    if (!path || /^\/v1\/?$/.test(path)) {
      u = u.replace(/\/+$/, "");
      if (!/\/v1$/.test(u)) u += "/v1";
      u += "/chat/completions";
      dm.apiUrlEl.value = u;
    }
  }
  state.settings.apiUrl = u;
  state.settings.apiKey = dm.apiKeyEl.value.trim();
  state.settings.modelName = dm.modelNameEl.value.trim();
  state.settings.stream = dm.streamToggle.checked;
  state.settings.reasoningEffort = dm.reasoningEffort.value;
  state.settings.temperature = dm.tempEl.value.trim();
  state.settings.maxTokens = dm.maxTokensEl.value.trim();
  state.settings.topP = dm.topPEl.value.trim();
  state.settings.frequencyPenalty = dm.freqPenaltyEl.value.trim();
  state.settings.presencePenalty = dm.presPenaltyEl.value.trim();
  // 提交 MP 配置到 /api/memory/config
  try {
    const mpBody = {
      workingMemoryTokens: parseInt(document.getElementById("mpWorkingTokens").value) || 32000,
      extractionModel: document.getElementById("mpExtractionModel").value.trim(),
    };
    fetch("/api/memory/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mpBody),
    });
  } catch {}
  saveSettings();
  clsSet();
  toast("已保存");
});
dm.resetSettingsBtn.addEventListener("click", () => {
  if (confirm("重置所有设置？")) {
    dm.apiProviderEl.value = "";
    dm.apiUrlEl.value = "";
    dm.apiKeyEl.value = "";
    dm.modelNameEl.value = "";
    dm.apiKeyEl.placeholder = "sk-...";
    dm.streamToggle.checked = true;
    dm.reasoningEffort.value = "medium";
    dm.tempEl.value = "";
    dm.maxTokensEl.value = "";
    dm.topPEl.value = "";
    dm.freqPenaltyEl.value = "";
    dm.presPenaltyEl.value = "";
    dm.saveSettingsBtn.click();
    toast("已重置");
  }
});

dm.renameBtn.addEventListener("click", () => {
  const c = getConv();
  if (!c) return;
  dm.renameInput.value = c.title;
  dm.renameModal.classList.add("active");
  setTimeout(() => dm.renameInput.focus(), 100);
});
function clsRen() {
  dm.renameModal.classList.remove("active");
}
dm.renameCloseBtn.addEventListener("click", clsRen);
dm.renameCancelBtn.addEventListener("click", clsRen);
dm.renameModal.addEventListener("click", (e) => {
  if (e.target === dm.renameModal) clsRen();
});
dm.renameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    dm.renameSaveBtn.click();
  }
  if (e.key === "Escape") clsRen();
});
dm.renameSaveBtn.addEventListener("click", () => {
  const c = getConv();
  if (!c) return;
  c.title = dm.renameInput.value.trim() || "新对话";
  saveConv(c);
  renderAll();
  clsRen();
  toast("已重命名");
});

dm.sortBtn.addEventListener("click", () => {
  state.sortMode = (state.sortMode + 1) % SORT_MODES.length;
  dm.sortBtn.textContent = ["⇅", "↓", "↑", "AZ", "ZA"][state.sortMode];
  dm.sortBtn.title = SORT_MODES[state.sortMode].label;
  renderSidebar();
});
dm.newChatBtn.addEventListener("click", newChat);
dm.clearAllBtn.addEventListener("click", delAllChats);
dm.clearMemoryBtn.addEventListener("click", clearMemory);

function opnSidebar() {
  dm.sidebar.classList.add("open");
  dm.sidebarOverlay.classList.add("active");
}
function clsSidebar() {
  dm.sidebar.classList.remove("open");
  dm.sidebarOverlay.classList.remove("active");
}
dm.menuBtn.addEventListener("click", opnSidebar);
dm.closeSidebarBtn.addEventListener("click", clsSidebar);
dm.sidebarOverlay.addEventListener("click", clsSidebar);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (dm.settingsModal.classList.contains("active")) clsSet();
    if (dm.renameModal.classList.contains("active")) clsRen();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    if ((dm.inputText.value.trim() || state.uploadedFiles.length) && !state.isStreaming)
      sendMsg(dm.inputText.value);
  }
});

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
  const radio = document.querySelector('input[name="illSource"]:checked');
  const mode = radio ? radio.value : "extract";
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
    // server.js: 成功 200 返回 {illustration:{engine}}（无 ok 字段），
    // 失败 500 返回 {error}（无 ok 字段）。故成功判断只用 r.ok，不能用 d.ok。
    if (!r.ok) throw new Error(d.error || "画图失败");
    // 按 convId 定位对话（异步期间用户可能已切换对话）
    const c = state.conversations.find((x) => x.id === convId);
    if (c && c.messages[msgIdx]) {
      c.messages[msgIdx].illustration = {
        engine: d.illustration?.engine, prompt, createdAt: Date.now(),
      };
      save(c);
    }
    // 直接关闭，绕过 clsIll 的 isIllustrating 守卫（该守卫仅用于阻止用户在生成中手动关闭）
    dm.illustrateModal.classList.remove("active");
    state.illustrateTarget = null;
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

load();
dm.sortBtn.title = SORT_MODES[state.sortMode].label;
renderAll();
dm.inputText.focus();
window.addEventListener("resize", resize);

// ── 记忆控制台 drawer ──
(function memConsole() {
  const root = document.getElementById("memConsole");
  const bar = document.getElementById("memConsoleBar");
  const body = document.getElementById("memConsoleBody");
  const toggle = document.getElementById("memConsoleToggle");
  if (!root || !bar || !body || !toggle) return;
  let polling = false;
  let sinceTs = 0;
  let timer = null;
  let filters = { info: true, warn: true, error: true };
  const updateFilters = () => {
    document.querySelectorAll(".mem-console-filters input").forEach(c => {
      filters[c.dataset.level] = c.checked;
    });
  };
  document.querySelectorAll(".mem-console-filters input").forEach(c =>
    c.addEventListener("change", () => { updateFilters(); })
  );
  async function poll() {
    if (!polling) return;
    try {
      const r = await fetch("/api/memory/log?since=" + sinceTs + "&limit=200");
      if (r.ok) {
        const d = await r.json();
        (d.logs || []).forEach(l => {
          if (!filters[l.level]) return;
          const div = document.createElement("div");
          div.className = "mem-log-line " + l.level;
          const time = new Date(l.ts).toLocaleTimeString("zh-CN", { hour12: false });
          div.textContent = "[" + time + "] " + l.text;
          body.appendChild(div);
          sinceTs = Math.max(sinceTs, l.ts);
        });
        while (body.childNodes.length > 500) body.removeChild(body.firstChild);
        body.scrollTop = body.scrollHeight;
      }
    } catch {}
    if (polling) timer = setTimeout(poll, 2000);
  }
  bar.addEventListener("click", (e) => {
    if (e.target.tagName === "INPUT" || e.target === toggle) return;
    const collapsed = root.classList.toggle("collapsed");
    toggle.textContent = collapsed ? "▲" : "▼";
    if (collapsed) { polling = false; if (timer) clearTimeout(timer); }
    else { polling = true; poll(); }
  });
})();
