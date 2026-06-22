# 记忆宫殿已知问题（适配后修复）

记忆宫殿（src/memory.js）在 memory-proxy 适配完成后仍作为展示用摘要层共存。
以下为已知严重问题，适配完成后单独排期修复：

1. **v4 模型兼容**：callSummaryAPI（memory.js:5）只读 message.content，v4 推理模型常把答案放
   reasoning_content 导致 content 为空 → STM 静默全部失败。需加 reasoning_content fallback +
   reasoning_effort:'low'（参考 memory-handler.ts:806）。
2. **buildMemoryPrompt 从未被调用**：记忆宫殿当前不向 LLM 注入任何记忆，只生成摘要面板。
   需决定是否启用注入（若启用，注意与 memory-proxy 注入的去重/冲突）。
3. **无 token 上限**：buildMemoryPrompt 拼接所有 unmerged STM + 所有 LTM，长会话会撑爆上下文。
4. **LTM 合并空洞**：unmerged.slice(-7) 在 STM 有失败轮次时跨断层，lastMergedRound 单一阈值
   会让中间未合并 STM 永久丢失。改为记录已合并 round 集合。
5. **抽取温度偏高**：temperature:0.3 做结构化抽取易润色事实，建议降到 0。
6. **无增量/去重保护**：round 用 user 消息计数，swipe/重生成会漂移，漏抽或重复抽。
7. **JSON 解析脆弱**：extractJSON 一次失败即丢一轮，无修复/重试/降级。
8. **存储耦合**：记忆塞在 conv.memory 随对话 JSON 全量重写，无并发保护。
