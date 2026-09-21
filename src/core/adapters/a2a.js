/**
 * A2A adapter —?talks to any A2A v1.0 / v0.3 peer over HTTP.
 *
 * Hermes is the reference target: it ships a full A2A server, so enabling
 * `A2A_PORT` on a Hermes box is all that is needed to make it a mesh node.
 *
 * Discovery  : GET /.well-known/agent-card.json (falls back to agent.json)
 * Send       : JSON-RPC `SendMessage`   (blocking)  or
 *              JSON-RPC `SendStreamingMessage` over SSE (when the card says streaming)
 * Cancel     : JSON-RPC `CancelTask`
 *
 * @module core/adapters/a2a
 */

import {
  A2A_VERSION,
  METHODS,
  LEGACY_METHODS,
  agentCardUrls,
  buildSendMessageRequest,
  buildGetTaskRequest,
  buildCancelTaskRequest,
  cardRpcTarget,
  isPrivateHost,
  isMethodNotFound,
  prefersLegacyMethods,
  normalizeSendResult,
  withConversationHistory,
  parseStreamPayload,
  summarizeCard,
  extractText,
} from '../../protocol/a2a.js';
import { EventType, makeEvent } from '../../protocol/events.js';
import { TaskState, isTerminal } from '../../protocol/states.js';
import { authHeaders, getJson, postJson, streamSse, HttpError } from '../transport/http.js';

/**
 * @typedef {object} A2aAdapterOptions
 * @property {any} node
 * @property {(ev:import('../../protocol/events.js').MeshEvent)=>void} emit
 * @property {number} [timeoutMs]
 */

export class A2aAdapter {
  /** @type {any} */
  #card = null;
  /** @type {{url:string, tenant:string, protocolVersion:string|null}|null} */
  #target = null;
  /** @type {string[]} */
  #warnings = [];
  #discovering = null;

  /**
   * @param {A2aAdapterOptions} opts
   */
  constructor({ node, emit, timeoutMs = 15 * 60_000 }) {
    this.node = node;
    this.emit = emit;
    this.timeoutMs = node.timeoutMs || timeoutMs;
  }

  /** @returns {Record<string,string>} */
  #headers() {
    return { 'A2A-Version': A2A_VERSION, ...authHeaders({ token: this.node.token }) };
  }

  /**
   * Fetch (and cache) the remote Agent Card.
   * @param {{force?:boolean}} [opts]
   * @returns {Promise<any>}
   */
  async discover({ force = false } = {}) {
    if (this.#card && !force) return this.#card;
    if (this.#discovering) return this.#discovering;
    this.#discovering = (async () => {
      const base = String(this.node.url || '').replace(/\/+$/, '');
      if (!base) throw new Error(`node '${this.node.name}' has no url configured`);
      /** @type {any} */
      let lastErr = null;
      for (const url of agentCardUrls(base)) {
        try {
          const card = await getJson({ url, headers: this.#headers(), timeoutMs: 15_000 });
          this.#card = card;
          this.#target = this.#resolveTarget(cardRpcTarget(card, base), base);
          return card;
        } catch (err) {
          lastErr = err;
          if (err instanceof HttpError && err.status === 404) continue; // try the legacy path
          throw err;
        }
      }
      throw new Error(`could not fetch an Agent Card from ${base}: ${lastErr?.message ?? 'unknown error'}`);
    })();
    try {
      return await this.#discovering;
    } finally {
      this.#discovering = null;
    }
  }

  /**
   * Decide where the JSON-RPC calls should actually go.
   *
   * The card is authoritative, but it is frequently wrong about its own address: an
   * agent behind NAT/VPC reports its private address even though the operator reached
   * the card over a public one. Following that literally sends every task to an
   * unroutable host, and the resulting timeout looks like a firewall problem.
   *
   * So: honour the card unless it names a PRIVATE host that differs from the host we
   * successfully fetched the card from. In that one case we keep the card's path (the
   * server chose it for routing) but swap in the origin we have already proved works,
   * and record a warning that `mesh probe` surfaces.
   *
   * @param {{url:string, tenant:string, protocolVersion:string|null}} target
   * @param {string} base  the URL the card was discovered from
   * @returns {{url:string, tenant:string, protocolVersion:string|null}}
   */
  #resolveTarget(target, base) {
    this.#warnings = [];
    if (!target?.url) return target;
    /** @type {URL} */ let advertised;
    /** @type {URL} */ let discovery;
    try {
      advertised = new URL(target.url);
      discovery = new URL(base);
    } catch {
      return target; // unparseable: leave it alone rather than guess
    }
    if (advertised.hostname === discovery.hostname) return target;
    if (!isPrivateHost(advertised.hostname)) return target;

    const fallback = `${discovery.origin}${advertised.pathname === '/' ? '' : advertised.pathname}`;
    this.#warnings.push(
      `the Agent Card advertises its RPC endpoint at ${target.url}, which is a private address; ` +
        `using ${fallback} instead, because that is the address the card was actually reachable on. ` +
        `Fix the agent's public URL setting to silence this.`,
    );
    return { ...target, url: fallback, advertisedUrl: target.url };
  }

  /**
   * Capability probe (`mesh probe`).
   * @returns {Promise<{transport:'a2a', card:any, summary:ReturnType<typeof summarizeCard>, rpcUrl:string, tenant:string, reachable:boolean, warnings:string[]}>}
   */
  async probe() {
    const card = await this.discover({ force: true });
    return {
      transport: 'a2a',
      reachable: true,
      card,
      summary: summarizeCard(card),
      rpcUrl: this.#target?.url ?? '',
      advertisedUrl: this.#target?.advertisedUrl ?? '',
      tenant: this.#target?.tenant ?? '',
      warnings: this.#warnings ?? [],
    };
  }

  /**
   * Send a task and wait for its answer.
   *
   * @param {object} opts
   * @param {string} opts.text
   * @param {string} [opts.contextId]
   * @param {string} [opts.taskId]        our task id, used to tag events
   * @param {boolean} [opts.stream]       force streaming off/on (default: use card capability)
   * @param {(ev:any)=>void} [opts.onEvent]
   * @param {AbortSignal} [opts.signal]
   * @param {number} [opts.timeoutMs]
   * @param {{role:'user'|'assistant', text:string}[]} [opts.history]  prior turns to replay for a peer with no server-side context
   * @returns {Promise<{contextId:string|null, remoteTaskId:string|null, state:string, text:string}>}
   */
  async send({ text, contextId, taskId, stream, onEvent, signal, timeoutMs, history }) {
    const card = await this.discover();
    const target = this.#target ?? this.#resolveTarget(cardRpcTarget(card, this.node.url), this.node.url);
    const wantsStream = stream ?? Boolean(card?.capabilities?.streaming);
    const timeout = timeoutMs ?? this.timeoutMs;

    if (wantsStream) {
      try {
        return await this.#sendStreaming({ target, text, contextId, taskId, onEvent, signal, timeoutMs: timeout, history });
      } catch (err) {
        // A server can advertise streaming and still fail it; fall back once.
        const ev = makeEvent({
          nodeId: this.node.id,
          taskId: taskId ?? null,
          type: EventType.LOG,
          text: `streaming failed (${err instanceof Error ? err.message : String(err)}); retrying without streaming`,
        });
        this.emit(ev);
      }
    }
    return this.#sendBlocking({ target, text, contextId, taskId, onEvent, signal, timeoutMs: timeout, history });
  }

  /**
   * @param {{target:any, text:string, contextId?:string, taskId?:string, onEvent?:Function, signal?:AbortSignal, timeoutMs:number, history?:{role:string,text:string}[]}} o
   */
  async #sendBlocking({ target, text, contextId, taskId, onEvent, signal, timeoutMs, history }) {
    // A peer that keeps no server-side context only learns about earlier turns if we
    // carry them, so fold the history in before choosing a method name.
    const outgoing = withConversationHistory(text, history);
    const attempt = (/** @type {boolean} */ legacy) =>
      postJson({
        url: target.url,
        body: buildSendMessageRequest({
          text: outgoing,
          contextId,
          tenant: target.tenant,
          method: legacy ? LEGACY_METHODS.SEND_MESSAGE : METHODS.SEND_MESSAGE,
        }),
        headers: this.#headers(),
        timeoutMs,
        signal,
      });

    const legacy = prefersLegacyMethods(this.#card, target);
    let res = await attempt(legacy);
    // A card can be wrong about which revision its server implements. `-32601` is the
    // peer telling us plainly, so retry once under the other naming family instead of
    // failing a task we could have completed.
    if (res?.error && isMethodNotFound(res.error)) {
      const other = !legacy;
      this.emit(
        makeEvent({
          nodeId: this.node.id,
          taskId: taskId ?? null,
          type: EventType.LOG,
          text: `peer rejected '${legacy ? LEGACY_METHODS.SEND_MESSAGE : METHODS.SEND_MESSAGE}' as an unknown method; retrying with '${other ? LEGACY_METHODS.SEND_MESSAGE : METHODS.SEND_MESSAGE}'`,
        }),
      );
      res = await attempt(other);
    }
    const id = res?.id ?? null;
    if (res?.error) {
      const message = String(res.error.message ?? 'A2A error');
      throw new Error(`peer '${this.node.name}' rejected the task: ${message}`);
    }
    const result = normalizeSendResult(res?.result);
    if (result.text) {
      const ev = makeEvent({
        nodeId: this.node.id,
        taskId: taskId ?? null,
        type: EventType.CHUNK,
        text: result.text,
        data: { rpcId: id, shape: result.shape, contextId: result.contextId },
      });
      this.emit(ev);
    }
    return { contextId: result.contextId, remoteTaskId: result.taskId, state: result.state, text: result.text };
  }

  /**
   * @param {{target:any, text:string, contextId?:string, taskId?:string, onEvent?:Function, signal?:AbortSignal, timeoutMs:number}} o
   */
  async #sendStreaming({ target, text, contextId, taskId, onEvent, signal, timeoutMs, history }) {
    // Folded in here as well as in the blocking path: a streaming-capable peer would
    // otherwise silently drop the conversation whenever --stream was used.
    const body = buildSendMessageRequest({
      text: withConversationHistory(text, history),
      contextId,
      tenant: target.tenant,
      method: prefersLegacyMethods(this.#card, target) ? LEGACY_METHODS.SEND_STREAMING_MESSAGE : METHODS.SEND_STREAMING_MESSAGE,
    });
    /** @type {{contextId:string|null, remoteTaskId:string|null, state:string, text:string}} */
    const acc = { contextId: contextId ?? null, remoteTaskId: null, state: TaskState.SUBMITTED, text: '' };
    let sawAny = false;
    // Artifacts are keyed by artifactId. `append: true` concatenates a fragment;
    // otherwise the incoming content REPLACES that artifact (A2A semantics).
    /** @type {Map<string,string>} */
    const artifacts = new Map();
    let statusText = '';

    await streamSse({
      url: target.url,
      method: 'POST',
      body,
      headers: this.#headers(),
      signal,
      idleTimeoutMs: timeoutMs,
      onFrame: (frame) => {
        const ev = parseStreamPayload(frame.data);
        if (!ev || ev.type === 'done') return;
        sawAny = true;
        if (ev.contextId) acc.contextId = ev.contextId;
        if (ev.taskId) acc.remoteTaskId = ev.taskId;
        if (ev.state) acc.state = ev.state;
        if (ev.text) {
          if (ev.type === 'artifact') {
            const key = ev.artifactId || '_default';
            artifacts.set(key, ev.append ? `${artifacts.get(key) || ''}${ev.text}` : ev.text);
          } else {
            statusText = statusText ? `${statusText}\n${ev.text}` : ev.text;
          }
        }

        /** @type {string} */
        let type = EventType.LOG;
        if (ev.type === 'artifact') type = EventType.CHUNK;
        else if (ev.type === 'message') type = EventType.CHUNK;
        else if (ev.type === 'status') type = EventType.TASK_STATE;
        else if (ev.type === 'task') type = EventType.TASK_STATE;

        const mev = makeEvent({
          nodeId: this.node.id,
          taskId: taskId ?? null,
          type,
          text: ev.text || '',
          data: { contextId: ev.contextId, remoteTaskId: ev.taskId, state: ev.state, streamType: ev.type, raw: ev.raw },
        });
        this.emit(mev);
      },
    });

    if (!sawAny) {
      // Empty stream: an A2A server may legitimately return nothing for a
      // completed task. Treat as completed-with-no-text rather than an error.
      acc.state = TaskState.COMPLETED;
    }
    acc.text = [[...artifacts.values()].join('\n'), statusText].map((s) => s.trim()).filter(Boolean).join('\n');
    return { contextId: acc.contextId, remoteTaskId: acc.remoteTaskId, state: acc.state, text: acc.text };
  }

  /**
   * Poll a remote task (used when a streaming call ends before the task does).
   * @param {string} remoteTaskId
   * @param {{legacy?:boolean}} [opts]
   */
  async getTask(remoteTaskId, opts = {}) {
    const card = await this.discover();
    const target = this.#target ?? this.#resolveTarget(cardRpcTarget(card, this.node.url), this.node.url);
    const res = await postJson({
      url: target.url,
      body: buildGetTaskRequest({ taskId: remoteTaskId, legacy: opts.legacy ?? prefersLegacyMethods(this.#card, target) }),
      headers: this.#headers(),
      timeoutMs: 60_000,
    });
    if (res?.error) throw new Error(String(res.error.message ?? 'A2A GetTask failed'));
    const task = res?.result ?? null;
    return {
      state: task?.status?.state ?? null,
      text: task ? extractText(task.status?.message || {}) || (Array.isArray(task.artifacts) ? task.artifacts.map((/** @type {any} */ a) => extractText(a)).filter(Boolean).join('\n') : '') : '',
      raw: task,
      terminal: isTerminal(String(task?.status?.state ?? '')),
    };
  }

  /**
   * @param {string} remoteTaskId
   */
  async cancel(remoteTaskId) {
    const card = await this.discover();
    const target = this.#target ?? this.#resolveTarget(cardRpcTarget(card, this.node.url), this.node.url);
    const res = await postJson({
      url: target.url,
      body: buildCancelTaskRequest({ taskId: remoteTaskId, legacy: prefersLegacyMethods(this.#card, target) }),
      headers: this.#headers(),
      timeoutMs: 60_000,
    });
    if (res?.error) throw new Error(String(res.error.message ?? 'A2A CancelTask failed'));
    return res?.result ?? null;
  }

  /** A2A is stateless per request; nothing to tear down. */
  async disconnect() {}
}
