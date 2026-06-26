import { BaseProvider } from './base.js';
import { ChatMessage, ProviderCapabilities } from '../types/provider.js';
import Anthropic from '@anthropic-ai/sdk';

export class ClaudeProvider extends BaseProvider {
  private client: Anthropic;

  constructor(apiKey?: string) {
    super();
    this.client = new Anthropic({
      apiKey: apiKey || process.env.ANTHROPIC_API_KEY || 'sk-ant-placeholder',
    });
  }

  parseMessages(raw: any): ChatMessage[] {
    const messages: ChatMessage[] = [];
    if (raw && typeof raw.system === 'string') {
      messages.push({ role: 'system', content: raw.system });
    }
    if (raw && Array.isArray(raw.messages)) {
      for (const m of raw.messages) {
        messages.push({
          role: m.role as 'user' | 'assistant',
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        });
      }
    }
    return messages;
  }

  getContextWindow(): number { return 200000; }
  getMaxOutputTokens(): number { return 4096; }

  getCapabilities(): ProviderCapabilities {
    return {
      contextWindow: 200000,
      maxOutputTokens: this.getMaxOutputTokens(),
      supportsSystemRole: true,
      supportsToolCall: true,
      supportsJsonMode: false,
      supportsReasoning: true,
    };
  }

  injectSystemPrompt(messages: ChatMessage[], system: string): ChatMessage[] {
    const existingSystemIdx = messages.findIndex(m => m.role === 'system');
    if (existingSystemIdx >= 0) {
      const updated = [...messages];
      updated[existingSystemIdx] = {
        role: 'system',
        content: `${system}\n\n---\n\n${messages[existingSystemIdx].content}`,
      };
      return updated;
    }
    return [{ role: 'system', content: system }, ...messages];
  }

  extractResponse(raw: any): string {
    if (typeof raw === 'string') return raw;
    if (raw?.content?.[0]?.text) return raw.content[0].text;
    return '';
  }

  async call(messages: ChatMessage[]): Promise<unknown> {
    const systemMsg = messages.find(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');
    return this.client.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      max_tokens: this.getMaxOutputTokens(),
      system: systemMsg?.content,
      messages: nonSystem.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    });
  }
}
