import { ProviderCapabilities } from '../types/provider.js';

interface BudgetInput {
  canonTokens: number;
  continuityTokens?: number;
  stateTokens: number;
  factTokens: number;
  eventTokens: number;
  relationshipTokens: number;
  workingTokens: number;
  summaryTokens: number;
}

export interface BudgetAllocation {
  canon: number;
  continuity: number;
  state: number;
  facts: number;
  events: number;
  relationships: number;
  working: number;
  summaries: number;
}

/** Tokens guaranteed for the system prompt template (LEVEL 0 contract,
 *  writing template, final output check) so memory injection never
 *  crowds it out — even on small context models. Capped at 2000 but
 *  scales down proportionally for tiny contexts. */
function computeSystemPromptReserve(available: number): number {
  return Math.min(2000, Math.floor(available * 0.05));
}

export class TokenBudgetManager {
  private capabilities: ProviderCapabilities;
  private responseBuffer: number;

  constructor(capabilities: ProviderCapabilities) {
    this.capabilities = capabilities;
    // Response buffer = model's max output tokens for this provider/caps,
    // floored at the old 5%-of-context minimum (so tiny test contexts still
    // work) and capped at 25% of context (beyond that memory injection is
    // pointless). Previously this used a flat min(4096, 5%*context), which
    // for a 128K-model with 32K max_tokens left ~124K "available" — but
    // prompt + 32K response could overflow the context window.
    const minBuffer = Math.min(4096, Math.floor(capabilities.contextWindow * 0.05));
    const maxBuffer = Math.floor(capabilities.contextWindow * 0.25);
    this.responseBuffer = Math.max(minBuffer, Math.min(capabilities.maxOutputTokens || minBuffer, maxBuffer));
  }

  allocate(input: BudgetInput): BudgetAllocation {
    const available = this.capabilities.contextWindow - this.responseBuffer;
    const systemReserve = computeSystemPromptReserve(available);

    // Tier 1: Untouchable — canon, continuity, current state, and system
    // prompt template reserve. The reserve ensures the output-format
    // template (LEVEL 0 contract + writing rules + branch options) is
    // never squeezed out by memory items, even on small-context models.
    const canon = input.canonTokens;
    const continuity = input.continuityTokens ?? 0;
    const state = input.stateTokens;
    let remaining = available - canon - continuity - state - systemReserve;

    if (remaining < 0) {
      return { canon, continuity, state, facts: 0, events: 0, relationships: 0, working: 0, summaries: 0 };
    }

    // Tier 2: Retrieved relationships, events, facts
    let relationships = Math.min(input.relationshipTokens, remaining);
    remaining -= relationships;
    let events = Math.min(input.eventTokens, remaining);
    remaining -= events;
    let facts = Math.min(input.factTokens, remaining);
    remaining -= facts;

    // Tier 3: Working Memory (uses remaining + the system prompt reserve,
    // since the reserve was set aside specifically for the template that
    // lives inside the working-memory messages)
    let working = Math.min(input.workingTokens, remaining + systemReserve);
    remaining = Math.max(0, remaining + systemReserve - working);

    // Tier 4: Summaries (first to be cut)
    let summaries = Math.min(input.summaryTokens, remaining);

    return { canon, continuity, state, relationships, events, facts, working, summaries };
  }

  getContextWindow(): number {
    return this.capabilities.contextWindow;
  }
}
