import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import fs from 'fs';
import path from 'path';

let db: SqlJsDatabase | null = null;
let dbPath: string | null = null;
let inMemoryOnly = false;

export async function initDatabase(filePath?: string): Promise<void> {
  const SQL = await initSqlJs();

  // Handle :memory: mode — no file I/O, purely in-memory
  if (filePath === ':memory:') {
    db = new SQL.Database();
    dbPath = null;
    inMemoryOnly = true;
    runMigrations();
    return;
  }

  const resolvedPath = filePath || path.join(process.cwd(), 'memory', 'proxy.db');
  dbPath = resolvedPath;
  inMemoryOnly = false;

  // Ensure directory exists
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Load existing or create new
  if (fs.existsSync(resolvedPath)) {
    const buffer = fs.readFileSync(resolvedPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  runMigrations();
  await persist();
}

function runMigrations(): void {
  if (!db) throw new Error('Database not initialized');

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      branch_id TEXT NOT NULL DEFAULT 'main',
      round INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      name TEXT NOT NULL,
      aliases TEXT NOT NULL DEFAULT '[]',
      type TEXT NOT NULL,
      first_seen_round INTEGER NOT NULL,
      last_seen_round INTEGER NOT NULL,
      embedding_id TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object_id TEXT,
      statement TEXT NOT NULL,
      confidence REAL NOT NULL,
      source TEXT NOT NULL,
      fact_type TEXT NOT NULL DEFAULT 'general',
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      valid_from INTEGER NOT NULL,
      valid_to INTEGER,
      embedding_id TEXT,
      trace_id TEXT NOT NULL,
      tombstone_deleted INTEGER NOT NULL DEFAULT 0,
      tombstone_deleted_at INTEGER,
      tombstone_deletion_reason TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Migration: add fact_type column for existing databases
  try {
    db.run('ALTER TABLE facts ADD COLUMN fact_type TEXT NOT NULL DEFAULT \'general\'');
  } catch {
    // Column already exists — ignore
  }

  // Migration V4.2: extraction progress tracking for incremental extraction
  try {
    db.run("ALTER TABLE sessions ADD COLUMN last_fingerprint TEXT NOT NULL DEFAULT ''");
  } catch {
    // Column already exists — ignore
  }
  try {
    db.run('ALTER TABLE sessions ADD COLUMN last_message_count INTEGER NOT NULL DEFAULT 0');
  } catch {
    // Column already exists — ignore
  }
  try {
    db.run("ALTER TABLE sessions ADD COLUMN last_integrity_hash TEXT NOT NULL DEFAULT ''");
  } catch {
    // Column already exists — ignore
  }

  try {
    db.run("ALTER TABLE sessions ADD COLUMN last_chat_model TEXT NOT NULL DEFAULT ''");
  } catch {
    // Column already exists
  }
  try {
    db.run('ALTER TABLE sessions ADD COLUMN last_model_seen_at INTEGER NOT NULL DEFAULT 0');
  } catch {
    // Column already exists
  }
  try {
    db.run("ALTER TABLE sessions ADD COLUMN active_handoff_id TEXT NOT NULL DEFAULT ''");
  } catch {
    // Column already exists
  }

  // [FIX: memory-extraction-backlog] V5: pending extraction flag for catch-up
  try {
    db.run('ALTER TABLE sessions ADD COLUMN extraction_pending INTEGER NOT NULL DEFAULT 0');
  } catch {
    // Column already exists
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      description TEXT NOT NULL,
      participants TEXT NOT NULL DEFAULT '[]',
      location_id TEXT,
      timestamp_round INTEGER NOT NULL,
      caused_by TEXT NOT NULL DEFAULT '[]',
      causes TEXT NOT NULL DEFAULT '[]',
      significance TEXT NOT NULL DEFAULT 'MEDIUM',
      embedding_id TEXT,
      trace_id TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS relationships (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      object_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      intensity REAL NOT NULL DEFAULT 0,
      description TEXT NOT NULL DEFAULT '',
      evolution TEXT NOT NULL DEFAULT '[]',
      metrics TEXT,
      trace_id TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS current_states (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE,
      location_value TEXT,
      location_confidence REAL NOT NULL DEFAULT 0,
      location_source TEXT NOT NULL DEFAULT 'INFERRED',
      location_updated_round INTEGER NOT NULL DEFAULT 0,
      characters_present TEXT NOT NULL DEFAULT '[]',
      inventory TEXT NOT NULL DEFAULT '[]',
      pending_questions TEXT NOT NULL DEFAULT '[]',
      pending_promises TEXT NOT NULL DEFAULT '[]',
      active_quests TEXT NOT NULL DEFAULT '[]',
      unresolved_hooks TEXT NOT NULL DEFAULT '[]',
      last_updated_round INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS canon_entries (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      tier TEXT NOT NULL DEFAULT 'CORE',
      category TEXT NOT NULL,
      statement TEXT NOT NULL,
      keywords TEXT NOT NULL DEFAULT '[]',
      implicit_triggers TEXT NOT NULL DEFAULT '[]',
      embedding_id TEXT,
      created_by TEXT NOT NULL DEFAULT 'USER',
      is_locked INTEGER NOT NULL DEFAULT 1,
      conflict_policy TEXT NOT NULL DEFAULT 'BLOCK',
      archived_at INTEGER,
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS summaries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      level INTEGER NOT NULL,
      content TEXT NOT NULL,
      source_from_round INTEGER NOT NULL,
      source_to_round INTEGER NOT NULL,
      parent_ids TEXT NOT NULL DEFAULT '[]',
      embedding_id TEXT,
      token_count INTEGER NOT NULL DEFAULT 0,
      importance_score REAL NOT NULL DEFAULT 0.5,
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS continuity_snapshots (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      source_round INTEGER NOT NULL,
      scene TEXT NOT NULL,
      plot TEXT NOT NULL,
      unresolved TEXT NOT NULL,
      relationships TEXT NOT NULL,
      characters TEXT NOT NULL,
      protagonist TEXT NOT NULL,
      timeline TEXT NOT NULL,
      world TEXT NOT NULL,
      interaction_contract TEXT NOT NULL,
      continuity_constraints TEXT NOT NULL,
      compact_text TEXT NOT NULL,
      medium_text TEXT NOT NULL,
      full_text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS model_handoffs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      from_model TEXT,
      to_model TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      created_round INTEGER NOT NULL,
      boost_turns_total INTEGER NOT NULL,
      boost_turns_remaining INTEGER NOT NULL,
      full_turns INTEGER NOT NULL,
      medium_turns INTEGER NOT NULL,
      handoff_text TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Create indexes
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_entities_session ON entities(session_id)',
    'CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name)',
    'CREATE INDEX IF NOT EXISTS idx_facts_session ON facts(session_id)',
    'CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject_id)',
    'CREATE INDEX IF NOT EXISTS idx_facts_predicate ON facts(predicate)',
    'CREATE INDEX IF NOT EXISTS idx_facts_valid_to ON facts(valid_to)',
    'CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id)',
    'CREATE INDEX IF NOT EXISTS idx_relationships_session ON relationships(session_id)',
    'CREATE INDEX IF NOT EXISTS idx_canon_tier ON canon_entries(tier)',
    'CREATE INDEX IF NOT EXISTS idx_summaries_session ON summaries(session_id)',
    'CREATE INDEX IF NOT EXISTS idx_summaries_level ON summaries(level)',
    'CREATE INDEX IF NOT EXISTS idx_continuity_snapshots_session ON continuity_snapshots(session_id, updated_at)',
    'CREATE INDEX IF NOT EXISTS idx_model_handoffs_session ON model_handoffs(session_id, active)',
  ];
  for (const idx of indexes) {
    db.run(idx);
  }

  // V4.1: fact_keywords index table for keyword-based retrieval
  db.run(`
    CREATE TABLE IF NOT EXISTS fact_keywords (
      fact_id TEXT NOT NULL,
      keyword TEXT NOT NULL,
      PRIMARY KEY (fact_id, keyword),
      FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_fact_keywords_kw ON fact_keywords(keyword)');
  db.run('CREATE INDEX IF NOT EXISTS idx_fact_keywords_fact ON fact_keywords(fact_id)');

  // V4.2: event_keywords index table for keyword-based event retrieval
  db.run(`
    CREATE TABLE IF NOT EXISTS event_keywords (
      event_id TEXT NOT NULL,
      keyword TEXT NOT NULL,
      PRIMARY KEY (event_id, keyword),
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_event_keywords_kw ON event_keywords(keyword)');
  db.run('CREATE INDEX IF NOT EXISTS idx_event_keywords_evt ON event_keywords(event_id)');
}

export function getDatabase(): SqlJsDatabase {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}

export async function persist(): Promise<void> {
  if (!db || !dbPath || inMemoryOnly) return;
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    dbPath = null;
    inMemoryOnly = false;
  }
}

// Helper: convert exec result to array of row objects
export function execQuery(sql: string, params?: any[]): any[] {
  if (!db) throw new Error('Database not initialized');
  const results = db.exec(sql, params);
  if (!results.length) return [];
  const [{ columns, values }] = results;
  return values.map((row: any[]) => {
    const obj: any = {};
    columns.forEach((col: string, i: number) => { obj[col] = row[i]; });
    return obj;
  });
}

// Helper: run and persist
export async function runAndPersist(sql: string, params?: any[]): Promise<void> {
  if (!db) throw new Error('Database not initialized');
  db.run(sql, params);
  await persist();
}
