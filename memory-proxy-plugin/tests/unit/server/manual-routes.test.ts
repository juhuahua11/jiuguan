import { describe, it, expect } from 'vitest';
import { registerManualMemoryRoutes } from '../../../src/server/manual-routes.js';

describe('registerManualMemoryRoutes', () => {
  it('registers continuity and handoff manual endpoints', () => {
    const routes: Array<{ path: string; handler: Function }> = [];
    const app = {
      post(path: string, handler: Function) {
        routes.push({ path, handler });
      },
    };

    registerManualMemoryRoutes(app);

    expect(routes.map(route => route.path)).toEqual([
      '/memory-proxy/continuity/refresh',
      '/memory-proxy/handoff/refresh',
      '/memory-proxy/handoff/clear',
    ]);
    expect(routes.every(route => typeof route.handler === 'function')).toBe(true);
  });
});
