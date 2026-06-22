import type { ContinuityInjectionLevel } from '../types/continuity.js';

export interface ContinuityLevelInput {
  active: boolean;
  boostTurnsRemaining: number;
  boostTurnsTotal: number;
  fullTurns: number;
  mediumTurns: number;
  triggerBoost: boolean;
}

export function containsContinuityTrigger(text: string): boolean {
  return /(之前|上次|继续|还记得|刚才|接着|后来|承诺|答应|关系|好感|信任|敌意)/.test(text);
}

export function resolveContinuityLevel(input: ContinuityLevelInput): ContinuityInjectionLevel {
  if (input.active && input.boostTurnsRemaining > 0) {
    const consumed = input.boostTurnsTotal - input.boostTurnsRemaining;
    if (consumed < input.fullTurns) return 'full';
    if (consumed < input.fullTurns + input.mediumTurns) return 'medium';
    return 'compact';
  }
  return input.triggerBoost ? 'compact' : 'normal';
}

export function pickSnapshotText(
  level: ContinuityInjectionLevel,
  snapshot: { compact_text: string; medium_text: string; full_text: string }
): string {
  if (level === 'full') return snapshot.full_text;
  if (level === 'medium') return snapshot.medium_text;
  return snapshot.compact_text;
}
