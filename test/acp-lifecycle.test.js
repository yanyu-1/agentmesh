// ACP adapter lifecycle tests against a REAL child process.
//
// Everything else in the suite stubs the adapter, so it cannot see a class of bug that
// lives in the process lifecycle: an old connection's exit handler firing after the
// next connection was installed. That is not hypothetical — `probe()` kills its
// throwaway agent, and because the exit handler closed `this.#peer` (by then the NEW
// peer) the following `send()` died with `closed: process exited (signal=SIGTERM)`.
// In the Web console, which probes nodes and then dispatches to them from one process,
// that broke every send to a freshly-probed node.
//
// Run: node test/acp-lifecycle.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Fleet } from '../src/core/fleet.js';

const AGENT = fileURLToPath(new URL('./helpers/fake-acp.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * A Fleet with one local ACP node backed by the real fake agent process, in its own
 * state directory (never the user's ~/.agentmesh).
 * @param {string} name
 */
function fleetWith(name) {
  process.env.AGENTMESH_HOME = mkdtempSync(join(tmpdir(), 'agentmesh-lifecycle-'));
  const fleet = new Fleet();
  fleet.registry.add({
    name,
    kind: 'generic-acp',
    transport: 'acp',
    local: true,
    command: process.execPath,
    args: [AGENT],
    cwd: ROOT,
    approvalPolicy: 'deny',
  });
  return fleet;
}

/**
 * A pipe-spawning sandbox (e.g. the one this repo is sometimes verified inside) denies
 * `child_process` with piped stdio. That is an environment limitation, not a product
 * failure, so report it as a skip rather than a false red — but never silently.
 * @param {Fleet} fleet
 * @param {string} name
 * @returns {Promise<string|null>} a skip reason, or null when the spawn worked
 */
async function skipReasonIfBlocked(fleet, name) {
  try {
    await fleet.probe(name);
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/EPERM|not permitted|EACCES/i.test(msg)) {
      return `cannot spawn a child with piped stdio here (${msg.split('\n')[0]}); run outside the sandbox to exercise this`;
    }
    throw err;
  }
}

test('probe() then send() on the same adapter still works', async (t) => {
  const fleet = fleetWith('lifecycle');
  try {
    const skip = await skipReasonIfBlocked(fleet, 'lifecycle');
    if (skip) return t.skip(skip);

    // The probe killed its own agent process. The next send must open a fresh one and
    // keep it: the dead connection's exit may not touch the live peer.
    const types = [];
    const task = await fleet.send({
      nodeRef: 'lifecycle',
      prompt: 'hello',
      timeoutMs: 20_000,
      permissionPolicy: 'allow-once',
      onEvent: (ev) => types.push(ev.type),
    });
    assert.equal(task.state, 'completed', `send after probe failed: ${task.error ?? '(no error recorded)'}`);
    assert.match(task.result ?? '', /fake answer/);
    assert.ok(types.includes('chunk'), 'the streamed chunk must reach the caller');
  } finally {
    await fleet.close().catch(() => {});
  }
});

test('two sequential sends reuse one healthy connection', async (t) => {
  const fleet = fleetWith('twice');
  try {
    const skip = await skipReasonIfBlocked(fleet, 'twice');
    if (skip) return t.skip(skip);

    const a = await fleet.send({ nodeRef: 'twice', prompt: 'one', timeoutMs: 20_000, permissionPolicy: 'allow-once' });
    const b = await fleet.send({ nodeRef: 'twice', prompt: 'two', timeoutMs: 20_000, permissionPolicy: 'allow-once' });
    assert.equal(a.state, 'completed', `first send failed: ${a.error ?? ''}`);
    assert.equal(b.state, 'completed', `second send failed: ${b.error ?? ''}`);
  } finally {
    await fleet.close().catch(() => {});
  }
});

test('an unexpected agent exit still closes the live peer', async (t) => {
  const fleet = fleetWith('death');
  try {
    const skip = await skipReasonIfBlocked(fleet, 'death');
    if (skip) return t.skip(skip);

    const adapter = fleet.adapterFor('death');
    // probe() leaves nothing connected (it tears its own connection down), so open one
    // deliberately to have something to tear down.
    await adapter.connect();
    assert.equal(adapter.connected, true, 'connect() establishes a live peer');
    // A deliberate teardown must not be reported as a crash: the exit handler has to
    // recognise that this stream is no longer the live one before it closes a peer.
    const logs = [];
    const off = fleet.subscribe((ev) => {
      if (ev.type === 'log') logs.push(ev.text);
    });
    await adapter.disconnect('test teardown');
    off();
    assert.equal(adapter.connected, false, 'disconnect clears the peer');
    assert.ok(
      !logs.some((l) => /process exited/.test(String(l))),
      `a deliberate disconnect emitted an exit log: ${JSON.stringify(logs)}`,
    );
    // And the adapter must be reusable afterwards.
    const task = await fleet.send({ nodeRef: 'death', prompt: 'again', timeoutMs: 20_000, permissionPolicy: 'allow-once' });
    assert.equal(task.state, 'completed', `reconnect failed: ${task.error ?? ''}`);
  } finally {
    await fleet.close().catch(() => {});
  }
});
