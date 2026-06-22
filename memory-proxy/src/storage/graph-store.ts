import { v4 as uuid } from 'uuid';

export interface GraphNode {
  id: string;
  entity_id: string;
  source_refs: {
    fact_ids: string[];
    event_ids: string[];
    relationship_ids: string[];
    canon_entry_ids: string[];
  };
}

export interface GraphEdge {
  id: string;
  from_node_id: string;
  to_node_id: string;
  edge_type: string;
  source_type: 'fact' | 'event' | 'relationship' | 'canon';
  source_id: string;
  weight: number;
  valid_from: number;
  valid_to: number | null;
}

export class GraphStore {
  private nodes: Map<string, GraphNode> = new Map();
  private edges: GraphEdge[] = [];
  // entity_id → node_id index
  private entityIndex: Map<string, string> = new Map();

  upsertNode(node: Omit<GraphNode, 'id'> & { id?: string }): GraphNode {
    // Check if node exists for this entity
    const existingId = this.entityIndex.get(node.entity_id);
    if (existingId) {
      const existing = this.nodes.get(existingId)!;
      // Merge source_refs
      const merged: GraphNode = {
        ...existing,
        source_refs: {
          fact_ids: [...new Set([...existing.source_refs.fact_ids, ...node.source_refs.fact_ids])],
          event_ids: [...new Set([...existing.source_refs.event_ids, ...node.source_refs.event_ids])],
          relationship_ids: [...new Set([...existing.source_refs.relationship_ids, ...node.source_refs.relationship_ids])],
          canon_entry_ids: [...new Set([...existing.source_refs.canon_entry_ids, ...node.source_refs.canon_entry_ids])],
        },
      };
      this.nodes.set(existingId, merged);
      return merged;
    }

    const id = node.id || uuid();
    const newNode: GraphNode = { ...node, id };
    this.nodes.set(id, newNode);
    this.entityIndex.set(node.entity_id, id);
    return newNode;
  }

  addEdge(edge: Omit<GraphEdge, 'id'> & { id?: string }): GraphEdge {
    // Dedup: same from+to+edge_type → update weight
    const existing = this.edges.find(
      e => e.from_node_id === edge.from_node_id &&
          e.to_node_id === edge.to_node_id &&
          e.edge_type === edge.edge_type
    );
    if (existing) {
      existing.weight = edge.weight;
      existing.valid_to = edge.valid_to;
      existing.source_id = edge.source_id;
      return existing;
    }

    const newEdge: GraphEdge = { ...edge, id: edge.id || uuid() };
    this.edges.push(newEdge);
    return newEdge;
  }

  getNodeByEntity(entityId: string): GraphNode | undefined {
    const nodeId = this.entityIndex.get(entityId);
    return nodeId ? this.nodes.get(nodeId) : undefined;
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  getEdgesFrom(nodeId: string): GraphEdge[] {
    return this.edges.filter(e => e.from_node_id === nodeId && e.valid_to === null);
  }

  getEdgesTo(nodeId: string): GraphEdge[] {
    return this.edges.filter(e => e.to_node_id === nodeId && e.valid_to === null);
  }

  getAllEdges(nodeId: string): GraphEdge[] {
    return this.edges.filter(
      e => (e.from_node_id === nodeId || e.to_node_id === nodeId) && e.valid_to === null
    );
  }

  bfsSearch(
    startEntityIds: string[],
    maxNodes: number = 30,
    maxEdges: number = 50
  ): { nodes: GraphNode[]; edges: GraphEdge[]; scores: Map<string, number> } {
    const visited = new Set<string>();
    const foundEdges: GraphEdge[] = [];
    const scores = new Map<string, number>();
    const queue: Array<{ entityId: string; depth: number; score: number }> = [];

    // Initialize BFS from start entities
    for (const entityId of startEntityIds) {
      const node = this.getNodeByEntity(entityId);
      if (node) {
        queue.push({ entityId, depth: 0, score: 1.0 });
        scores.set(entityId, 1.0);
      }
    }

    while (queue.length > 0 && visited.size < maxNodes && foundEdges.length < maxEdges) {
      const current = queue.shift()!;
      const node = this.getNodeByEntity(current.entityId);
      if (!node || visited.has(node.id)) continue;
      visited.add(node.id);

      const neighbors = this.getAllEdges(node.id);
      for (const edge of neighbors) {
        if (foundEdges.length >= maxEdges) break;

        const neighborNodeId = edge.from_node_id === node.id ? edge.to_node_id : edge.from_node_id;
        const neighborNode = this.nodes.get(neighborNodeId);
        if (!neighborNode || visited.has(neighborNodeId)) continue;

        foundEdges.push(edge);

        // Score decays with depth and edge weight
        const depthDecay = current.depth === 0 ? 1.0 : current.depth === 1 ? 0.5 : 0.25;
        const neighborScore = current.score * edge.weight * depthDecay;
        const existingScore = scores.get(neighborNode.entity_id) || 0;
        scores.set(neighborNode.entity_id, Math.max(existingScore, neighborScore));

        if (current.depth < 2) { // 1-hop and 2-hop only
          queue.push({ entityId: neighborNode.entity_id, depth: current.depth + 1, score: neighborScore });
        }
      }
    }

    const visitedNodes = Array.from(visited).map(id => this.nodes.get(id)!).filter(Boolean);
    return { nodes: visitedNodes, edges: foundEdges, scores };
  }

  clear(): void {
    this.nodes.clear();
    this.edges = [];
    this.entityIndex.clear();
  }

  get nodeCount(): number { return this.nodes.size; }
  get edgeCount(): number { return this.edges.length; }
}
