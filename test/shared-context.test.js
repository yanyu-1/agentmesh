// Cross-node context sharing (`--share-context`).
//
// Sessions in AgentMesh are per node: `lastSession(nodeId)` and `historyForContext({nodeId})` are
// both scoped to one node, so a peer is never told anything about another agent. That isolation
// is the right default and this test pins it — the failure that would matter most here is
// context leaking between agents that were never meant to see each other.
//
// The other half is what a collaborating operator asks for: several agents on one job, each
// needing to know what the others were asked and answered. That goes in as a fenced transcript
// prepended to the outbound text, and the tests below check the parts that are easy to get wrong
// — that the fence says it is not the peer's own history, that the real request still comes last,
// that the stored record still shows what was actually asked, and that the transcript is bounded.
//
// Run: node test/shared-context.test.js

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOMES = [];
function freshHome() {
  const dir = mkdtempSync(join(tmpdir(), 'agentmesh-shared-'));
  HOMES.push(dir);
  process.env.AGENTMESH_HOME = dir;
  return dir;
}

const { Fleet } = await import('../src/core/fleet.js');
const { TaskState } = await import('../src/protocol/states.js');

/** @type {any[]} */
const FLEETS = [];
after(async () => {
  for (const fleet of FLEETS) {
    try {
      await fleet.close();
    } catch {
      /* ignore */
    }
  }
  for (const d of HOMES) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/**
 * A fleet of two A2A nodes whose transport is stubbed, so the test can read exactly what the
 * peer would have received.
 */
function fixture() {
  freshHome();
  const fleet = new Fleet();
  FLEETS.push(fleet);
  fleet.registry.add({ name: 'nas', transport: 'a2a', url: 'http://nas.invalid:9900' });
  fleet.registry.add({ name: 'aliyun', transport: 'a2a', url: 'http://aliyun.invalid:9900' });

  /** @type {{node:string, text:string}[]} */
  const sent = [];
  /** @type {any} */
  const stub = {
    send: async ({ text, taskId }) => {
      sent.push({ node: 'stub', text });
      return { state: TaskState.COMPLETED, text: `answer-${sent.length}`, contextId: 'ctx-stub' };
    },
    close: async () => {},
  };
  // `send()` resolves the adapter once, by node name.
  fleet.adapterFor = () => stub;
  return { fleet, sent, textOf: (i) => sent[i].text };
}

test('by default a peer is told nothing about another node', async () => {
  const { fleet, textOf } = fixture();
  await fleet.send({ nodeRef: 'nas', prompt: 'list the volumes' });
  assert.equal(textOf(0), 'list the volumes', 'the peer must receive exactly what was asked, and nothing more');

  // A second node receives only its own request — no trace of the nas exchange.
  await fleet.send({ nodeRef: 'aliyun', prompt: 'check the disk' });
  assert.equal(textOf(1), 'check the disk');
  assert.ok(!textOf(1).includes('list the volumes'));
});

test('--share-context sends the other node\'s turns, fenced, with the real request last', async () => {
  const { fleet, textOf } = fixture();
  await fleet.send({ nodeRef: 'nas', prompt: 'list the volumes' });
  const nasTask = fleet.store.recentTurns({ limit: 5 });
  assert.equal(nasTask.length, 1, 'the first turn is recorded');

  await fleet.send({ nodeRef: 'aliyun', prompt: 'check the disk', shareContext: true });
  const text = textOf(1);

  // The peer sees what the other agent was asked AND answered.
  assert.ok(text.includes('list the volumes'), 'the other node\'s question must be present');
  assert.ok(text.includes('answer-1'), 'the other node\'s answer must be present');
  assert.ok(text.includes('nas'), 'the transcript must name the node it came from');

  // Fenced, and explicit that this is not the peer's own history. A transcript that reads like
  // the agent's own past turns invites it to treat someone else's answer as work it already did.
  assert.ok(/Shared context from AgentMesh/.test(text));
  assert.ok(/not your own conversation/i.test(text));
  assert.ok(/End of shared context/.test(text));

  // The actual request must come after the fence, because that is what the peer has to act on.
  assert.ok(text.indexOf('check the disk') > text.indexOf('End of shared context'));
  assert.ok(text.trimEnd().endsWith('check the disk'));

  // And the peer's own name must not be in the transcript it is reading.
  assert.ok(!/aliyun was asked/.test(text), 'the target node must be excluded from its own shared context');
});

test('the stored task keeps the real prompt, not the injected transcript', async () => {
  // `mesh task <id>` is how you read back what you asked. If the record held the augmented text,
  // every shared task would open with a wall of other nodes' history.
  const { fleet } = fixture();
  await fleet.send({ nodeRef: 'nas', prompt: 'first question' });
  const task = await fleet.send({ nodeRef: 'aliyun', prompt: 'second question', shareContext: true });
  assert.equal(task.prompt, 'second question');
  assert.ok(!String(task.prompt).includes('Shared context'));
});

test('the transcript is bounded, and unanswered turns are left out', async () => {
  const { fleet, sent } = fixture();

  // A very long answer must not push the real request out of the peer's context.
  const huge = 'x'.repeat(5000);
  fleet.store.createTask({ nodeId: fleet.registry.get('nas').id, prompt: 'huge question' });
  const t = fleet.store.recentTurns({ limit: 10 });
  assert.equal(t.length, 0, 'a task with no result must not be replayed: nothing answered it');

  const task = fleet.store.createTask({ nodeId: fleet.registry.get('nas').id, prompt: 'a'.repeat(2000) });
  fleet.store.updateTask(task.id, { state: TaskState.COMPLETED, result: huge });

  await fleet.send({ nodeRef: 'aliyun', prompt: 'do the thing', shareContext: true });
  const text = sent.at(-1).text;
  assert.ok(text.length < 3000, `the transcript must be clipped, got ${text.length} chars`);
  assert.ok(text.includes('…'), 'a clipped field must be visibly clipped');
  assert.ok(text.trimEnd().endsWith('do the thing'));

  // `shareLimit` bounds how many turns are included.
  for (let i = 0; i < 5; i += 1) {
    const t2 = fleet.store.createTask({ nodeId: fleet.registry.get('nas').id, prompt: `q${i}` });
    fleet.store.updateTask(t2.id, { state: TaskState.COMPLETED, result: `r${i}` });
  }
  await fleet.send({ nodeRef: 'aliyun', prompt: 'go', shareContext: true, shareLimit: 2 });
  const limited = sent.at(-1).text;
  const turns = (limited.match(/was asked:/g) || []).length;
  assert.equal(turns, 2, `shareLimit=2 must include 2 turns, got ${turns}`);
  assert.ok(limited.includes('r4'), 'the newest turns are the ones kept');
  assert.ok(!limited.includes('huge question'), 'the oldest turn must have been dropped');
});

test('recentTurns returns oldest first and can exclude a node', async () => {
  const { fleet } = fixture();
  const nasId = fleet.registry.get('nas').id;
  const aliyunId = fleet.registry.get('aliyun').id;
  for (const [nodeId, n] of [[nasId, 'n1'], [aliyunId, 'a1'], [nasId, 'n2']]) {
    const t = fleet.store.createTask({ nodeId, prompt: n });
    fleet.store.updateTask(t.id, { state: TaskState.COMPLETED, result: `ans-${n}` });
  }
  assert.deepEqual(fleet.store.recentTurns({ limit: 10 }).map((t) => t.prompt), ['n1', 'a1', 'n2']);
  assert.deepEqual(fleet.store.recentTurns({ limit: 10, excludeNodeId: nasId }).map((t) => t.prompt), ['a1']);
  assert.deepEqual(fleet.store.recentTurns({ limit: 2 }).map((t) => t.prompt), ['a1', 'n2']);
});
