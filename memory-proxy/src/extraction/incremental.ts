import { createHash } from 'crypto';
import { ChatMessage } from '../types/provider.js';
import { encoding_for_model, TiktokenModel } from 'tiktoken';

/** 懒加载 tiktoken encoder，避免每次调用 chunkMessages 重建 */
let _encoder: ReturnType<typeof encoding_for_model> | null = null;
function getEncoder(): ReturnType<typeof encoding_for_model> {
  if (!_encoder) _encoder = encoding_for_model('gpt-4' as TiktokenModel);
  return _encoder;
}

/**
 * 计算消息数组的指纹（SHA256 前16位）。
 * 只取每条消息的 role + mes 前80字，轻量且稳定。
 */
export function computeFingerprint(messages: ChatMessage[], windowSize: number = 5): string {
  if (messages.length === 0) return '';
  const slice = messages.slice(-windowSize);
  const key = slice.map(m => `${m.role}:${(m.content || '').slice(0, 80)}`).join('|');
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * 计算最后一条 user 消息的锚点哈希。user 消息不会被 swipe/regenerate（只有 assistant
 * 会被），也不承载 ST 的 depth 注入（Author's Note / Summary / World Info 等通常是
 * system role 或注入在尾部窗口内）。因此最后一条 user 消息是比"尾部 5 条整体"更稳定
 * 的位置锚点，用于在 5 窗口指纹因 depth 注入漂移而失配时做 fallback 定位。
 *
 * 返回 `${hash}:${userIndexFromEnd}` 形式，索引部分帮助定位（容忍末尾的 assistant
 * 回复和注入条目）。找不到 user 消息返回 ''。
 */
export function computeUserAnchor(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      const key = `user:${(messages[i].content || '').slice(0, 80)}`;
      const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
      return `${hash}:${messages.length - 1 - i}`;
    }
  }
  return '';
}

/**
 * 在消息数组中滑动匹配指纹，返回指纹窗口结束的位置（即新消息开始的位置）。
 * 返回 -1 表示未找到匹配。
 */
export function findFingerprintPosition(
  messages: ChatMessage[],
  fingerprint: string,
  windowSize: number = 5
): number {
  if (!fingerprint || messages.length < windowSize) return 0;

  // Search from the END — fingerprint is computed from the tail of messages,
  // so the last match is the correct position (avoid re-extracting already-processed content)
  for (let i = messages.length - windowSize; i >= 0; i--) {
    const candidate = computeFingerprint(messages.slice(i, i + windowSize), windowSize);
    if (candidate === fingerprint) {
      return i + windowSize;
    }
  }
  return -1;
}

/**
 * 用 user 锚点定位"上次提取时的最后一条 user 消息"在新数组中的位置，返回该 user 消息
 * 之后的位置（即新消息开始处）。锚点格式为 `${hash}:${userIndexFromEnd}`。
 *
 * 容忍尾部偏移：上次记录的 userIndexFromEnd 是"距当时数组末尾的距离"，新数组末尾
 * 多了 assistant 回复 + 可能的 depth 注入，所以从末尾往前找 user 消息时，只要内容
 * 哈希匹配就接受（不要求 indexFromEnd 严格相等，只用作粗校验防止匹配到更早的同内容
 * user 消息——取最后一个匹配）。
 *
 * 返回 -1 表示未找到。
 */
export function findUserAnchorPosition(
  messages: ChatMessage[],
  anchor: string
): number {
  if (!anchor) return -1;
  const sep = anchor.lastIndexOf(':');
  if (sep < 0) return -1;
  const targetHash = anchor.slice(0, sep);
  if (!targetHash) return -1;
  // Search from the END so the LAST matching user message wins (mirrors fingerprint semantics).
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue;
    const key = `user:${(messages[i].content || '').slice(0, 80)}`;
    const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
    if (hash === targetHash) {
      return i + 1; // new messages start right after this user message
    }
  }
  return -1;
}

export interface DiffResult {
  /** 需要提取的新消息 */
  newMessages: ChatMessage[];
  /** 新消息在原数组中的起始索引 */
  startIndex: number;
  /** 指纹是否匹配成功 */
  found: boolean;
}

/**
 * 根据上次指纹从当前消息中差量提取新消息。
 * 定位优先级（最稳 → 最弱）：
 *  1. lastMessageCount：正常对话每轮 +2 条，count 单调递增。若新数组更长，直接从
 *     lastMessageCount 位置取新消息。比任何内容哈希都稳——不受 swipe/edit/depth 注入
 *     影响（它们改内容不改条数）。count 缩小（窗口裁剪/swipe 删条）时不采用。
 *  2. 5 窗口指纹匹配
 *  3. user 锚点（容忍 depth 注入漂移，但 swipe/edit user 消息会失配）
 *  4. fallback: 最后 fallbackCount 条
 * - 首次提取（空指纹） → 返回所有消息
 */
export function diffNewMessages(
  messages: ChatMessage[],
  fingerprint: string,
  fallbackCount: number = 50,
  userAnchor?: string,
  lastMessageCount?: number
): DiffResult {
  // 首次提取：无指纹 且 无有效 count → 真正从零开始，返回全部消息。
  // 但若空指纹却有 lastMessageCount（僵尸恢复场景：上一次提取崩溃，sentinel 被清空把
  // 指纹抹成空字符串，但 last_message_count 只在成功提取时更新、崩溃不动它），则不能全量——
  // 否则一次僵尸恢复会把 2329 条历史全切成 9 块重提取（18 次 LLM 调用）。此时落到下面的
  // count-based 定位，只取 count 之后的新消息（通常就是最后 2 条）。
  if (!fingerprint && !(typeof lastMessageCount === 'number' && lastMessageCount > 0)) {
    return { newMessages: [...messages], startIndex: 0, found: false };
  }

  // 1. count 优先定位 —— 最稳，正常对话每轮 +2 条。
  //    用 >= 而非 >：ST 每轮常发两个请求（流式+非流式），allMessages.length 相同。
  //    第二个请求来时 length === lastMessageCount，slice(lastMessageCount) 返回空
  //    → newMessages=[] → 调用方跳过提取。这避免了重复处理同一批消息并触发 50 条回退。
  //    只有当 count 明显偏小（窗口裁剪/swipe 删条）或偏大太多（stale count）时才放弃。
  if (typeof lastMessageCount === 'number' && lastMessageCount > 0 && messages.length >= lastMessageCount) {
    const newCount = messages.length - lastMessageCount;
    if (newCount <= fallbackCount) {
      // newCount === 0 means "already processed up to here" (e.g. the duplicate request
      // of a stream/non-stream pair). Return empty — caller skips. found=true so the
      // caller treats it as "matched, nothing new" rather than "fallback".
      return {
        newMessages: messages.slice(lastMessageCount),
        startIndex: lastMessageCount,
        found: true,
      };
    }
    // newCount too large — likely the count is stale (messages were re-added after a
    // trim/swipe). Fall through to fingerprint/anchor instead of trusting the count.
  }

  const pos = findFingerprintPosition(messages, fingerprint);

  if (pos !== -1) {
    // 无新消息
    if (pos >= messages.length) {
      return { newMessages: [], startIndex: pos, found: true };
    }
    return {
      newMessages: messages.slice(pos),
      startIndex: pos,
      found: true,
    };
  }

  // 2. 5 窗口指纹失配 —— 尝试 user 锚点 fallback（容忍 depth 注入漂移）
  if (userAnchor) {
    const anchorPos = findUserAnchorPosition(messages, userAnchor);
    if (anchorPos !== -1) {
      console.log(`[IncrementalExtraction] Fingerprint not found, but user anchor matched at ${anchorPos} — using anchor instead of fallback`);
      if (anchorPos >= messages.length) {
        return { newMessages: [], startIndex: anchorPos, found: true };
      }
      return {
        newMessages: messages.slice(anchorPos),
        startIndex: anchorPos,
        found: true,
      };
    }
  }

  // 3. 都未找到：ST 可能截断了历史或锚点也漂移，fallback 到最后 N 条
  const start = Math.max(0, messages.length - fallbackCount);
  console.log(`[IncrementalExtraction] Fingerprint and user anchor both not found, falling back to last ${messages.length - start} messages`);
  return {
    newMessages: messages.slice(start),
    startIndex: start,
    found: false,
  };
}

/**
 * 计算消息数组的完整性哈希（SHA256 前16位）。
 * 只采样前 MAX_SAMPLE_RANGE 条消息——超出后 hash 完全稳定，不再受增长影响。
 * 检测前 2000 条中的删除/swipe/修改。尾部删除依赖 fingerprint fallback。
 *
 * DESIGN: This is the ONLY way to make integrity hash stable under long
 * conversations. Any position-based sampling over the full array will
 * eventually cross a boundary as messages grow, triggering false mismatches
 * and wasteful full re-extractions. By capping at 2000, conversations
 * beyond this threshold get permanent hash stability.
 */
const MAX_SAMPLE_RANGE = 2000;

export function computeIntegrityHash(
  messages: ChatMessage[],
  sampleInterval: number = 20
): string {
  if (messages.length === 0) return '';
  // Only sample up to MAX_SAMPLE_RANGE — beyond this, growth is invisible
  const end = Math.min(messages.length, MAX_SAMPLE_RANGE);
  const samples: string[] = [];
  for (let i = 0; i < end; i += sampleInterval) {
    samples.push(`${messages[i].role}:${(messages[i].content || '').slice(0, 40)}`);
  }
  return createHash('sha256').update(samples.join('|')).digest('hex').slice(0, 16);
}

/**
 * 用 tiktoken 估算单条消息的 token 数（角色 + 格式开销 + 内容）。
 */
function estimateMessageTokens(msg: ChatMessage, enc: ReturnType<typeof encoding_for_model>): number {
  return enc.encode((msg.content || '')).length + 4; // 4 = role + formatting overhead
}

/**
 * 将消息数组按 token 上限分块，块间有重叠以保证上下文连续。
 * 保证每块至少包含 1 条消息（即使单条超过上限）。
 */
export function chunkMessages(
  messages: ChatMessage[],
  maxTokens: number,
  overlap: number = 5
): ChatMessage[][] {
  if (messages.length === 0) return [];

  const enc = getEncoder();
  const chunks: ChatMessage[][] = [];
  let cursor = 0;

  while (cursor < messages.length) {
    let chunkTokens = 0;
    let chunkEnd = cursor;

    // 填充当前块，直到超出 token 上限或消息耗尽
    while (chunkEnd < messages.length) {
      const msgTokens = estimateMessageTokens(messages[chunkEnd], enc);
      // 块非空时检查是否超限；空块至少包含 1 条
      if (chunkEnd > cursor && chunkTokens + msgTokens > maxTokens) {
        break;
      }
      chunkTokens += msgTokens;
      chunkEnd++;
    }

    // 实际块起始位置：当前 cursor 往回拉 overlap 条（不能为负）
    const chunkStart = Math.max(0, cursor - overlap);
    chunks.push(messages.slice(chunkStart, chunkEnd));

    cursor = chunkEnd;
  }

  return chunks;
}
