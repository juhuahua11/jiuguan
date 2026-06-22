import { describe, it, expect } from 'vitest';
import { WorkingMemory } from '../../../src/session/working-memory.js';
import { ChatMessage } from '../../../src/types/provider.js';

describe('WorkingMemory', () => {
  it('should start empty', () => {
    const wm = new WorkingMemory(8000);
    expect(wm.getMessages()).toHaveLength(0);
  });

  it('should append messages', () => {
    const wm = new WorkingMemory(8000);
    wm.append({ role: 'user', content: 'Hello' });
    wm.append({ role: 'assistant', content: 'Hi there!' });
    expect(wm.getMessages()).toHaveLength(2);
  });

  it('should estimate tokens', () => {
    const wm = new WorkingMemory(8000);
    const msg: ChatMessage = { role: 'user', content: 'Hello world, this is a test message.' };
    const tokens = wm.estimateTokens([msg]);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(30);
  });

  it('should detect overflow and return overflowed messages', () => {
    const wm = new WorkingMemory(30);
    const longMsg: ChatMessage = { role: 'user', content: 'A'.repeat(200) };
    wm.append(longMsg);
    wm.append({ role: 'assistant', content: 'B'.repeat(200) });
    wm.append({ role: 'user', content: 'C'.repeat(200) });
    const overflow = wm.getOverflow();
    expect(overflow.length).toBeGreaterThan(0);
  });

  it('should not overflow when under token limit', () => {
    const wm = new WorkingMemory(100000);
    wm.append({ role: 'user', content: 'Short message' });
    expect(wm.getOverflow()).toHaveLength(0);
  });

  it('should trim to token window keeping most recent', () => {
    const wm = new WorkingMemory(30);
    wm.append({ role: 'user', content: 'First message with some content' });
    wm.append({ role: 'assistant', content: 'Second message with some content' });
    wm.append({ role: 'user', content: 'Third message with some content' });
    const trimmed = wm.trimToWindow();
    expect(trimmed.length).toBeLessThan(3);
  });

  it('should MUTATE internal messages on trimToWindow (the bug: full history was forwarded)', () => {
    // Regression guard: trimToWindow used to be a no-op that only RETURNED the
    // overflow without dropping it from internal state. The full conversation
    // history was then forwarded to the upstream model every turn — the
    // "20M tokens for 49 turns" symptom. After the fix, getMessages() must
    // contain only the recent window that fits the budget.
    const wm = new WorkingMemory(20);
    wm.append({ role: 'user', content: 'First message with some content' });
    wm.append({ role: 'assistant', content: 'Second message with some content' });
    wm.append({ role: 'user', content: 'Third message with some content' });
    const trimmed = wm.trimToWindow();
    expect(trimmed.length).toBeGreaterThan(0);
    expect(wm.getMessages().length).toBeLessThan(3);
    // The kept window is the most recent messages, in order.
    const kept = wm.getMessages();
    expect(kept[kept.length - 1].content).toBe('Third message with some content');
  });

  it('should always keep at least the most recent message even if it alone overflows', () => {
    // Defensive: a single turn larger than the whole budget must not wipe the
    // working window, otherwise upstream gets no conversation context at all.
    const wm = new WorkingMemory(10);
    wm.append({ role: 'user', content: 'A'.repeat(500) });
    wm.append({ role: 'assistant', content: 'B'.repeat(500) });
    wm.trimToWindow();
    expect(wm.getMessages().length).toBeGreaterThanOrEqual(1);
    // The kept message is the newest (assistant reply).
    expect(wm.getMessages()[wm.getMessages().length - 1].content).toBe('B'.repeat(500));
  });

  it('should leave messages unchanged when under budget', () => {
    const wm = new WorkingMemory(100000);
    wm.append({ role: 'user', content: 'Short message one' });
    wm.append({ role: 'assistant', content: 'Short message two' });
    const trimmed = wm.trimToWindow();
    expect(trimmed).toHaveLength(0);
    expect(wm.getMessages()).toHaveLength(2);
  });
});
