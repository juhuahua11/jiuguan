import { RelationshipSignal } from '../types/extraction.js';
import { RelationType, EvolutionEntry, RelationshipMetrics } from '../types/relationship.js';

interface SignalRule {
  friendship: number;
  trust: number;
  affection: number;
  respect: number;
  hostility: number;
  /** Maps to which RelationType this signal primarily affects */
  primaryType: RelationType;
}

/**
 * Deterministic signal-to-intensity rules.
 * LLM observes and outputs a signal type; this engine computes the numeric deltas.
 * This ensures cross-model consistency.
 */
const SIGNAL_RULES: Record<string, SignalRule> = {
  protective_action:  { friendship: 0.15, trust: 0.25, affection: 0.05, respect: 0.10, hostility: -0.05, primaryType: RelationType.FRIENDSHIP },
  saved_life:         { friendship: 0.25, trust: 0.30, affection: 0.15, respect: 0.20, hostility: -0.20, primaryType: RelationType.LOYALTY },
  betrayal:           { friendship: -0.30, trust: -0.40, affection: -0.10, respect: -0.25, hostility: 0.35, primaryType: RelationType.HOSTILITY },
  shared_secret:      { friendship: 0.10, trust: 0.20, affection: 0.05, respect: 0.05, hostility: 0,    primaryType: RelationType.FRIENDSHIP },
  verbal_insult:      { friendship: -0.10, trust: -0.05, affection: -0.05, respect: -0.15, hostility: 0.15, primaryType: RelationType.HOSTILITY },
  gift_exchange:      { friendship: 0.10, trust: 0.05, affection: 0.10, respect: 0.05, hostility: -0.05, primaryType: RelationType.FRIENDSHIP },
  romantic_gesture:   { friendship: 0.05, trust: 0.10, affection: 0.20, respect: 0.05, hostility: -0.05, primaryType: RelationType.ROMANCE },
  confession:         { friendship: 0.10, trust: 0.25, affection: 0.15, respect: 0.05, hostility: 0,    primaryType: RelationType.ROMANCE },
  helped_in_battle:   { friendship: 0.15, trust: 0.20, affection: 0.05, respect: 0.10, hostility: -0.10, primaryType: RelationType.ALLIANCE },
  kept_promise:       { friendship: 0.10, trust: 0.20, affection: 0.05, respect: 0.15, hostility: 0,    primaryType: RelationType.LOYALTY },
  broke_promise:      { friendship: -0.15, trust: -0.25, affection: -0.05, respect: -0.10, hostility: 0.10, primaryType: RelationType.HOSTILITY },
  deception:          { friendship: -0.15, trust: -0.30, affection: -0.10, respect: -0.10, hostility: 0.15, primaryType: RelationType.HOSTILITY },
  mentor_teaching:    { friendship: 0.05, trust: 0.10, affection: 0.05, respect: 0.20, hostility: 0,    primaryType: RelationType.MASTER_STUDENT },
  showing_mercy:      { friendship: 0.10, trust: 0.15, affection: 0.05, respect: 0.15, hostility: -0.20, primaryType: RelationType.FRIENDSHIP },
  intimidation:       { friendship: -0.05, trust: -0.10, affection: -0.10, respect: 0.05, hostility: 0.20, primaryType: RelationType.HOSTILITY },
};

export function getSignalRule(signalType: string): SignalRule | null {
  return SIGNAL_RULES[signalType] || null;
}

export function getAvailableSignalTypes(): string[] {
  return Object.keys(SIGNAL_RULES);
}

export function computeIntensityDelta(signal: RelationshipSignal): {
  primaryType: RelationType;
  intensityDelta: number;
  metricsDelta: RelationshipMetrics;
} | null {
  const rule = getSignalRule(signal.type);
  if (!rule) return null;

  // Compute scalar intensity delta (weighted average of metric changes)
  const intensityDelta =
    (rule.friendship + rule.trust + rule.affection + rule.respect - rule.hostility) / 5;

  return {
    primaryType: rule.primaryType,
    intensityDelta: Math.round(intensityDelta * 100) / 100,
    metricsDelta: {
      trust: rule.trust,
      affection: rule.affection,
      respect: rule.respect,
      hostility: rule.hostility,
    },
  };
}

export function applySignalToMetrics(
  currentMetrics: RelationshipMetrics,
  deltas: RelationshipMetrics
): RelationshipMetrics {
  const clamp = (v: number) => Math.max(-1, Math.min(1, v));
  return {
    trust: clamp(currentMetrics.trust + deltas.trust),
    affection: clamp(currentMetrics.affection + deltas.affection),
    respect: clamp(currentMetrics.respect + deltas.respect),
    hostility: clamp(currentMetrics.hostility + deltas.hostility),
  };
}
