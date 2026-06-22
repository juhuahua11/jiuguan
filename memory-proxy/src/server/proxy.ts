import Fastify, { FastifyInstance } from 'fastify';
import { loadConfig } from '../config.js';
import { initDatabase } from '../storage/db.js';
import { registerRoutes } from './routes.js';
import path from 'path';

export async function startProxy(): Promise<FastifyInstance> {
  const config = loadConfig();
  const dbPath = path.join(config.dataDir, 'proxy.db');
  await initDatabase(dbPath);

  const app = Fastify({
    logger: true,
    bodyLimit: 50 * 1024 * 1024, // 50MB，防止大请求体被拒绝
  });
  await registerRoutes(app, config);
  await app.listen({ port: config.proxyPort, host: '0.0.0.0' });
  console.log(`Memory Proxy listening on http://localhost:${config.proxyPort}`);
  console.log(`Forwarding to: ${config.upstreamUrl}`);
  return app;
}
