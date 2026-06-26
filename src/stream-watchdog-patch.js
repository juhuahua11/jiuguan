
// Streaming watchdog patch:
// Keep normal token streaming, but allow the backend to send a jiuguan control event
// that replaces only the branch-option section at the end of the current assistant message.
(function () {
  const BRANCH_HEADER_RE = /【\s*下一步剧情发展推荐选项\s*】/;

  function replaceBranchSection(output, branchBlock) {
    const source = String(output || "").trimEnd();
    const block = String(branchBlock || "").trim();
    if (!block) return source;
    const m = source.match(BRANCH_HEADER_RE);
    if (!m || m.index == null) return source + "\n\n" + block;
    return source.slice(0, m.index).trimEnd() + "\n\n" + block;
  }

  streamContent = async function* patchedStreamContent(response) {
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
  };

  streamCall = async function patchedStreamCall(model, aiIdx, conv) {
    const { apiUrl, apiKey } = state.settings;
    const prepareBody = pipe(injectSystemPrompt(conv), buildRequestBody(model, true));
    const body = await prepareBody(conv.messages);
    const response = await callLLM(apiUrl, apiKey)(body);

    let fc = "";
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
  };
})();
