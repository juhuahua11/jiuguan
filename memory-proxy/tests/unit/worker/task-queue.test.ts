import { describe, it, expect } from 'vitest';
import { TaskQueue } from '../../../src/worker/task-queue.js';

describe('TaskQueue', () => {
  it('should start empty', () => {
    const q = new TaskQueue();
    expect(q.length).toBe(0);
  });

  it('should process tasks in priority order', async () => {
    const q = new TaskQueue();
    const order: string[] = [];

    q.enqueue('t1', 's1', 1, async () => { order.push('low'); }, 10);
    q.enqueue('t2', 's1', 1, async () => { order.push('high'); }, 1);
    q.enqueue('t3', 's1', 1, async () => { order.push('mid'); }, 5);

    await q.processAll();
    expect(order).toEqual(['high', 'mid', 'low']);
    expect(q.length).toBe(0);
  });

  it('should handle task failures gracefully', async () => {
    const q = new TaskQueue();
    q.enqueue('t1', 's1', 1, async () => { throw new Error('boom'); }, 1);
    q.enqueue('t2', 's1', 1, async () => { /* succeeds */ }, 2);

    const result = await q.processAll();
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(1);
  });
});
