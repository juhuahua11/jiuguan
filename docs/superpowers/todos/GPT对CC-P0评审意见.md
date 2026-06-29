# GPT 对 CC P0 repair 绕过实现的评审意见

> 主题：`[FIX: memory-extraction-backlog]` / P0 repair 请求绕过 memory side effects
>
> 结论：P0 方向正确，核心目标基本达成，但 fast path 的上游请求复用 / timeout 逻辑需要小修。

---

## 一、总体结论

```text
P0 repair 绕过 memory side effects：基本完成
但 fast path 的 timeout / fetch 复用实现还需要修一下
```

当前实现已经达成：

```text
repair 请求不会进入 DB 初始化
repair 请求不会 resolve session
repair 请求不会递增 round
repair 请求不会触发 keyword / continuity / memory retrieval
repair 请求不会 scheduleExtraction
```

但 fast path 目前手写了一套 fetch/timer 逻辑，没有真正复用主路径 `fetchOnce`，这一点需要修。

---

## 二、已确认正确的地方

### 1. `memory/adapter.js` 已经加内部标记

`makeRepairBody()` 中已经加：

```js
jiuguan_internal_repair: true
```

这是正确的。

### 2. `memory-handler.ts` 的 fast path 放置位置正确

fast path 放在：

```text
messages 验证之后
ensureDb / session 初始化之前
```

这意味着 repair 请求不会进入 DB/session/round/memory/extraction 主链路。

### 3. 内部字段已剥离

fast path 里剥掉了：

```ts
jiuguan_internal_repair
chat_id
```

这可以避免上游看到内部字段，也避免 repair 被当成真实会话。

---

## 三、需要修的问题

### 问题 1：fast path 没有真正复用主路径 `fetchOnce`

共享文档里的共识是：

```text
fast path 应复用主路径 fetchOnce / 上游请求 helper
```

原因是主路径已经处理了：

```text
first-byte timeout
total timeout
retry
upstreamAgent
错误响应格式
provider-specific 参数
```

但当前 fast path 实际上重新写了一套 fetch/timer 逻辑。

这会导致 fast path 和普通请求行为分叉。

---

### 问题 2：repair 请求可能被错误地 30 秒超时

当前 fast path 逻辑近似是：

```ts
const firstByteTimer = setTimeout(() => firstByteController.abort(), FIRST_BYTE_TIMEOUT_MS);
const totalTimer = setTimeout(() => totalController.abort(), NONSTREAM_TIMEOUT_MS);
firstByteController.signal.addEventListener('abort', () => totalController.abort());

const res = await fetch(...);
const data = await res.json();

clearTimeout(firstByteTimer);
clearTimeout(totalTimer);
```

问题是：

```text
firstByteTimer 没有在 fetch 返回 headers 后立即清掉
```

这意味着：

```text
上游 30 秒内已经返回 headers
但完整 JSON 生成超过 30 秒
→ firstByteTimer 仍可能触发
→ totalController 被 abort
→ repair 请求被错误判为 timeout
```

实际效果可能变成：

```text
repair 总时长超过 30 秒就失败
```

而不是预期的：

```text
30 秒 first-byte timeout
5 分钟 total timeout
```

---

### 问题 3：fast path 没有主路径 retry

主路径对部分连接类错误有 retry，例如：

```text
UND_ERR_CONNECT_TIMEOUT
ECONNRESET
ENOTFOUND
EAI_AGAIN
HeadersTimeoutError
```

fast path 目前没有 retry。

这不是致命问题，但会导致：

```text
普通请求遇到瞬时连接问题会重试
repair 请求遇到同样问题直接失败
```

这不符合“fast path 复用主路径上游请求能力”的目标。

---

## 四、建议修法

### 推荐方案 A：抽公共 helper

把主路径上游请求逻辑抽成公共函数，例如：

```ts
forwardUpstreamOnly(requestBody, {
  wantStream,
  apiKey,
  upstreamUrl,
  upstreamPath,
  upstreamAgent,
})
```

然后：

```text
普通 memory 请求调用它
internal repair fast path 也调用它
```

这是最稳方案。

---

### 最小修法 B：至少修 first-byte timer

如果暂时不抽 helper，至少要在 fast path 里改成：

```ts
const res = await fetch(...);
clearTimeout(firstByteTimer); // fetch 返回 headers 后立刻清 first-byte timer
const data = await res.json();
```

并尽量补上和主路径一致的 retry 逻辑。

---

## 五、P0 是否可以进入 P1？

我的建议：

```text
不要立刻进入 P1。
先把 P0 fast path 的 fetch / timeout 问题修掉。
然后再让 DeepSeek 基于最新 main 做 P1 runExtractionOnce + pending/catch-up。
```

原因：P1 会继续改 `memory-handler.ts` 后半段。如果 P0 的 fast path 后续还要大改 helper，可能和 P1 的 handler 改动产生冲突。

---

## 六、最终判断

```text
P0 目标：达成
P0 位置：正确
P0 side effects 绕过：正确
P0 内部标记：正确
P0 上游请求复用：不够，需要小修
```

建议 CC 修完 fast path 后再通知 DeepSeek pull 最新 main。
