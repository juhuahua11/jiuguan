import { describe, it, expect } from 'vitest';
import { containsContinuityTrigger, resolveContinuityLevel } from '../../../src/continuity/injection-policy.js';

describe('resolveContinuityLevel', () => {
  it('uses full for the first configured handoff turns', () => {
    expect(resolveContinuityLevel({
      active: true,
      boostTurnsRemaining: 20,
      boostTurnsTotal: 20,
      fullTurns: 3,
      mediumTurns: 7,
      triggerBoost: false,
    })).toBe('full');
  });

  it('decays from medium to compact to normal', () => {
    expect(resolveContinuityLevel({
      active: true,
      boostTurnsRemaining: 16,
      boostTurnsTotal: 20,
      fullTurns: 3,
      mediumTurns: 7,
      triggerBoost: false,
    })).toBe('medium');
    expect(resolveContinuityLevel({
      active: true,
      boostTurnsRemaining: 8,
      boostTurnsTotal: 20,
      fullTurns: 3,
      mediumTurns: 7,
      triggerBoost: false,
    })).toBe('compact');
    expect(resolveContinuityLevel({
      active: false,
      boostTurnsRemaining: 0,
      boostTurnsTotal: 20,
      fullTurns: 3,
      mediumTurns: 7,
      triggerBoost: false,
    })).toBe('normal');
  });

  it('temporarily upgrades normal to compact when trigger phrases appear', () => {
    expect(containsContinuityTrigger('我们继续之前在月门的问题')).toBe(true);
    expect(resolveContinuityLevel({
      active: false,
      boostTurnsRemaining: 0,
      boostTurnsTotal: 20,
      fullTurns: 3,
      mediumTurns: 7,
      triggerBoost: true,
    })).toBe('compact');
  });
});
