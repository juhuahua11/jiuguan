import path from 'path';
import { randomUUID } from 'crypto';
import { buildContinuitySnapshot } from 'memory-proxy/continuity/snapshot-builder';
import {
  getLatestContinuitySnapshot,
  saveContinuitySnapshot,
  saveModelHandoff,
} from 'memory-proxy/storage/continuity-store';
import { initDatabase, runAndPersist } from 'memory-proxy/storage/db';
import type { ChatMessage } from 'memory-proxy/types/provider';
import type { ModelHandoff } from 'memory-proxy/types/continuity';

type RouteApp = { post: (path: string, handler: Function) => void };

let manualDbInitializedPath: string | null = null;

async function ensureManualDb(pluginDir?: string): Promise<void> {
  if (!pluginDir) return;
  const dbPath = path.join(pluginDir, 'data', 'memory.db');
  if (manualDbInitializedPath === dbPath) return;
  await initDatabase(dbPath);
  manualDbInitializedPath = dbPath;
}

function readSessionId(req: any): string | null {
  const sessionId = req.body?.sessionId;
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
}

function readRound(req: any): number {
  return Number(req.body?.round || 0);
}

function readRecentMessages(req: any): ChatMessage[] {
  if (!Array.isArray(req.body?.recentMessages)) return [];
  return req.body.recentMessages
    .filter((m: any) => ['system', 'user', 'assistant'].includes(m?.role) && typeof m?.content === 'string')
    .map((m: any) => ({ role: m.role, content: m.content }));
}

function sendBadRequest(res: any): void {
  res.status(400).json({ error: 'sessionId string required' });
}

export function registerManualMemoryRoutes(app: RouteApp, pluginDir?: string): void {
  app.post('/memory-proxy/continuity/refresh', async (req: any, res: any) => {
    try {
      const sessionId = readSessionId(req);
      if (!sessionId) {
        sendBadRequest(res);
        return;
      }

      await ensureManualDb(pluginDir);
      const snapshot = await saveContinuitySnapshot(await buildContinuitySnapshot(sessionId, {
        sourceRound: readRound(req),
        recentMessages: readRecentMessages(req),
      }));
      res.json({ ok: true, snapshotId: snapshot.id });
    } catch (e: any) {
      console.error('[MemoryProxy] continuity refresh failed:', e?.message || e);
      res.status(500).json({ error: 'internal' });
    }
  });

  app.post('/memory-proxy/handoff/refresh', async (req: any, res: any) => {
    try {
      const sessionId = readSessionId(req);
      if (!sessionId) {
        sendBadRequest(res);
        return;
      }

      await ensureManualDb(pluginDir);
      let snapshot = getLatestContinuitySnapshot(sessionId);
      if (!snapshot) {
        snapshot = await saveContinuitySnapshot(await buildContinuitySnapshot(sessionId, {
          sourceRound: readRound(req),
          recentMessages: readRecentMessages(req),
        }));
      }

      const now = Date.now();
      const boostTurns = Number(req.body?.boostTurns || 20);
      const handoff: ModelHandoff = {
        id: randomUUID(),
        session_id: sessionId,
        from_model: typeof req.body?.fromModel === 'string' ? req.body.fromModel : null,
        to_model: typeof req.body?.toModel === 'string' ? req.body.toModel : 'manual',
        snapshot_id: snapshot.id!,
        created_round: readRound(req),
        boost_turns_total: boostTurns,
        boost_turns_remaining: boostTurns,
        full_turns: Number(req.body?.fullTurns || 3),
        medium_turns: Number(req.body?.mediumTurns || 7),
        handoff_text: `[模型接手提示]\n你正在手动接手一个长期对话。请优先保持剧情、人物关系、事件进度和未解决事项连续。\n\n${snapshot.full_text}`,
        active: true,
        created_at: now,
        updated_at: now,
      };
      await saveModelHandoff(handoff);
      res.json({ ok: true, handoffId: handoff.id });
    } catch (e: any) {
      console.error('[MemoryProxy] handoff refresh failed:', e?.message || e);
      res.status(500).json({ error: 'internal' });
    }
  });

  app.post('/memory-proxy/handoff/clear', async (req: any, res: any) => {
    try {
      const sessionId = readSessionId(req);
      if (!sessionId) {
        sendBadRequest(res);
        return;
      }

      await ensureManualDb(pluginDir);
      await runAndPersist(
        'UPDATE model_handoffs SET active = 0, boost_turns_remaining = 0, updated_at = ? WHERE session_id = ?',
        [Date.now(), sessionId]
      );
      res.json({ ok: true });
    } catch (e: any) {
      console.error('[MemoryProxy] handoff clear failed:', e?.message || e);
      res.status(500).json({ error: 'internal' });
    }
  });
}
