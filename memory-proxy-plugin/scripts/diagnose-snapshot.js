// Diagnose what the continuity snapshot actually contains for this session.
// Usage: node scripts/diagnose-snapshot.js "<plugins/memory-proxy dir>"
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

async function main() {
  const pluginDir = process.argv[2] || '.';
  const dbPath = path.join(pluginDir, 'data', 'memory.db');
  if (!fs.existsSync(dbPath)) { console.error('no db at', dbPath); process.exit(1); }
  const SQL = await initSqlJs();
  const buf = fs.readFileSync(dbPath);
  const db = new SQL.Database(buf);

  const q = (sql, params = []) => {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  };
  const count = (table) => q(`SELECT COUNT(*) c FROM ${table}`)[0]?.c ?? 0;

  // Find the Seraphina session
  const sessions = q(`SELECT id, round, last_message_count, last_chat_model, active_handoff_id, substr(id,1,1) hint FROM sessions`);
  console.log('=== sessions ===');
  for (const s of sessions) console.log(s);
  const sid = sessions[0]?.id;
  if (!sid) { console.log('no session'); return; }

  console.log('\n=== per-table counts for this session ===');
  for (const t of ['facts','events','relationships','canon_entries','current_states','summaries','continuity_snapshots','model_handoffs']) {
    try { console.log(`${t}: ${q(`SELECT COUNT(*) c FROM ${t} WHERE session_id = ?`, [sid])[0]?.c ?? 0}`); }
    catch(e){ console.log(`${t}: (err ${e.message})`); }
  }

  console.log('\n=== latest continuity snapshot text ===');
  const snap = q(`SELECT id, source_round, length(full_text) full_len, length(medium_text) med_len, length(compact_text) cmp_len, full_text, medium_text, compact_text FROM continuity_snapshots WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1`, [sid])[0];
  if (snap) {
    console.log(`id=${snap.id} round=${snap.source_round} full_len=${snap.full_len} med_len=${snap.med_len} cmp_len=${snap.cmp_len}`);
    console.log('--- FULL TEXT ---');
    console.log(snap.full_text);
  } else console.log('no snapshot');

  console.log('\n=== latest events (10) ===');
  for (const r of q(`SELECT timestamp_round, substr(description,1,120) d FROM events WHERE session_id = ? ORDER BY timestamp_round DESC LIMIT 10`, [sid])) console.log(`r${r.timestamp_round}: ${r.d}`);

  console.log('\n=== relationships (10) ===');
  for (const r of q(`SELECT subject_id, object_id, relation_type, intensity, substr(description,1,100) d FROM relationships WHERE session_id = ? ORDER BY updated_at DESC LIMIT 10`, [sid])) console.log(`${r.subject_id} ${r.relation_type} ${r.object_id} (${r.intensity}): ${r.d}`);

  console.log('\n=== current_state ===');
  const cs = q(`SELECT * FROM current_states WHERE session_id = ?`, [sid])[0];
  if (cs) console.log(cs); else console.log('none');

  console.log('\n=== canon (10) ===');
  for (const r of q(`SELECT substr(statement,1,120) s FROM canon_entries WHERE (session_id = ? OR session_id IS NULL) AND archived_at IS NULL LIMIT 10`, [sid])) console.log(r.s);

  console.log('\n=== handoffs ===');
  for (const r of q(`SELECT from_model, to_model, boost_turns_remaining, active, created_at FROM model_handoffs WHERE session_id = ? ORDER BY created_at DESC`, [sid])) console.log(r);

  db.close();
}
main().catch(e => { console.error(e); process.exit(1); });
