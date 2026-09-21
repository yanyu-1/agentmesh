// Fleet targeting tests.
//
// Exists because of a real bug: `mesh broadcast --capability c` passed the array
// the CLI produces into `resolveTargets`, which read it as a single string. The
// comparison `['c'].includes(['c'])` is always false, so a capability broadcast
// silently selected ZERO nodes and reported success on an empty result set.
//
// Run: node test/fleet.test.js

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOMES = [];
function freshHome() {
  const dir = mkdtempSync(join(tmpdir(), 'agentmesh-fleet-'));
  HOMES.push(dir);
  process.env.AGENTMESH_HOME = dir;
  return dir;
}

const { Fleet } = await import('../src/core/fleet.js');
const { EventType } = await import('../src/protocol/events.js');
const { TaskState } = await import('../src/protocol/states.js');

/** @type {any[]} */
const FLEETS = [];

after(async () => {
  // A leaked SQLite handle makes this process exit non-zero even when every test
  // passed, so close every fleet before tearing the temp homes down.
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

/** Build a fleet with three nodes and no live connections. */
function fixture() {
  freshHome();
  const fleet = new Fleet();
  FLEETS.push(fleet);
  fleet.registry.add({ name: 'alpha', kind: 'generic-acp', capabilities: ['review'], tags: [] });
  fleet.registry.add({ name: 'beta', kind: 'generic-acp', capabilities: [], tags: ['gpu'] });
  fleet.registry.add({ name: 'gamma', kind: 'generic-acp', capabilities: ['review', 'translate'], tags: [] });
  fleet.registry.add({ name: 'off', kind: 'generic-acp', capabilities: ['review'], enabled: false });
  return fleet;
}

/** @param {import('../src/core/registry.js').NodeConfig[]} nodes */
const names = (nodes) => nodes.map((n) => n.name).sort();

test('a capability given as an array matches nodes advertising any of them', () => {
  const fleet = fixture();
  // The CLI hands over an array (`--capability review --capability translate`).
  assert.deepEqual(names(fleet.resolveTargets({ capability: ['review'] })), ['alpha', 'gamma']);
  assert.deepEqual(names(fleet.resolveTargets({ capability: ['translate'] })), ['gamma']);
  assert.deepEqual(names(fleet.resolveTargets({ capability: ['translate', 'review'] })), ['alpha', 'gamma']);
});

test('a capability given as a plain string still works', () => {
  const fleet = fixture();
  assert.deepEqual(names(fleet.resolveTargets({ capability: 'review' })), ['alpha', 'gamma']);
  assert.deepEqual(names(fleet.resolveTargets({ capability: 'nope' })), []);
});

test("'*' and an absent capability mean every enabled node", () => {
  const fleet = fixture();
  assert.deepEqual(names(fleet.resolveTargets({ capability: '*' })), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(names(fleet.resolveTargets({})), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(names(fleet.resolveTargets({ capability: [] })), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(names(fleet.resolveTargets({ capability: [true] })), ['alpha', 'beta', 'gamma'], 'junk must not filter everything out');
});

test('a tag is usable as a capability selector', () => {
  const fleet = fixture();
  assert.deepEqual(names(fleet.resolveTargets({ capability: 'gpu' })), ['beta']);
});

test('explicit refs win, and a disabled node is never selected implicitly', () => {
  const fleet = fixture();
  assert.deepEqual(names(fleet.resolveTargets({ refs: ['beta'] })), ['beta']);
  assert.ok(!names(fleet.resolveTargets({ capability: 'review' })).includes('off'), 'a disabled node must not be swept in');
  // An explicit ref to a disabled node is honoured (the operator asked by name).
  assert.deepEqual(names(fleet.resolveTargets({ refs: ['off'] })), ['off']);
  assert.throws(() => fleet.resolveTargets({ refs: ['ghost'] }), /ghost/);
});

// ---------------------------------------------------------------------------
// Secrets never reach the registry file
// ---------------------------------------------------------------------------
//
// These guard the invariant behind a real leak: the Web console's only secret field sent
// an SSH password as `token`, so it was written to nodes.json in cleartext AND ignored by
// the ssh path. The fix is structural — secrets live in a side table keyed by node id, not
// on the node object, so the code that serialises nodes cannot reach them.

/** A node that goes over ssh, i.e. one where a password means an SSH password. */
const sshNode = (extra = {}) => ({
  name: 'nas',
  kind: 'hermes',
  transport: 'acp',
  local: false,
  command: 'hermes-acp',
  ssh: { host: '10.0.0.9', user: 'me', port: 2222, batchMode: false, ...extra },
});

test('a password passed to add() is held in memory and never serialised', () => {
  const fleet = fixture();
  const node = fleet.registry.add({ ...sshNode(), sshPassword: 'hunter2' });

  assert.equal(fleet.registry.resolveSshPassword(node), 'hunter2');
  assert.equal(fleet.registry.hasSshPassword(node), true);
  // The node object itself must not carry it.
  assert.equal(node.ssh.password, undefined);
  assert.equal(node.sshPassword, undefined);
  // And it must not be in the file the registry just wrote.
  const raw = readFileSync(join(process.env.AGENTMESH_HOME, 'nodes.json'), 'utf8');
  assert.ok(!raw.includes('hunter2'), 'the password must not be on disk');
});

test('every spelling of an ssh password is quarantined, not persisted', () => {
  for (const spell of ['sshPassword', 'sshPasswordNested', 'passwordOnSshNode']) {
    const fleet = fixture();
    const input =
      spell === 'sshPassword'
        ? { ...sshNode(), sshPassword: 'x-secret' }
        : spell === 'sshPasswordNested'
          ? { ...sshNode(), ssh: { ...sshNode().ssh, password: 'x-secret' } }
          : { ...sshNode(), password: 'x-secret' };
    const node = fleet.registry.add(input);
    assert.equal(fleet.registry.hasSshPassword(node), true, `${spell} must be picked up`);
    const raw = readFileSync(join(process.env.AGENTMESH_HOME, 'nodes.json'), 'utf8');
    assert.ok(!raw.includes('x-secret'), `${spell} must not reach the file`);
    assert.ok(!/"password"/.test(raw), `${spell} must not leave a password key behind`);
  }
});

test('an opencode password is still persisted — it is that node type\'s real credential', () => {
  // The quarantine must not be a blanket ban: `password` on an opencode node is
  // OPENCODE_SERVER_PASSWORD and is documented as living in the config.
  const fleet = fixture();
  fleet.registry.add({ name: 'oc', kind: 'opencode', transport: 'opencode', url: 'http://h:4096', password: 'oc-pw' });
  const raw = readFileSync(join(process.env.AGENTMESH_HOME, 'nodes.json'), 'utf8');
  assert.ok(raw.includes('oc-pw'), 'an opencode password stays in the registry by design');
});

test('a passwordEnv is stored as a name and resolved from the environment at use time', () => {
  const fleet = fixture();
  const node = fleet.registry.add(sshNode({ passwordEnv: 'MESH_TEST_PW' }));
  assert.equal(fleet.registry.hasSshPassword(node), false, 'no value in the environment yet');

  process.env.MESH_TEST_PW = 'from-env';
  try {
    assert.equal(fleet.registry.resolveSshPassword(node), 'from-env');
    const raw = readFileSync(join(process.env.AGENTMESH_HOME, 'nodes.json'), 'utf8');
    assert.ok(raw.includes('MESH_TEST_PW'), 'the variable NAME persists — that is what survives a restart');
    assert.ok(!raw.includes('from-env'), 'the VALUE does not');
  } finally {
    delete process.env.MESH_TEST_PW;
  }
});

test('runtimeNode hands the adapter a copy carrying the secret, leaving the stored node clean', () => {
  const fleet = fixture();
  const stored = fleet.registry.add({ ...sshNode(), sshPassword: 'pw' });
  const runtime = fleet.registry.runtimeNode('nas');

  assert.equal(runtime.ssh.password, 'pw', 'the adapter needs the password');
  assert.notEqual(runtime, stored, 'it must be a copy');
  assert.equal(stored.ssh.password, undefined, 'the stored node must stay clean');
  assert.ok(!readFileSync(join(process.env.AGENTMESH_HOME, 'nodes.json'), 'utf8').includes('"pw"'));

  // The copy must be detached, not just differently-identified: an adapter that mutates
  // what it was handed must not be able to reach into the live registry entry.
  const originalPort = runtime.ssh.port;
  const originalHost = runtime.ssh.host;
  runtime.ssh.port = 1;
  runtime.ssh.host = 'evil';
  runtime.name = 'renamed';
  const fresh = fleet.registry.get('nas');
  assert.equal(fresh.ssh.port, originalPort);
  assert.equal(fresh.ssh.host, originalHost);
  assert.equal(fresh.name, 'nas');

  // And a node with no secret at all is still handed over as a copy.
  const plain = fleet.registry.add({ name: 'plain', kind: 'hermes', transport: 'acp', local: true, command: 'x' });
  const plainRuntime = fleet.registry.runtimeNode('plain');
  assert.notEqual(plainRuntime, plain);
  plainRuntime.name = 'renamed';
  assert.equal(fleet.registry.get('plain').name, 'plain');
});

test('update merges ssh rather than replacing it, and can unset a field', () => {
  const fleet = fixture();
  fleet.registry.add({ ...sshNode(), ssh: { ...sshNode().ssh, extraOptions: ['StrictHostKeyChecking=accept-new'] } });

  // A port-only edit must not drop the user, the options, or the auth mode.
  const after = fleet.registry.update('nas', { ssh: { port: 2222 } });
  assert.equal(after.ssh.port, 2222);
  assert.equal(after.ssh.user, 'me');
  assert.deepEqual(after.ssh.extraOptions, ['StrictHostKeyChecking=accept-new']);
  assert.equal(after.ssh.batchMode, false);

  // Merging can only add or overwrite, so removal needs an explicit instruction.
  const cleaned = fleet.registry.update('nas', { unset: ['token'] });
  assert.equal(cleaned.token, undefined);
  const nested = fleet.registry.update('nas', { unset: ['ssh.extraOptions'] });
  assert.equal(nested.ssh.extraOptions, undefined);
  assert.equal(nested.ssh.user, 'me', 'unsetting one ssh field must not clear the rest');
});

test('removing a node also drops its held secret', () => {
  const fleet = fixture();
  const node = fleet.registry.add({ ...sshNode(), sshPassword: 'pw' });
  assert.equal(fleet.registry.hasSshPassword(node), true);
  fleet.registry.remove('nas');
  assert.equal(fleet.registry.resolveSshPassword(node), '', 'a deleted node must not keep a live credential');
});

test('a plaintext password already in the file is scrubbed on load, and the node still works', async () => {
  // A registry written by an older build can already contain `ssh.password`. Loading it
  // as-is would have the next save() write the credential straight back, so the secret is
  // moved to memory and the file rewritten. The node must keep working throughout.
  const home = freshHome();
  const legacy = {
    version: 1,
    nodes: [
      {
        id: 'node_legacy',
        name: 'legacy',
        kind: 'hermes',
        transport: 'acp',
        local: false,
        command: 'hermes-acp',
        approvalPolicy: 'deny',
        ssh: { host: '10.0.0.9', user: 'me', port: 2222, batchMode: false, password: 'legacy-plaintext' },
      },
    ],
  };
  writeFileSync(join(home, 'nodes.json'), JSON.stringify(legacy, null, 2), 'utf8');

  const fleet = new Fleet();
  FLEETS.push(fleet);
  const node = fleet.registry.get('legacy');

  assert.equal(fleet.registry.resolveSshPassword(node), 'legacy-plaintext', 'the node must keep working');
  assert.equal(node.ssh.password, undefined, 'but the secret must not live on the node object');

  const raw = readFileSync(join(home, 'nodes.json'), 'utf8');
  assert.ok(!raw.includes('legacy-plaintext'), 'the file must have been rewritten without the secret');
  assert.ok(!/"password"/.test(raw));
});

// ---------------------------------------------------------------------------
// A remote asking for a decision (defect 61)
//
// Found from a real deployment: an A2A peer that answered TASK_STATE_INPUT_REQUIRED with a
// question — a peer doing exactly what its protocol says — left the operator with a task that
// looked stuck. The question did arrive, in the task result, but nothing said "nobody is working
// and nothing will move until you answer", and `--approval ask` had been quietly discarded
// because the A2A adapter has no permission channel at all.
// ---------------------------------------------------------------------------

/** A fleet of one stubbed node, plus the events its run produced. */
function stubbedRun(transport, outcome) {
  freshHome();
  const fleet = new Fleet();
  FLEETS.push(fleet);
  fleet.registry.add({ name: 'peer', transport, url: 'http://peer.invalid:9900' });
  /** @type {any[]} */
  const events = [];
  fleet.adapterFor = () => ({ send: async () => outcome, prompt: async () => outcome, close: async () => {} });
  return { fleet, events, onEvent: (/** @type {any} */ ev) => events.push(ev) };
}

test('a task parked in a waiting state says so, and says how to answer it', () => {
  const question = 'DANGEROUS COMMAND: 需要你确认是否执行 rm -rf /tmp/x';
  const { fleet, events, onEvent } = stubbedRun('a2a', { state: TaskState.INPUT_REQUIRED, text: question, contextId: 'ctx-1' });

  return fleet.send({ nodeRef: 'peer', prompt: '把 8088 停掉', onEvent }).then((task) => {
    assert.equal(task.state, TaskState.INPUT_REQUIRED);
    const signal = events.filter((e) => e.type === EventType.NEEDS_INPUT);
    assert.equal(signal.length, 1, 'exactly one needs-input event per parked task');
    // The remote's own words, verbatim: the operator decides on those, not on a summary.
    assert.equal(signal[0].text, question);
    assert.equal(signal[0].data.question, question);
    assert.equal(signal[0].data.contextId, 'ctx-1');
    // And the exact way to answer, because "input-required" is not an instruction.
    assert.match(signal[0].data.replyWith, /mesh send peer .* --continue/);
    // It must arrive before `done`, so a live watcher sees it in the right order.
    const order = events.map((e) => e.type);
    assert.ok(order.indexOf(EventType.NEEDS_INPUT) < order.indexOf(EventType.DONE));
  });
});

test('a completed task does not claim to be waiting for anyone', async () => {
  const { fleet, events, onEvent } = stubbedRun('a2a', { state: TaskState.COMPLETED, text: 'done', contextId: 'ctx-1' });
  await fleet.send({ nodeRef: 'peer', prompt: 'x', onEvent });
  assert.deepEqual(events.filter((e) => e.type === EventType.NEEDS_INPUT), []);
});

test('a waiting state with no question still reports rather than staying silent', async () => {
  // A peer may park the task and say nothing. Silence is the thing that must not happen.
  const { fleet, events, onEvent } = stubbedRun('a2a', { state: TaskState.INPUT_REQUIRED, text: '', contextId: 'ctx-1' });
  await fleet.send({ nodeRef: 'peer', prompt: 'x', onEvent });
  const signal = events.find((e) => e.type === EventType.NEEDS_INPUT);
  assert.ok(signal, 'the operator must still be told that a person is needed');
  assert.match(signal.text, /did not say/);
  assert.equal(signal.data.question, '');
});

test('--approval on a transport with no permission channel is refused loudly, not dropped', async () => {
  // This is the defect's second half. The flag was silently ignored, so an operator who had asked
  // to be consulted believed they would be — and the one moment a human was needed produced no
  // signal at all. Saying nothing is the single worst option; saying it is cheap.
  const { fleet, events, onEvent } = stubbedRun('a2a', { state: TaskState.COMPLETED, text: 'ok' });
  await fleet.send({ nodeRef: 'peer', prompt: 'x', permissionPolicy: 'ask', onEvent });

  const warning = events.find((e) => e.type === EventType.LOG && e.data?.state === 'approval-unsupported');
  assert.ok(warning, 'an ignored --approval must produce a warning event');
  assert.match(warning.text, /no effect on the 'a2a' transport/);
  // The message has to name the way out, not just the problem.
  assert.match(warning.text, /--continue/);
  assert.equal(warning.data.transport, 'a2a');
  assert.equal(warning.data.policy, 'ask');
});

test('a transport that does have a permission channel is configured without a warning', async () => {
  // The guard must not turn into noise on the transports where the flag does work.
  const { fleet, events, onEvent } = stubbedRun('acp', { state: TaskState.COMPLETED, text: 'ok' });
  const adapter = /** @type {any} */ ({ send: async () => ({ state: TaskState.COMPLETED, text: 'ok' }), prompt: async () => ({ state: TaskState.COMPLETED, text: 'ok' }), close: async () => {}, permissionPolicy: 'deny' });
  fleet.adapterFor = () => adapter;
  await fleet.send({ nodeRef: 'peer', prompt: 'x', permissionPolicy: 'ask', onEvent });

  assert.equal(adapter.permissionPolicy, 'ask', 'the policy must actually be applied');
  assert.deepEqual(
    events.filter((e) => e.type === EventType.LOG && e.data?.state === 'approval-unsupported'),
    [],
    'a working transport must not warn',
  );
});
