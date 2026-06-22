import { normalizePredicate } from './predicate-registry.js';
import type { Fact } from '../types/fact.js';
import type { Event } from '../types/event.js';

export interface NormalizedResults {
  facts: Array<Partial<Fact>>;
  events: Array<Partial<Event>>;
}

export function normalizeExtractionResults(
  facts: Array<Partial<Fact>>,
  events: Array<Partial<Event>>
): NormalizedResults {
  const normalizedFacts = facts.map(f => ({
    ...f,
    predicate: normalizePredicate(f.predicate || ''),
  }));

  const normalizedEvents = events.map(e => ({
    ...e,
    description: e.description || '',
    participants: e.participants || [],
  }));

  return { facts: normalizedFacts, events: normalizedEvents };
}
