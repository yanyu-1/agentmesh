/**
 * Task / event / approval store, backed by Node's built-in SQLite
 * (`node:sqlite`, Node >= 22.5). No native modules, no install step.
 *
 * Design notes:
 *   - Tasks are written BEFORE dispatch (design principle 1: the session is not
 *     tied to the connection), so a crashed client still has a record.
 *   - Events are append-only with a monotonic `seq`, so the Web console can
 *     reconnect and replay with `?after=<seq>`.
 *   - Approvals are first-class rows, not in-memory state (design principle 2).
 *
 * @module core/store
 */

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { meshHome, newId, nowIso } from '../protocol/util.js';
import { TaskState, isTerminal } from '../protocol/states.js';

/**
 * Is a process with this pid still running? Signal 0 performs the permission/existence
 * check without touching the process. Used only for crash recovery.
 * @param {number} pid
 * @returns {boolean}
 */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return /** @type {any} */ (err)?.code === 'EPERM';
  }
}

/**
 * @typedef {object} TaskRecord
 * @property {string} id
 * @property {string} nodeId
 * @property {string} prompt
 * @property {string} state
 * @property {string|null} sessionId
 * @property {string|null} contextId
 * @property {string|null} remoteTaskId
 * @property {string|null} result
 * @property {string|null} error
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string|null} endedAt
 * @property {number} eventCount
 */

export class Store {
  /** @type {DatabaseSync} */
  #db;
  /** @type {string} */
  #file;

  /** @param {string} [file] */
  constructor(file) {
    this.#file = file || join(meshHome(), 'mesh.db');
    this.#db = new DatabaseSync(this.#file);
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#migrate();
  }

  get file() {
    return this.#file;
  }

  /**
   * Release the SQLite handle.
   *
   * `DatabaseSync` keeps the database file open until it is closed or collected. On
   * Windows an open handle makes the containing directory impossible to delete, which is
   * how this was found: every web-console test passed and then failed in cleanup with
   * `EPERM: Permission denied` on its temp directory. It is also the reason a long-lived
   * `mesh serve` held `mesh.db` after shutdown.
   */
  close() {
    try {
      this.#db.close();
    } catch {
      /* already closed */
    }
  }

  #migrate() {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id             TEXT PRIMARY KEY,
        node_id        TEXT NOT NULL,
        prompt         TEXT NOT NULL,
        state          TEXT NOT NULL,
        session_id     TEXT,
        context_id     TEXT,
        remote_task_id TEXT,
        result         TEXT,
        error          TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        ended_at       TEXT,
        event_count    INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_node ON tasks(node_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state, created_at DESC);

      CREATE TABLE IF NOT EXISTS events (
        seq      INTEGER PRIMARY KEY AUTOINCREMENT,
        ts       TEXT NOT NULL,
        task_id  TEXT,
        node_id  TEXT NOT NULL,
        type     TEXT NOT NULL,
        text     TEXT,
        data     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, seq);
      CREATE INDEX IF NOT EXISTS idx_events_node ON events(node_id, seq DESC);

      CREATE TABLE IF NOT EXISTS approvals (
        id           TEXT PRIMARY KEY,
        request_id   TEXT,
        task_id      TEXT,
        node_id      TEXT NOT NULL,
        title        TEXT,
        tool_call_id TEXT,
        options      TEXT,
        status       TEXT NOT NULL,
        option_id    TEXT,
        auto         INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL,
        resolved_at  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at DESC);
    `);

    // Crash recovery. A task only makes progress while the process that dispatched
    // it is alive: if that process is killed while an agent is blocked on an
    // approval, the row would sit in `working` forever and the dashboard would lie.
    // Adding the column in a second step keeps existing databases usable.
    const columns = this.#db.prepare('PRAGMA table_info(tasks)').all().map((c) => String(c.name));
    if (!columns.includes('owner_pid')) this.#db.exec('ALTER TABLE tasks ADD COLUMN owner_pid INTEGER');
  }

  /**
   * Mark tasks left behind by dead control-plane processes as `interrupted`.
   *
   * A task whose owning pid no longer exists cannot be advanced by anyone, so it is
   * reconciled to a terminal state instead of being reported as still running.
   *
   * @returns {number} how many tasks were reconciled
   */
  reconcileOrphans() {
    const rows = this.#db.prepare("SELECT id, owner_pid FROM tasks WHERE state NOT IN ('completed','failed','canceled','rejected')").all();
    let fixed = 0;
    for (const row of rows) {
      const pid = Number(row.owner_pid);
      // No recorded pid (rows from before this migration) or a live pid: leave alone.
      if (!pid || pid === process.pid || isAlive(pid)) continue;
      this.updateTask(String(row.id), {
        state: TaskState.FAILED,
        error: `interrupted: the control-plane process that owned this task (pid ${pid}) is gone`,
      });
      fixed += 1;
    }
    return fixed;
  }

  /**
   * Create a task before it is dispatched.
   * @param {{nodeId:string, prompt:string, sessionId?:string|null, contextId?:string|null}} input
   * @returns {TaskRecord}
   */
  createTask({ nodeId, prompt, sessionId = null, contextId = null }) {
    const id = newId('task');
    const now = nowIso();
    this.#db
      .prepare(
        `INSERT INTO tasks (id, node_id, prompt, state, session_id, context_id, created_at, updated_at, owner_pid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, nodeId, prompt, TaskState.QUEUED, sessionId, contextId, now, now, process.pid);
    return this.getTask(id);
  }

  /**
   * @param {string} id
   * @returns {TaskRecord}
   */
  getTask(id) {
    const row = this.#db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!row) throw new Error(`unknown task ${id}`);
    return rowToTask(row);
  }

  /**
   * @param {string} id
   * @returns {TaskRecord|null}
   */
  findTask(id) {
    const row = this.#db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    return row ? rowToTask(row) : null;
  }

  /**
   * Update a task's mutable fields.
   * @param {string} id
   * @param {{state?:string, sessionId?:string|null, contextId?:string|null, remoteTaskId?:string|null, result?:string|null, error?:string|null}} patch
   * @returns {TaskRecord}
   */
  updateTask(id, patch) {
    const current = this.getTask(id);
    const next = {
      state: patch.state ?? current.state,
      session_id: patch.sessionId !== undefined ? patch.sessionId : current.sessionId,
      context_id: patch.contextId !== undefined ? patch.contextId : current.contextId,
      remote_task_id: patch.remoteTaskId !== undefined ? patch.remoteTaskId : current.remoteTaskId,
      result: patch.result !== undefined ? patch.result : current.result,
      error: patch.error !== undefined ? patch.error : current.error,
      updated_at: nowIso(),
      ended_at: patch.state && isTerminal(patch.state) ? nowIso() : current.endedAt,
    };
    this.#db
      .prepare(
        `UPDATE tasks SET state = ?, session_id = ?, context_id = ?, remote_task_id = ?, result = ?, error = ?, updated_at = ?, ended_at = ?
         WHERE id = ?`,
      )
      .run(next.state, next.session_id, next.context_id, next.remote_task_id, next.result, next.error, next.updated_at, next.ended_at, id);
    return this.getTask(id);
  }

  /**
   * @param {{nodeId?:string, state?:string, limit?:number, activeOnly?:boolean}} [opts]
   * @returns {TaskRecord[]}
   */
  listTasks(opts = {}) {
    const { nodeId, state, limit = 50, activeOnly = false } = opts;
    const where = [];
    const params = [];
    if (nodeId) {
      where.push('node_id = ?');
      params.push(nodeId);
    }
    if (state) {
      where.push('state = ?');
      params.push(state);
    }
    if (activeOnly) {
      where.push("state NOT IN ('completed','failed','canceled','rejected')");
    }
    const sql = `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);
    return this.#db.prepare(sql).all(...params).map(rowToTask);
  }

  /**
   * Reconstruct the prior turns of one conversation, oldest first.
   *
   * A2A groups a conversation by `contextId`, but whether the agent actually *sees*
   * the earlier turns depends on the peer keeping server-side context. Real peers
   * exist that accept and echo a `contextId` while building each prompt from the
   * latest message alone — the exchange then looks like a conversation without being
   * one. This lets the client carry the history itself when asked to.
   *
   * @param {{nodeId:string, contextId:string, excludeTaskId?:string|null, limit?:number}} opts
   * @returns {{role:'user'|'assistant', text:string}[]}
   */
  historyForContext({ nodeId, contextId, excludeTaskId = null, limit = 40 }) {
    if (!nodeId || !contextId) return [];
    const rows = this.#db
      .prepare('SELECT * FROM tasks WHERE node_id = ? AND context_id = ? ORDER BY created_at ASC LIMIT ?')
      .all(nodeId, contextId, limit)
      .map(rowToTask);
    /** @type {{role:'user'|'assistant', text:string}[]} */
    const turns = [];
    for (const t of rows) {
      if (excludeTaskId && t.id === excludeTaskId) continue;
      if (t.prompt) turns.push({ role: 'user', text: String(t.prompt) });
      // Only a settled task has an answer worth replaying; an empty or failed one would
      // just inject noise into the peer's prompt.
      if (t.result && String(t.result).trim()) turns.push({ role: 'assistant', text: String(t.result) });
    }
    return turns;
  }

  /**
   * The most recent settled **turns from other nodes**, newest first in the database and
   * returned oldest first.
   *
   * Sessions in this program are per node: a node only ever receives its own conversation, so
   * two agents collaborating on one job cannot see what the other was asked or answered. That
   * isolation is the right default — nothing should leak between agents by accident — so the
   * opposite is available only when asked for, and this is the query behind it.
   *
   * Only turns with a non-empty result qualify: an unanswered or failed task would add a
   * question to the peer's prompt that nothing answered, which reads as a task it failed to do.
   *
   * @param {{excludeNodeId?:string|null, limit?:number}} [opts]
   * @returns {{nodeId:string, prompt:string, result:string, at:string}[]} oldest first
   */
  recentTurns(opts = {}) {
    const limit = Math.max(1, Number(opts.limit) || 6);
    const rows = this.#db
      .prepare(
        `SELECT node_id, prompt, result, created_at FROM tasks
         WHERE node_id IS NOT ? AND result IS NOT NULL AND TRIM(result) != ''
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(opts.excludeNodeId ?? null, limit);
    return rows
      .map((r) => ({
        nodeId: String(r.node_id ?? ''),
        prompt: String(r.prompt ?? ''),
        result: String(r.result ?? ''),
        at: String(r.created_at ?? ''),
      }))
      .reverse();
  }

  /**
   * Append an event and bump the task's counter.
   * @param {import('../protocol/events.js').MeshEvent} ev
   * @returns {number} the assigned seq
   */
  appendEvent(ev) {
    const info = this.#db
      .prepare('INSERT INTO events (ts, task_id, node_id, type, text, data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ev.ts || nowIso(), ev.taskId ?? null, ev.nodeId, ev.type, ev.text ?? '', ev.data === undefined ? null : JSON.stringify(ev.data));
    if (ev.taskId) {
      this.#db.prepare('UPDATE tasks SET event_count = event_count + 1 WHERE id = ?').run(ev.taskId);
    }
    return Number(info.lastInsertRowid);
  }

  /**
   * Events for one task, strictly AFTER `after` (exclusive: a client that already
   * saw seq N must not receive N again).
   *
   * Accepts either `{after, limit}` or a bare number for `after`; passing a number to
   * an options-object API used to silently mean "after 0" and return everything.
   *
   * @param {string} taskId
   * @param {{after?:number, limit?:number}|number} [opts]
   */
  eventsForTask(taskId, opts = {}) {
    const { after = 0, limit = 1000 } = typeof opts === 'number' ? { after: opts } : opts;
    return this.#db
      .prepare('SELECT * FROM events WHERE task_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
      .all(taskId, after, limit)
      .map(rowToEvent);
  }

  /**
   * Tail the whole event log (used by the Web console for live streaming and replay).
   * Strictly after `after`; accepts a bare number as shorthand for `{after}`.
   * @param {{after?:number, limit?:number}|number} [opts]
   */
  eventsSince(opts = {}) {
    const { after = 0, limit = 500 } = typeof opts === 'number' ? { after: opts } : opts;
    return this.#db
      .prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?')
      .all(after, limit)
      .map(rowToEvent);
  }

  /** @returns {number} */
  lastSeq() {
    const row = this.#db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM events').get();
    return Number(row?.s ?? 0);
  }

  /**
   * @param {string} nodeId
   * @returns {{sessionId:string|null, contextId:string|null, taskId:string, at:string}|null}
   */
  lastSession(nodeId) {
    const row = this.#db
      .prepare(
        `SELECT id, session_id, context_id, created_at FROM tasks
         WHERE node_id = ? AND (session_id IS NOT NULL OR context_id IS NOT NULL)
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(nodeId);
    if (!row) return null;
    return { sessionId: row.session_id ?? null, contextId: row.context_id ?? null, taskId: row.id, at: row.created_at };
  }

  /**
   * @param {object} input
   * @param {string} input.nodeId
   * @param {string|null} [input.taskId]
   * @param {any} [input.requestId]
   * @param {string} [input.title]
   * @param {string|null} [input.toolCallId]
   * @param {any[]} [input.options]
   * @param {boolean} [input.auto]
   * @param {string} [input.id]
   * @returns {any}
   */
  createApproval({ nodeId, taskId = null, requestId = null, title = '', toolCallId = null, options = [], auto = false, id }) {
    const approvalId = id || newId('appr');
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO approvals (id, request_id, task_id, node_id, title, tool_call_id, options, status, auto, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(approvalId, requestId === null ? null : String(requestId), taskId, nodeId, title, toolCallId, JSON.stringify(options), auto ? 1 : 0, nowIso());
    return this.getApproval(approvalId);
  }

  /**
   * @param {string} id
   */
  getApproval(id) {
    const row = this.#db.prepare('SELECT * FROM approvals WHERE id = ?').get(id);
    if (!row) throw new Error(`unknown approval ${id}`);
    return rowToApproval(row);
  }

  /**
   * @param {string} id
   * @param {{status:string, optionId?:string|null}} patch
   */
  resolveApproval(id, { status, optionId = null }) {
    this.#db.prepare('UPDATE approvals SET status = ?, option_id = ?, resolved_at = ? WHERE id = ?').run(status, optionId, nowIso(), id);
    return this.getApproval(id);
  }

  /**
   * List approvals.
   *
   * `status` defaults to `null` = **no filter**. Defaulting to `'pending'` was a trap:
   * `listApprovals({})` and `--all`/`?status=all` (which passed `undefined`) both
   * silently returned pending-only, so an approved row looked like it was never
   * recorded. Callers that want pending must say so.
   *
   * @param {{status?:string|null, limit?:number}} [opts]
   */
  listApprovals({ status = null, limit = 100 } = {}) {
    const rows = status
      ? this.#db.prepare('SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit)
      : this.#db.prepare('SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?').all(limit);
    return rows.map(rowToApproval);
  }

  /** Aggregate counters for the Web dashboard / `mesh status`. */
  stats() {
    const tasks = this.#db.prepare('SELECT state, COUNT(*) AS n FROM tasks GROUP BY state').all();
    const byState = {};
    for (const r of tasks) byState[String(r.state)] = Number(r.n);
    const total = Object.values(byState).reduce((a, b) => a + b, 0);
    const pendingApprovals = Number(this.#db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'").get()?.n ?? 0);
    return { totalTasks: total, byState, pendingApprovals, lastSeq: this.lastSeq() };
  }

  close() {
    try {
      this.#db.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {any} row
 * @returns {TaskRecord}
 */
function rowToTask(row) {
  return {
    id: String(row.id),
    nodeId: String(row.node_id),
    prompt: String(row.prompt ?? ''),
    state: String(row.state),
    sessionId: row.session_id == null ? null : String(row.session_id),
    contextId: row.context_id == null ? null : String(row.context_id),
    remoteTaskId: row.remote_task_id == null ? null : String(row.remote_task_id),
    result: row.result == null ? null : String(row.result),
    error: row.error == null ? null : String(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    endedAt: row.ended_at == null ? null : String(row.ended_at),
    eventCount: Number(row.event_count ?? 0),
  };
}

/**
 * @param {any} row
 */
function rowToEvent(row) {
  /** @type {any} */
  let data = null;
  if (row.data != null) {
    try {
      data = JSON.parse(String(row.data));
    } catch {
      data = { _raw: String(row.data) };
    }
  }
  return {
    seq: Number(row.seq),
    ts: String(row.ts),
    taskId: row.task_id == null ? null : String(row.task_id),
    nodeId: String(row.node_id),
    type: String(row.type),
    text: row.text == null ? '' : String(row.text),
    data,
  };
}

/**
 * @param {any} row
 */
function rowToApproval(row) {
  /** @type {any[]} */
  let options = [];
  try {
    options = JSON.parse(String(row.options ?? '[]'));
  } catch {
    options = [];
  }
  return {
    id: String(row.id),
    requestId: row.request_id == null ? null : String(row.request_id),
    taskId: row.task_id == null ? null : String(row.task_id),
    nodeId: String(row.node_id),
    title: String(row.title ?? ''),
    toolCallId: row.tool_call_id == null ? null : String(row.tool_call_id),
    options,
    status: String(row.status),
    optionId: row.option_id == null ? null : String(row.option_id),
    auto: Number(row.auto ?? 0) === 1,
    createdAt: String(row.created_at),
    resolvedAt: row.resolved_at == null ? null : String(row.resolved_at),
  };
}
