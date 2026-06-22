import { BaseProvider } from './base.js';
import { ChatMessage, ProviderCapabilities } from '../types/provider.js';
import OpenAI from 'openai';

export class OpenAIProvider extends BaseProvider {
  private client: OpenAI;

  constructor(apiKey?: string, baseURL?: string) {
    super();
    this.client = new OpenAI({
      apiKey: apiKey || process.env.OPENAI_API_KEY || 'sk-placeholder',
      baseURL: baseURL || process.env.OPENAI_BASE_URL,
    });
  }

  parseMessages(raw: any): ChatMessage[] {
    if (raw && Array.isArray(raw.messages)) {
      return raw.messages.map((m: any) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      }));
    }
    return [];
  }

  getContextWindow(): number { return 128000; }
  getMaxOutputTokens(): number { return 4096; }

  getCapabilities(): ProviderCapabilities {
    return {
      contextWindow: 128000,
      supportsSystemRole: true,
      supportsToolCall: true,
      supportsJsonMode: true,
      supportsReasoning: false,
    };
  }

  injectSystemPrompt(messages: ChatMessage[], system: string): ChatMessage[] {
    return [{ role: 'system', content: system }, ...messages];
  }

  extractResponse(raw: any): string {
    return raw?.choices?.[0]?.message?.content || '';
  }

  async call(messages: ChatMessage[]): Promise<unknown> {
    return this.client.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      messages: messages as any,
      max_tokens: this.getMaxOutputTokens(),
    });
  }
}
