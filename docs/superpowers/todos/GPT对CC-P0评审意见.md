# GPT 给 DeepSeek 的 P1 后续修复意见

> 主题：`[FIX: memory-extraction-backlog]` / P1 pending + catch-up 后续小修
>
> 结论：DeepSeek 的 P1 主体方案已经落地，方向正确，可以进入最后小修阶段。当前只建议修两个边界问题：
>
> 1. DB pending 为 true 但进程内 Map 丢失时，pending 可能长期残留。
> 2. `runExtractionOnce()` 内部吞掉异常，外层 catch-up 可能误打 `complete` 日志。

---

## 一、总体判断

```text
P0：已修正，可以通过
P1：主体方案通过
剩余：两个边界小修
```

当前远端已经实现了我们讨论的核心结构：

```text
1. db.ts 增加 extraction_pending migration
2. session-store.ts 增加 setExtractionPending / getExtractionPending
3. Session 类型补 extraction_pending 字段
4. memory-handler.ts 增加 pendingExtractionMap
5. sentinel fresh 时不再无痕 skip，而是 mark pending + 存最新 messages
6. scheduleExtraction 抽出 runExtractionOnce
7. normal extraction 完成后检查 pending 并触发 catch-up
8. catch-up 使用同一套 extraction / diff / chunk / sentinel / fingerprint 主流程
9. catch-up 不递归
```

这说明 P1 的大方向已经对齐，可以继续推进小修，而不是推倒重写。

---

## 二、需要修的问题 1：pending=true 但 Map 丢失时可能长期残留

### 现状

当前逻辑大致是：

```ts
if (getExtractionPending(sessionId)) {
  const pending = pendingExtractionMap.get(sessionId);
  if (pending) {
    setExtractionPending(sessionId, false);
    pendingExtractionMap.delete(sessionId);
    await runExtractionOnce(...pending...);
  }
}
```

也就是说，只有 `pendingExtractionMap` 中有 snapshot 时，才会清掉 DB 里的 `extraction_pending`。

### 风险

如果服务在 pending=true 之后重启：

```text
DB: extraction_pending = true 仍然存在
Map: pendingExtractionMap 已经丢失
```

下一次真实用户请求触发 normal extraction 时，normal extraction 本身会拿到当前最新 `requestMessages`，并且可以正常追上最新内容。

但是 normal extraction 完成后，如果进入 pending 检查：

```ts
const pending = pendingExtractionMap.get(sessionId); // undefined
```

当前代码如果什么都不做，就可能导致：

```text
extraction_pending 永远保持 true
后续每次都检查到 pending，但没有 Map snapshot 可用
日志和状态长期不干净
```

### 建议修法

在 pending flag 为 true 但 Map 不存在时，加一个明确分支。

建议逻辑：

```ts
if (getExtractionPending(sessionId)) {
  const pending = pendingExtractionMap.get(sessionId);

  if (!pending) {
    console.log('[MemoryProxy] Pending extraction flag set but no pending snapshot; clearing flag after normal extraction');
    setExtractionPending(sessionId, false);
    return;
  }

  setExtractionPending(sessionId, false);
  pendingExtractionMap.delete(sessionId);
  console.log('[MemoryProxy] Pending extraction detected; starting catch-up');
  ...
}
```

### 为什么可以清 pending？

因为这个检查发生在 normal extraction 完成之后。

如果服务重启导致 Map 丢失，那么下一次真实用户请求携带的是最新 `requestMessages`。normal extraction 已经基于这份最新消息运行过。此时没有 Map snapshot 可用于额外 catch-up，保留 pending 只会制造脏状态。

### 注意

这个分支只应该放在：

```text
normal extraction 完成之后的 pending 检查处
```

不要在 sentinel fresh 的 skip 分支里清 pending。sentinel fresh 时必须继续：

```ts
pendingExtractionMap.set(sessionId, { messages: [...requestMessages], responseText });
setExtractionPending(sessionId, true);
return;
```

---

## 三、需要修的问题 2：catch-up 失败时可能误报 complete

### 现状

当前 catch-up 外层逻辑大致是：

```ts
try {
  await runExtractionOnce(..., 'catchup');
  console.log('[MemoryProxy] Catch-up extraction complete');
} catch (e) {
  console.error('[MemoryProxy] Catch-up extraction failed:', e);
}
```

但 `runExtractionOnce()` 内部自己有：

```ts
try {
  ... extraction 主流程 ...
} catch (err) {
  console.error(`[MemoryProxy] Extraction error (${source}):`, err);
  try { clearExtractionSentinel(...) } catch {}
}
```

也就是说，`runExtractionOnce()` 内部 catch 了异常，并不一定会 rethrow。

结果是：

```text
runExtractionOnce 内部已经失败
但外层 await 没收到 throw
外层仍然打印 Catch-up extraction complete
```

这会误导日志排查。

### 建议修法

让 `runExtractionOnce()` 返回结构化结果，而不是只返回 `void`。

建议类型：

```ts
type ExtractionRunResult = {
  ok: boolean;
  skipped: boolean;
  facts: number;
  events: number;
  chunks: number;
  chunksFailed: number;
  source: 'normal' | 'catchup';
  reason?: string;
};
```

### 建议返回规则

#### 1. 没有新消息

```ts
return {
  ok: true,
  skipped: true,
  facts: 0,
  events: 0,
  chunks: 0,
  chunksFailed: 0,
  source,
  reason: 'no-new-messages',
};
```

#### 2. 所有 chunk 成功

```ts
return {
  ok: true,
  skipped: false,
  facts: totalFacts,
  events: totalEvents,
  chunks: chunks.length,
  chunksFailed: 0,
  source,
};
```

#### 3. 部分 chunk 失败

```ts
return {
  ok: false,
  skipped: false,
  facts: totalFacts,
  events: totalEvents,
  chunks: chunks.length,
  chunksFailed,
  source,
  reason: 'chunk-failed',
};
```

#### 4. 顶层异常

```ts
return {
  ok: false,
  skipped: false,
  facts: 0,
  events: 0,
  chunks: 0,
  chunksFailed: 0,
  source,
  reason: err instanceof Error ? err.message : String(err),
};
```

---

## 四、catch-up 外层日志建议

把 catch-up 外层改成根据 `ExtractionRunResult` 打日志。

建议逻辑：

```ts
const result = await runExtractionOnce(..., 'catchup');

if (result.skipped) {
  console.log('[MemoryProxy] Catch-up extraction skipped — no new messages');
} else if (!result.ok) {
  console.warn(`[MemoryProxy] Catch-up extraction did not complete cleanly — reason=${result.reason || 'unknown'} chunksFailed=${result.chunksFailed}`);
  // 注意：这里不需要立刻 set pending true。
  // fingerprint 没推进时，下次 normal extraction 会重试。
} else {
  console.log(`[MemoryProxy] Catch-up extraction complete: ${result.facts} facts, ${result.events} events (${result.chunks} chunk(s))`);
}
```

### 为什么不建议 catch-up 失败时立刻重新 set pending=true？

因为如果 chunk 失败，`runExtractionOnce()` 内部应该已经：

```text
不推进 fingerprint
clearExtractionSentinel(... previousFingerprint)
```

下一次真实用户请求的 normal extraction 会基于旧 fingerprint 自动重试。

如果 catch-up 失败后立刻 set pending=true，可能会造成：

```text
pending 状态反复被保留
但 Map snapshot 可能已经被 delete
后续状态更难判断
```

所以第一版建议：

```text
catch-up 失败只打清晰日志
依靠 fingerprint 未推进 + 下一轮 normal extraction 重试
```

---

## 五、不要改动的部分

DeepSeek 这次 P1 的主体结构是对的，不建议大改。

不要动：

```text
P0 repair fast path
forwardUpstreamRequest
replace_branch watchdog
Prompt Compiler
世界书预算裁剪
memory retrieval / continuity 注入逻辑
extraction prompt / chunk 参数
```

这次只做两个边界小修：

```text
1. pending=true 但 Map 缺失时清 flag
2. runExtractionOnce 返回结构化结果，避免 catch-up 误报 complete
```

---

## 六、修完后的验收日志

期望看到：

```text
[MemoryProxy] Extraction already in-progress; marked pending catch-up
[MemoryProxy] Pending extraction detected; starting catch-up
[MemoryProxy] Catch-up extraction complete: X facts, Y events (N chunk(s))
```

边界情况下应该看到：

```text
[MemoryProxy] Pending extraction flag set but no pending snapshot; clearing flag after normal extraction
```

失败情况下应该看到：

```text
[MemoryProxy] Catch-up extraction did not complete cleanly — reason=chunk-failed chunksFailed=1
```

不应该出现：

```text
Catch-up extraction complete
```

但同一轮前面实际已经有：

```text
Extraction error (catchup)
Chunk extraction failed
Fingerprint NOT saved
```

---

## 七、最终建议

```text
DeepSeek 当前 P1 主体通过。
不要推倒重写。
只补两个边界问题，然后交给 GPT 做最终 review。
```

推荐提交信息：

```text
fix(memory): harden extraction catch-up edge cases
```
