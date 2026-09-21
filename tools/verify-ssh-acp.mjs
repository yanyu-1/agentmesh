#!/usr/bin/env node
/**
 * End-to-end verification of the ACP-over-SSH code path.
 *
 * This machine has no sshd (no admin rights, no WSL distro) and no reachable remote
 * host, so the SSH *transport* is substituted by `tools/fake-ssh.mjs`. That shim
 * receives exactly the argv OpenSSH would receive and executes the remote command
 * line AgentMesh built, with inherited stdio.
 *
 * So this verifies: the SSH branch of the ACP adapter (`sshProcess`), the ssh argv,
 * the remote command line (cd / exec / env), env passthrough, and ACP over that
 * extra process hop. It does NOT verify SSH itself (auth, encryption, host keys).
 *
 * Drives the real CLI, so it also covers `node add --ssh-binary ...`.
 *
 * Usage: node tools/verify-ssh-acp.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const MESH = join(ROOT, 'bin', 'mesh.js');
const SHIM = join(HERE, 'fake-ssh.mjs');
const HERMES_ACP = join(process.env.LOCALAPPDATA || '', 'hermes', 'bin', 'hermes-acp.exe');

const HOME = mkdtempSync(join(tmpdir(), 'agentmesh-ssh-'));
const SSH_LOG = join(HOME, 'fake-ssh.jsonl');
const NODE_NAME = 'hermes-ssh';
const PROBE_ENV = `mesh_probe_${Date.now().toString(36)}`;

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/**
 * Run the CLI, capturing stdout/stderr through file descriptors.
 *
 * Not pipes: this environment's sandbox denies piped stdio, and fd redirection is
 * just as good for reading the result afterwards.
 *
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<{code:number|null, stdout:string, stderr:string}>}
 */
function runCli(args, timeoutMs = 300_000) {
  const outFile = join(HOME, `stdout-${Math.random().toString(36).slice(2)}.txt`);
  const errFile = join(HOME, `stderr-${Math.random().toString(36).slice(2)}.txt`);
  const outFd = openSync(outFile, 'w');
  const errFd = openSync(errFile, 'w');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MESH, ...args], {
      cwd: ROOT,
      env: { ...process.env, AGENTMESH_HOME: HOME, AGENTMESH_FAKE_SSH_LOG: SSH_LOG },
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
    });
    /** @type {any} */
    let timer = null;
    const finish = (code) => {
      if (timer) clearTimeout(timer);
      closeSync(outFd);
      closeSync(errFd);
      const read = (/** @type {string} */ f) => {
        try {
          return readFileSync(f, 'utf8');
        } catch {
          return '';
        }
      };
      resolve({ code, stdout: read(outFile), stderr: read(errFile) });
    };
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* gone */
      }
      finish(null);
    }, timeoutMs);
    child.on('error', () => finish(null));
    child.on('exit', (code) => finish(code));
  });
}

/** @returns {any[]} */
function sshLog() {
  if (!existsSync(SSH_LOG)) return [];
  return readFileSync(SSH_LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// --- 1. register the node through the real CLI --------------------------------
console.log(`fake-ssh shim : ${SHIM}`);
console.log(`ssh binary     : ${process.execPath}`);
console.log(`hermes-acp     : ${HERMES_ACP}\n`);

const add = await runCli([
  'node',
  'add',
  NODE_NAME,
  '--kind',
  'hermes',
  '--ssh',
  '127.0.0.1',
  '--ssh-user',
  'shim',
  '--ssh-port',
  '2222',
  '--ssh-key',
  '/home/shim/.ssh/id_ed25519',
  '--ssh-binary',
  process.execPath,
  '--ssh-binary-arg',
  SHIM,
  '--command',
  HERMES_ACP,
  '--cwd',
  'D:\\工作',
  '--env',
  `AGENTMESH_SSH_PROBE=${PROBE_ENV}`,
  '--json',
], 60_000);
record('mesh node add --ssh-binary accepted the SSH node', add.code === 0, add.code === 0 ? '' : `${add.stdout}${add.stderr}`.slice(0, 300));

if (add.code !== 0) {
  console.log('\nnode could not be registered; aborting');
  console.log(add.stdout);
  console.log(add.stderr);
  process.exit(1);
}

// --- 2. probe over the fake SSH transport ------------------------------------
const probe = await runCli(['probe', NODE_NAME, '--json'], 180_000);
let probeJson = null;
try {
  probeJson = JSON.parse(probe.stdout);
} catch {
  probeJson = null;
}
record(
  'ACP handshake completed through the SSH path',
  probe.code === 0 && probeJson?.connected === true,
  probeJson ? `agent=${probeJson.agentInfo?.name} v${probeJson.agentInfo?.version} protocol=${probeJson.protocolVersion}` : `${probe.stdout}${probe.stderr}`.slice(0, 400),
);

// --- 3. what actually crossed the boundary -----------------------------------
const afterProbe = sshLog();
record('the ssh client was actually invoked', afterProbe.length > 0, `${afterProbe.length} invocation(s)`);
const first = afterProbe[0];
if (first) {
  record('destination came from the node config', first.destination === 'shim@127.0.0.1', `destination=${first.destination}`);
  const flags = first.clientFlags.join(' ');
  record(
    'ssh flags are the ones buildSshArgs produces',
    flags.includes('-o BatchMode=yes') && flags.includes('-o ConnectTimeout=10') && flags.includes('-T') && flags.includes('-p 2222') && flags.includes('-i /home/shim/.ssh/id_ed25519'),
    flags,
  );
  // Leading binaryArgs must sit in front of the ssh flags (that is how an alternate
  // client such as plink is wired in).
  record('the alternate ssh binary received its shape intact', first.clientFlags[0] === '-o', 'no stray args before the ssh flags');
  record(
    'the remote command is `cd <cwd> && exec env <K=V> <program>`',
    /^cd 'D:\\工作' && exec env AGENTMESH_SSH_PROBE=/.test(first.remoteCommand),
    first.remoteCommand.slice(0, 160),
  );
  record('cwd was parsed back out of the quoted word', first.cwd === 'D:\\工作', `cwd=${JSON.stringify(first.cwd)}`);
  record('the agent program resolved to the configured command', first.program === HERMES_ACP, first.program);
  // The bug this round fixed: node env used to be dropped entirely over SSH.
  record(
    'node --env values reach the remote process',
    first.env.AGENTMESH_SSH_PROBE === PROBE_ENV,
    `env=${JSON.stringify(first.env)}`,
  );
}

// --- 4. a real task over the SSH path ---------------------------------------
const send = await runCli(['send', NODE_NAME, '不要使用任何工具，只用一句中文说明你是什么。', '--json'], 300_000);
const events = send.stdout
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);
const done = events.find((e) => e.type === 'done');
const answer = events
  .filter((e) => e.type === 'chunk')
  .map((e) => e.text || '')
  .join('')
  .trim();

// Keep the raw stream: when a check fails, the NDJSON is the evidence.
const rawFile = join(ROOT, 'logs', 'verify-ssh-events.ndjson');
writeFileSync(rawFile, `# node add\n${add.stdout}\n# probe\n${probe.stdout}\n# send\n${send.stdout}\n# send stderr\n${send.stderr}\n`);

record('a task completed over the SSH path', send.code === 0 && done?.data?.state === 'completed', `exit=${send.code} state=${done?.data?.state ?? '?'} eventTypes=[${[...new Set(events.map((e) => e.type))].join(',')}]`);
record('the agent returned real text through the ssh pipe', answer.length > 0, answer.slice(0, 160) || `stderr=${send.stderr.slice(0, 200)}`);

// A fresh ssh invocation must have happened for the send; otherwise this check
// would pass vacuously on a run where nothing was dispatched at all.
const finalLog = sshLog();
record('the send opened its own ssh session', finalLog.length > afterProbe.length, `${finalLog.length} total invocation(s), ${afterProbe.length} during probe`);

// --- summary -----------------------------------------------------------------
const passed = results.filter((r) => r.pass).length;
console.log(`\n==== ${passed}/${results.length} checks passed ====`);
const failed = results.filter((r) => !r.pass);
if (failed.length) {
  console.log('failed checks:');
  for (const f of failed) console.log(`  - ${f.name} (${f.detail})`);
}
if (!process.env.AGENTMESH_KEEP_TMP) {
  try {
    rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
} else {
  console.log(`\n(fake-ssh log kept at ${SSH_LOG})`);
}
process.exit(failed.length ? 1 : 0);
