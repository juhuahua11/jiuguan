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

export class TokenBudgetManager {
  private capabilities: ProviderCapabilities;
  private responseBuffer: number;

  constructor(capabilities: ProviderCapabilities) {
    this.capabilities = capabilities;
    this.responseBuffer = Math.min(4096, Math.floor(capabilities.contextWindow * 0.05));
  }

  allocate(input: BudgetInput): BudgetAllocation {
    const available = this.capabilities.contextWindow - this.responseBuffer;

    // Tier 1: Untouchable
    const canon = input.canonTokens;
    const continuity = input.continuityTokens ?? 0;
    const state = input.stateTokens;
    let remaining = available - canon - continuity - state;

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

    // Tier 3: Working Memory
    let working = Math.min(input.workingTokens, remaining);
    remaining -= working;

    // Tier 4: Summaries (first to be cut)
    let summaries = Math.min(input.summaryTokens, remaining);

    return { canon, continuity, state, relationships, events, facts, working, summaries };
  }

  getContextWindow(): number {
    return this.capabilities.contextWindow;
  }
}
