import { QueryContext } from '../types/retrieval.js';
import { searchFactsByKeywords, searchEventsByKeywords } from './semantic-search.js';
import type { KeywordContext } from './keyword-extractor.js';
import { getSessionGraph } from '../extraction/graph-builder.js';
import { getFact } from '../storage/fact-store.js';
import { execQuery } from '../storage/db.js';

export interface RetrievalItem {
  id: string;
  type: 'fact' | 'event' | 'relationship' | 'canon';
  content: string;
  score: number;
  source: 'semantic' | 'graph' | 'both' | 'cache' | 'cache-reconstructed';
  tier: 1 | 2 | 3;
}

/**
 * Combined dual-path retrieval: semantic + graph.
 */
export async function dualRetrieve(
  sessionId: string,
  queryContext: QueryContext,
  keywordCtx: KeywordContext,
  topK: number = 20
): Promise<RetrievalItem[]> {
  const items: Map<string, RetrievalItem> = new Map();

  // Path 1: Keyword Search (facts + events)
  if (keywordCtx.search_terms.length > 0) {
    const factResults = await searchFactsByKeywords(sessionId, keywordCtx, topK);
    for (const item of factResults) {
      items.set(`fact:${item.id}`, {
        id: item.id, type: 'fact', content: item.content,
        score: item.score, source: 'semantic', tier: item.tier as 1 | 2 | 3,
      });
    }

    // V4.2: keyword-based event search — previously events were only reachable
    // via graph BFS, meaning events without entity-name mentions were invisible.
    const eventResults = searchEventsByKeywords(sessionId, keywordCtx, topK);
    for (const item of eventResults) {
      const key = `event:${item.id}`;
      const existing = items.get(key);
      if (existing) {
        existing.score = Math.max(existing.score, item.score);
        if (item.score > existing.score) existing.source = 'semantic';
      } else {
        items.set(key, {
          id: item.id, type: 'event', content: item.content,
          score: item.score, source: 'semantic', tier: item.tier as 1 | 2 | 3,
        });
      }
    }
  }

  // Path 2: Graph Search
  if (queryContext.entities.length > 0) {
    const graph = getSessionGraph(sessionId);
    const graphResult = graph.bfsSearch(queryContext.entities);

    for (const edge of graphResult.edges) {
      // Look up entity_id from the node for score access
      // (bfsSearch scores are keyed by entity_id, not node_id)
      const fromNode = graphResult.nodes.find(n => n.id === edge.from_node_id);
      const entityId = fromNode?.entity_id;
      const baseScore = entityId ? (graphResult.scores.get(entityId) || 0.5) : 0.5;

      // Get the facts/events/relationships associated with this edge
      if (edge.source_type === 'fact') {
        const fact = getFact(edge.source_id);
        if (fact) {
          const graphScore = baseScore * edge.weight;
          const key = `fact:${fact.id}`;
          const existing = items.get(key);
          if (existing) {
            existing.score += graphScore;
            existing.source = 'both';
          } else {
            items.set(key, {
              id: fact.id, type: 'fact', content: fact.statement,
              score: graphScore, source: 'graph', tier: 1,
            });
          }
        }
      }

      if (edge.source_type === 'event') {
        const rows = execQuery('SELECT * FROM events WHERE id = ?', [edge.source_id]);
        if (rows.length > 0) {
          const event = rows[0];
          const graphScore = baseScore * edge.weight;
          items.set(`event:${event.id}`, {
            id: event.id, type: 'event', content: event.description,
            score: graphScore, source: 'graph', tier: 1,
          });
        }
      }

      if (edge.source_type === 'relationship') {
        const rows = execQuery('SELECT * FROM relationships WHERE id = ?', [edge.source_id]);
        if (rows.length > 0) {
          const rel = rows[0];
          const graphScore = baseScore * edge.weight;
          items.set(`rel:${rel.id}`, {
            id: rel.id, type: 'relationship',
            content: `${rel.subject_id} ${rel.relation_type} ${rel.object_id} (intensity: ${rel.intensity})`,
            score: graphScore, source: 'graph', tier: 1,
          });
        }
      }
    }
  }

  // Sort by score and assign tiers
  const sorted = Array.from(items.values()).sort((a, b) => b.score - a.score);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].score > 0.8) sorted[i].tier = 1;
    else if (sorted[i].score > 0.5) sorted[i].tier = 2;
    else if (sorted[i].score > 0.3) sorted[i].tier = 3;
    else sorted[i].tier = 3;
  }

  return sorted.filter(item => item.score > 0.3);
}
