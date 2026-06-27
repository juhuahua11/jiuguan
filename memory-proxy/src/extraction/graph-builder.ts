import { GraphStore } from '../storage/graph-store.js';
import { execQuery } from '../storage/db.js';

/**
 * Build/rebuild graph from Facts, Events, Relationships, and Canon for a session.
 */
export function buildGraph(sessionId: string, store: GraphStore): void {
  // 1. Register entity nodes
  const entities = execQuery('SELECT id, name FROM entities WHERE session_id = ?', [sessionId]);
  for (const entity of entities) {
    store.upsertNode({
      entity_id: entity.id,
      source_refs: { fact_ids: [], event_ids: [], relationship_ids: [], canon_entry_ids: [] },
    });
  }

  // 2. Facts → edges (subject owns/located_at/etc object)
  const facts = execQuery(
    'SELECT * FROM facts WHERE session_id = ? AND valid_to IS NULL AND tombstone_deleted = 0',
    [sessionId]
  );
  for (const fact of facts) {
    if (fact.object_id) {
      // Ensure both nodes exist
      store.upsertNode({
        entity_id: fact.subject_id,
        source_refs: { fact_ids: [fact.id], event_ids: [], relationship_ids: [], canon_entry_ids: [] },
      });
      store.upsertNode({
        entity_id: fact.object_id,
        source_refs: { fact_ids: [fact.id], event_ids: [], relationship_ids: [], canon_entry_ids: [] },
      });
      // Add edge
      store.addEdge({
        from_node_id: store.getNodeByEntity(fact.subject_id)!.id,
        to_node_id: store.getNodeByEntity(fact.object_id)!.id,
        edge_type: fact.predicate,
        source_type: 'fact',
        source_id: fact.id,
        weight: fact.confidence,
        valid_from: fact.valid_from,
        valid_to: fact.valid_to,
      });
    }
  }

  // 3. Events → edges (participant relationships)
  const events = execQuery('SELECT * FROM events WHERE session_id = ?', [sessionId]);
  for (const event of events) {
    const participants: string[] = JSON.parse(event.participants || '[]');
    // Connect each participant to a virtual "event entity" concept
    // For simplicity, connect first participant to others
    if (participants.length >= 2) {
      for (let i = 1; i < participants.length; i++) {
        store.upsertNode({
          entity_id: participants[0],
          source_refs: { fact_ids: [], event_ids: [event.id], relationship_ids: [], canon_entry_ids: [] },
        });
        store.upsertNode({
          entity_id: participants[i],
          source_refs: { fact_ids: [], event_ids: [event.id], relationship_ids: [], canon_entry_ids: [] },
        });
        // Time decay: newer events have higher weight
        const recencyWeight = Math.max(0.3, 1.0 - (Date.now() - event.created_at) / (1000 * 60 * 60 * 24 * 365));
        const sigWeight = event.significance === 'CRITICAL' ? 1.0 :
          event.significance === 'HIGH' ? 0.8 :
          event.significance === 'MEDIUM' ? 0.5 : 0.3;
        const node1 = store.getNodeByEntity(participants[0]);
        const node2 = store.getNodeByEntity(participants[i]);
        if (node1 && node2) {
          store.addEdge({
            from_node_id: node1.id, to_node_id: node2.id,
            edge_type: 'participated_with',
            source_type: 'event', source_id: event.id,
            weight: recencyWeight * sigWeight,
            valid_from: event.timestamp_round, valid_to: null,
          });
        }
      }
    }
  }

  // 4. Relationships → edges
  const relationships = execQuery('SELECT * FROM relationships WHERE session_id = ?', [sessionId]);
  for (const rel of relationships) {
    store.upsertNode({
      entity_id: rel.subject_id,
      source_refs: { fact_ids: [], event_ids: [], relationship_ids: [rel.id], canon_entry_ids: [] },
    });
    store.upsertNode({
      entity_id: rel.object_id,
      source_refs: { fact_ids: [], event_ids: [], relationship_ids: [rel.id], canon_entry_ids: [] },
    });
    const node1 = store.getNodeByEntity(rel.subject_id);
    const node2 = store.getNodeByEntity(rel.object_id);
    if (node1 && node2) {
      store.addEdge({
        from_node_id: node1.id, to_node_id: node2.id,
        edge_type: rel.relation_type.toLowerCase(),
        source_type: 'relationship', source_id: rel.id,
        weight: Math.abs(rel.intensity),
        valid_from: 0, valid_to: null,
      });
    }
  }

  // 5. Canon → edges (for Extended Canon entity references)
  const canonEntries = execQuery(
    "SELECT * FROM canon_entries WHERE (session_id = ? OR session_id IS NULL) AND archived_at IS NULL",
    [sessionId]
  );
  for (const canon of canonEntries) {
    const keywords: string[] = JSON.parse(canon.keywords || '[]');
    // Canon nodes connect keywords as conceptual entities
    for (const kw of keywords) {
      const node = store.getNodeByEntity(`canon:${kw}`);
      if (!node) {
        store.upsertNode({
          entity_id: `canon:${kw}`,
          source_refs: { fact_ids: [], event_ids: [], relationship_ids: [], canon_entry_ids: [canon.id] },
        });
      }
    }
  }
}

// Global graph store per session, with LRU eviction to prevent unbounded
// memory growth from inactive sessions. Each active session's graph holds
// all facts/events/relationships in memory; without eviction, long-running
// servers with many sessions would leak memory indefinitely.
const sessionGraphs = new Map<string, GraphStore>();
const MAX_GRAPH_CACHE = 32;

function evictLRU() {
  if (sessionGraphs.size <= MAX_GRAPH_CACHE) return;
  // Map keys iterate in insertion order. Since we delete+re-set on every
  // get, the first key is genuinely least-recently-used (not just oldest).
  const oldest = sessionGraphs.keys().next().value;
  if (oldest !== undefined) {
    sessionGraphs.delete(oldest);
    console.log(`[MemoryProxy] Graph LRU evicted session=${oldest.slice(0, 40)} (cache size: ${sessionGraphs.size})`);
  }
}

export function getSessionGraph(sessionId: string): GraphStore {
  let store = sessionGraphs.get(sessionId);
  if (store) {
    // Move to end of Map to mark as most-recently-used (true LRU)
    sessionGraphs.delete(sessionId);
    sessionGraphs.set(sessionId, store);
    return store;
  }
  store = new GraphStore();
  const t0 = Date.now();
  buildGraph(sessionId, store);
  console.log(`[MemoryProxy] Graph built for session=${sessionId.slice(0, 40)} — nodes=${store.nodeCount} edges=${store.edgeCount} (${Date.now() - t0}ms)`);
  sessionGraphs.set(sessionId, store);
  evictLRU();
  return store;
}

export function invalidateGraph(sessionId: string): void {
  sessionGraphs.delete(sessionId);
}
