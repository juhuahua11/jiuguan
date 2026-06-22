import { OpenAIProvider } from './openai.js';
import { ChatMessage, ProviderCapabilities } from '../types/provider.js';

export class DeepSeekProvider extends OpenAIProvider {
  constructor(apiKey?: string, baseURL?: string) {
    super(
      apiKey || process.env.DEEPSEEK_API_KEY || '',
      baseURL || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1'
    );
  }

  /** Base URL for Anthropic-compatible endpoint */
  getAnthropicBaseURL(): string {
    return process.env.DEEPSEEK_ANTHROPIC_BASE_URL || 'https://api.deepseek.com/anthropic';
  }

  getContextWindow(): number {
    return 131072; // 128K tokens
  }

  getMaxOutputTokens(): number {
    return 393216; // DeepSeek valid range: [1, 393216]
  }

  getCapabilities(): ProviderCapabilities {
    return {
      contextWindow: 131072,
      supportsSystemRole: true,
      supportsToolCall: true,
      supportsJsonMode: true,
      supportsReasoning: true,
    };
  }

  /**
   * Parse messages from either OpenAI or Anthropic format.
   * Detects Anthropic format by presence of top-level `system` field
   * alongside `messages` array (Claude API shape).
   */
  parseMessages(raw: any): ChatMessage[] {
    // Anthropic format: { system?: string, messages: [...] }
    if (raw && raw.messages && typeof raw.system === 'string') {
      const messages: ChatMessage[] = [];
      if (raw.system) {
        messages.push({ role: 'system', content: raw.system });
      }
      for (const m of raw.messages) {
        messages.push({
          role: m.role as 'user' | 'assistant',
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        });
      }
      return messages;
    }
    // Fall through to OpenAI format
    return super.parseMessages(raw);
  }

  async call(messages: ChatMessage[]): Promise<unknown> {
    const client = (this as any).client;
    return client.chat.completions.create({
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      messages: messages as any,
      max_tokens: this.getMaxOutputTokens(),
    });
  }
}
