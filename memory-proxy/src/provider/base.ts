import { Provider, ProviderCapabilities, ChatMessage } from '../types/provider.js';

export abstract class BaseProvider implements Provider {
  abstract parseMessages(raw: unknown): ChatMessage[];
  abstract getContextWindow(): number;
  abstract getMaxOutputTokens(): number;
  abstract getCapabilities(): ProviderCapabilities;
  abstract injectSystemPrompt(messages: ChatMessage[], system: string): ChatMessage[];
  abstract extractResponse(raw: unknown): string;
  abstract call(messages: ChatMessage[]): Promise<unknown>;
}
