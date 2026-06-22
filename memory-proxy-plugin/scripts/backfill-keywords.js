#!/usr/bin/env node
/**
 * Backfill script: index all existing facts into fact_keywords table.
 * Run after upgrading to V4.1 (which created the fact_keywords table).
 *
 * Usage:
 *   node scripts/backfill-keywords.js "<path-to-plugin-dir>"
 *
 * Example:
 *   node scripts/backfill-keywords.js "f:/SillyTavern/SillyTavern Launcher GUI/data/sillytavern/1.18.0/plugins/memory-proxy"
 */

const path = require('path');
const pluginDir = process.argv[2];

if (!pluginDir) {
  console.error('Usage: node scripts/backfill-keywords.js "<path-to-plugin-dir>"');
  process.exit(1);
}

async function main() {
  const { initDatabase, execQuery, runAndPersist } = require(path.join(pluginDir, 'node_modules', 'memory-proxy', 'storage', 'db.ts'));
  const dbPath = path.join(pluginDir, 'data', 'memory.db');

  console.log(`Opening database: ${dbPath}`);
  await initDatabase(dbPath);

  // Count existing facts
  const facts = execQuery(
    "SELECT id, statement FROM facts WHERE valid_to IS NULL AND tombstone_deleted = 0"
  );
  console.log(`Found ${facts.length} active facts to index`);

  // Require the tokenizer (same module used by pipeline)
  const { indexFactKeywords } = require(path.join(pluginDir, 'node_modules', 'memory-proxy', 'storage', 'fact-keyword-indexer.ts'));

  let indexed = 0;
  let skipped = 0;

  for (const fact of facts) {
    // Skip facts that already have keyword entries
    const existing = execQuery(
      'SELECT COUNT(*) as c FROM fact_keywords WHERE fact_id = ?',
      [fact.id]
    );
    if (existing[0].c > 0) {
      skipped++;
      continue;
    }

    try {
      indexFactKeywords(fact.id, fact.statement);
      indexed++;
      if (indexed % 50 === 0) {
        console.log(`  ${indexed}/${facts.length} facts indexed...`);
      }
    } catch (err) {
      console.error(`  Error indexing fact ${fact.id}: ${err.message}`);
    }
  }

  console.log(`\nDone: ${indexed} facts indexed, ${skipped} already indexed, ${facts.length} total`);
}

main().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
