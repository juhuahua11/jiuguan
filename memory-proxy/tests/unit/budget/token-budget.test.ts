import { describe, it, expect } from 'vitest';
import { TokenBudgetManager } from '../../../src/budget/token-budget.js';
import { ProviderCapabilities } from '../../../src/types/provider.js';

const caps: ProviderCapabilities = {
  contextWindow: 100000, supportsSystemRole: true,
  supportsToolCall: true, supportsJsonMode: true, supportsReasoning: false,
};

describe('TokenBudgetManager', () => {
  it('should protect canon and state from budget cuts', () => {
    const tinyCap = { ...caps, contextWindow: 2000 };
    const manager = new TokenBudgetManager(tinyCap);
    const alloc = manager.allocate({
      canonTokens: 500, stateTokens: 300, factTokens: 2000,
      eventTokens: 1500, relationshipTokens: 800,
      workingTokens: 5000, summaryTokens: 4000,
    });
    expect(alloc.canon).toBe(500);
    expect(alloc.state).toBe(300);
  });

  it('should trim summaries first when budget is tight', () => {
    const smallCap = { ...caps, contextWindow: 5000 };
    const manager = new TokenBudgetManager(smallCap);
    const alloc = manager.allocate({
      canonTokens: 500, stateTokens: 300, factTokens: 2000,
      eventTokens: 1500, relationshipTokens: 800,
      workingTokens: 5000, summaryTokens: 4000,
    });
    expect(alloc.canon).toBe(500);
    expect(alloc.state).toBe(300);
    expect(alloc.summaries).toBeLessThan(4000);
    expect(alloc.working).toBeLessThan(5000);
  });

  it('should fit within context window', () => {
    const manager = new TokenBudgetManager(caps);
    const alloc = manager.allocate({
      canonTokens: 500, stateTokens: 200, factTokens: 3000,
      eventTokens: 2000, relationshipTokens: 1000,
      workingTokens: 10000, summaryTokens: 5000,
    });
    const total = alloc.canon + alloc.state + alloc.facts + alloc.events +
      alloc.relationships + alloc.working + alloc.summaries;
    expect(total).toBeLessThanOrEqual(100000 - 4096);
    expect(alloc.canon).toBe(500);
    expect(alloc.state).toBe(200);
  });
});
