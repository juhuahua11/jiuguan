import { describe, it, expect, beforeEach } from 'vitest';
import { GraphStore } from '../../../src/storage/graph-store.js';

describe('GraphStore', () => {
  let store: GraphStore;

  beforeEach(() => {
    store = new GraphStore();
  });

  it('should start empty', () => {
    expect(store.nodeCount).toBe(0);
    expect(store.edgeCount).toBe(0);
  });

  it('should upsert and retrieve nodes', () => {
    const node = store.upsertNode({
      entity_id: 'e_zhangsan',
      source_refs: { fact_ids: ['f1'], event_ids: [], relationship_ids: [], canon_entry_ids: [] },
    });
    expect(node.id).toBeDefined();
    expect(store.nodeCount).toBe(1);

    const found = store.getNodeByEntity('e_zhangsan');
    expect(found).toBeDefined();
    expect(found!.source_refs.fact_ids).toContain('f1');
  });

  it('should merge source refs on duplicate entity', () => {
    store.upsertNode({ entity_id: 'e_zhangsan', source_refs: { fact_ids: ['f1'], event_ids: [], relationship_ids: [], canon_entry_ids: [] } });
    store.upsertNode({ entity_id: 'e_zhangsan', source_refs: { fact_ids: ['f2'], event_ids: [], relationship_ids: [], canon_entry_ids: [] } });

    const node = store.getNodeByEntity('e_zhangsan')!;
    expect(node.source_refs.fact_ids).toHaveLength(2);
    expect(store.nodeCount).toBe(1);
  });

  it('should add and deduplicate edges', () => {
    const n1 = store.upsertNode({ entity_id: 'e_a', source_refs: { fact_ids: [], event_ids: [], relationship_ids: [], canon_entry_ids: [] } });
    const n2 = store.upsertNode({ entity_id: 'e_b', source_refs: { fact_ids: [], event_ids: [], relationship_ids: [], canon_entry_ids: [] } });

    store.addEdge({ from_node_id: n1.id, to_node_id: n2.id, edge_type: 'owns', source_type: 'fact', source_id: 'f1', weight: 0.5, valid_from: 1, valid_to: null });
    store.addEdge({ from_node_id: n1.id, to_node_id: n2.id, edge_type: 'owns', source_type: 'fact', source_id: 'f1-new', weight: 0.9, valid_from: 1, valid_to: null });

    expect(store.edgeCount).toBe(1);
    const edges = store.getEdgesFrom(n1.id);
    expect(edges[0].weight).toBe(0.9);
  });

  it('should perform BFS search from entities', () => {
    const a = store.upsertNode({ entity_id: 'e_a', source_refs: { fact_ids: [], event_ids: [], relationship_ids: [], canon_entry_ids: [] } });
    const b = store.upsertNode({ entity_id: 'e_b', source_refs: { fact_ids: [], event_ids: [], relationship_ids: [], canon_entry_ids: [] } });
    const c = store.upsertNode({ entity_id: 'e_c', source_refs: { fact_ids: [], event_ids: [], relationship_ids: [], canon_entry_ids: [] } });

    store.addEdge({ from_node_id: a.id, to_node_id: b.id, edge_type: 'owns', source_type: 'fact', source_id: 'f1', weight: 1.0, valid_from: 1, valid_to: null });
    store.addEdge({ from_node_id: b.id, to_node_id: c.id, edge_type: 'located_at', source_type: 'fact', source_id: 'f2', weight: 0.8, valid_from: 1, valid_to: null });

    const result = store.bfsSearch(['e_a']);
    expect(result.nodes.length).toBeGreaterThanOrEqual(2);
    expect(result.edges.length).toBeGreaterThanOrEqual(1);
  });

  it('should respect BFS depth limit', () => {
    const a = store.upsertNode({ entity_id: 'e_a', source_refs: { fact_ids: [], event_ids: [], relationship_ids: [], canon_entry_ids: [] } });
    const b = store.upsertNode({ entity_id: 'e_b', source_refs: { fact_ids: [], event_ids: [], relationship_ids: [], canon_entry_ids: [] } });
    const c = store.upsertNode({ entity_id: 'e_c', source_refs: { fact_ids: [], event_ids: [], relationship_ids: [], canon_entry_ids: [] } });
    const d = store.upsertNode({ entity_id: 'e_d', source_refs: { fact_ids: [], event_ids: [], relationship_ids: [], canon_entry_ids: [] } });

    store.addEdge({ from_node_id: a.id, to_node_id: b.id, edge_type: 'x', source_type: 'fact', source_id: '1', weight: 1, valid_from: 1, valid_to: null });
    store.addEdge({ from_node_id: b.id, to_node_id: c.id, edge_type: 'x', source_type: 'fact', source_id: '2', weight: 1, valid_from: 1, valid_to: null });
    store.addEdge({ from_node_id: c.id, to_node_id: d.id, edge_type: 'x', source_type: 'fact', source_id: '3', weight: 1, valid_from: 1, valid_to: null });

    const result = store.bfsSearch(['e_a']);
    // Only 1-hop and 2-hop; d should not be reached (3-hop)
    const entityIds = result.nodes.map(n => n.entity_id);
    expect(entityIds).toContain('e_a');
    expect(entityIds).toContain('e_b');
    expect(entityIds).toContain('e_c');
    expect(entityIds).not.toContain('e_d');
  });
});
