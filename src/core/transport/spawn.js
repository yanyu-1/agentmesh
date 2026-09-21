/**
 * Local process transport: stdio pipes to a child process.
 *
 * This is the substrate for ACP (which is stdio-only in its stable form) when the
 * agent runs on the same machine as AgentMesh.
 *
 * @module core/transport/spawn
 */

import { spawn } from 'node:child_process';

/**
 * @typedef {object} StdioStream
 * @property {(data:string|Buffer)=>void} write
 * @property {()=>void} end
 * @property {(cb:(chunk:Buffer)=>void)=>void} onData
 * @property {(cb:(chunk:Buffer)=>void)=>void} onStderr
 * @property {(cb:(info:{code:number|null, signal:string|null})=>void)=>void} onExit
 * @property {(signal?:NodeJS.Signals)=>void} kill
 * @property {number|undefined} pid
 * @property {boolean} alive
 */

/**
 * Spawn a command and expose its stdio as a duplex stream.
 *
 * @param {object} opts
 * @param {string} opts.command
 * @param {string[]} [opts.args]
 * @param {string} [opts.cwd]
 * @param {Record<string,string>} [opts.env]
 * @param {boolean} [opts.shell]        run through a shell (needed for `.cmd`/`.bat` shims on Windows)
 * @param {string} [opts.label]         used in error messages
 * @returns {StdioStream}
 */
export function spawnProcess({ command, args = [], cwd, env, shell = false, label }) {
  const name = label || [command, ...args].join(' ');
  const child = spawn(command, args, {
    cwd: cwd || undefined,
    env: { ...process.env, ...(env || {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell,
  });

  /** @type {StdioStream} */
  const stream = {
    pid: child.pid,
    alive: true,
    write(data) {
      if (!child.stdin || child.stdin.destroyed) throw new Error(`${name}: stdin is closed`);
      child.stdin.write(data);
    },
    end() {
      try {
        child.stdin?.end();
      } catch {
        /* already gone */
      }
    },
    onData(cb) {
      child.stdout?.on('data', cb);
    },
    onStderr(cb) {
      child.stderr?.on('data', cb);
    },
    onExit(cb) {
      child.on('exit', (code, signal) => {
        stream.alive = false;
        cb({ code, signal: signal ?? null });
      });
      child.on('error', (err) => {
        stream.alive = false;
        cb({ code: null, signal: null, error: err });
      });
    },
    kill(signal = 'SIGTERM') {
      if (!stream.alive) return;
      try {
        child.kill(signal);
      } catch {
        /* ignore */
      }
    },
  };
  return stream;
}

/**
 * Wait for a process to exit, or resolve on timeout.
 * @param {StdioStream} stream
 * @param {number} timeoutMs
 * @returns {Promise<{code:number|null, signal:string|null}|null>}
 */
export function waitForExit(stream, timeoutMs) {
  return new Promise((resolve) => {
    /** @type {any} */
    let timer = null;
    if (timeoutMs > 0) timer = setTimeout(() => resolve(null), timeoutMs);
    stream.onExit((info) => {
      if (timer) clearTimeout(timer);
      resolve(info);
    });
  });
}
