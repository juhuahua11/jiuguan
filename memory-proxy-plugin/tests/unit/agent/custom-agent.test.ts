import { describe, it, expect } from 'vitest';
import http from 'http';
import https from 'https';
import { CustomHttpAgent } from '../../../src/agent/custom-agent';

function makeAgents() {
  const upstream = new http.Agent();
  const local = new https.Agent({ rejectUnauthorized: false });
  return { upstream, local };
}

describe('CustomHttpAgent', () => {
  it('should be constructable', () => {
    const { upstream, local } = makeAgents();
    const agent = new CustomHttpAgent({
      upstreamAgent: upstream as any,
      localAgent: local,
      interceptHosts: ['api.deepseek.com'],
      redirectHost: '127.0.0.1',
      redirectPort: 19999,
    });
    expect(agent).toBeDefined();
  });

  it('should expose the upstream agent', () => {
    const { upstream, local } = makeAgents();
    const agent = new CustomHttpAgent({
      upstreamAgent: upstream as any,
      localAgent: local,
      interceptHosts: ['api.deepseek.com'],
      redirectHost: '127.0.0.1',
      redirectPort: 19999,
    });
    expect(agent.getUpstreamAgent()).toBe(upstream);
  });

  it('should add x-upstream-host header and redirect for intercepted hosts', () => {
    const { upstream, local } = makeAgents();
    const agent = new CustomHttpAgent({
      upstreamAgent: upstream as any,
      localAgent: local,
      interceptHosts: ['api.deepseek.com'],
      redirectHost: '127.0.0.1',
      redirectPort: 19999,
    });

    const setHeaders: Record<string, string> = {};
    const req = { setHeader: (n: string, v: string) => { setHeaders[n] = v; } } as any;
    const options: any = { hostname: 'api.deepseek.com', port: 443, path: '/v1/chat/completions' };

    // Intercepted: request goes through localAgent
    let localGotOptions: any = null;
    local.addRequest = (r, opts) => { localGotOptions = opts; };

    agent.addRequest(req, options, 443);

    expect(setHeaders['x-upstream-host']).toBe('api.deepseek.com');
    expect(setHeaders['x-upstream-port']).toBe('443');
    expect(localGotOptions.hostname).toBe('127.0.0.1');
    expect(localGotOptions.port).toBe(19999);
  });

  it('should NOT add x-upstream-host for non-intercepted hosts', () => {
    const { upstream, local } = makeAgents();
    const agent = new CustomHttpAgent({
      upstreamAgent: upstream as any,
      localAgent: local,
      interceptHosts: ['api.deepseek.com'],
      redirectHost: '127.0.0.1',
      redirectPort: 19997,
    });

    const setHeaders: Record<string, string> = {};
    const mockReq = { setHeader: (n: string, v: string) => { setHeaders[n] = v; } };
    let capturedOptions: any = null;
    upstream.addRequest = (_r: any, opts: any) => { capturedOptions = opts; };

    const options = { hostname: 'api.openai.com', port: 443, path: '/v1/models' };
    agent.addRequest(mockReq as any, options as any);

    expect(setHeaders['x-upstream-host']).toBeUndefined();
    expect(capturedOptions.hostname).toBe('api.openai.com');
  });
});
