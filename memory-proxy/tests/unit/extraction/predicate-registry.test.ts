import { describe, it, expect } from 'vitest';
import { normalizePredicate, isStatePredicate, getPredicateLayer, PredicateLayer } from '../../../src/extraction/predicate-registry.js';

describe('Predicate Registry', () => {
  it('should pass through standard predicates', () => {
    expect(normalizePredicate('owns')).toBe('owns');
    expect(normalizePredicate('located_at')).toBe('located_at');
    expect(normalizePredicate('trusts')).toBe('trusts');
  });

  it('should normalize Chinese predicates to English', () => {
    expect(normalizePredicate('有')).toBe('owns');
    expect(normalizePredicate('交给')).toBe('gave');
    expect(normalizePredicate('信任')).toBe('trusts');
  });

  it('should normalize unknown predicates to snake_case', () => {
    expect(normalizePredicate('is friends with')).toBe('is_friends_with');
  });

  it('should identify state predicates', () => {
    expect(isStatePredicate('owns')).toBe(true);
    expect(isStatePredicate('gave')).toBe(false);
    expect(isStatePredicate('trusts')).toBe(true);
  });

  it('should return predicate layer', () => {
    expect(getPredicateLayer('owns')).toBe(PredicateLayer.PHYSICAL);
    expect(getPredicateLayer('trusts')).toBe(PredicateLayer.MENTAL);
    expect(getPredicateLayer('likes')).toBe(PredicateLayer.EMOTIONAL);
    expect(getPredicateLayer('nonexistent')).toBeNull();
  });
});
