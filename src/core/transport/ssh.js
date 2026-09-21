/**
 * SSH transport: run a command on a remote host and speak a stdio protocol
 * through it.
 *
 * This is the piece that makes AgentMesh work without opening ANY inbound port on
 * the managed servers: `ssh host <agent> acp` gives us a bidirectional stdio pipe,
 * which is exactly what ACP needs (ACP v1's only stable transport is stdio).
 *
 * @module core/transport/ssh
 */

import { spawnProcess } from './spawn.js';

/**
 * Quote a single shell word for POSIX `sh`.
 * @param {string} word
 * @returns {string}
 */
export function shellQuote(word) {
  if (word === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build a POSIX command line to hand to `ssh host <cmdline>`.
 *
 * Always uses `exec` so the remote shell is *replaced* by the agent: without it a
 * wrapper shell survives, signals do not reach the agent, and killing the SSH
 * session can orphan it.
 *
 * Environment variables are applied through `env` (not a bare `VAR=x` prefix)
 * because a plain assignment would bind to `cd`, not to the agent:
 * `cd /srv && exec A=1 hermes-acp` and `A=1 cd /srv && exec ...` are both wrong.
 *
 * @param {string} command
 * @param {string[]} [args]
 * @param {string} [cwd]
 * @param {Record<string,string>} [env]
 * @returns {string}
 */
export function buildRemoteCommand(command, args = [], cwd = '', env = {}) {
  return buildRawRemoteCommand([command, ...args].map(shellQuote).join(' '), cwd, env);
}

/**
 * Build a POSIX command line from an ALREADY-FORMED shell line.
 *
 * `buildRemoteCommand` quotes each word, which is right when the caller holds a
 * program plus argv. Handing it a line like `hermes --version` instead produced
 * `exec 'hermes --version'` — one impossible program name, exit 127. Callers that
 * pass a shell line (one-shot remote commands) must come through here so the line
 * keeps its spaces; only `env` assignments and `cwd` are quoted.
 *
 * @param {string} commandLine
 * @param {string} [cwd]
 * @param {Record<string,string>} [env]
 * @returns {string}
 */
export function buildRawRemoteCommand(commandLine, cwd = '', env = {}) {
  const assignments = Object.entries(env || {}).map(([k, v]) => shellQuote(`${k}=${v}`));
  const withEnv = assignments.length ? `env ${assignments.join(' ')} ${commandLine}` : commandLine;
  if (!cwd) return `exec ${withEnv}`;
  return `cd ${shellQuote(cwd)} && exec ${withEnv}`;
}

/**
 * Build a remote command for a ONE-SHOT shell line.
 *
 * The agent path deliberately uses `exec` (the remote shell is replaced by the agent so
 * signals reach it). That is actively wrong for a one-shot line: `exec a; b` replaces
 * the shell with `a`, so every statement after the first `;`/`&&` silently never runs —
 * `sshExec({command: 'md5sum f; cat f'})` reported only the md5sum and looked like a
 * success. The line goes through `sh -c` instead, which keeps `;`, `&&`, pipes and
 * redirections working and makes `cwd`/`env` apply to the whole line rather than to its
 * first command only.
 *
 * @param {string} commandLine
 * @param {string} [cwd]
 * @param {Record<string,string>} [env]
 * @returns {string}
 */
export function buildShellRemoteCommand(commandLine, cwd = '', env = {}) {
  const assignments = Object.entries(env || {}).map(([k, v]) => shellQuote(`${k}=${v}`));
  const wrapped = `sh -c ${shellQuote(commandLine)}`;
  const withEnv = assignments.length ? `env ${assignments.join(' ')} ${wrapped}` : wrapped;
  if (!cwd) return withEnv;
  return `cd ${shellQuote(cwd)} && ${withEnv}`;
}

/**
 * @typedef {object} SshTarget
 * @property {string} host
 * @property {string} [user]
 * @property {number} [port]
 * @property {string} [identityFile]
 * @property {string[]} [extraOptions]
 * @property {string} [binary]       ssh executable to use instead of the auto-detected one
 * @property {string[]} [binaryArgs] args to place BEFORE the ssh args (alternate ssh/placer tools)
 */

/**
 * @param {SshTarget} target
 * @returns {string}
 */
export function sshDestination({ host, user }) {
  return user ? `${user}@${host}` : host;
}

/**
 * Build the `ssh` argv for a target plus remote command.
 * @param {SshTarget} target
 * @param {string} remoteCommand
 * @param {{batchMode?:boolean, connectTimeoutSec?:number}} [opts]
 * @returns {string[]}
 */
export function buildSshArgs(target, remoteCommand, opts = {}) {
  const args = [];
  if (opts.batchMode !== false) args.push('-o', 'BatchMode=yes');
  args.push('-o', `ConnectTimeout=${opts.connectTimeoutSec ?? 10}`);
  // Keep the pipe clean: no TTY, no local echo.
  args.push('-T');
  if (target.port) args.push('-p', String(target.port));
  if (target.identityFile) args.push('-i', target.identityFile);
  for (const opt of target.extraOptions || []) args.push('-o', opt);
  args.push(sshDestination(target), remoteCommand);
  return args;
}

/**
 * Locate the `ssh` binary. Native Windows ships one under System32\OpenSSH.
 *
 * @param {string} [override] explicit binary (per-node), wins over the environment
 * @returns {string}
 */
export function findSshBinary(override) {
  if (override) return override;
  if (process.env.AGENTMESH_SSH) return process.env.AGENTMESH_SSH;
  if (process.platform === 'win32') {
    const candidate = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\OpenSSH\\ssh.exe`;
    return candidate;
  }
  return 'ssh';
}

/**
 * Reject a Windows batch-file "ssh".
 *
 * A `.cmd`/`.bat` cannot be spawned at all without `shell: true` (Node raises
 * EINVAL), and with `shell: true` cmd.exe re-splits the argument vector: `-o
 * BatchMode=yes` arrives as two arguments and the remote command is chopped at the
 * first space, with `&&` executed locally. That silently corrupts every remote
 * command, so it is refused loudly instead.
 *
 * @param {string} binary
 */
function assertSpawnableSsh(binary) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary)) {
    throw new Error(
      `refusing to use '${binary}' as the ssh binary: Windows batch files must run through cmd.exe, ` +
        'which re-splits the argument vector and would corrupt the remote command. ' +
        'Point AGENTMESH_SSH (or ssh.binary) at a real executable such as ssh.exe or plink.exe.',
    );
  }
}

/**
 * Start a remote stdio process over SSH.
 *
 * @param {object} opts
 * @param {SshTarget} opts.target
 * @param {string} opts.command          remote command, e.g. `hermes-acp`
 * @param {string[]} [opts.args]
 * @param {string} [opts.cwd]            remote working directory
 * @param {Record<string,string>} [opts.env]  environment for the remote process
 * @param {boolean} [opts.batchMode]     default true (never prompt for a password)
 * @param {Record<string,string>} [opts.childEnv] environment for the ssh CLIENT process
 *   itself (as opposed to `env`, which travels to the remote command). This is how an
 *   SSH password reaches `tools/ssh-askpass.mjs` via MESH_ASKPASS_SECRET without ever
 *   being written to a config file or exported into the control plane's own environment.
 * @param {string} [opts.remoteCommand]  pre-built remote command line, used verbatim.
 *   Callers that hold a shell LINE (see `buildRawRemoteCommand`) must pass it here:
 *   routing it through `command` would word-quote the whole line into one impossible
 *   program name.
 * @returns {import('./spawn.js').StdioStream}
 */
export function sshProcess({ target, command, args = [], cwd = '', env = {}, batchMode = true, remoteCommand: preset, childEnv = {} }) {
  const remoteCommand = preset ?? buildRemoteCommand(command, args, cwd, env);
  const sshArgs = buildSshArgs(target, remoteCommand, { batchMode });
  const binary = findSshBinary(target.binary);
  assertSpawnableSsh(binary);
  const leading = target.binaryArgs || [];
  return spawnProcess({
    command: binary,
    // Leading args let an alternate client (plink, a jump-host wrapper) be used
    // without pretending it is OpenSSH.
    args: [...leading, ...sshArgs],
    env: childEnv,
    label: `ssh ${sshDestination(target)} ${remoteCommand}`,
  });
}

/**
 * The env an ssh client needs so that a password-only host can be answered without the
 * secret touching stdin (which is the ACP protocol pipe) or any file.
 *
 * Returns `{}` when there is no password, so the default `BatchMode=yes` path stays
 * exactly as strict as before.
 *
 * @param {SshTarget & {password?:string}} target
 * @returns {Record<string,string>}
 */
export function askpassChildEnv(target) {
  const password = target?.password;
  if (!password) return {};
  // The wrapper (tools/ssh-askpass.mjs) reads this and re-exports it to the askpass
  // helper, scoped to the ssh child. Setting it here — per spawn — means two nodes with
  // different passwords cannot bleed into each other, and nothing leaks to the caller.
  return { MESH_ASKPASS_SECRET: password };
}

/**
 * Run a one-shot remote command and collect its output (used by `mesh node check`
 * and by `cli`-transport probes).
 *
 * `command` is a POSIX **shell line**, not a program path — callers pass things like
 * `${node.command} --version`. It is deliberately not word-quoted; see
 * `buildRawRemoteCommand`.
 *
 * @param {object} opts
 * @param {SshTarget} opts.target
 * @param {string} opts.command
 * @param {string} [opts.cwd]
 * @param {Record<string,string>} [opts.env]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{code:number|null, stdout:string, stderr:string}>}
 */
export function sshExec({ target, command, cwd = '', env = {}, timeoutMs = 20_000, childEnv }) {
  return new Promise((resolve) => {
    // Honour the target's own auth mode: hardcoding `true` here made every one-shot
    // remote command (e.g. `mesh node check`) fail on password-only nodes, even when
    // the node was registered with batchMode:false.
    const stream = sshProcess({
      target,
      remoteCommand: buildShellRemoteCommand(command, cwd, env),
      batchMode: target.batchMode !== false,
      childEnv: childEnv ?? askpassChildEnv(target),
    });
    let stdout = '';
    let stderr = '';
    stream.onData((c) => {
      stdout += c.toString('utf8');
    });
    stream.onStderr((c) => {
      stderr += c.toString('utf8');
    });
    /** @type {any} */
    let timer = setTimeout(() => {
      stream.kill();
      resolve({ code: null, stdout, stderr: stderr + '\n[timeout]' });
    }, timeoutMs);
    stream.onExit(({ code }) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
