interface QueuedTask {
  id: string;
  sessionId: string;
  version: number;
  priority: number; // lower = higher priority
  execute: () => Promise<void>;
  createdAt: number;
}

export class TaskQueue {
  private queue: QueuedTask[] = [];
  private processing = false;

  enqueue(
    id: string,
    sessionId: string,
    version: number,
    execute: () => Promise<void>,
    priority: number = 5
  ): void {
    this.queue.push({ id, sessionId, version, priority, execute, createdAt: Date.now() });
    // Sort by priority (lower first), then by creation time
    this.queue.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
  }

  async processAll(): Promise<{ succeeded: number; failed: number }> {
    if (this.processing) return { succeeded: 0, failed: 0 };
    this.processing = true;

    let succeeded = 0;
    let failed = 0;

    while (this.queue.length > 0) {
      const task = this.queue.shift()!;
      try {
        await task.execute();
        succeeded++;
      } catch (err) {
        failed++;
        console.error(`Task ${task.id} failed:`, err);
      }
    }

    this.processing = false;
    return { succeeded, failed };
  }

  get length(): number {
    return this.queue.length;
  }

  clear(): void {
    this.queue = [];
  }
}
