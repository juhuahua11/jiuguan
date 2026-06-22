/**
 * Lightweight in-memory vector store for V1.
 * Uses cosine similarity. Swap for ChromaDB/Qdrant in V2.
 */

interface VectorEntry {
  id: string;
  vector: number[];
  metadata: Record<string, string>;
}

export class VectorStore {
  private entries: VectorEntry[] = [];

  async add(id: string, vector: number[], metadata: Record<string, string> = {}): Promise<void> {
    // Remove existing entry with same ID
    this.entries = this.entries.filter(e => e.id !== id);
    this.entries.push({ id, vector, metadata });
  }

  async addBatch(items: Array<{ id: string; vector: number[]; metadata?: Record<string, string> }>): Promise<void> {
    for (const item of items) {
      await this.add(item.id, item.vector, item.metadata || {});
    }
  }

  async query(vector: number[], topK: number = 10): Promise<Array<{ id: string; score: number; metadata: Record<string, string> }>> {
    if (this.entries.length === 0) return [];

    const scored = this.entries.map(entry => ({
      id: entry.id,
      score: cosineSimilarity(vector, entry.vector),
      metadata: entry.metadata,
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  async delete(id: string): Promise<void> {
    this.entries = this.entries.filter(e => e.id !== id);
  }

  async count(): Promise<number> {
    return this.entries.length;
  }

  async clear(): Promise<void> {
    this.entries = [];
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
