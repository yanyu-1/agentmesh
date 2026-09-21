#!/usr/bin/env node
/**
 * verify-console — drive the Web control plane the way the browser does, against a REAL
 * remote agent.
 *
 * Why this exists
 * ---------------
 * The original bug report was entirely about the console: it had no username field, no
 * port field, and its single secret box wrote an SSH password into `token`, where the
 * ssh path never looks. The result was a node that looked registered, leaked the password
 * to disk in cleartext, and failed with nothing but `process exited (code=255)`.
 *
 * Unit tests cover the shape of that fix. This covers the thing the user actually does:
 * POST the same body the form sends, then press 探测 and get a real agent handshake back
 * from another machine.
 *
 * It is skipped, loudly, unless the NAS is configured — a verification that silently
 * passes when nothing is reachable is worse than no verification.
 *
 * Usage:
 *   $env:NAS_SSH_PW = '...'        # never written to any file
 *   node tools/verify-console.mjs
 *
 * Options: --host <ip> --port <ssh port> --user <name> --cmd <remote acp binary>
 */

import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const HOST = flag('host', '10.0.0.5');
const PORT = Number(flag('port', 2222));
const USER = flag('user', 'user');
const CMD = flag('cmd', '/opt/hermes/bin/hermes-acp');
const PASSWORD = process.env.NAS_SSH_PW || process.env.MESH_ASKPASS_SECRET || '';

const HOME = path.join(root, '.agentmesh-verify-console');

let passed = 0;
let failed = 0;
/** @type {string[]} */
const failures = [];

/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    process.stdout.write(`  \u2713 ${name}${detail ? ` — ${detail}` : ''}\n`);
  } else {
    failed += 1;
    failures.push(name);
    process.stdout.write(`  \u2717 ${name}${detail ? ` — ${detail}` : ''}\n`);
  }
}

function freshHome() {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });
  return HOME;
}

const nodesFile = () => path.join(HOME, 'nodes.json');
const nodesText = () => (existsSync(nodesFile()) ? readFileSync(nodesFile(), 'utf8') : '');

/** Start a real console on an ephemeral port and return a small client for it. */
async function startConsole() {
  process.env.AGENTMESH_HOME = HOME;
  const { createConsole } = await import(`../src/web/server.js?verify=${Date.now()}`);
  const c = await createConsole({ port: 0, host: '127.0.0.1' });

  /** @param {string} p @param {any} [body] */
  const post = async (p, body) => {
    const res = await fetch(c.url + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  };
  /** @param {string} p */
  const get = async (p) => {
    const res = await fetch(c.url + p);
    return { status: res.status, body: await res.json() };
  };
  return { ...c, post, get };
}

/** The ssh block a real remote Hermes needs. Mirrors what the form now produces. */
function sshBlock(extra = {}) {
  return {
    host: HOST,
    user: USER,
    port: PORT,
    binary: process.execPath,
    binaryArgs: [
      path.join(root, 'tools', 'ssh-askpass.mjs'),
      'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
    ],
    batchMode: false,
    extraOptions: [
      `UserKnownHostsFile=${path.join(root, '.ssh', 'known_hosts')}`,
      'StrictHostKeyChecking=accept-new',
    ],
    ...extra,
  };
}

/** The node body the console form now sends for an SSH ACP agent. */
function nodeBody(name, secretField) {
  return {
    name,
    kind: 'hermes',
    transport: 'acp',
    local: false,
    command: CMD,
    cwd: '/srv/work',
    env: { HERMES_HOME: '/tmp/mesh-verify', HOME: '/tmp/mesh-verify' },
    approvalPolicy: 'ask',
    ssh: sshBlock(),
    ...secretField,
  };
}

/** Pull the interesting bit out of a probe response, or the error text. */
function probeSummary(r) {
  if (r.status >= 400) return `HTTP ${r.status}: ${r.body?.error ?? JSON.stringify(r.body)}`;
  const b = r.body || {};
  if (b.agentInfo) return `ACP ${b.agentInfo.name || '?'} v${b.protocolVersion ?? '?'}`;
  if (b.summary) return `${b.summary.name} v${b.summary.version}`;
  return JSON.stringify(b).slice(0, 200);
}

process.stdout.write(`verify-console: ${USER}@${HOST}:${PORT}  ${CMD}\n`);
process.stdout.write(`  registry: ${nodesFile()}\n`);
if (!PASSWORD) {
  process.stdout.write('  NAS_SSH_PW is not set — every SSH scenario will be reported as SKIPPED, not as a pass.\n');
}
process.stdout.write('\n');

// ---------------------------------------------------------------------------
// Scenario 1 — the console can express this node at all, and leaks nothing
// ---------------------------------------------------------------------------
process.stdout.write('1. the form now produces a node that ssh can actually use\n');

const console_ = await startConsole();
let nodeId = null;
try {
  const created = await console_.post('/api/nodes', {
    ...nodeBody('nas-console'),
    ...(PASSWORD ? { sshPassword: PASSWORD } : {}),
  });
  check('POST /api/nodes accepts user, port, command and cwd', created.status === 201, `HTTP ${created.status}`);
  const node = created.body || {};
  nodeId = node.id;
  check('the port survived registration', node.ssh?.port === PORT, `port=${node.ssh?.port}`);
  check('the username survived registration', node.ssh?.user === USER, `user=${node.ssh?.user}`);
  check('the remote command survived registration', node.command === CMD);
  check('BatchMode is off, so a password can be answered', node.ssh?.batchMode === false);

  if (PASSWORD) {
    check('the console reports a usable password', node.hasSshPassword === true, `source=${node.sshPasswordSource}`);
    check('the password is NOT in nodes.json', !nodesText().includes(PASSWORD), 'checked against the raw bytes');
    check('no sshPassword key was persisted', !nodesText().includes('"sshPassword"'));
  } else {
    process.stdout.write('  - skipped secret assertions (no NAS_SSH_PW)\n');
  }

  const listed = await console_.get('/api/nodes');
  check('GET /api/nodes does not echo the password', !JSON.stringify(listed.body).includes(PASSWORD || '\u0000'));

  // -------------------------------------------------------------------------
  // Scenario 2 — 探测, the button the user pressed
  // -------------------------------------------------------------------------
  process.stdout.write('\n2. 探测 reaches the real agent over ssh\n');
  if (!PASSWORD) {
    process.stdout.write('  - SKIPPED: no NAS_SSH_PW in the environment\n');
  } else {
    const probe = await console_.post('/api/nodes/nas-console/probe');
    const ok = probe.status < 400 && (probe.body?.agentInfo || probe.body?.summary);
    check('probe returns a real ACP handshake', ok, probeSummary(probe));

    // -----------------------------------------------------------------------
    // Scenario 3 — the failure reason is visible, not just an exit code
    // -----------------------------------------------------------------------
    process.stdout.write('\n3. a WRONG port explains itself instead of saying "code=255"\n');
    await console_.post('/api/nodes', {
      name: 'nas-wrongport',
      kind: 'hermes',
      transport: 'acp',
      local: false,
      command: CMD,
      ssh: sshBlock({ port: 22 }), // the NAS drops mid-banner here; this is the user's original symptom
      sshPassword: PASSWORD,
    });
    const bad = await console_.post('/api/nodes/nas-wrongport/probe');
    const text = bad.status >= 400 ? String(bad.body?.error ?? '') : JSON.stringify(bad.body);
    check('the failure is reported as an error', bad.status >= 400, `HTTP ${bad.status}`);
    check(
      'the message carries ssh stderr, not only an exit code',
      /banner|refused|denied|reset|timed out|Connection/i.test(text) && text.length > 'process exited (code=255)'.length,
      text.split('\n').slice(0, 3).join(' | ').slice(0, 220),
    );
  }

  // -------------------------------------------------------------------------
  // Scenario 4 — a password can come from a NAMED env var, so it survives a restart
  // -------------------------------------------------------------------------
  process.stdout.write('\n4. ssh.passwordEnv names a variable; the value stays out of the file\n');
  const envName = 'MESH_VERIFY_SSH_PW';
  await console_.post('/api/nodes', {
    name: 'nas-env',
    kind: 'hermes',
    transport: 'acp',
    local: false,
    command: CMD,
    ssh: sshBlock({ passwordEnv: envName }),
  });
  check('the variable NAME is persisted', nodesText().includes(envName));
  if (PASSWORD) {
    check('the value is not persisted', !nodesText().includes(PASSWORD));
  }
  process.env[envName] = PASSWORD || '';
  const envListed = await console_.get('/api/nodes');
  const envNode = envListed.body.find((n) => n.name === 'nas-env');
  check(
    'the console resolves the password from the environment',
    PASSWORD ? envNode?.hasSshPassword === true && envNode?.sshPasswordSource === 'env' : envNode?.hasSshPassword === false,
    `hasSshPassword=${envNode?.hasSshPassword} source=${envNode?.sshPasswordSource}`,
  );
  delete process.env[envName];

  // -------------------------------------------------------------------------
  // Scenario 5 — editing the port, the thing that was impossible before
  // -------------------------------------------------------------------------
  process.stdout.write('\n5. an existing node can be edited (there was no way to do this at all)\n');
  const edited = await console_.post('/api/nodes/nas-console/update', { ssh: { port: PORT } });
  check('update returns the node with the new port', edited.body?.ssh?.port === PORT);
  check('the username was not dropped by a port-only edit', edited.body?.ssh?.user === USER);
  check('the command was not dropped', edited.body?.command === CMD);
  check('the password survived the edit', !PASSWORD || edited.body?.hasSshPassword === true);

  const removed = await console_.post('/api/nodes/nas-console/delete');
  check('delete removes the node', removed.body?.removed === 'nas-console');
  check('nothing secret is left in the registry', !PASSWORD || !nodesText().includes(PASSWORD));
} finally {
  await console_.close();
  rmSync(HOME, { recursive: true, force: true });
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed) {
  process.stdout.write(`failed: ${failures.join(', ')}\n`);
  process.exit(1);
}
if (!PASSWORD) {
  process.stdout.write('NOTE: the SSH scenarios were skipped. Re-run with NAS_SSH_PW set for the full check.\n');
}
