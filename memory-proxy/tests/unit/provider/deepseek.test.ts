import { describe, it, expect } from 'vitest';
import { DeepSeekProvider } from '../../../src/provider/deepseek.js';

describe('DeepSeekProvider', () => {
  const provider = new DeepSeekProvider('sk-test', 'https://api.deepseek.com/v1');

  it('should report context window of 128K', () => {
    expect(provider.getContextWindow()).toBe(131072);
  });

  it('should support reasoning capability', () => {
    expect(provider.getCapabilities().supportsReasoning).toBe(true);
  });

  it('should report Anthropic base URL', () => {
    expect(provider.getAnthropicBaseURL()).toBe('https://api.deepseek.com/anthropic');
  });

  // --- OpenAI format ---

  it('should parse OpenAI-format messages', () => {
    const raw = {
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello' },
      ],
    };
    const messages = provider.parseMessages(raw);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
  });

  // --- Anthropic format ---

  it('should parse Anthropic-format messages with system', () => {
    const raw = {
      system: 'You are DeepSeek.',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ],
    };
    const messages = provider.parseMessages(raw);
    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toBe('You are DeepSeek.');
    expect(messages[1].role).toBe('user');
    expect(messages[2].role).toBe('assistant');
  });

  it('should parse Anthropic-format messages without system', () => {
    const raw = {
      messages: [
        { role: 'user', content: 'Hello' },
      ],
    };
    const messages = provider.parseMessages(raw);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
  });

  it('should inject system prompt', () => {
    const result = provider.injectSystemPrompt(
      [{ role: 'user', content: 'Hi' }],
      'System instruction'
    );
    expect(result[0].role).toBe('system');
    expect(result[0].content).toBe('System instruction');
  });

  it('should extract response from OpenAI format', () => {
    const raw = { choices: [{ message: { content: '你好！' } }] };
    expect(provider.extractResponse(raw)).toBe('你好！');
  });
});
