import { describe, it, expect } from 'vitest';
import { computeIntensityDelta, applySignalToMetrics, getSignalRule, getAvailableSignalTypes } from '../../../src/extraction/relationship-engine.js';
import { RelationshipMetrics } from '../../../src/types/relationship.js';

describe('Relationship Engine', () => {
  it('should have a set of available signal types', () => {
    const types = getAvailableSignalTypes();
    expect(types.length).toBeGreaterThan(10);
    expect(types).toContain('protective_action');
    expect(types).toContain('betrayal');
  });

  it('should compute positive delta for protective action', () => {
    const result = computeIntensityDelta({ type: 'protective_action', actor: 'a', target: 'b', description: 'test', round: 1 });
    expect(result).not.toBeNull();
    expect(result!.intensityDelta).toBeGreaterThan(0);
    expect(result!.metricsDelta.trust).toBe(0.25);
  });

  it('should compute negative delta for betrayal', () => {
    const result = computeIntensityDelta({ type: 'betrayal', actor: 'a', target: 'b', description: 'test', round: 1 });
    expect(result).not.toBeNull();
    expect(result!.intensityDelta).toBeLessThan(0);
    expect(result!.metricsDelta.trust).toBe(-0.40);
  });

  it('should return null for unknown signal type', () => {
    const result = computeIntensityDelta({ type: 'nonexistent_signal', actor: 'a', target: 'b', description: 'test', round: 1 });
    expect(result).toBeNull();
  });

  it('should apply metrics deltas with clamping', () => {
    const current: RelationshipMetrics = { trust: 0.5, affection: 0.3, respect: 0.2, hostility: 0.1 };
    const deltas: RelationshipMetrics = { trust: 0.25, affection: 0.15, respect: -0.10, hostility: -0.05 };
    const result = applySignalToMetrics(current, deltas);
    expect(result.trust).toBeCloseTo(0.75);
    expect(result.affection).toBeCloseTo(0.45);
    expect(result.hostility).toBeCloseTo(0.05);
  });

  it('should clamp values to [-1, 1]', () => {
    const current: RelationshipMetrics = { trust: 0.9, affection: 0, respect: 0, hostility: 0 };
    const deltas: RelationshipMetrics = { trust: 0.5, affection: 0, respect: 0, hostility: 0 };
    const result = applySignalToMetrics(current, deltas);
    expect(result.trust).toBe(1.0);
  });
});
