import { DatabaseSync } from 'node:sqlite';

const home = process.env.AGENTMESH_HOME || 'D:\\工作\\.agentmesh';
const db = new DatabaseSync(home + '\\mesh.db');

console.log('--- recent approvals ---');
for (const r of db.prepare('SELECT id, task_id, title, status, auto, option_id, created_at, resolved_at FROM approvals ORDER BY created_at DESC LIMIT 8').all()) {
  console.log(JSON.stringify(r));
}

const taskId = process.argv[2];
if (taskId) {
  console.log(`\n--- events of ${taskId} ---`);
  const rows = db.prepare('SELECT seq, type, text, data FROM events WHERE task_id = ? ORDER BY seq').all(taskId);
  for (const r of rows) {
    console.log(String(r.seq).padStart(4), String(r.type).padEnd(20), '|', String(r.text || '').slice(0, 80));
  }
  console.log(`\n(${rows.length} events)`);
}

db.close();
