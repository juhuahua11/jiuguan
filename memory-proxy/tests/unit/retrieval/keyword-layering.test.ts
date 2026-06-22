import { describe, expect, it } from 'vitest';
import { layerKeywordContext } from '../../../src/retrieval/keyword-extractor.js';

describe('layerKeywordContext', () => {
  it('keeps entities and keywords ahead of low-signal search-term tail', () => {
    const result = layerKeywordContext({
      entities: ['Alice', 'Bob', 'Carol'],
      keywords: ['promise', 'sword'],
      search_terms: ['tail-1', 'Alice', 'tail-2', 'tail-3', 'tail-4', 'promise'],
      implicit_topics: ['debt', 'trade', 'travel'],
    }, {
      maxEntities: 2,
      maxKeywords: 1,
      maxAdditionalSearchTerms: 2,
      maxImplicitTopics: 2,
    });

    expect(result.entities).toEqual(['Alice', 'Bob']);
    expect(result.keywords).toEqual(['promise']);
    expect(result.search_terms).toEqual(['Alice', 'Bob', 'promise', 'tail-1', 'tail-2']);
    expect(result.implicit_topics).toEqual(['debt', 'trade']);
  });
});
