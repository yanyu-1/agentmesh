// `mesh cancel` must never claim a cancellation it did not perform.
//
// A cancellation is only delivered over the live connection, so the process that owns
// the task is the only one that can really stop the agent. `cmdCancel` used to build a
// fresh Fleet, find the task in the SHARED store, call `adapter.cancel()` on a brand-new
// (never connected) adapter — a silent no-op because the implementation is
// `this.#peer?.notify(...)` — and then mark the row `canceled` anyway, print
// "✓ canceled" and exit 0. The agent kept working while every listing said it had
// stopped. It was reproduced for real: with no console running, cancelling a stale
// `working` row reported success and flipped the row to `canceled` while nothing was
// listening on the port at all.
//
// These tests pin the honest contract: talk to the daemon that holds the task; when
// there is none, refuse loudly and leave the record alone.
//
// Run: node test/cli-cancel.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/core/store.js';
import { listenOnFetchablePort } from '../src/core/transport/net.js';

const CLI = fileURLToPath(new URL('../bin/mesh.js', import.meta.url));

/**
 * A state directory of our own, never the user's real ~/.agentmesh.
 * @param {string} label
 */
function isolatedHome(label) {
  const dir = mkdtempSync(join(tmpdir(), `agentmesh-${label}-`));
  process.env.AGENTMESH_HOME = dir;
  return dir;
}

/**
 * A port nothing is listening on, so the "no daemon" branch is deterministic rather
 * than dependent on whatever happens to be running on 7331.
 * @returns {Promise<number>}
 */
async function freePort() {
  const server = createServer();
  await listenOnFetchablePort(server, '127.0.0.1');
  const { port } = /** @type {any} */ (server.address());
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * Run the CLI as a real child process and capture its exit code and streams.
 *
 * A pipe-spawning sandbox denies `child_process` with piped stdio. That is an
 * environment limitation, not a product failure, so it is reported as a skip — but
 * never silently.
 *
 * @param {string[]} args
 * @param {string} home
 * @returns {Promise<{skip:string}|{status:number, stdout:string, stderr:string}>}
 */
async function runCli(args, home) {
  return await new Promise((resolve) => {
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      child = spawn(process.execPath, [CLI, ...args], {
        env: { ...process.env, AGENTMESH_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/EPERM|not permitted|EACCES/i.test(msg)) {
        resolve({ skip: `cannot spawn a child with piped stdio here (${msg}); run outside the sandbox` });
        return;
      }
      throw err;
    }
    let stdout = '';
    let stderr = '';
    let failed = null;
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      failed = err;
    });
    child.on('close', (status) => {
      if (failed && /EPERM|not permitted|EACCES/i.test(failed.message)) {
        resolve({ skip: `cannot spawn a child with piped stdio here (${failed.message}); run outside the sandbox` });
        return;
      }
      resolve({ status: status ?? -1, stdout, stderr });
    });
  });
}

test('with no daemon, cancelling a live-looking task refuses instead of lying', async (t) => {
  const home = isolatedHome('cancel-refuse');
  const store = new Store();
  const task = store.createTask({ nodeId: 'node_missing', prompt: 'agent is busy' });
  store.updateTask(task.id, { state: 'working' });
  store.close();

  const port = await freePort();
  const res = await runCli(['cancel', task.id, '--port', String(port)], home);
  if ('skip' in res) return t.skip(res.skip);

  assert.equal(res.status, 1, `expected a refusal, got exit ${res.status}: ${res.stderr}`);
  assert.match(res.stderr, /no live connection holds it/, 'the refusal must say why');
  assert.match(res.stderr, /NOT marked canceled/, 'the refusal must state the record is untouched');
  assert.doesNotMatch(res.stdout, /canceled/, 'nothing may claim success');

  // The decisive assertion: the record must be exactly as we left it.
  const after = new Store();
  assert.equal(after.findTask(task.id)?.state, 'working', 'the task row must not be flipped to canceled');
  after.close();
});

test('with no daemon, cancelling an already-finished task is a truthful no-op', async (t) => {
  const home = isolatedHome('cancel-terminal');
  const store = new Store();
  const task = store.createTask({ nodeId: 'node_missing', prompt: 'already done' });
  store.updateTask(task.id, { state: 'completed', result: 'ok' });
  store.close();

  const port = await freePort();
  const res = await runCli(['cancel', task.id, '--port', String(port)], home);
  if ('skip' in res) return t.skip(res.skip);

  assert.equal(res.status, 0, `a no-op is not an error: ${res.stderr}`);
  assert.match(res.stderr, /already completed/, 'it should say which state it is in');
});

test('an unknown task is an error, not a success', async (t) => {
  const home = isolatedHome('cancel-unknown');
  const port = await freePort();
  const res = await runCli(['cancel', 'task_deadbeefdeadbeef', '--port', String(port)], home);
  if ('skip' in res) return t.skip(res.skip);

  assert.equal(res.status, 1);
  assert.match(res.stderr, /unknown task/);
});

test('a reachable daemon is asked first: it owns the live connection', async (t) => {
  const home = isolatedHome('cancel-daemon');
  const store = new Store();
  const task = store.createTask({ nodeId: 'node_missing', prompt: 'owned by the daemon' });
  store.close();

  /** @type {any} */
  let received = null;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      received = { method: req.method, url: req.url, body: JSON.parse(body || '{}') };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ canceled: task.id }));
    });
  });
  await listenOnFetchablePort(server, '127.0.0.1');
  const port = /** @type {any} */ (server.address()).port;

  try {
    const res = await runCli(['cancel', task.id, '--port', String(port)], home);
    if ('skip' in res) return t.skip(res.skip);

    assert.equal(res.status, 0, res.stderr);
    // `ok()` writes to stderr: stdout is reserved for the answer itself, so scripts
    // can redirect it without picking up progress chatter.
    assert.match(res.stderr, /canceled/, 'the daemon did the work, so success is truthful');
    assert.equal(res.stdout, '', 'a status line must never land on stdout');
    assert.equal(received?.method, 'POST');
    assert.equal(received?.url, '/api/cancel');
    assert.equal(received?.body?.taskId, task.id, 'the daemon must be told WHICH task');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a daemon that answers 404 is reported as an unknown task', async (t) => {
  const home = isolatedHome('cancel-404');
  const server = createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unknown task' }));
  });
  await listenOnFetchablePort(server, '127.0.0.1');
  const port = /** @type {any} */ (server.address()).port;

  try {
    const res = await runCli(['cancel', 'task_deadbeefdeadbeef', '--port', String(port)], home);
    if ('skip' in res) return t.skip(res.skip);

    assert.equal(res.status, 1);
    assert.match(res.stderr, /unknown task/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
