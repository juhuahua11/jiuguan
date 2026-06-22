import { OpenAIProvider } from './openai.js';
import { ChatMessage, ProviderCapabilities } from '../types/provider.js';

export class MiMoProvider extends OpenAIProvider {
  constructor(apiKey?: string, baseURL?: string) {
    super(
      apiKey || process.env.MIMO_API_KEY || '',
      baseURL || process.env.MIMO_BASE_URL || 'https://api.xiaomimimo.com/v1'
    );
  }

  /** Base URL for Anthropic-compatible endpoint */
  getAnthropicBaseURL(): string {
    return process.env.MIMO_ANTHROPIC_BASE_URL || 'https://api.xiaomimimo.com/anthropic';
  }

  getContextWindow(): number {
    const model = process.env.MIMO_MODEL || 'mimo-v2-flash';
    if (model.includes('pro')) return 1_000_000;
    return 262_144;
  }

  getMaxOutputTokens(): number {
    return 16384;
  }

  getCapabilities(): ProviderCapabilities {
    return {
      contextWindow: this.getContextWindow(),
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
      model: process.env.MIMO_MODEL || 'mimo-v2-flash',
      messages: messages as any,
      max_tokens: this.getMaxOutputTokens(),
    });
  }
}
