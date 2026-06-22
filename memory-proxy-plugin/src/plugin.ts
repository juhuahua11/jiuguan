import fs from 'fs';
import path from 'path';
import https from 'https';
import { CustomHttpAgent } from './agent/custom-agent.js';
import { startInternalServer } from './internal-server.js';
import { handleMemoryRequest, notifyChatId } from './server/memory-handler.js';
import { registerManualMemoryRoutes } from './server/manual-routes.js';
import type { ServerInstance } from './internal-server.js';

const TARGET_HOSTS = [
  'api.deepseek.com',
  'api.xiaomimimo.com',
];

let internalServer: ServerInstance | null = null;
let customAgent: CustomHttpAgent | null = null;
let previousGlobalAgent: https.Agent | null = null;

/** Load TLS certificate from pre-generated files, fall back to runtime in-memory generation.

 *  The fallback NEVER uses a hardcoded key — every install gets its own ephemeral
 *  self-signed cert generated in memory via the `selfsigned` package (no OpenSSL
 *  CLI dependency, no private key checked into git, no shared key across installs).
 *  The cert exists only for the lifetime of the process and is used solely to TLS
 *  the localhost interception proxy between ST and this plugin.
 */
async function loadOrGenerateCert(pluginDir: string): Promise<{ key: string; cert: string }> {
  const certPath = path.join(pluginDir, 'cert.pem');
  const keyPath = path.join(pluginDir, 'key.pem');

  // 1. Try pre-generated files (created by install-to-st.js when OpenSSL is present)
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    console.log('[MemoryProxy] Loading pre-generated TLS certificate...');
    return {
      cert: fs.readFileSync(certPath, 'utf-8'),
      key: fs.readFileSync(keyPath, 'utf-8'),
    };
  }

  // 2. No cert files — generate an ephemeral self-signed cert in memory.
  //    This is the only fallback: no hardcoded key, no shared secret, no OpenSSL CLI.
  console.log('[MemoryProxy] No pre-generated cert found, generating ephemeral localhost cert in memory...');
  try {
    const selfsigned = require('selfsigned');
    // selfsigned v5 is async and returns a Promise<{ private, public, cert }>.
    const pems = await selfsigned.generate(
      [{ name: 'commonName', value: 'localhost' }],
      { keySize: 2048, algorithm: 'sha256' }
    );
    if (!pems?.private || !pems?.cert) {
      throw new Error('selfsigned.generate returned incomplete PEM data');
    }
    console.log('[MemoryProxy] Generated ephemeral localhost TLS cert (valid for this process only)');
    return { key: pems.private, cert: pems.cert };
  } catch (e: any) {
    throw new Error(
      '[MemoryProxy] Cannot load or generate TLS certificate: ' + (e instanceof Error ? e.message : String(e)) + '\n' +
      '  Run the install script first: node scripts/install-to-st.js <st-path>\n' +
      '  Or install the `selfsigned` dependency: npm install selfsigned'
    );
  }
}

export async function initPlugin(_app: any, pluginDir: string) {
  console.log('[MemoryProxy] V3 initializing via globalAgent interception...');

  // 1. Load or create plugin-config.json
  const configPath = path.join(pluginDir, 'plugin-config.json');
  const defaultConfig = {
    workingMemoryTokens: 32000,
    enabledModules: {
      canon: true, currentState: true, facts: true,
      events: true, relationships: true, graph: true, summaries: true,
    },
    // Optional: separate model/API key for memory extraction.
    // When unset, extraction reuses the chat model + its API key.
    extractionModel: '',
    extractionApiKey: '',
    continuity: {
      enabled: true,
      snapshotDetail: 'full',
      normalMaxTokens: 800,
      compactMaxTokens: 1200,
      mediumMaxTokens: 1800,
      fullMaxTokens: 3000,
      refreshEveryTurns: 5,
    },
    handoff: {
      enabled: true,
      triggerOnModelSwitch: true,
      manualRefreshEnabled: true,
      boostTurns: 20,
      fullTurns: 3,
      mediumTurns: 7,
    },
    keywordRetrieval: {
      enabled: true,
      maxKeywords: 15,
      tierWeights: { entity: 3.0, keyword: 2.0 },
      entityHitBonuses: { two: 1.5, threePlus: 2.0 },
      topicBoost: 1.0,
      recencyHalfLives: {
        identity: 0,
        relationship: 0,
        profile: 180,
        preference: 180,
        event: 30,
        general: 30,
      },
    },
  };
  let pluginConfig = defaultConfig;
  if (fs.existsSync(configPath)) {
    try {
      // Strip a leading UTF-8 BOM (U+FEFF) — see memory-handler.ts for why.
      pluginConfig = { ...defaultConfig, ...JSON.parse(fs.readFileSync(configPath, 'utf-8').replace(/^﻿/, '')) };
    } catch { /* keep defaults */ }
  } else {
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
    console.log('[MemoryProxy] Created default plugin-config.json');
  }

  // 1.5 Register API route for frontend extension to notify current chat ID.
  // Guard against a null/missing _app (e.g. tests passing null) so the whole plugin
  // doesn't abort init just because the route can't be mounted.
  if (_app?.post) {
    _app.post('/set-chat-id', (req: any, res: any) => {
      try {
        const chatId = req.body?.chatId;
        if (chatId && typeof chatId === 'string' && chatId.length <= 256) {
          const changed = notifyChatId(chatId);
          if (changed) console.log('[MemoryProxy] Chat ID updated:', chatId.slice(0, 50));
          res.json({ ok: true });
        } else {
          res.status(400).json({ error: 'chatId (string, max 256 chars) required' });
        }
      } catch (e: any) {
        console.error('[MemoryProxy] /set-chat-id handler error:', e?.message || e);
        res.status(500).json({ error: 'internal' });
      }
    });
    registerManualMemoryRoutes(_app, pluginDir);
  } else {
    console.warn('[MemoryProxy] No _app.post available — /set-chat-id route not mounted (chat_id will fall back to body.chat_id / hash).');
  }

  // 2. Load or generate TLS certificate for the internal server
  const tlsCert = await loadOrGenerateCert(pluginDir);

  // 3. Create upstream agent for real API calls (normal TLS validation)
  const upstreamAgent = new https.Agent({ keepAlive: true });

  // 4. Create local agent for localhost connections (accepts self-signed cert)
  const localAgent = new https.Agent({
    keepAlive: true,
    rejectUnauthorized: false,
  });

  // 5. Start internal Fastify server with HTTPS
  const { server, port } = await startInternalServer({
    handleRequest: (body, headers) => handleMemoryRequest(body, headers, pluginDir, upstreamAgent),
    upstreamAgent,
    pluginDir,
    https: tlsCert,
  });
  internalServer = { server, port };

  // 6. Replace https.globalAgent with CustomHttpAgent
  previousGlobalAgent = https.globalAgent;
  customAgent = new CustomHttpAgent({
    upstreamAgent: previousGlobalAgent as any,
    localAgent,
    interceptHosts: TARGET_HOSTS,
    redirectHost: '127.0.0.1',
    redirectPort: port,
  });
  https.globalAgent = customAgent as any;

  console.log(`[MemoryProxy] Intercepting: ${TARGET_HOSTS.join(', ')}`);
  console.log(`[MemoryProxy] Internal server: https://127.0.0.1:${port}`);
  console.log(`[MemoryProxy] Working memory: ${pluginConfig.workingMemoryTokens} tokens`);

  // 7. Return cleanup function
  return async () => {
    console.log('[MemoryProxy] Shutting down...');
    if (https.globalAgent === (customAgent as any)) {
      https.globalAgent = previousGlobalAgent || new https.Agent({ keepAlive: true });
    }
    if (internalServer) {
      try { await internalServer.server.close(); } catch {}
    }
  };
}
