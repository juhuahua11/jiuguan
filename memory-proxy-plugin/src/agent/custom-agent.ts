import http from 'http';
import https from 'https';

export interface CustomHttpAgentOptions {
  upstreamAgent: http.Agent;
  /** Agent for localhost connections (accepts self-signed TLS certs) */
  localAgent: https.Agent;
  interceptHosts: string[];
  redirectHost: string;
  redirectPort: number;
}

/**
 * Custom agent for intercepting HTTPS requests by hostname.
 * Extends https.Agent so it can be used as a drop-in replacement
 * for https.globalAgent.
 *
 * For intercepted hosts: redirects to localhost via localAgent (self-signed TLS).
 * For other hosts: passes through to upstreamAgent (normal TLS validation).
 */
export class CustomHttpAgent extends https.Agent {
  private upstreamAgent: http.Agent;
  private localAgent: https.Agent;
  private interceptHosts: Set<string>;
  private redirectHost: string;
  private redirectPort: number;

  constructor(options: CustomHttpAgentOptions) {
    super();
    this.upstreamAgent = options.upstreamAgent;
    this.localAgent = options.localAgent;
    this.interceptHosts = new Set(options.interceptHosts);
    this.redirectHost = options.redirectHost;
    this.redirectPort = options.redirectPort;
  }

  /** Return the upstream agent for direct API calls (avoiding loops) */
  getUpstreamAgent(): http.Agent {
    return this.upstreamAgent;
  }

  addRequest(
    req: http.ClientRequest,
    options: http.ClientRequestArgs,
    port?: number,
    localAddress?: string
  ): void {
    const hostname = (options.hostname || options.host || '') as string;

    if (this.interceptHosts.has(hostname)) {
      req.setHeader('x-upstream-host', hostname);
      req.setHeader('x-upstream-port', String(options.port ?? 443));

      options.hostname = this.redirectHost;
      options.host = this.redirectHost;
      (options as any).port = this.redirectPort;

      // Use localAgent for localhost — accepts self-signed cert
      (this.localAgent as any).addRequest(req, options, port, localAddress);
      return;
    }

    (this.upstreamAgent as any).addRequest(req, options, port, localAddress);
  }
}
