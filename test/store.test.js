// Store tests: task lifecycle, event ordering, and crash recovery.
//
// Run: node test/store.test.js

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HOMES = [];
function freshHome() {
  const dir = mkdtempSync(join(tmpdir(), 'agentmesh-store-'));
  HOMES.push(dir);
  process.env.AGENTMESH_HOME = dir;
  return dir;
}

const { Store } = await import('../src/core/store.js');
const { TaskState } = await import('../src/protocol/states.js');
const { EventType, makeEvent } = await import('../src/protocol/events.js');

/**
 * Rewrite a task's owning pid through a second connection, the way a different
 * process would see it. Using a separate handle also proves the migration added
 * the column for real.
 * @param {string} taskId
 * @param {number} pid
 */
function forceOwnerPid(taskId, pid) {
  const db = new DatabaseSync(join(/** @type {string} */ (process.env.AGENTMESH_HOME), 'mesh.db'));
  db.prepare('UPDATE tasks SET owner_pid = ? WHERE id = ?').run(pid, taskId);
  db.close();
}

after(() => {
  for (const d of HOMES) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

test('a task is persisted before dispatch and moves through states', () => {
  freshHome();
  const store = new Store();
  const task = store.createTask({ nodeId: 'n1', prompt: 'do a thing' });
  assert.equal(task.state, TaskState.QUEUED, 'a task must exist before anything is dispatched');
  assert.ok(task.id.startsWith('task_'));

  store.updateTask(task.id, { state: TaskState.SUBMITTED });
  assert.equal(store.getTask(task.id).state, TaskState.SUBMITTED);

  const done = store.updateTask(task.id, { state: TaskState.COMPLETED, result: 'the answer', sessionId: 'sess-1' });
  assert.equal(done.state, TaskState.COMPLETED);
  assert.equal(done.result, 'the answer');
  assert.ok(done.endedAt, 'a terminal state must stamp endedAt');
  store.close();
});

test('events get a monotonic seq so the console can replay from ?after=', () => {
  freshHome();
  const store = new Store();
  const task = store.createTask({ nodeId: 'n1', prompt: 'p' });
  const a = store.appendEvent(makeEvent({ nodeId: 'n1', taskId: task.id, type: EventType.TASK_STATE, text: 'submitted' }));
  const b = store.appendEvent(makeEvent({ nodeId: 'n1', taskId: task.id, type: EventType.CHUNK, text: 'hi' }));
  const c = store.appendEvent(makeEvent({ nodeId: 'n1', taskId: task.id, type: EventType.DONE, text: 'completed' }));
  assert.ok(a < b && b < c, 'seq must increase');
  assert.equal(store.lastSeq(), c);

  const replay = store.eventsSince({ after: a });
  assert.deepEqual(replay.map((e) => e.text), ['hi', 'completed'], 'replay must exclude what the client already saw');
  // The bare-number shorthand must agree, otherwise a plausible call silently
  // returns the whole log instead of the tail.
  assert.deepEqual(store.eventsSince(a).map((e) => e.text), ['hi', 'completed']);
  assert.deepEqual(store.eventsForTask(task.id, { after: b }).map((e) => e.text), ['completed']);
  assert.equal(store.eventsForTask(task.id).length, 3);
  assert.equal(store.getTask(task.id).eventCount, 3);
  store.close();
});

test('lastSession finds the newest session/context for --continue', () => {
  freshHome();
  const store = new Store();
  const t1 = store.createTask({ nodeId: 'n1', prompt: 'first' });
  store.updateTask(t1.id, { state: TaskState.COMPLETED, sessionId: 'sess-a' });
  const t2 = store.createTask({ nodeId: 'n1', prompt: 'second' });
  store.updateTask(t2.id, { state: TaskState.COMPLETED, sessionId: 'sess-b' });

  const last = store.lastSession('n1');
  assert.equal(last.sessionId, 'sess-b', 'must pick the most recent, not the first');
  assert.equal(store.lastSession('n-nope'), null);
  store.close();
});

test('a malformed event payload never breaks the store', () => {
  freshHome();
  const store = new Store();
  const task = store.createTask({ nodeId: 'n1', prompt: 'p' });
  // Circumflex data is the norm (a tool result can contain anything); serializing it
  // must not throw and must not lose the row.
  const ev = makeEvent({ nodeId: 'n1', taskId: task.id, type: EventType.TOOL_UPDATE, text: 'ok', data: { nested: { deep: [1, 2, { x: '值' }] } } });
  const seq = store.appendEvent(ev);
  const back = store.eventsForTask(task.id)[0];
  assert.equal(back.seq, seq);
  assert.equal(back.data.nested.deep[2].x, '值');
  store.close();
});

test('tasks abandoned by a dead process are reconciled, live ones are left alone', () => {
  freshHome();
  const store = new Store();
  const mine = store.createTask({ nodeId: 'n1', prompt: 'still running here' });
  store.updateTask(mine.id, { state: TaskState.WORKING });

  // Simulate a task whose owner is gone. pid 0 is never a real process id.
  const orphan = store.createTask({ nodeId: 'n1', prompt: 'owner crashed' });
  store.updateTask(orphan.id, { state: TaskState.WORKING });
  forceOwnerPid(orphan.id, 999_999_999);

  const fixed = store.reconcileOrphans();
  assert.equal(fixed, 1, 'exactly the orphaned task must be reconciled');

  const after = store.getTask(orphan.id);
  assert.equal(after.state, TaskState.FAILED);
  assert.match(after.error, /interrupted/);
  assert.match(after.error, /999999999/);

  assert.equal(store.getTask(mine.id).state, TaskState.WORKING, 'a task owned by this live process must be untouched');

  // Idempotent: nothing left to fix.
  assert.equal(store.reconcileOrphans(), 0);
  store.close();
});

test('terminal tasks are never reconciled even with a dead owner', () => {
  freshHome();
  const store = new Store();
  const t = store.createTask({ nodeId: 'n1', prompt: 'finished long ago' });
  store.updateTask(t.id, { state: TaskState.COMPLETED, result: 'ok' });
  forceOwnerPid(t.id, 999_999_999);
  assert.equal(store.reconcileOrphans(), 0);
  assert.equal(store.getTask(t.id).state, TaskState.COMPLETED);
  store.close();
});

test('an existing database from before the owner_pid column still opens', () => {
  // Migration path: create a tasks table without owner_pid, then let Store open it.
  const home = freshHome();
  const file = join(home, 'mesh.db');
  const legacy = new DatabaseSync(file);
  legacy.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, node_id TEXT NOT NULL, prompt TEXT NOT NULL, state TEXT NOT NULL,
    session_id TEXT, context_id TEXT, remote_task_id TEXT, result TEXT, error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT,
    event_count INTEGER NOT NULL DEFAULT 0)`);
  legacy.prepare('INSERT INTO tasks (id, node_id, prompt, state, created_at, updated_at) VALUES (?,?,?,?,?,?)').run('task_legacy', 'n1', 'old row', 'completed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  legacy.close();

  const store = new Store();
  assert.equal(store.getTask('task_legacy').prompt, 'old row', 'pre-existing rows must survive the migration');
  // Pre-migration rows have no owner pid, so reconciliation must leave them alone
  // rather than guessing that they are dead.
  assert.equal(store.reconcileOrphans(), 0);
  store.close();
});

test('stats counts every state and the total', () => {
  freshHome();
  const store = new Store();
  const a = store.createTask({ nodeId: 'n1', prompt: 'a' });
  store.updateTask(a.id, { state: TaskState.COMPLETED });
  const b = store.createTask({ nodeId: 'n1', prompt: 'b' });
  store.updateTask(b.id, { state: TaskState.FAILED, error: 'nope' });
  const c = store.createTask({ nodeId: 'n1', prompt: 'c' });
  store.updateTask(c.id, { state: TaskState.WORKING });

  const stats = store.stats();
  assert.equal(stats.byState.completed, 1);
  assert.equal(stats.byState.failed, 1);
  assert.equal(stats.byState.working, 1);
  assert.equal(stats.totalTasks, 3);
  store.close();
});

test('historyForContext rebuilds a conversation oldest-first and skips empty answers', () => {
  freshHome();
  const store = new Store();

  // Two settled turns in one context, one turn in another, one in-flight turn.
  const t1 = store.createTask({ nodeId: 'n1', prompt: 'Q1', contextId: 'ctx-a' });
  store.updateTask(t1.id, { state: TaskState.COMPLETED, result: 'A1' });
  const t2 = store.createTask({ nodeId: 'n1', prompt: 'Q2', contextId: 'ctx-a' });
  store.updateTask(t2.id, { state: TaskState.COMPLETED, result: 'A2' });
  const other = store.createTask({ nodeId: 'n1', prompt: 'OTHER', contextId: 'ctx-b' });
  store.updateTask(other.id, { state: TaskState.COMPLETED, result: 'OTHER-A' });
  const pending = store.createTask({ nodeId: 'n1', prompt: 'Q3', contextId: 'ctx-a' });
  store.updateTask(pending.id, { state: TaskState.WORKING });
  const otherNode = store.createTask({ nodeId: 'n2', prompt: 'N2Q', contextId: 'ctx-a' });
  store.updateTask(otherNode.id, { state: TaskState.COMPLETED, result: 'N2A' });

  const turns = store.historyForContext({ nodeId: 'n1', contextId: 'ctx-a' });
  assert.deepEqual(turns, [
    { role: 'user', text: 'Q1' },
    { role: 'assistant', text: 'A1' },
    { role: 'user', text: 'Q2' },
    { role: 'assistant', text: 'A2' },
    // `pending` (Q3) contributes its user turn but has no answer yet to replay.
    { role: 'user', text: 'Q3' },
  ]);

  // Another context, and another node's tasks in the SAME context, must not bleed in.
  assert.equal(store.historyForContext({ nodeId: 'n1', contextId: 'ctx-b' }).length, 2);
  assert.ok(!turns.some((t) => t.text === 'N2Q'), 'a different node must not contribute');

  // Excluding the current task keeps it out of its own history.
  const withoutPending = store.historyForContext({ nodeId: 'n1', contextId: 'ctx-a', excludeTaskId: pending.id });
  assert.ok(!withoutPending.some((t) => t.text === 'Q3'));

  // An unknown context is empty, not an error.
  assert.deepEqual(store.historyForContext({ nodeId: 'n1', contextId: 'nope' }), []);
  assert.deepEqual(store.historyForContext({ nodeId: 'n1', contextId: '' }), []);
  store.close();
});
