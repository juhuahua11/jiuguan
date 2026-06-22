import { ChatMessage } from '../types/provider.js';
import { encoding_for_model, TiktokenModel } from 'tiktoken';

export class WorkingMemory {
  private messages: ChatMessage[] = [];
  private tokenLimit: number;
  private enc: ReturnType<typeof encoding_for_model>;

  constructor(tokenLimit: number = 8000) {
    this.tokenLimit = tokenLimit;
    this.enc = encoding_for_model('gpt-4' as TiktokenModel);
  }

  append(message: ChatMessage): void {
    this.messages.push(message);
  }

  getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  estimateTokens(messages: ChatMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      total += this.enc.encode(msg.content).length;
      total += 4; // role + formatting overhead per message
    }
    return total + 2; // priming overhead
  }

  getOverflow(): ChatMessage[] {
    const tokenCount = this.estimateTokens(this.messages);
    if (tokenCount <= this.tokenLimit) return [];

    const overflow: ChatMessage[] = [];
    let running = 0;
    for (const msg of this.messages) {
      const msgTokens = this.enc.encode(msg.content).length + 4;
      if (running + msgTokens > this.tokenLimit) {
        overflow.push(msg);
      }
      running += msgTokens;
    }
    return overflow;
  }

  /**
   * Trim working memory IN PLACE to the most recent messages that fit within
   * tokenLimit. Returns the dropped (older) messages in chronological order so
   * the caller can route them to long-term extraction.
   *
   * Walk newest→oldest accumulating tokens; once a message no longer fits,
   * everything older is also dropped (contiguous recent window). Always keeps
   * at least the single most recent message, even if it alone exceeds the
   * budget — otherwise an over-long turn would wipe working memory entirely
   * and the upstream would receive no conversation context.
   */
  trimToWindow(): ChatMessage[] {
    const tokenCount = this.estimateTokens(this.messages);
    if (tokenCount <= this.tokenLimit) return [];

    const kept: ChatMessage[] = [];
    const trimmed: ChatMessage[] = [];
    let running = 0;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      const msgTokens = this.enc.encode(msg.content).length + 4;
      if (running + msgTokens > this.tokenLimit) {
        trimmed.push(msg);
      } else {
        kept.push(msg);
      }
      // Always accumulate (even for trimmed) so once we exceed the budget,
      // every older message is also trimmed — no gaps in the recent window.
      running += msgTokens;
    }
    // Safety net: never wipe the working window entirely. If even the newest
    // message overflowed, force-keep it so upstream still gets the current turn.
    if (kept.length === 0 && this.messages.length > 0) {
      kept.push(this.messages[this.messages.length - 1]);
      // That message was wrongly pushed into trimmed; remove it.
      trimmed.shift();
    }
    this.messages = kept.reverse(); // restore oldest→newest order
    return trimmed.reverse();       // chronological order of dropped messages
  }
}
