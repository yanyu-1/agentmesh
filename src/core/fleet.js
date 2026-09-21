/**
 * Fleet — dispatch, fan-out, aggregation and approval routing.
 *
 * This is the layer that makes heterogeneous nodes feel like one system:
 * whichever adapter a node uses, the caller gets the same task record, the same
 * event stream, and the same state machine.
 *
 * @module core/fleet
 */

import { Registry } from './registry.js';
import { Store } from './store.js';
import { AcpAdapter } from './adapters/acp.js';
import { A2aAdapter } from './adapters/a2a.js';
import { OpencodeAdapter } from './adapters/opencode.js';
import { CliAdapter } from './adapters/cli.js';
import { EventType, makeEvent } from '../protocol/events.js';
import { TaskState, isTerminal, WAITING_STATES } from '../protocol/states.js';
import { PermissionPolicy } from '../protocol/acp.js';
import { errLine } from '../protocol/util.js';

/**
 * @typedef {object} SendOptions
 * @property {string} nodeRef
 * @property {string} prompt
 * @property {boolean} [continueSession]  reuse the node's last session/context
 * @property {boolean} [replayHistory]    also send the prior turns, for peers that keep no server-side context
 * @property {boolean} [shareContext]     also send recent turns from OTHER nodes
 * @property {number} [shareLimit]        how many of those turns (default 6)
 * @property {string} [cwd]
 * @property {boolean} [stream]
 * @property {boolean} [quiet]
 * @property {AbortSignal} [signal]
 * @property {number} [timeoutMs]
 * @property {(ev:any)=>void} [onEvent]
 * @property {PermissionPolicy} [permissionPolicy]
 */

/**
 * Render other nodes' recent turns as a block to prepend to the outbound text.
 *
 * Two things matter for this not to make things worse. It is **fenced** on both sides and says
 * plainly that it is not the peer's own history, because the failure mode of a transcript is the
 * model treating another agent's answer as its own and skipping the work. And each field is
 * **truncated**, because one large result would otherwise push the actual request out of context
 * — the request is at the end, after the fenced block, so the peer always reads it last.
 *
 * @param {{nodeId:string, prompt:string, result:string}[]} turns
 * @param {Registry} registry
 * @returns {string}
 */
function formatSharedContext(turns, registry) {
  /** @param {string} s @param {number} max */
  const clip = (s, max) => {
    const one = String(s).replace(/\s+/g, ' ').trim();
    return one.length > max ? `${one.slice(0, max)}…` : one;
  };
  /** @param {string} id */
  const nameOf = (id) => {
    try {
      return registry.get(id)?.name ?? id;
    } catch {
      return id;
    }
  };
  const lines = [
    '[Shared context from AgentMesh — recent work by OTHER agents, not your own conversation]',
    '',
  ];
  for (const t of turns) {
    const name = nameOf(t.nodeId);
    lines.push(`${name} was asked: ${clip(t.prompt, 400)}`);
    lines.push(`${name} answered: ${clip(t.result, 800)}`);
    lines.push('');
  }
  lines.push('[End of shared context. Your own task follows.]');
  lines.push('');
  return lines.join('\n');
}

export class Fleet {
  /**
   * @param {{registry?:Registry, store?:Store}} [opts]
   */
  constructor({ registry, store } = {}) {
    this.registry = registry || new Registry();
    this.store = store || new Store();
    /** @type {Map<string, any>} */
    this.adapters = new Map();
    /** @type {Set<(ev:any)=>void>} */
    this.listeners = new Set();
    /**
     * Per-send event sinks, keyed by task id.
     *
     * This is the *only* way an event reaches the callback a caller passed to
     * `send()`. Adapters used to forward to it directly as well, which meant events
     * the Fleet itself emits — task-created, task-state, done, error — never reached
     * the caller at all: `mesh send --json` produced a stream with no terminal event,
     * so a consumer could not tell a run had finished, let alone how.
     *
     * @type {Map<string, (ev:any)=>void>}
     */
    this.taskSinks = new Map();
  }

  /**
   * Subscribe to every event in the fleet.
   * @param {(ev:any)=>void} fn
   * @returns {()=>void} unsubscribe
   */
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Persist + broadcast an event.
   *
   * Approval events are mirrored into the `approvals` table here, because an
   * approval must be an addressable, durable resource (PLAN.md design principle 2)
   * rather than adapter-local memory: `mesh approvals`, the Web console and
   * `mesh approve` all read that table, and it must survive the operator looking
   * at it from another terminal.
   *
   * @param {import('../protocol/events.js').MeshEvent} ev
   */
  emit(ev) {
    if (ev.type === EventType.APPROVAL_REQUESTED && ev.data?.id) {
      try {
        this.store.createApproval({
          id: ev.data.id,
          nodeId: ev.nodeId,
          taskId: ev.taskId ?? null,
          requestId: ev.data.requestId ?? null,
          title: ev.data.title ?? '',
          toolCallId: ev.data.toolCallId ?? null,
          options: ev.data.options || [],
          auto: Boolean(ev.data.auto),
        });
      } catch {
        /* duplicate id or storage hiccup: never break a live run */
      }
    } else if (ev.type === EventType.APPROVAL_RESOLVED && ev.data?.id) {
      // Auto-decided approvals never emitted a REQUESTED event, so the row may
      // not exist yet. Record them too, so the audit trail shows what the policy
      // allowed without asking.
      try {
        this.store.createApproval({
          id: ev.data.id,
          nodeId: ev.nodeId,
          taskId: ev.taskId ?? null,
          requestId: ev.data.requestId ?? null,
          title: ev.data.title ?? '',
          toolCallId: ev.data.toolCallId ?? null,
          options: ev.data.options || [],
          auto: Boolean(ev.data.auto),
        });
      } catch {
        /* already recorded */
      }
      try {
        this.store.resolveApproval(ev.data.id, {
          status: ev.data.optionId ? 'approved' : ev.data.timeout ? 'timeout' : 'denied',
          optionId: ev.data.optionId ?? null,
        });
      } catch {
        /* row missing: nothing to update */
      }
    }

    let seq = null;
    try {
      seq = this.store.appendEvent(ev);
    } catch {
      /* never let storage break a live run */
    }
    const enriched = seq === null ? ev : { ...ev, seq };
    for (const fn of this.listeners) {
      try {
        fn(enriched);
      } catch {
        /* a bad listener must not kill the dispatch */
      }
    }
    // The send that owns this task gets it too — whether the adapter produced it or
    // the Fleet did. Adapters must NOT also call their `onEvent` directly, or every
    // chunk would be delivered (and so concatenated into the result) twice.
    const sink = ev.taskId ? this.taskSinks.get(ev.taskId) : null;
    if (sink) {
      try {
        sink(enriched);
      } catch {
        /* a bad sink must not kill the dispatch */
      }
    }
    return enriched;
  }

  /**
   * Get (or build) the adapter for a node.
   * @param {string} nodeRef
   * @returns {any}
   */
  adapterFor(nodeRef) {
    // `runtimeNode` (not `mustGet`) so an SSH password held in memory — or named by
    // `ssh.passwordEnv` — reaches the adapter without ever being part of the persisted
    // node. It returns a copy, so the secret cannot be written back by `save()`.
    const node = this.registry.runtimeNode(nodeRef);
    if (!node.enabled) throw new Error(`node '${node.name}' is disabled`);
    const cached = this.adapters.get(node.id);
    if (cached) return cached;

    const emit = (/** @type {any} */ ev) => this.emit({ ...ev, nodeId: node.id });
    /** @type {any} */
    let adapter;
    switch (node.transport) {
      case 'acp':
        adapter = new AcpAdapter({
          node,
          emit,
          permissionPolicy: node.approvalPolicy || PermissionPolicy.DENY,
          approvalTtlMs: node.approvalTtlMs,
        });
        break;
      case 'a2a':
        adapter = new A2aAdapter({ node, emit });
        break;
      case 'opencode':
        adapter = new OpencodeAdapter({ node, emit });
        break;
      case 'cli':
        adapter = new CliAdapter({ node, emit });
        break;
      default:
        throw new Error(`node '${node.name}' has unknown transport '${node.transport}'`);
    }
    this.adapters.set(node.id, adapter);
    return adapter;
  }

  /**
   * Forget the cached adapter for a node.
   *
   * Adapters are cached per node id and capture their config at construction (including
   * the route to an SSH password). Without this, editing a node in the long-lived
   * console — or supplying a password after the node was first probed — would appear to
   * save successfully and then keep using the OLD settings, because the cached adapter
   * is what actually gets used. That is the "looks like it worked, silently did not"
   * class of defect this project keeps running into.
   *
   * @param {string} nodeRef
   * @returns {boolean} whether something was dropped
   */
  invalidate(nodeRef) {
    const node = this.registry.get(nodeRef);
    if (!node) return false;
    const existing = this.adapters.get(node.id);
    if (existing && typeof existing.close === 'function') {
      // Best effort: a connection owned by someone else (an in-flight send) will refuse
      // to die, which is correct — it must not be pulled out from under a live task.
      try {
        const closed = existing.close();
        if (closed && typeof closed.catch === 'function') closed.catch(() => {});
      } catch {
        /* a busy adapter stays open until its task finishes */
      }
    }
    return this.adapters.delete(node.id);
  }

  /**
   * Discover a node's capabilities without sending a task.
   * @param {string} nodeRef
   */
  async probe(nodeRef) {
    const node = this.registry.mustGet(nodeRef);
    const adapter = this.adapterFor(nodeRef);
    if (typeof adapter.probe !== 'function') throw new Error(`transport '${node.transport}' does not support probe`);
    return adapter.probe();
  }

  /**
   * Run one task on one node. Returns the final task record.
   * @param {SendOptions} opts
   */
  async send(opts) {
    const node = this.registry.mustGet(opts.nodeRef);
    const previous = opts.continueSession ? this.store.lastSession(node.id) : null;
    // A2A continuity lives in `contextId`, which only helps if the peer keeps
    // server-side context. Some peers accept and echo the contextId while answering
    // each message in isolation, so `--continue` looks like a conversation without
    // being one. When asked, replay the prior turns from our own store so even a
    // stateless peer receives the conversation.
    const history =
      opts.replayHistory && previous?.contextId
        ? this.store.historyForContext({ nodeId: node.id, contextId: previous.contextId })
        : null;
    // Cross-node context, when asked for. Sessions here are per node, so a peer is told nothing
    // about another agent unless this is on — the isolation is deliberate and is the default, and
    // `--share-context` is how an operator says "these agents are working on one thing, let them
    // see each other". The transcript goes into the TEXT sent to the peer rather than through a
    // transport-specific channel, because that is the one path every transport (ACP, A2A,
    // opencode, cli) already has.
    const shared = opts.shareContext
      ? this.store.recentTurns({ limit: opts.shareLimit ?? 6, excludeNodeId: node.id })
      : [];
    const outbound = shared.length ? `${formatSharedContext(shared, this.registry)}${opts.prompt}` : opts.prompt;
    const task = this.store.createTask({
      nodeId: node.id,
      // The record keeps what was actually asked. The transcript is context added on the way out,
      // not part of the request, and `mesh task` showing a wall of other nodes' history would
      // make the record useless for reading back what you asked for.
      prompt: opts.prompt,
      sessionId: previous?.sessionId ?? null,
      contextId: previous?.contextId ?? null,
    });

    /** @type {(ev:any)=>void} */
    const forward = (ev) => {
      opts.onEvent?.(ev);
    };

    // ACP streams the answer as `agent_message_chunk` deltas, so the final text only
    // exists if we concatenate them ourselves. Without this the task record (and so
    // `mesh task <id>`, the Web console and `--json`) stores an empty result for
    // every ACP run — the chunks were displayed live and then thrown away.
    /** @type {string[]} */
    const acpChunks = [];
    /** @type {(ev:any)=>void} */
    const forwardAndCollect = (ev) => {
      if (ev.type === EventType.CHUNK && ev.text) acpChunks.push(ev.text);
      forward(ev);
    };

    // Registered before the first event is emitted so `task-created` is not lost,
    // and removed once the run settles.
    this.taskSinks.set(task.id, forwardAndCollect);

    this.emit(
      makeEvent({
        nodeId: node.id,
        taskId: task.id,
        type: EventType.TASK_CREATED,
        text: `${node.name} (${node.transport})`,
        data: { nodeId: node.id, nodeName: node.name, transport: node.transport, prompt: opts.prompt, cwd: opts.cwd ?? node.cwd ?? null },
      }),
    );
    this.store.updateTask(task.id, { state: TaskState.SUBMITTED });
    this.emit(makeEvent({ nodeId: node.id, taskId: task.id, type: EventType.TASK_STATE, text: 'submitted', data: { state: TaskState.SUBMITTED } }));

    const adapter = this.adapterFor(node.name);
    // A transport with no permission channel cannot carry this, and saying nothing would leave the
    // operator believing they had asked to be consulted. That is how the A2A case was found: a
    // peer returned `input-required` with a question, the run had been started with `--approval
    // ask`, and the flag had been dropped on the floor — so the one moment a human was needed
    // produced no signal at all. Telling them the truth is worth more than the false comfort.
    if (opts.permissionPolicy) {
      if ('permissionPolicy' in adapter) adapter.permissionPolicy = opts.permissionPolicy;
      else {
        this.emit(
          makeEvent({
            nodeId: node.id,
            taskId: task.id,
            type: EventType.LOG,
            text:
              `--approval ${opts.permissionPolicy} has no effect on the '${node.transport}' transport: ` +
              `it has no permission channel. ACP carries session/request_permission and opencode has its ` +
              `own, but A2A only reports TASK_STATE_INPUT_REQUIRED, which stops the task and waits for a ` +
              `follow-up message. Use an ACP node for approvals, or answer with: ` +
              `mesh send ${node.name} "<answer>" --continue`,
            data: { state: 'approval-unsupported', transport: node.transport, policy: opts.permissionPolicy },
          }),
        );
      }
    }

    try {
      this.store.updateTask(task.id, { state: TaskState.WORKING });
      this.emit(makeEvent({ nodeId: node.id, taskId: task.id, type: EventType.TASK_STATE, text: 'working', data: { state: TaskState.WORKING } }));

      /** @type {{sessionId?:string, contextId?:string, remoteTaskId?:string, state:string, text?:string, stopReason?:string}} */
      let outcome;
      if (node.transport === 'acp') {
        const res = await adapter.prompt({
          text: outbound,
          sessionId: previous?.sessionId ?? undefined,
          cwd: opts.cwd || node.cwd,
          taskId: task.id,
          onEvent: forwardAndCollect,
          signal: opts.signal,
          timeoutMs: opts.timeoutMs,
        });
        outcome = { sessionId: res.sessionId, state: res.state, stopReason: res.stopReason, text: acpChunks.join('').trim() };
      } else {
        const res = await adapter.send({
          text: outbound,
          contextId: previous?.contextId ?? undefined,
          taskId: task.id,
          stream: opts.stream,
          onEvent: forward,
          signal: opts.signal,
          timeoutMs: opts.timeoutMs,
          history: history ?? undefined,
        });
        outcome = { contextId: res.contextId ?? undefined, remoteTaskId: res.remoteTaskId ?? undefined, state: res.state, text: res.text };
      }

      const finalState = outcome.state || TaskState.COMPLETED;
      const record = this.store.updateTask(task.id, {
        state: finalState,
        sessionId: outcome.sessionId ?? task.sessionId,
        contextId: outcome.contextId ?? task.contextId,
        remoteTaskId: outcome.remoteTaskId ?? null,
        result: outcome.text ?? '',
      });
      // A waiting state means nobody is working and nothing will move until a human replies. It is
      // not a failure and it is not a success, and reporting only `state: input-required` in a
      // terminal event left the operator with a task that looked stuck — the "指令消失" problem.
      // So it gets its own event, carrying the remote's own words and the exact way to answer.
      // A2A is where this was observed, but this is raised by the transport-independent layer: any
      // future transport that parks a task gets the same signal for free.
      if (WAITING_STATES.has(finalState)) {
        const question = String(outcome.text ?? '').trim();
        this.emit(
          makeEvent({
            nodeId: node.id,
            taskId: task.id,
            type: EventType.NEEDS_INPUT,
            text: question || '(the remote did not say what it needs)',
            data: {
              state: finalState,
              question,
              contextId: record.contextId ?? null,
              // The A2A answer to `input-required` is a new message in the same context, which is
              // exactly what `--continue` does. There is no option set to offer, so the operator's
              // words are the answer.
              replyWith: `mesh send ${node.name} "<your answer>" --continue`,
              transport: node.transport,
            },
          }),
        );
      }
      this.emit(
        makeEvent({
          nodeId: node.id,
          taskId: task.id,
          type: EventType.DONE,
          text: finalState,
          data: { state: finalState, stopReason: outcome.stopReason ?? null, sessionId: record.sessionId, contextId: record.contextId },
        }),
      );
      return record;
    } catch (err) {
      const message = errLine(err);
      this.store.updateTask(task.id, { state: TaskState.FAILED, error: message });
      this.emit(makeEvent({ nodeId: node.id, taskId: task.id, type: EventType.ERROR, text: message, data: { error: message } }));
      this.emit(makeEvent({ nodeId: node.id, taskId: task.id, type: EventType.DONE, text: 'failed', data: { state: TaskState.FAILED } }));
      return this.store.getTask(task.id);
    } finally {
      // The run has settled (or thrown); stop routing events to its callback.
      this.taskSinks.delete(task.id);
    }
  }

  /**
   * Fan a prompt out to several nodes.
   *
   * @param {object} opts
   * @param {string} opts.prompt
   * @param {string[]} [opts.refs]            explicit node refs
   * @param {string} [opts.capability]        match nodes advertising this capability ('*' = all)
   * @param {'all'|'first'|'best'} [opts.mode]
   * @param {number} [opts.concurrency]
   * @param {(ev:any)=>void} [opts.onEvent]
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<Array<{node:any, task:any}>>}
   */
  async broadcast(opts) {
    const mode = ['all', 'first', 'best'].includes(opts.mode || '') ? opts.mode : 'all';
    const targets = this.resolveTargets(opts);
    if (!targets.length) throw new Error('no nodes matched');

    const concurrency = Math.max(1, Math.min(opts.concurrency || targets.length, 8));
    /** @type {Array<{node:any, task:any}>} */
    const results = [];
    /** @type {any[]} */
    const queue = [...targets];
    let stopEarly = false;

    const worker = async () => {
      for (;;) {
        if (stopEarly && mode === 'first') return;
        const node = queue.shift();
        if (!node) return;
        const task = await this.send({
          nodeRef: node.name,
          prompt: opts.prompt,
          shareContext: opts.shareContext,
          shareLimit: opts.shareLimit,
          onEvent: opts.onEvent,
          signal: opts.signal,
        });
        results.push({ node, task });
        if (mode === 'first' && task.state === TaskState.COMPLETED && (task.result || '').trim()) stopEarly = true;
      }
    };

    await Promise.all(Array.from({ length: concurrency }, worker));
    results.sort((a, b) => a.node.name.localeCompare(b.node.name));
    return results;
  }

  /**
   * Resolve which nodes a broadcast targets.
   *
   * `capability` accepts a string OR an array (the CLI's `--capability` is
   * repeatable). It used to be read as a single string, so passing the array the
   * CLI produced made `includes()` compare a string against an array and match
   * *nothing* — `mesh broadcast --capability c` silently selected zero nodes.
   *
   * @param {{refs?:string[], capability?:string|string[]}} opts
   * @returns {import('./registry.js').NodeConfig[]}
   */
  resolveTargets({ refs, capability }) {
    if (refs && refs.length) return refs.map((r) => this.registry.mustGet(r));
    const all = this.registry.list().filter((n) => n.enabled);
    const wanted = (Array.isArray(capability) ? capability : [capability]).filter((c) => typeof c === 'string' && c);
    if (!wanted.length || wanted.includes('*')) return all;
    return all.filter((n) => wanted.some((c) => (n.capabilities || []).includes(c) || (n.tags || []).includes(c)));
  }

  /**
   * Resolve a parked approval. Works only while the process holding the live
   * connection is alive (CLI with `--approval ask`, `mesh watch`, or the Web daemon).
   *
   * @param {string} approvalId
   * @param {string|null} optionId
   * @returns {{ok:boolean, reason?:string}}
   */
  resolveApproval(approvalId, optionId) {
    for (const adapter of this.adapters.values()) {
      if (typeof adapter.listParked !== 'function') continue;
      for (const rec of adapter.listParked()) {
        if (rec.id === approvalId) {
          const ok = adapter.resolveApproval(rec.requestId, optionId);
          this.store.resolveApproval(approvalId, { status: ok ? (optionId ? 'approved' : 'denied') : 'expired', optionId });
          return { ok };
        }
      }
    }
    return { ok: false, reason: 'no live connection is holding this approval (start `mesh serve` or `mesh watch`)' };
  }

  /** @returns {any[]} */
  pendingApprovals() {
    /** @type {any[]} */
    const out = [];
    for (const adapter of this.adapters.values()) {
      if (typeof adapter.listParked !== 'function') continue;
      out.push(...adapter.listParked());
    }
    return out;
  }

  /**
   * Close every adapter and release the store's database handle.
   */
  async close() {
    for (const adapter of this.adapters.values()) {
      try {
        await adapter.disconnect?.('fleet closing');
      } catch {
        /* ignore */
      }
    }
    this.adapters.clear();
    // The store holds an open SQLite handle; leaving it open keeps mesh.db (and on
    // Windows its whole directory) locked after shutdown.
    try {
      this.store?.close?.();
    } catch {
      /* ignore */
    }
  }
}

export { TaskState, isTerminal };
