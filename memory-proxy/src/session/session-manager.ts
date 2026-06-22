import { Session } from '../types/session.js';
import { createSession, getSession, updateSessionRound } from '../storage/session-store.js';
import { createHash } from 'crypto';

export class SessionManager {
  private cache: Map<string, Session> = new Map();

  resolve(character_id: string, chat_id: string, branch_id: string = 'main'): Session {
    const sid = this.buildSessionID(character_id, chat_id, branch_id);
    const cached = this.cache.get(sid);
    if (cached) return cached;

    let session = getSession(sid);
    if (!session) {
      session = createSession(character_id, chat_id, branch_id);
    }
    this.cache.set(sid, session);
    return session;
  }

  incrementRound(sessionId: string): number {
    const session = getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const newRound = session.round + 1;
    updateSessionRound(sessionId, newRound);
    this.cache.delete(sessionId);
    return newRound;
  }

  private buildSessionID(character_id: string, chat_id: string, branch_id: string): string {
    const raw = `${character_id}|${chat_id}|${branch_id}`;
    return createHash('sha256').update(raw).digest('hex').slice(0, 32);
  }
}
