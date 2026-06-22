import { Entity, EntityType } from '../types/entity.js';
import { getDatabase, execQuery, runAndPersist } from '../storage/db.js';
import { createHash } from 'crypto';

function entityDedupKey(session_id: string, name: string, type: EntityType): string {
  const raw = `${name.toLowerCase()}|${type}|${session_id}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

export class EntityResolver {
  register(session_id: string, name: string, type: EntityType, round: number): Entity {
    const db = getDatabase();
    const dk = entityDedupKey(session_id, name, type);

    const existing = execQuery('SELECT * FROM entities WHERE id = ?', [dk]);

    if (existing.length > 0) {
      const row = existing[0];
      const newRound = Math.max(row.last_seen_round, round);
      const now = Date.now();
      db.run('UPDATE entities SET last_seen_round = ?, updated_at = ? WHERE id = ?', [newRound, now, dk]);

      return {
        id: row.id, session_id: row.session_id, name: row.name,
        aliases: JSON.parse(row.aliases || '[]'), type: row.type as EntityType,
        first_seen_round: row.first_seen_round, last_seen_round: newRound,
        embedding_id: row.embedding_id, version: row.version + 1,
        created_at: row.created_at, updated_at: now,
      };
    }

    const now = Date.now();
    runAndPersist(
      `INSERT INTO entities (id, session_id, name, aliases, type, first_seen_round, last_seen_round, version, created_at, updated_at)
       VALUES (?, ?, ?, '[]', ?, ?, ?, 1, ?, ?)`,
      [dk, session_id, name, type, round, round, now, now]
    );

    return { id: dk, session_id, name, aliases: [], type, first_seen_round: round, last_seen_round: round, version: 1, created_at: now, updated_at: now };
  }

  lookup(session_id: string, nameOrAlias: string): Entity | null {
    const lower = nameOrAlias.toLowerCase();

    // Exact name match
    let rows = execQuery(
      'SELECT * FROM entities WHERE session_id = ? AND LOWER(name) = ?',
      [session_id, lower]
    );

    // Alias match
    if (!rows.length) {
      rows = execQuery(
        'SELECT * FROM entities WHERE session_id = ? AND aliases LIKE ?',
        [session_id, `%${lower}%`]
      );
    }

    if (!rows.length) return null;
    const row = rows[0];
    return {
      id: row.id, session_id: row.session_id, name: row.name,
      aliases: JSON.parse(row.aliases || '[]'), type: row.type as EntityType,
      first_seen_round: row.first_seen_round, last_seen_round: row.last_seen_round,
      embedding_id: row.embedding_id, version: row.version,
      created_at: row.created_at, updated_at: row.updated_at,
    };
  }

  addAlias(entity_id: string, alias: string): void {
    const rows = execQuery('SELECT aliases FROM entities WHERE id = ?', [entity_id]);
    if (!rows.length) throw new Error(`Entity not found: ${entity_id}`);
    const aliases: string[] = JSON.parse(rows[0].aliases || '[]');
    if (!aliases.includes(alias)) {
      aliases.push(alias);
      runAndPersist('UPDATE entities SET aliases = ?, updated_at = ? WHERE id = ?',
        [JSON.stringify(aliases), Date.now(), entity_id]);
    }
  }
}
