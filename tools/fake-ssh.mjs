#!/usr/bin/env node
/**
 * fake-ssh — a stand-in for the `ssh` executable, used to exercise AgentMesh's
 * SSH code path on a machine that has no reachable SSH server.
 *
 * WHAT IT REPLACES: the SSH transport itself (TCP connection, authentication,
 * encryption, remote shell). WHAT IT KEEPS: everything AgentMesh is responsible
 * for — the argv OpenSSH would receive, the remote command line, and the stdio
 * pipe that ACP rides on.
 *
 * It is invoked the way a real ssh client would be:
 *   node fake-ssh.mjs [-o opt] [-p port] [-i key] ... <destination> <remoteCommand>
 * (wired up via `ssh.binary` = node and `ssh.binaryArgs` = [this file]).
 *
 * It then evaluates the remote command the way a POSIX shell would, for exactly the
 * shapes `buildRemoteCommand()` emits:
 *   exec <cmd> [args...]
 *   cd <dir> && exec <cmd> [args...]
 *   ... where <cmd> may be prefixed by `env K=V K=V`
 * and spawns the program with its stdio INHERITED, so the JSON-RPC pipe flows
 * straight through this process.
 *
 * Every invocation is appended as one JSON line to $AGENTMESH_FAKE_SSH_LOG, which is
 * what the verifier asserts against — evidence of what actually crossed the boundary.
 *
 * Deliberate limitations (do not treat as verified anywhere):
 *   - paths are local Windows paths, not remote POSIX ones;
 *   - no quoting subtleties beyond the POSIX single-quote rules;
 *   - no host key checking, no auth, no ProxyJump.
 */

import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

/** Flags that consume the following token as their value. */
const FLAGS_WITH_VALUE = new Set(['-o', '-p', '-i', '-l', '-F', '-J', '-b', '-c', '-e', '-m', '-D', '-L', '-R', '-W', '-w', '-Q', '-S', '-E']);

/**
 * Split a POSIX command line into words, honouring single quotes and backslash
 * escapes. This is the same grammar `shellQuote()` targets, so a round-trip here
 * proves the quoting is right.
 *
 * @param {string} line
 * @returns {string[]}
 */
export function splitPosix(line) {
  /** @type {string[]} */
  const words = [];
  let current = '';
  let started = false;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      if (end === -1) throw new Error(`unterminated single quote in: ${line}`);
      current += line.slice(i + 1, end);
      started = true;
      i = end + 1;
      continue;
    }
    if (ch === '\\' && i + 1 < line.length) {
      current += line[i + 1];
      started = true;
      i += 2;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (started) words.push(current);
      current = '';
      started = false;
      i += 1;
      continue;
    }
    current += ch;
    started = true;
    i += 1;
  }
  if (started) words.push(current);
  return words;
}

/**
 * Interpret the remote command line the way a POSIX shell would.
 * @param {string} remoteCommand
 * @returns {{cwd:string|null, program:string, args:string[], env:Record<string,string>}}
 */
export function parseRemoteCommand(remoteCommand) {
  let tokens = splitPosix(remoteCommand);
  /** @type {string|null} */
  let cwd = null;

  if (tokens[0] === 'cd') {
    if (tokens[2] !== '&&') throw new Error(`expected \`cd <dir> && ...\`, got: ${remoteCommand}`);
    cwd = tokens[1];
    tokens = tokens.slice(3);
  }
  if (tokens[0] === 'exec') tokens = tokens.slice(1);

  /** @type {Record<string,string>} */
  const env = {};
  if (tokens[0] === 'env') {
    tokens = tokens.slice(1);
    while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
      const eq = tokens[0].indexOf('=');
      env[tokens[0].slice(0, eq)] = tokens[0].slice(eq + 1);
      tokens = tokens.slice(1);
    }
  }

  if (!tokens.length) throw new Error(`remote command has no program: ${JSON.stringify(remoteCommand)}`);
  return { cwd, program: tokens[0], args: tokens.slice(1), env };
}

// --- argv: behave like the ssh client ----------------------------------------
const argv = process.argv.slice(2);
/** @type {string[]} */
const clientFlags = [];
let index = 0;
for (; index < argv.length; index += 1) {
  const token = argv[index];
  if (!token.startsWith('-')) break;
  clientFlags.push(token);
  if (FLAGS_WITH_VALUE.has(token) && index + 1 < argv.length) {
    clientFlags.push(argv[index + 1]);
    index += 1;
  }
}
const destination = argv[index];
const remoteCommand = argv[index + 1];

if (!destination || !remoteCommand) {
  process.stderr.write(`fake-ssh: expected <destination> <remoteCommand>\nargv: ${JSON.stringify(argv)}\n`);
  process.exit(255);
}

/** @type {ReturnType<typeof parseRemoteCommand>} */
let parsed;
try {
  parsed = parseRemoteCommand(remoteCommand);
} catch (err) {
  process.stderr.write(`fake-ssh: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(255);
}

const logFile = process.env.AGENTMESH_FAKE_SSH_LOG;
if (logFile) {
  try {
    appendFileSync(
      logFile,
      `${JSON.stringify({
        at: new Date().toISOString(),
        destination,
        clientFlags,
        remoteCommand,
        program: parsed.program,
        args: parsed.args,
        cwd: parsed.cwd,
        env: parsed.env,
      })}\n`,
    );
  } catch {
    /* logging is evidence, not function */
  }
}

// stdio: 'inherit' is the whole point — this process *is* the pipe.
const child = spawn(parsed.program, parsed.args, {
  cwd: parsed.cwd || undefined,
  env: { ...process.env, ...parsed.env },
  stdio: 'inherit',
  windowsHide: true,
});

child.on('error', (err) => {
  process.stderr.write(`fake-ssh: failed to start ${parsed.program}: ${err.message}\n`);
  process.exit(255);
});
child.on('exit', (code, signal) => {
  process.exit(code === null ? (signal ? 128 : 1) : code);
});

// Forward termination so the "ssh session" dies with its parent.
for (const sig of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
  process.on(sig, () => {
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
  });
}
