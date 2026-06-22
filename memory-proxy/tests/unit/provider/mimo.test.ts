import { describe, it, expect } from 'vitest';
import { MiMoProvider } from '../../../src/provider/mimo.js';

describe('MiMoProvider', () => {
  const provider = new MiMoProvider('sk-test', 'https://api.xiaomimimo.com/v1');

  it('should report context window of 262K for flash model', () => {
    expect(provider.getContextWindow()).toBe(262144);
  });

  it('should support reasoning capability', () => {
    expect(provider.getCapabilities().supportsReasoning).toBe(true);
  });

  it('should report Anthropic base URL', () => {
    expect(provider.getAnthropicBaseURL()).toBe('https://api.xiaomimimo.com/anthropic');
  });

  // OpenAI format
  it('should parse OpenAI-format messages', () => {
    const raw = {
      messages: [
        { role: 'user', content: 'How is the weather?' },
        { role: 'assistant', content: 'The weather is nice!' },
      ],
    };
    const messages = provider.parseMessages(raw);
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe('assistant');
  });

  // Anthropic format
  it('should parse Anthropic-format messages with system', () => {
    const raw = {
      system: 'You are MiMo, a helpful assistant.',
      messages: [
        { role: 'user', content: 'Introduce yourself' },
      ],
    };
    const messages = provider.parseMessages(raw);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toBe('You are MiMo, a helpful assistant.');
    expect(messages[1].role).toBe('user');
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

  it('should inject system prompt by prepending', () => {
    const messages = [{ role: 'user', content: 'Hello' }];
    const result = provider.injectSystemPrompt(messages, 'You are MiMo.');
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('system');
    expect(result[0].content).toBe('You are MiMo.');
  });

  it('should extract response from OpenAI format', () => {
    const raw = { choices: [{ message: { content: 'Hello from MiMo!' } }] };
    expect(provider.extractResponse(raw)).toBe('Hello from MiMo!');
  });
});
