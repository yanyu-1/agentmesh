// Regression test for the approval-persistence bug the end-to-end run exposed:
// approvals used to live only in adapter memory, so `mesh approvals` and the Web
// console saw an empty list and the operator could never answer.
//
// Run: node test/approval.test.js

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOMES = [];
function freshHome() {
  const dir = mkdtempSync(join(tmpdir(), 'agentmesh-appr-'));
  HOMES.push(dir);
  process.env.AGENTMESH_HOME = dir;
  return dir;
}

const { Fleet } = await import('../src/core/fleet.js');
const { EventType, makeEvent } = await import('../src/protocol/events.js');
const { newId } = await import('../src/protocol/util.js');

after(() => {
  for (const d of HOMES) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/** A fleet with a fake ACP-ish adapter whose parked approvals we control. */
function makeFleet() {
  freshHome();
  const fleet = new Fleet();
  fleet.registry.add({ name: 'fake', kind: 'hermes', transport: 'acp', local: true, command: process.execPath });
  /** @type {Map<any, any>} */
  const parked = new Map();
  const adapter = {
    permissionPolicy: 'ask',
    listParked: () => [...parked.values()].map((p) => p.record),
    resolveApproval(requestId, optionId) {
      const entry = parked.get(requestId);
      if (!entry) return false;
      parked.delete(requestId);
      entry.resolved = optionId;
      fleet.emit(
        makeEvent({
          nodeId: 'fake',
          taskId: entry.record.taskId,
          type: EventType.APPROVAL_RESOLVED,
          text: optionId ? `approved (${optionId})` : 'denied',
          data: { ...entry.record, optionId },
        }),
      );
      return true;
    },
    seed(record) {
      parked.set(record.requestId, { record, resolved: undefined });
    },
  };
  fleet.adapters.set('fake', adapter);
  return { fleet, adapter };
}

test('an APPROVAL_REQUESTED event becomes a durable, queryable approval row', () => {
  const { fleet, adapter } = makeFleet();
  const task = fleet.store.createTask({ nodeId: 'fake', prompt: 'edit a file' });

  const record = {
    id: 'appr_test1',
    requestId: 42,
    nodeId: 'fake',
    taskId: task.id,
    sessionId: 'sess-1',
    title: 'Approve edit: probe.txt',
    toolCallId: 'tc-1',
    options: [
      { optionId: 'allow_once', name: 'Allow edit', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ],
    policy: 'ask',
    requestedAt: new Date().toISOString(),
  };
  adapter.seed(record);

  fleet.emit(makeEvent({ nodeId: 'fake', taskId: task.id, type: EventType.APPROVAL_REQUESTED, text: 'needs approval', data: record }));

  const pending = fleet.store.listApprovals({ status: 'pending' });
  assert.equal(pending.length, 1, 'the approval must be persisted, not just held in memory');
  assert.equal(pending[0].id, 'appr_test1');
  assert.equal(pending[0].title, 'Approve edit: probe.txt');
  assert.equal(pending[0].options.length, 2);
  assert.equal(pending[0].status, 'pending');

  // What `mesh approvals` / GET /api/approvals expose.
  const live = fleet.pendingApprovals();
  assert.equal(live.length, 1);
  assert.equal(live[0].id, 'appr_test1');

  fleet.store.close();
});

test('resolving an approval marks the row and emits APPROVAL_RESOLVED', () => {
  const { fleet, adapter } = makeFleet();
  const task = fleet.store.createTask({ nodeId: 'fake', prompt: 'edit a file' });
  const record = {
    id: 'appr_test2',
    requestId: 7,
    nodeId: 'fake',
    taskId: task.id,
    sessionId: 'sess-2',
    title: 'Approve edit: two.txt',
    toolCallId: 'tc-2',
    options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }],
    policy: 'ask',
    requestedAt: new Date().toISOString(),
  };
  adapter.seed(record);

  const seen = [];
  fleet.subscribe((ev) => seen.push(ev));
  fleet.emit(makeEvent({ nodeId: 'fake', taskId: task.id, type: EventType.APPROVAL_REQUESTED, text: 'needs approval', data: record }));

  const result = fleet.resolveApproval('appr_test2', 'allow_once');
  assert.equal(result.ok, true);
  assert.equal(adapter.listParked().length, 0, 'the parked request must be released');

  const row = fleet.store.getApproval('appr_test2');
  assert.equal(row.status, 'approved');
  assert.equal(row.optionId, 'allow_once');
  assert.ok(seen.some((e) => e.type === EventType.APPROVAL_RESOLVED && e.data.optionId === 'allow_once'));

  // `{}` must mean "no filter": otherwise `--all` / `?status=all` silently lie and
  // a resolved approval looks like it was never recorded.
  assert.equal(fleet.store.listApprovals({}).length, 1, 'listApprovals({}) must not hide resolved rows');
  assert.equal(fleet.store.listApprovals({ status: 'pending' }).length, 0);
  assert.equal(fleet.store.listApprovals({ status: 'approved' }).length, 1);

  fleet.store.close();
});

test('denying is recorded as denied, and unknown ids resolve to ok:false', () => {
  const { fleet, adapter } = makeFleet();
  const task = fleet.store.createTask({ nodeId: 'fake', prompt: 'x' });
  const record = { id: 'appr_test3', requestId: 9, nodeId: 'fake', taskId: task.id, sessionId: 's3', title: 'T', toolCallId: null, options: [], policy: 'ask', requestedAt: new Date().toISOString() };
  adapter.seed(record);
  fleet.emit(makeEvent({ nodeId: 'fake', taskId: task.id, type: EventType.APPROVAL_REQUESTED, text: '', data: record }));

  fleet.resolveApproval('appr_test3', null);
  assert.equal(fleet.store.getApproval('appr_test3').status, 'denied');

  const missing = fleet.resolveApproval('appr_nope', 'allow_once');
  assert.equal(missing.ok, false);
  assert.match(String(missing.reason), /no live connection/);

  fleet.store.close();
});

test('an auto-decided approval still leaves an audit row', () => {
  const { fleet } = makeFleet();
  const task = fleet.store.createTask({ nodeId: 'fake', prompt: 'x' });
  fleet.emit(
    makeEvent({
      nodeId: 'fake',
      taskId: task.id,
      type: EventType.APPROVAL_RESOLVED,
      text: 'auto allow_once: Approve edit',
      data: { id: 'appr_auto', requestId: 11, title: 'Approve edit', toolCallId: null, options: [], optionId: 'allow_once', auto: true },
    }),
  );
  const row = fleet.store.getApproval('appr_auto');
  assert.equal(row.status, 'approved');
  assert.equal(row.auto, true);
  fleet.store.close();
});

test('two runs that reuse the same JSON-RPC request id both stay visible', () => {
  // Regression: approval ids used to be derived from the JSON-RPC request id, which
  // restarts at the same base in every process. The second run's `appr_0` hit the
  // primary key of the first run's row and INSERT OR IGNORE swallowed it, so the
  // operator saw "no pending approvals" while the agent sat blocked forever.
  //
  // Modelled faithfully as two separate processes (two Fleets) sharing one store.
  const home = freshHome();

  /** Build a Fleet with its own fake adapter whose parked request has id 0. */
  const bootRun = (label, requestId) => {
    process.env.AGENTMESH_HOME = home; // same on-disk store across "runs"
    const fleet = new Fleet();
    fleet.registry.add({ name: `fake-${label}`, kind: 'hermes', transport: 'acp', local: true, command: process.execPath });
    /** @type {Map<any, any>} */
    const parked = new Map();
    let lastRecord = null;
    const adapter = {
      permissionPolicy: 'ask',
      listParked: () => [...parked.values()].map((p) => p.record),
      resolveApproval(id) {
        const entry = [...parked.values()].find((p) => p.record.requestId === id);
        if (!entry) return false;
        parked.delete(entry.record.id);
        fleet.emit(makeEvent({ nodeId: entry.record.nodeId, taskId: entry.record.taskId, type: EventType.APPROVAL_RESOLVED, text: 'answered', data: { ...entry.record, optionId: 'allow_once' } }));
        return true;
      },
    };
    fleet.adapters.set(`fake-${label}`, adapter);
    const task = fleet.store.createTask({ nodeId: 'fake', prompt: label });
    lastRecord = {
      id: newId('appr'),
      requestId, // 0 in both runs, exactly like a fresh JSON-RPC peer
      nodeId: `fake-${label}`,
      taskId: task.id,
      sessionId: `sess-${label}`,
      title: `Approve edit: ${label}.txt`,
      toolCallId: null,
      options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow' }],
      policy: 'ask',
      requestedAt: new Date().toISOString(),
    };
    parked.set(lastRecord.id, { record: lastRecord });
    fleet.emit(makeEvent({ nodeId: lastRecord.nodeId, taskId: task.id, type: EventType.APPROVAL_REQUESTED, text: '', data: lastRecord }));
    return { fleet, record: lastRecord, adapter };
  };

  const run1 = bootRun('first', 0);
  const r1 = run1.record;
  // A second process: same store, same request id, brand-new approval.
  const run2 = bootRun('second', 0);
  const r2 = run2.record;

  assert.notEqual(r1.id, r2.id, 'approval ids must not be derived from the request id');

  const pending = run2.fleet.store.listApprovals({ status: 'pending' });
  assert.equal(pending.length, 2, 'both runs must be queryable');
  assert.deepEqual(pending.map((p) => p.id).sort(), [r1.id, r2.id].sort());
  assert.equal(run1.fleet.pendingApprovals().length, 1);
  assert.equal(run2.fleet.pendingApprovals().length, 1);

  // ...and each one resolves independently.
  assert.equal(run2.fleet.resolveApproval(r2.id, 'allow_once').ok, true);
  assert.equal(run2.fleet.store.getApproval(r2.id).status, 'approved');
  assert.equal(run2.fleet.store.getApproval(r1.id).status, 'pending');

  // Close both connections: a leaked SQLite handle keeps the loop alive and makes
  // the test runner exit non-zero even though every assertion passed.
  run1.fleet.store.close();
  run2.fleet.store.close();
});
