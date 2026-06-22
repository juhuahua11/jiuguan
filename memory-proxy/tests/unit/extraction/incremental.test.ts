// f:\SillyTavern\memory-proxy\tests\unit\extraction\incremental.test.ts
import { describe, it, expect } from 'vitest';
import { computeIntegrityHash, findFingerprintPosition, computeFingerprint, computeUserAnchor, findUserAnchorPosition, diffNewMessages } from '../../../src/extraction/incremental.js';
import type { ChatMessage } from '../../../src/types/provider.js';

const mkMsg = (role: string, content: string): ChatMessage => ({ role: role as any, content });

describe('computeIntegrityHash', () => {
  it('should return empty string for empty messages', () => {
    expect(computeIntegrityHash([])).toBe('');
  });

  it('should produce the same hash for the same messages', () => {
    const msgs = [mkMsg('user', 'hello'), mkMsg('assistant', 'hi there')];
    const h1 = computeIntegrityHash(msgs);
    const h2 = computeIntegrityHash(msgs);
    expect(h1).toBe(h2);
  });

  it('should detect deletion of a message at an unsampled position (sampleInterval=4)', () => {
    const msgs = Array.from({ length: 8 }, (_, i) => mkMsg('user', `msg ${i}`));
    const originalHash = computeIntegrityHash(msgs, 4);
    const deleted = [...msgs.slice(0, 2), ...msgs.slice(3)];
    const deletedHash = computeIntegrityHash(deleted, 4);
    expect(deletedHash).not.toBe(originalHash);
  });

  it('should detect append of new messages (tail sentinel shifts)', () => {
    // Tail sentinel means hash changes when messages are appended.
    // Growth stability is ensured at the caller level: compute hash on
    // requestMessages (without new assistant response), not allMessages.
    const base = Array.from({ length: 8 }, (_, i) => mkMsg('user', `msg ${i}`));
    const baseHash = computeIntegrityHash(base, 4);
    const grown = [...base, mkMsg('assistant', 'reply 1'), mkMsg('user', 'msg 10')];
    const grownHash = computeIntegrityHash(grown, 4);
    expect(grownHash).not.toBe(baseHash); // tail sentinel catches append
  });

  it('should detect swipe at sampled position', () => {
    const msgs = Array.from({ length: 8 }, (_, i) => mkMsg('user', `msg ${i}`));
    const originalHash = computeIntegrityHash(msgs, 4);
    const swiped = [...msgs];
    swiped[4] = mkMsg('user', 'swiped content');
    const swipedHash = computeIntegrityHash(swiped, 4);
    expect(swipedHash).not.toBe(originalHash);
  });

  it('should be stable under normal appending — hash does NOT change when only new messages are appended (no new sample boundary)', () => {
    // With sampleInterval=4, appending from 8 to 9 messages crosses no sample boundary
    // (both sample at 0, 4 — same positions for the pre-existing messages)
    // But since messages are appended at the END, the array shifts... the sampled
    // content at positions 0 and 4 is still the same content.
    const base = Array.from({ length: 8 }, (_, i) => mkMsg('user', `msg ${i}`));
    const baseHash = computeIntegrityHash(base, 2); // interval=2 samples 0,2,4,6
    const grown = [...base, mkMsg('assistant', 'reply'), mkMsg('user', 'msg 8')];
    const grownHash = computeIntegrityHash(grown, 2);
    // Same 4 base samples (0,2,4,6) + new samples at 8, 10 — hash changes because
    // new sample positions are introduced. With interval=4 this wouldn't happen as
    // easily (need to cross a multiple of 4), but interval=2 crosses every 2 msgs.
    // We expect the hash to differ because sample positions changed.
    expect(baseHash).not.toBe(grownHash);
  });

  it('should have matching hashes when message count does not cross a sample boundary and content unchanged', () => {
    // interval=100: only samples at 0. Same content → same hash.
    const msgs = Array.from({ length: 50 }, (_, i) => mkMsg('user', `msg ${i}`));
    const hash1 = computeIntegrityHash(msgs, 100);
    const msgs2 = [...msgs, mkMsg('assistant', 'extra')]; // 51 messages, still only samples at 0
    const hash2 = computeIntegrityHash(msgs2, 100);
    // msg[0] unchanged → same hash
    expect(hash1).toBe(hash2);
  });
});

describe('findFingerprintPosition', () => {
  it('should find fingerprint at the end of messages (tail search)', () => {
    const msgs = Array.from({ length: 20 }, (_, i) => mkMsg('user', `msg ${i}`));
    const fingerprint = computeFingerprint(msgs.slice(-5));
    const pos = findFingerprintPosition(msgs, fingerprint);
    expect(pos).toBe(20);
  });

  it('should prefer the LAST match when fingerprint appears twice', () => {
    const pattern = [mkMsg('user', 'hello'), mkMsg('assistant', 'hi'), mkMsg('user', 'how'), mkMsg('assistant', 'fine'), mkMsg('user', 'ok')];
    const msgs: ChatMessage[] = [];
    for (let i = 0; i < 10; i++) msgs.push(mkMsg('user', `filler ${i}`));
    msgs.push(...pattern);
    for (let i = 0; i < 5; i++) msgs.push(mkMsg('user', `bridge ${i}`));
    msgs.push(...pattern);
    const fingerprint = computeFingerprint(pattern);
    const pos = findFingerprintPosition(msgs, fingerprint);
    // Should find the LAST match, so no remaining messages to extract
    expect(pos).toBe(msgs.length);
  });

  it('should return 0 when messages shorter than windowSize', () => {
    const msgs = [mkMsg('user', 'hi')];
    const pos = findFingerprintPosition(msgs, 'some-fingerprint');
    expect(pos).toBe(0);
  });

  it('should return -1 when fingerprint not found', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => mkMsg('user', `msg ${i}`));
    const pos = findFingerprintPosition(msgs, 'nonexistent-fingerprint');
    expect(pos).toBe(-1);
  });
});

describe('user anchor fallback', () => {
  it('computeUserAnchor hashes the last user message and records its index from end', () => {
    const msgs: ChatMessage[] = [
      mkMsg('user', 'hello'),
      mkMsg('assistant', 'hi'),
      mkMsg('user', 'how are you'),
      mkMsg('assistant', 'fine'),
    ];
    const anchor = computeUserAnchor(msgs);
    // Last user message is at index 2, which is 1 from the end (index 3)
    expect(anchor.endsWith(':1')).toBe(true);
    expect(anchor).not.toBe('');
  });

  it('computeUserAnchor returns empty when no user message', () => {
    const msgs: ChatMessage[] = [mkMsg('assistant', 'hi'), mkMsg('assistant', 'bye')];
    expect(computeUserAnchor(msgs)).toBe('');
  });

  it('findUserAnchorPosition locates the last user message with matching content', () => {
    const msgs: ChatMessage[] = [
      mkMsg('user', 'hello'),
      mkMsg('assistant', 'hi'),
      mkMsg('user', 'how are you'),
      mkMsg('assistant', 'fine'),
    ];
    const anchor = computeUserAnchor(msgs);
    // After extraction, new messages follow: a fresh assistant reply + depth injection + new user msg
    const grown: ChatMessage[] = [
      ...msgs,
      mkMsg('assistant', 'new reply'),
      mkMsg('system', '[injected author note]'),  // depth injection drifts the 5-window fingerprint
      mkMsg('user', 'next question'),
    ];
    const pos = findUserAnchorPosition(grown, anchor);
    // The anchored user message ('how are you') is at index 2; new content starts at 3
    expect(pos).toBe(3);
  });

  it('findUserAnchorPosition returns -1 when anchor content gone (swiped away)', () => {
    const msgs: ChatMessage[] = [
      mkMsg('user', 'original question'),
      mkMsg('assistant', 'reply'),
    ];
    const anchor = computeUserAnchor(msgs);
    // User message content changed entirely (e.g. edited)
    const changed: ChatMessage[] = [
      mkMsg('user', 'totally different question'),
      mkMsg('assistant', 'reply'),
    ];
    expect(findUserAnchorPosition(changed, anchor)).toBe(-1);
  });

  it('diffNewMessages falls back to user anchor when 5-window fingerprint drifts', () => {
    // Turn N: messages end with 5-window [u,a,u,a,u]; fingerprint stored.
    const turnN: ChatMessage[] = [
      mkMsg('user', 'q1'), mkMsg('assistant', 'a1'),
      mkMsg('user', 'q2'), mkMsg('assistant', 'a2'),
      mkMsg('user', 'q3'),
    ];
    const fp = computeFingerprint(turnN);
    const anchor = computeUserAnchor(turnN);

    // Turn N+1: ST injected an Author's Note at depth 0 (tail), so the 5-window
    // fingerprint no longer matches (tail changed), but the last user message
    // 'q3' is still present. Without the anchor, diffNewMessages would fall back
    // to the last 50 messages (a huge re-extraction).
    const turnN1: ChatMessage[] = [
      ...turnN,
      mkMsg('assistant', 'a3'),
      mkMsg('system', '[author note injected]'),  // depth-0 injection drifts the tail
      mkMsg('user', 'q4'),
    ];
    const diff = diffNewMessages(turnN1, fp, 50, anchor);
    expect(diff.found).toBe(true);
    // New messages = after the anchored user 'q3' (index 4): a3, [author note], q4
    expect(diff.newMessages.length).toBe(3);
    expect(diff.newMessages[0].content).toBe('a3');
  });

  it('diffNewMessages falls back to last-N only when both fingerprint and anchor miss', () => {
    const turnN: ChatMessage[] = [
      mkMsg('user', 'q1'), mkMsg('assistant', 'a1'),
      mkMsg('user', 'q2'), mkMsg('assistant', 'a2'),
    ];
    const fp = computeFingerprint(turnN);
    const anchor = computeUserAnchor(turnN);

    // Both anchors invalidated: user message swiped AND tail changed.
    const turnN1: ChatMessage[] = [
      mkMsg('user', 'different q1'), mkMsg('assistant', 'a1'),
      mkMsg('user', 'different q2'), mkMsg('assistant', 'a2'),
      mkMsg('user', 'q3'),
    ];
    const diff = diffNewMessages(turnN1, fp, 2, anchor);
    expect(diff.found).toBe(false);
    expect(diff.newMessages.length).toBe(2); // fallback to last 2
  });

  it('diffNewMessages uses lastMessageCount to locate new messages (most stable, ignores content drift)', () => {
    // Turn N: 4 messages, fingerprint + count stored.
    const turnN: ChatMessage[] = [
      mkMsg('user', 'q1'), mkMsg('assistant', 'a1'),
      mkMsg('user', 'q2'), mkMsg('assistant', 'a2'),
    ];
    const fp = computeFingerprint(turnN);

    // Turn N+1: +2 messages. ST ALSO injected an Author's Note AND swiped the last user
    // message, so BOTH the 5-window fingerprint and the user anchor would miss.
    // But count went 4 -> 6, so count-based定位 should still find exactly the 2 new msgs.
    const turnN1: ChatMessage[] = [
      mkMsg('user', 'q1'), mkMsg('assistant', 'a1'),
      mkMsg('user', 'q2 SWIPED'),  // content changed — anchor would miss
      mkMsg('assistant', 'a2'),
      mkMsg('system', '[author note]'),  // depth injection — 5-window fingerprint would miss
      mkMsg('user', 'q3'),
    ];
    const anchor = computeUserAnchor(turnN); // anchors to old 'q2', now swiped
    const diff = diffNewMessages(turnN1, fp, 50, anchor, 4);
    expect(diff.found).toBe(true);
    expect(diff.newMessages.length).toBe(2);
    expect(diff.newMessages[0].content).toBe('[author note]');
    expect(diff.newMessages[1].content).toBe('q3');
  });

  it('diffNewMessages returns empty when count equals length (duplicate stream/non-stream request)', () => {
    // ST sends two requests per turn (stream + non-stream) with the same messages array.
    // After the first extracts and stores count=N, the second arrives with length=N.
    // count-based location (>=) returns empty -> caller skips, no 50-msg fallback.
    const turnN: ChatMessage[] = Array.from({ length: 6 }, (_, i) => mkMsg('user', `q${i}`));
    const fp = computeFingerprint(turnN);
    // Same length as stored count — duplicate request
    const diff = diffNewMessages(turnN, fp, 50, undefined, 6);
    expect(diff.found).toBe(true);
    expect(diff.newMessages.length).toBe(0);
  });

  it('diffNewMessages does NOT full-re-extract on zombie recovery (empty fingerprint but count present)', () => {
    // Zombie-recovery scenario: a prior extraction crashed mid-run. markExtractionInProgress
    // had overwritten last_fingerprint with '__PROCESSING__'; on restart the stale-sentinel
    // guard cleared it to '' (empty). But last_message_count only updates on SUCCESSFUL
    // extraction, so it still reflects the last completed position.
    // Without the fix, empty fingerprint hit the first-run branch and returned ALL messages
    // (a catastrophic full re-extraction: 2329 msgs -> 9 chunks -> 18 LLM calls). With the
    // fix, an empty fingerprint + valid count falls through to count-based location and only
    // extracts the messages after count (here: the 2 newest).
    const processed: ChatMessage[] = Array.from({ length: 100 }, (_, i) => mkMsg('user', `old${i}`));
    const grown: ChatMessage[] = [
      ...processed,
      mkMsg('assistant', 'new reply 1'),
      mkMsg('user', 'new question 2'),
    ];
    // Empty fingerprint (zombie-cleared), but count=100 says we already extracted up to msg 100.
    const diff = diffNewMessages(grown, '', 50, undefined, 100);
    expect(diff.found).toBe(true);
    expect(diff.newMessages.length).toBe(2);
    expect(diff.newMessages[0].content).toBe('new reply 1');
    expect(diff.newMessages[1].content).toBe('new question 2');
    expect(diff.startIndex).toBe(100);
  });

  it('diffNewMessages still full-extracts on true first run (empty fingerprint AND no count)', () => {
    // Genuine first run: never extracted before, no fingerprint, no count.
    // This MUST return all messages — the count guard must not regress the first-run path.
    const msgs: ChatMessage[] = Array.from({ length: 5 }, (_, i) => mkMsg('user', `q${i}`));
    const diff = diffNewMessages(msgs, '', 50);
    expect(diff.found).toBe(false);
    expect(diff.newMessages.length).toBe(5);
    expect(diff.startIndex).toBe(0);
  });

  it('diffNewMessages falls through to fingerprint when count would pull too many (stale count)', () => {
    // count says 6, but array has 60 messages — count is stale (e.g. after a window trim
    // restored old messages). Should NOT trust count (would pull 54 msgs > fallbackCount);
    // fall through to fingerprint matching instead. Use >=5 msgs so the 5-window fingerprint
    // is well-defined and matches at the tail of the original 6.
    const turnN: ChatMessage[] = Array.from({ length: 6 }, (_, i) => mkMsg('user', `q${i}`));
    const fp = computeFingerprint(turnN); // hashes last 5 of the 6
    const big: ChatMessage[] = [...turnN, ...Array.from({ length: 54 }, (_, i) => mkMsg('assistant', `a${i}`))];
    // The 5-window fingerprint matches at index 1 (msgs[1..5] == last 5 of turnN), pos = 1+5 = 6
    const diff = diffNewMessages(big, fp, 50, undefined, 6);
    expect(diff.found).toBe(true);
    expect(diff.startIndex).toBe(6);
  });
});
