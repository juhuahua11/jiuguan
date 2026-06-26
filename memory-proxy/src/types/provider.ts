export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ProviderCapabilities {
  contextWindow: number;
  maxOutputTokens: number;
  supportsSystemRole: boolean;
  supportsToolCall: boolean;
  supportsJsonMode: boolean;
  supportsReasoning: boolean;
}

export interface Provider {
  parseMessages(raw: unknown): ChatMessage[];
  getContextWindow(): number;
  getMaxOutputTokens(): number;
  getCapabilities(): ProviderCapabilities;
  injectSystemPrompt(messages: ChatMessage[], system: string): ChatMessage[];
  extractResponse(raw: unknown): string;
  call(messages: ChatMessage[]): Promise<unknown>;
}
