/**
 * ACP adapter —?AgentMesh acts as an ACP **client**.
 *
 * Supports any agent that can serve ACP over stdio:
 *   local : spawn `hermes-acp`, `opencode acp`, `gemini --experimental-acp`, —? *   remote: `ssh host <same command>` (no inbound port needed on the server)
 *
 * Handles the bidirectional part of ACP properly:
 *   - `session/update` notifications          -> normalized MeshEvents
 *   - `session/request_permission` requests   -> policy decision, or PARKED as a
 *                                                resumable approval resource so the
 *                                                operator can answer from C later
 *   - `fs/*` and `terminal/*` requests        -> only served if we advertised the
 *                                                capability; otherwise the agent is
 *                                                told METHOD_NOT_FOUND and keeps using
 *                                                its own tools on its own machine
 *
 * @module core/adapters/acp
 */

import { JsonRpcPeer, JsonRpcError, ErrorCodes } from '../../protocol/jsonrpc.js';
import {
  ACP_PROTOCOL_VERSION,
  AGENT_METHODS,
  CLIENT_METHODS,
  PermissionPolicy,
  clientCapabilities,
  createNdJsonDecoder,
  encodeMessage,
  permissionOutcome,
  pickPermissionOption,
  summarizeUpdate,
  classifyUpdate,
  textBlock,
  stateFromStopReason,
} from '../../protocol/acp.js';
import { EventType, makeEvent } from '../../protocol/events.js';
import { newId } from '../../protocol/util.js';
import { TaskState } from '../../protocol/states.js';
import { spawnProcess } from '../transport/spawn.js';
import { sshProcess, askpassChildEnv } from '../transport/ssh.js';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const CLIENT_INFO = { name: 'agentmesh', title: 'AgentMesh Control Plane', version: '0.1.0' };

/**
 * @typedef {object} AcpAdapterOptions
 * @property {any} node                      node config (see core/registry.js)
 * @property {(ev:import('../../protocol/events.js').MeshEvent)=>void} emit
 * @property {PermissionPolicy} [permissionPolicy]
 * @property {number} [approvalTtlMs]        how long a parked approval waits before auto-cancel
 * @property {number} [promptTimeoutMs]      0 = wait forever
 * @property {number} [connectTimeoutMs]
 */

export class AcpAdapter {
  /** @type {import('../transport/spawn.js').StdioStream|null} */
  #stream = null;
  /** @type {JsonRpcPeer|null} */
  #peer = null;
  /** @type {Map<string, {taskId:string, onEvent?:(ev:any)=>void}>} */
  #sessions = new Map();
  /** @type {Map<any, {resolve:(o:any)=>void, taskId:string, sessionId:string, record:any}>} */
  #parked = new Map();
  /** @type {any} */
  #initResult = null;
  #connecting = false;

  /**
   * @param {AcpAdapterOptions} opts
   */
  constructor({ node, emit, permissionPolicy, approvalTtlMs = 15 * 60_000, promptTimeoutMs = 0, connectTimeoutMs = 30_000 }) {
    this.node = node;
    this.emit = emit;
    this.permissionPolicy = permissionPolicy || node.approvalPolicy || PermissionPolicy.DENY;
    this.approvalTtlMs = approvalTtlMs;
    this.promptTimeoutMs = promptTimeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
  }

  get connected() {
    return Boolean(this.#peer && !this.#peer.closed);
  }

  get agentInfo() {
    return this.#initResult?.agentInfo || null;
  }

  get capabilities() {
    return this.#initResult?.agentCapabilities || null;
  }

  get authMethods() {
    return Array.isArray(this.#initResult?.authMethods) ? this.#initResult.authMethods : [];
  }

  /** Parked approval requests, for `mesh approvals`. */
  listParked() {
    return [...this.#parked.values()].map((p) => p.record);
  }

  /**
   * Resolve a parked approval (called by `mesh approve`).
   * @param {any} requestId
   * @param {string|null} optionId  null => cancelled
   * @returns {boolean} whether a parked request was found
   */
  resolveApproval(requestId, optionId) {
    const entry = this.#parked.get(requestId);
    if (!entry) return false;
    this.#parked.delete(requestId);
    entry.resolve(permissionOutcome(optionId));
    this.emit(
      makeEvent({
        nodeId: this.node.id,
        taskId: entry.taskId,
        type: EventType.APPROVAL_RESOLVED,
        text: optionId ? `approved (${optionId})` : 'denied / cancelled',
        data: { requestId, optionId, approvalId: entry.record.id },
      }),
    );
    return true;
  }

  /**
   * Start the agent process and complete the ACP handshake.
   * @param {{initialize?:boolean}} [opts]
   */
  async connect({ initialize = true } = {}) {
    if (this.connected) return this.#initResult;
    if (this.#connecting) throw new Error(`node '${this.node.name}' is already connecting`);
    this.#connecting = true;
    try {
      // Bind the handlers to THIS connection, not to `this.#stream`/`this.#peer`.
      // A superseded connection can report its exit after the next connect() has
      // already installed a fresh peer — and because the old exit handler used to
      // close whatever `this.#peer` happened to be, `probe()` (which kills its
      // throwaway process) would SIGTERM the connection that replaced it. That made
      // "probe a node, then send to it" in the same process — i.e. the Web console —
      // fail with `closed: process exited (signal=SIGTERM)`.
      const stream = (this.#stream = this.#startProcess());

      const peer = (this.#peer = new JsonRpcPeer({
        name: `acp:${this.node.name}`,
        defaultTimeoutMs: 0,
        send: (msg) => {
          stream.write(encodeMessage(msg));
        },
        onError: (err) => this.#log(`peer error: ${err.message}`),
      }));

      const decoder = createNdJsonDecoder(
        (msg) => (this.#peer === peer ? peer.accept(msg) : undefined),
        (err, line) => this.#log(`undecodable stdout line (${err.message}): ${line.slice(0, 200)}`),
      );

      stream.onData((chunk) => decoder.push(chunk));
      // Keep the tail of stderr so a failed connect can say WHY. Without this,
      // `mesh probe nas` reported only `process exited (code=255)` while ssh had already
      // explained the problem (`banner exchange: Connection to UNKNOWN port -1:
      // Connection refused` — the node had no port, so ssh used 22). The console showed
      // the lines because they are also forwarded as events; the CLI showed nothing.
      const stderrTail = [];
      stream.onStderr((chunk) => {
        const text = chunk.toString('utf8').trimEnd();
        if (!text) return;
        stderrTail.push(...text.split('\n'));
        while (stderrTail.length > 8) stderrTail.shift();
        this.#log(text.split('\n').slice(-3).join('\n'));
      });
      stream.onExit(({ code, signal, error }) => {
        // This stream is no longer the live one: it belongs to a connection that was
        // already replaced (or deliberately torn down). Its exit must not touch the
        // current peer.
        if (this.#stream !== stream) return;
        const base = error ? error.message : `process exited (code=${code}${signal ? `, signal=${signal}` : ''})`;
        const detail = stderrTail.join('\n').trim();
        const reason = detail ? `${base}\n${detail}` : base;
        peer.close(reason);
        // Anything still parked can never be answered now.
        for (const [id, entry] of this.#parked) {
          entry.resolve(permissionOutcome(null));
          this.#parked.delete(id);
          this.emit(
            makeEvent({
              nodeId: this.node.id,
              taskId: entry.taskId,
              type: EventType.APPROVAL_RESOLVED,
              text: 'agent exited while approval was pending',
              data: { approvalId: entry.record.id, requestId: id, optionId: null },
            }),
          );
        }
        this.#log(reason);
      });

      this.#registerHandlers();

      if (!initialize) return null;
      return await this.initialize();
    } finally {
      this.#connecting = false;
    }
  }

  /** @returns {import('../transport/spawn.js').StdioStream} */
  #startProcess() {
    const node = this.node;
    const command = node.command;
    if (!command) throw new Error(`node '${node.name}' has no command configured for ACP`);
    const env = { ...(node.env || {}) };
    if (node.local === false || node.ssh) {
      if (!node.ssh) throw new Error(`node '${node.name}' has no ssh target configured`);
      return sshProcess({
        target: node.ssh,
        command,
        args: node.args || [],
        cwd: node.cwd || '',
        // Node env must travel with the remote command: over SSH there is no way to
        // hand the child a private environment, so it is folded into the command line.
        env,
        batchMode: node.ssh.batchMode !== false,
        // ...whereas the SSH password belongs to the ssh CLIENT process only.
        childEnv: askpassChildEnv(node.ssh),
      });
    }
    return spawnProcess({
      command,
      args: node.args || [],
      cwd: node.cwd || undefined,
      env,
      // Windows: `gemini`/`hermes` may be .cmd shims that need a shell.
      shell: Boolean(node.shell),
      label: `${node.name}: ${command}`,
    });
  }

  #registerHandlers() {
    const peer = this.#peer;
    if (!peer) return;

    peer.onNotification(CLIENT_METHODS.SESSION_UPDATE, (params) => {
      const sessionId = String(params?.sessionId ?? '');
      const ctx = this.#sessions.get(sessionId);
      const update = params?.update ?? {};
      const cls = classifyUpdate(update);
      const summary = summarizeUpdate(update);

      /** @type {string} */
      let type = EventType.LOG;
      switch (cls.kind) {
        case 'agent_message_chunk':
          type = EventType.CHUNK;
          break;
        case 'agent_thought_chunk':
          type = EventType.THOUGHT;
          break;
        case 'tool_call':
          type = EventType.TOOL_CALL;
          break;
        case 'tool_call_update':
          type = EventType.TOOL_UPDATE;
          break;
        case 'plan':
          type = EventType.PLAN;
          break;
        case 'usage_update':
          type = EventType.USAGE;
          break;
        default:
          type = EventType.LOG;
      }

      const ev = makeEvent({
        nodeId: this.node.id,
        taskId: ctx?.taskId ?? null,
        type,
        text: summary ?? cls.text ?? '',
        data: { sessionId, updateKind: cls.kind, toolCallId: cls.toolCallId, status: cls.status, raw: update },
      });
      this.emit(ev);
    });

    peer.onRequest(CLIENT_METHODS.SESSION_REQUEST_PERMISSION, (params, ctx) => this.#handlePermission(params, ctx));

    if (this.node.clientFs) {
      peer.onRequest(CLIENT_METHODS.FS_READ_TEXT_FILE, async (params) => this.#readTextFile(params));
      peer.onRequest(CLIENT_METHODS.FS_WRITE_TEXT_FILE, async (params) => this.#writeTextFile(params));
    }
  }

  /**
   * The heart of remote approvals: either answer immediately per policy, or park
   * the request as a resumable resource (returning a promise we resolve later).
   * @param {any} params
   * @param {{id:any, method:string}} ctx
   */
  async #handlePermission(params, ctx) {
    const sessionId = String(params?.sessionId ?? '');
    const session = this.#sessions.get(sessionId);
    const taskId = session?.taskId ?? null;
    const options = Array.isArray(params?.options) ? params.options : [];
    const toolCall = params?.toolCall || {};
    const decision = pickPermissionOption(options, /** @type {any} */ (this.permissionPolicy));

    const record = {
      // The approval id MUST be globally unique, NOT derived from `ctx.id`. JSON-RPC
      // request ids restart from the same base in every process, so an id like
      // `appr_0` collides with a historical row from an earlier run —?and that
      // collision silently hides the new approval (the operator sees "no pending
      // approvals" while the agent sits blocked waiting). `requestId` stays the
      // routing key back to the live JSON-RPC request.
      id: newId('appr'),
      requestId: ctx.id,
      nodeId: this.node.id,
      taskId,
      sessionId,
      title: String(toolCall.title ?? toolCall.toolCallId ?? 'tool call'),
      toolCallId: toolCall.toolCallId ?? null,
      options,
      policy: this.permissionPolicy,
      requestedAt: new Date().toISOString(),
    };

    if (decision.optionId) {
      // Policy already decided —?answer now, no operator round-trip.
      const ev = makeEvent({
        nodeId: this.node.id,
        taskId,
        type: EventType.APPROVAL_RESOLVED,
        text: `auto ${decision.kind}: ${record.title}`,
        data: { ...record, optionId: decision.optionId, auto: true },
      });
      this.emit(ev);
      return permissionOutcome(decision.optionId);
    }

    // Park it: the JSON-RPC response stays open until someone answers.
    const ev = makeEvent({
      nodeId: this.node.id,
      taskId,
      type: EventType.APPROVAL_REQUESTED,
      text: `needs approval: ${record.title}`,
      data: record,
    });
    this.emit(ev);

    return new Promise((resolve) => {
      this.#parked.set(ctx.id, { resolve, taskId: taskId ?? '', sessionId, record });
      if (this.approvalTtlMs > 0) {
        const timer = setTimeout(() => {
          if (this.#parked.has(ctx.id)) {
            this.#parked.delete(ctx.id);
            resolve(permissionOutcome(null));
            const to = makeEvent({
              nodeId: this.node.id,
              taskId,
              type: EventType.APPROVAL_RESOLVED,
              text: `approval timed out after ${Math.round(this.approvalTtlMs / 1000)}s`,
              data: { ...record, optionId: null, timeout: true },
            });
            this.emit(to);
          }
        }, this.approvalTtlMs);
        if (typeof timer.unref === 'function') timer.unref();
      }
    });
  }

  /**
   * `fs/read_text_file` —?only reachable when the node opted into clientFs.
   * @param {any} params
   */
  async #readTextFile(params) {
    const path = this.#resolveClientPath(params?.path);
    const raw = await readFile(path, 'utf8');
    const line = params?.line;
    const limit = params?.limit;
    if (typeof line === 'number' || typeof limit === 'number') {
      const lines = raw.split('\n');
      const start = Math.max(0, (line ?? 1) - 1);
      const end = typeof limit === 'number' ? start + limit : lines.length;
      return { content: lines.slice(start, end).join('\n') };
    }
    return { content: raw };
  }

  /**
   * `fs/write_text_file` —?refused unless the node opted in.
   * @param {any} params
   */
  async #writeTextFile(params) {
    const path = this.#resolveClientPath(params?.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, String(params?.content ?? ''), 'utf8');
    return null;
  }

  /**
   * Resolve a client-side path, refusing anything outside the configured root.
   * @param {any} p
   * @returns {string}
   */
  #resolveClientPath(p) {
    const root = resolve(this.node.clientRoot || this.node.cwd || process.cwd());
    const target = resolve(root, String(p ?? ''));
    const rel = relative(root, target);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new JsonRpcError(ErrorCodes.INVALID_PARAMS, `path outside client root: ${p}`);
    }
    return target;
  }

  /**
   * Perform the ACP `initialize` handshake.
   * @param {{authMethodId?:string}} [opts]
   */
  async initialize(opts = {}) {
    const peer = this.#peer;
    if (!peer) throw new Error('not connected');
    const result = await peer.request(
      AGENT_METHODS.INITIALIZE,
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: clientCapabilities({
          fs: Boolean(this.node.clientFs),
          terminal: Boolean(this.node.clientTerminal),
        }),
        clientInfo: CLIENT_INFO,
      },
      { timeoutMs: this.connectTimeoutMs },
    );
    this.#initResult = result || {};
    const negotiated = Number(result?.protocolVersion ?? 0);
    if (negotiated && negotiated !== ACP_PROTOCOL_VERSION) {
      throw new Error(
        `agent '${this.node.name}' negotiated ACP protocol version ${negotiated}, but this client implements version ${ACP_PROTOCOL_VERSION}`,
      );
    }
    if (opts.authMethodId) await this.authenticate(opts.authMethodId);
    return this.#initResult;
  }

  /**
   * @param {string} methodId
   */
  async authenticate(methodId) {
    const peer = this.#peer;
    if (!peer) throw new Error('not connected');
    return peer.request(AGENT_METHODS.AUTHENTICATE, { methodId }, { timeoutMs: this.connectTimeoutMs });
  }

  /**
   * Run `initialize` on a throwaway connection to report node capability
   * (`mesh probe`). Keeps the connection open on success so the caller can close it.
   */
  async probe() {
    await this.connect();
    const out = {
      connected: true,
      protocolVersion: this.#initResult?.protocolVersion ?? null,
      agentInfo: this.agentInfo,
      capabilities: this.capabilities,
      authMethods: this.authMethods,
    };
    await this.disconnect('probe complete');
    return out;
  }

  /**
   * Create a session.
   * @param {{cwd?:string, additionalDirectories?:string[], mcpServers?:any[]}} [opts]
   * @returns {Promise<string>} sessionId
   */
  async newSession(opts = {}) {
    const peer = this.#peer;
    if (!peer) throw new Error('not connected');
    const cwd = opts.cwd || this.node.cwd || process.cwd();
    const result = await peer.request(
      AGENT_METHODS.SESSION_NEW,
      { cwd, mcpServers: opts.mcpServers || [], ...(opts.additionalDirectories ? { additionalDirectories: opts.additionalDirectories } : {}) },
      { timeoutMs: this.connectTimeoutMs },
    );
    const sessionId = String(result?.sessionId ?? '');
    if (!sessionId) throw new Error(`agent '${this.node.name}' returned no sessionId`);
    this.#sessions.set(sessionId, { taskId: '', onEvent: undefined });
    return sessionId;
  }

  /**
   * Resume a previously created session (`session/load`), when the agent supports it.
   * @param {{sessionId:string, cwd?:string, mcpServers?:any[]}} opts
   */
  async loadSession({ sessionId, cwd, mcpServers }) {
    const peer = this.#peer;
    if (!peer) throw new Error('not connected');
    const result = await peer.request(
      AGENT_METHODS.SESSION_LOAD,
      { sessionId, cwd: cwd || this.node.cwd || process.cwd(), mcpServers: mcpServers || [] },
      { timeoutMs: this.connectTimeoutMs },
    );
    this.#sessions.set(sessionId, { taskId: '', onEvent: undefined });
    return result;
  }

  /**
   * Send one prompt and wait for the turn to finish.
   *
   * @param {object} opts
   * @param {string} opts.text
   * @param {string} [opts.sessionId]     omit to create a new session
   * @param {string} [opts.cwd]
   * @param {string} [opts.taskId]        used to tag emitted events
   * @param {(ev:any)=>void} [opts.onEvent]
   * @param {AbortSignal} [opts.signal]
   * @param {number} [opts.timeoutMs]
   * @returns {Promise<{sessionId:string, stopReason:string, state:string}>}
   */
  async prompt({ text, sessionId, cwd, taskId, onEvent, signal, timeoutMs }) {
    await this.connect();
    const peer = this.#peer;
    if (!peer) throw new Error('not connected');

    const sid = sessionId || (await this.newSession({ cwd }));
    this.#sessions.set(sid, { taskId: taskId ?? '', onEvent });

    const result = await peer.request(
      AGENT_METHODS.SESSION_PROMPT,
      { sessionId: sid, prompt: [textBlock(text)] },
      { signal, timeoutMs: timeoutMs ?? this.promptTimeoutMs },
    );

    const stopReason = String(result?.stopReason ?? 'end_turn');
    return { sessionId: sid, stopReason, state: stateFromStopReason(stopReason) };
  }

  /**
   * Ask the agent to abort the current turn.
   * @param {string} sessionId
   */
  async cancel(sessionId) {
    await this.#peer?.notify(AGENT_METHODS.SESSION_CANCEL, { sessionId });
  }

  /**
   * @param {string} sessionId
   * @param {string} modeId
   */
  async setMode(sessionId, modeId) {
    return this.#peer?.request(AGENT_METHODS.SESSION_SET_MODE, { sessionId, modeId }, { timeoutMs: this.connectTimeoutMs });
  }

  /**
   * Close the connection and stop the agent process.
   * @param {string} [reason]
   */
  async disconnect(reason = 'client closed') {
    const stream = this.#stream;
    this.#stream = null;
    this.#peer?.close(reason);
    this.#peer = null;
    this.#sessions.clear();
    if (stream) {
      stream.end();
      stream.kill();
    }
  }

  /**
   * @param {string} line
   */
  #log(line) {
    this.emit(makeEvent({ nodeId: this.node.id, type: EventType.LOG, text: line, data: { source: 'acp' } }));
  }
}
