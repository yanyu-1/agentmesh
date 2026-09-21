#!/usr/bin/env node
/**
 * ssh-askpass — run a real ssh client that may need a password, WITHOUT letting the
 * secret leak into the caller's environment.
 *
 * Why a wrapper is needed
 * -----------------------
 * OpenSSH can take a password from a helper program instead of the terminal, but the
 * helper path is a single token: `SSH_ASKPASS` cannot carry arguments. On Windows the
 * only universally present interpreter is node.exe, and ssh would pass it the prompt
 * string as if it were a script name. The way out is to preload a tiny CommonJS file
 * that prints the secret and exits before node ever loads that "script":
 *
 *     SSH_ASKPASS=<node.exe>
 *     NODE_OPTIONS=--require <askpass.cjs>
 *
 * But `NODE_OPTIONS` is inherited by every node process below whoever sets it. Export
 * it in the shell and the AgentMesh CLI itself would preload the helper and print the
 * password to its own stdout. So it must be scoped to the ssh child alone — which is
 * exactly what this wrapper does. Point a node at it with:
 *
 *     mesh node add nas --ssh 10.0.0.9 --ssh-user me --ssh-port 2222 \
 *       --ssh-batch-mode no \
 *       --ssh-binary "<node.exe>" \
 *       --ssh-binary-arg "<this file>" \
 *       --ssh-binary-arg "<real ssh.exe>"
 *
 * The secret is read from MESH_ASKPASS_SECRET (or the file named by
 * MESH_ASKPASS_SECRET_FILE) and exists only in memory and in this process's
 * environment — never in nodes.json.
 *
 * Usage: node ssh-askpass.mjs <real-ssh> [ssh args...]
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const [realSsh, ...sshArgs] = process.argv.slice(2);

if (!realSsh) {
  process.stderr.write('ssh-askpass: usage: node ssh-askpass.mjs <real-ssh> [ssh args...]\n');
  process.exit(2);
}

let secret = process.env.MESH_ASKPASS_SECRET ?? '';
if (!secret && process.env.MESH_ASKPASS_SECRET_FILE) {
  try {
    secret = readFileSync(process.env.MESH_ASKPASS_SECRET_FILE, 'utf8').replace(/\r?\n$/, '');
  } catch (err) {
    process.stderr.write(`ssh-askpass: cannot read MESH_ASKPASS_SECRET_FILE: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
if (!secret) {
  process.stderr.write('ssh-askpass: no secret — set MESH_ASKPASS_SECRET or MESH_ASKPASS_SECRET_FILE\n');
  process.exit(2);
}

const helper = fileURLToPath(new URL('./askpass.cjs', import.meta.url));

const child = spawn(realSsh, sshArgs, {
  stdio: 'inherit', // ssh must inherit the ACP pipes; a password prompt never reads stdin
  env: {
    ...process.env,
    SSH_ASKPASS: process.execPath, // ssh runs THIS node as the helper
    SSH_ASKPASS_REQUIRE: 'force', // ...even with no DISPLAY and no tty
    NODE_OPTIONS: `--require ${JSON.stringify(helper)}`, // scoped to the helper only
    MESH_ASKPASS_SECRET: secret,
  },
});

child.on('error', (err) => {
  process.stderr.write(`ssh-askpass: cannot run ${path.basename(realSsh)}: ${err.message}\n`);
  process.exit(127);
});
child.on('exit', (code, signal) => {
  process.exit(signal ? 128 : code ?? 1);
});
