import { describe, it, expect } from 'vitest';
import { OpenAIProvider } from '../../../src/provider/openai.js';

describe('OpenAIProvider', () => {
  const provider = new OpenAIProvider();

  it('should report context window of 128k', () => {
    expect(provider.getContextWindow()).toBe(128000);
  });

  it('should support system role', () => {
    expect(provider.getCapabilities().supportsSystemRole).toBe(true);
  });

  it('should support tool calls', () => {
    expect(provider.getCapabilities().supportsToolCall).toBe(true);
  });

  it('should parse OpenAI-format messages', () => {
    const raw = {
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
      ],
    };
    const messages = provider.parseMessages(raw);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
  });

  it('should inject system prompt by prepending system message', () => {
    const messages = [{ role: 'user', content: 'Hello' }];
    const result = provider.injectSystemPrompt(messages, 'You are a wizard.');
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('system');
    expect(result[0].content).toBe('You are a wizard.');
  });

  it('should extract response content', () => {
    const raw = { choices: [{ message: { content: 'Hello, human!' } }] };
    expect(provider.extractResponse(raw)).toBe('Hello, human!');
  });
});
