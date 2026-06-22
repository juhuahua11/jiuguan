import { describe, it, expect } from 'vitest';
import { ClaudeProvider } from '../../../src/provider/claude.js';

describe('ClaudeProvider', () => {
  const provider = new ClaudeProvider();

  it('should report context window of 200k', () => {
    expect(provider.getContextWindow()).toBe(200000);
  });

  it('should support system role via top-level system param', () => {
    expect(provider.getCapabilities().supportsSystemRole).toBe(true);
  });

  it('should parse Anthropic-format messages with system', () => {
    const raw = {
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'Hello' }],
    };
    const messages = provider.parseMessages(raw);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toBe('You are a helpful assistant.');
    expect(messages[1].role).toBe('user');
  });

  it('should inject system prompt when no existing system message', () => {
    const messages = [{ role: 'user', content: 'Hello' }];
    const result = provider.injectSystemPrompt(messages, 'You are a wizard.');
    expect(result[0].role).toBe('system');
  });

  it('should prepend to existing system prompt', () => {
    const messages = [
      { role: 'system', content: 'Original system prompt.' },
      { role: 'user', content: 'Hello' },
    ];
    const result = provider.injectSystemPrompt(messages, 'Memory context.');
    expect(result[0].content).toContain('Memory context.');
    expect(result[0].content).toContain('Original system prompt.');
  });
});
