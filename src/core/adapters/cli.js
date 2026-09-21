/**
 * CLI adapter —?the lowest common denominator.
 *
 * For agents that expose neither ACP nor A2A nor an HTTP server, AgentMesh can
 * still drive them as a one-shot command, locally or over SSH:
 *
 *   local : `<command> <args> "<prompt>"`
 *   remote: `ssh host '<command> <args> "prompt"'`
 *
 * stdout becomes a stream of `chunk` events; the exit code decides completed/failed.
 * It cannot answer permission prompts (there is no channel), which is exactly why
 * ACP/A2A nodes are preferable.
 *
 * @module core/adapters/cli
 */

import { EventType, makeEvent } from '../../protocol/events.js';
import { TaskState } from '../../protocol/states.js';
import { spawnProcess } from '../transport/spawn.js';
import { sshProcess, sshExec, askpassChildEnv } from '../transport/ssh.js';

export class CliAdapter {
  /**
   * @param {{node:any, emit:(ev:any)=>void}} opts
   */
  constructor({ node, emit }) {
    this.node = node;
    this.emit = emit;
  }

  /**
   * Build argv for the node's command, substituting the prompt.
   * Supported placeholders in `node.args`: `{prompt}`.
   * @param {string} prompt
   * @returns {string[]}
   */
  #argv(prompt) {
    const node = this.node;
    const template = Array.isArray(node.args) ? node.args : [];
    const hasPlaceholder = template.some((a) => String(a).includes('{prompt}'));
    const args = template.map((a) => String(a).replace('{prompt}', prompt));
    if (!hasPlaceholder && node.promptVia !== 'stdin') args.push(prompt);
    return args;
  }

  /**
   * @param {string} command
   */
  async #exec(command, timeoutMs = 20_000) {
    if (this.node.ssh && this.node.local !== true) {
      return sshExec({ target: this.node.ssh, command, timeoutMs, childEnv: askpassChildEnv(this.node.ssh) });
    }
    return new Promise((/** @type {any} */ resolve) => {
      const stream = spawnProcess({ command, args: [], cwd: this.node.cwd, shell: true, label: `${this.node.name}: ${command}` });
      let stdout = '';
      let stderr = '';
      stream.onData((c) => {
        stdout += c.toString('utf8');
      });
      stream.onStderr((c) => {
        stderr += c.toString('utf8');
      });
      const timer = setTimeout(() => {
        stream.kill();
        resolve({ code: null, stdout, stderr: `${stderr}\n[timeout]` });
      }, timeoutMs);
      stream.onExit(({ code }) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  }

  async probe() {
    const versionCmd = this.node.versionCommand || `${this.node.command} --version`;
    const res = await this.#exec(versionCmd, 20_000);
    return {
      transport: 'cli',
      reachable: res.code === 0,
      command: this.node.command,
      version: (res.stdout || res.stderr).trim().split('\n')[0] || '(no output)',
      exitCode: res.code,
    };
  }

  /**
   * @param {{text:string, taskId?:string, onEvent?:(ev:any)=>void, signal?:AbortSignal, timeoutMs?:number}} opts
   */
  async send({ text, taskId, onEvent, signal, timeoutMs }) {
    const node = this.node;
    if (!node.command) throw new Error(`node '${node.name}' has no command configured`);
    const args = this.#argv(text);

    /** @type {ReturnType<typeof spawnProcess>} */
    const stream =
      node.ssh && node.local !== true
        ? sshProcess({ target: node.ssh, command: node.command, args, cwd: node.cwd || '' })
        : spawnProcess({
            command: node.command,
            args,
            cwd: node.cwd,
            env: node.env,
            shell: Boolean(node.shell),
            label: `${node.name}: ${node.command}`,
          });

    const onAbort = () => stream.kill();
    if (signal) {
      if (signal.aborted) stream.kill();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    if (node.promptVia === 'stdin') stream.write(text.endsWith('\n') ? text : `${text}\n`);

    let stdout = '';
    /** @type {{code:number|null, signal:string|null, error?:Error}|null} */
    let exit = null;

    stream.onData((c) => {
      const chunk = c.toString('utf8');
      stdout += chunk;
      const ev = makeEvent({ nodeId: node.id, taskId: taskId ?? null, type: EventType.CHUNK, text: chunk });
      this.emit(ev);
    });
    stream.onStderr((c) => {
      const text2 = c.toString('utf8').trimEnd();
      if (!text2) return;
      const ev = makeEvent({ nodeId: node.id, taskId: taskId ?? null, type: EventType.LOG, text: text2 });
      this.emit(ev);
    });

    /** @type {Promise<void>} */
    const done = new Promise((resolve) => {
      stream.onExit((info) => {
        exit = info;
        resolve();
      });
    });

    /** @type {any} */
    let timer = null;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => stream.kill(), timeoutMs);
    }
    await done;
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);

    const code = exit ? /** @type {any} */ (exit).code : null;
    const state = code === 0 ? TaskState.COMPLETED : TaskState.FAILED;
    if (state === TaskState.FAILED) {
      const msg = exit && /** @type {any} */ (exit).error ? String(/** @type {any} */ (exit).error.message) : `exited with code ${code}`;
      const ev = makeEvent({ nodeId: node.id, taskId: taskId ?? null, type: EventType.ERROR, text: msg, data: { exitCode: code } });
      this.emit(ev);
    }
    return { state, text: stdout.trim(), contextId: null, remoteTaskId: null };
  }

  async disconnect() {}
}
