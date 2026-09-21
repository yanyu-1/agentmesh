/**
 * opencode adapter —?talks to `opencode serve`'s headless HTTP API.
 *
 * Reverse-engineered from the checked-in OpenAPI document (`packages/sdk/openapi.json`,
 * byte-identical to tag v1.18.31) plus the server source; see
 * `research/opencode-api.md` for every claim and its source URL.
 *
 * Three things that are easy to get wrong and are handled here:
 *   1. `POST /session/{id}/message` is SYNCHRONOUS and never streams. The streaming
 *      path is `POST /session/{id}/prompt_async` (204 No Content) followed by
 *      `GET /event`, whose SSE `event:` field is always literally `message` —?the
 *      real type lives inside the JSON envelope `{id, type, properties}`.
 *   2. Requests are scoped by directory (`?directory=` or `x-opencode-directory`),
 *      and `/event` is filtered server-side by it, so we must pass it or we will
 *      subscribe to the wrong project's stream.
 *   3. Answering a permission prompt is `POST /session/{id}/permissions/{permissionID}`
 *      with body `{"response":"once"|"always"|"reject"}` —?NOT the `remember` field
 *      the public docs table still shows.
 *
 * Auth: HTTP Basic, user `opencode` (or OPENCODE_SERVER_USERNAME),
 * password = OPENCODE_SERVER_PASSWORD.
 *
 * @module core/adapters/opencode
 */

import { EventType, makeEvent } from '../../protocol/events.js';
import { TaskState } from '../../protocol/states.js';
import { newId } from '../../protocol/util.js';
import { authHeaders, getJson, postJson, streamSse } from '../transport/http.js';

/**
 * Logical name -> path template. Override per node with `node.endpoints`.
 * @type {Record<string,string>}
 */
export const DEFAULT_ENDPOINTS = {
  openapi: '/doc',
  health: '/global/health',
  event: '/event',
  sessionCreate: '/session',
  sessionList: '/session',
  sessionMessages: '/session/:id/message',
  sessionPrompt: '/session/:id/message',
  sessionPromptAsync: '/session/:id/prompt_async',
  sessionAbort: '/session/:id/abort',
  sessionStatus: '/session/status',
  sessionDelete: '/session/:id',
  permissionList: '/permission',
  permissionAnswer: '/session/:id/permissions/:permissionID',
  agentList: '/agent',
  providerList: '/provider',
};

/** Map an opencode permission reply to our approval optionId space. */
const REPLY_TO_OPTION = { once: 'allow_once', always: 'allow_always', reject: 'deny' };
const OPTION_TO_REPLY = { allow_once: 'once', allow_always: 'always', deny: 'reject', reject_once: 'reject', reject_always: 'reject' };

export class OpencodeAdapter {
  /**
   * @param {{node:any, emit:(ev:any)=>void}} opts
   */
  constructor({ node, emit }) {
    this.node = node;
    this.emit = emit;
    this.endpoints = { ...DEFAULT_ENDPOINTS, ...(node.endpoints || {}) };
    // `permissionPolicy` is the name Fleet overrides per-send (the Web console's
    // approval selector); keep it in sync with the node's stored default.
    this.permissionPolicy = node.approvalPolicy || 'deny';
    /** @type {any} */
    this.openapi = null;
    /** @type {Map<string, any>} pending permission requests keyed by request id */
    this.parked = new Map();
  }

  get baseUrl() {
    return String(this.node.url || '').replace(/\/+$/, '');
  }

  #headers() {
    // NOTE: do NOT send `x-opencode-directory` here. HTTP header values must be
    // latin1, so any non-ASCII working directory (e.g. `D:\工作`) makes fetch throw
    // "Cannot convert argument to a ByteString". `?directory=` is both
    // percent-encodable and higher precedence in opencode, so we always use that.
    return authHeaders({
      username: this.node.username || 'opencode',
      password: this.node.password,
      token: this.node.token,
      extra: this.node.headers || {},
    });
  }

  /**
   * Append the directory scope, which opencode uses to pick the project.
   * @param {string} url
   * @returns {string}
   */
  #scoped(url) {
    if (!this.node.cwd) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}directory=${encodeURIComponent(this.node.cwd)}`;
  }

  /**
   * @param {string} key
   * @param {Record<string,string>} [params]
   * @returns {string}
   */
  #path(key, params = {}) {
    let p = String(this.endpoints[key] || '');
    for (const [k, v] of Object.entries(params)) p = p.replace(`:${k}`, encodeURIComponent(v));
    return this.#scoped(this.baseUrl + p);
  }

  /**
   * Health + endpoint discovery. `mesh probe` uses this.
   */
  async probe() {
    /** @type {any} */
    let health = null;
    /** @type {Record<string,string>} */
    const errors = {};
    try {
      health = await getJson({ url: this.#path('health'), headers: this.#headers(), timeoutMs: 10_000 });
    } catch (err) {
      health = null;
      errors.health = err instanceof Error ? err.message : String(err);
    }

    let doc = null;
    try {
      doc = await getJson({ url: this.#path('openapi'), headers: this.#headers(), timeoutMs: 15_000 });
    } catch (err) {
      doc = null;
      errors.openapi = err instanceof Error ? err.message : String(err);
    }
    this.openapi = doc;

    const paths = Object.keys(doc?.paths || []);
    /** @type {Record<string, boolean>} */
    const endpointsFound = {};
    for (const [key, tmpl] of Object.entries(this.endpoints)) {
      const normalized = String(tmpl).replace(/:([A-Za-z]+)/g, '{$1}');
      endpointsFound[key] = paths.some((p) => p === normalized || p === String(tmpl));
    }

    return {
      transport: 'opencode',
      reachable: Boolean(health?.healthy) || paths.length > 0,
      baseUrl: this.baseUrl,
      directory: this.node.cwd || null,
      version: health?.version ?? doc?.info?.version ?? null,
      title: doc?.info?.title ?? 'opencode',
      pathCount: paths.length,
      endpointsFound,
      availablePaths: paths.slice(0, 400),
      ...(Object.keys(errors).length ? { errors } : {}),
    };
  }

  /**
   * @returns {Promise<string>}
   */
  async createSession() {
    const res = await postJson({
      url: this.#path('sessionCreate'),
      body: this.node.sessionBody || {},
      headers: this.#headers(),
      timeoutMs: 60_000,
    });
    const id = res?.id || res?.sessionID || res?.session?.id;
    if (!id) throw new Error(`opencode returned no session id from ${this.endpoints.sessionCreate}: ${JSON.stringify(res).slice(0, 200)}`);
    return String(id);
  }

  /**
   * Build the prompt body.
   * @param {string} text
   */
  #promptBody(text) {
    /** @type {any} */
    const body = { parts: [{ type: 'text', text }], ...(this.node.promptBody || {}) };
    // Note the inconsistent `model` shape between endpoints; only forward when the
    // operator supplied the prompt-flavoured shape.
    if (this.node.model?.providerID && this.node.model?.modelID) body.model = this.node.model;
    if (this.node.agent) body.agent = this.node.agent;
    return body;
  }

  /**
   * Normalize one `/event` frame into a Mesh event plus accumulated text.
   * @param {any} payload
   * @returns {{type:string, text:string, partID:string|null, sessionId:string|null, full:string|null}}
   */
  #classifyEvent(payload) {
    const type = String(payload?.type ?? '');
    const props = payload?.properties || {};
    const sessionId = props.sessionID || props.part?.sessionID || props.info?.sessionID || null;

    switch (type) {
      case 'message.part.updated': {
        const part = props.part || {};
        if (part.type === 'text') return { type: EventType.CHUNK, text: '', partID: part.id ?? null, sessionId, full: String(part.text ?? '') };
        if (part.type === 'reasoning') return { type: EventType.THOUGHT, text: '', partID: part.id ?? null, sessionId, full: String(part.text ?? '') };
        if (part.type === 'tool') {
          const status = part.state?.status;
          const label = `🔧 ${part.tool ?? 'tool'}${status ? ` ${status}` : ''}`;
          return { type: status === 'completed' || status === 'error' ? EventType.TOOL_UPDATE : EventType.TOOL_CALL, text: label, partID: part.id ?? null, sessionId, full: null };
        }
        return { type: EventType.LOG, text: '', partID: part.id ?? null, sessionId, full: null };
      }
      case 'message.part.delta':
        return { type: EventType.CHUNK, text: String(props.delta ?? ''), partID: props.partID ?? null, sessionId, full: null };
      case 'session.next.text.delta':
        return { type: EventType.CHUNK, text: String(props.delta ?? props.text ?? ''), partID: props.partID ?? null, sessionId, full: null };
      case 'session.next.reasoning.delta':
        return { type: EventType.THOUGHT, text: String(props.delta ?? ''), partID: props.partID ?? null, sessionId, full: null };
      case 'session.next.tool.called':
        return { type: EventType.TOOL_CALL, text: `🔧 ${props.tool ?? props.name ?? 'tool'}`, partID: null, sessionId, full: null };
      case 'session.next.tool.success':
      case 'session.next.tool.failed':
        return { type: EventType.TOOL_UPDATE, text: `🔧 ${props.tool ?? props.name ?? 'tool'} ${type.endsWith('failed') ? 'failed' : 'completed'}`, partID: null, sessionId, full: null };
      case 'session.error':
        return { type: EventType.ERROR, text: String(props.error?.data?.message ?? props.error?.name ?? 'session error'), partID: null, sessionId, full: null };
      case 'session.idle':
        return { type: EventType.TASK_STATE, text: 'idle', partID: null, sessionId, full: null };
      case 'server.connected':
      case 'server.heartbeat':
        return { type: EventType.LOG, text: '', partID: null, sessionId, full: null };
      default:
        return { type: EventType.LOG, text: '', partID: null, sessionId, full: null };
    }
  }

  /**
   * Send a prompt and stream the response.
   *
   * @param {{text:string, contextId?:string, taskId?:string, stream?:boolean, onEvent?:(ev:any)=>void, signal?:AbortSignal, timeoutMs?:number}} opts
   * @returns {Promise<{state:string, text:string, contextId:string, remoteTaskId:null, error?:string}>}
   */
  async send({ text, contextId, taskId, onEvent, signal, timeoutMs = 30 * 60_000 }) {
    const sessionId = contextId || (await this.createSession());
    const useAsync = this.node.useAsyncStream !== false;

    /** @type {Map<string,string>} */
    const parts = new Map();
    /** @type {{resolve:()=>void}|null} */
    let idleSignal = null;
    const idle = new Promise((resolve) => {
      idleSignal = { resolve };
    });
    /** @type {string|null} */
    let streamError = null;

    const streamCtl = new AbortController();
    const onOuterAbort = () => streamCtl.abort();
    if (signal) {
      if (signal.aborted) streamCtl.abort();
      else signal.addEventListener('abort', onOuterAbort, { once: true });
    }

    const emitEvent = (type, text, data) => {
      const ev = makeEvent({ nodeId: this.node.id, taskId: taskId ?? null, type, text, data: { sessionId, ...(data || {}) } });
      this.emit(ev);
    };

    // Subscribe BEFORE prompting so no early chunk is missed.
    const eventStream = streamSse({
      url: this.#path('event'),
      headers: this.#headers(),
      signal: streamCtl.signal,
      idleTimeoutMs: 0,
      onFrame: (frame) => {
        let payload = null;
        try {
          payload = JSON.parse(frame.data);
        } catch {
          return;
        }
        const cls = this.#classifyEvent(payload);

        // Permission prompts are the opencode analogue of ACP's
        // session/request_permission: park them as durable approvals.
        if (payload?.type === 'permission.asked' && payload.properties) {
          this.#parkPermission(payload.properties, sessionId, taskId, onEvent);
          return;
        }

        if (cls.sessionId && String(cls.sessionId) !== String(sessionId)) return; // another session's traffic

        if (cls.full !== null && cls.partID) {
          const prev = parts.get(cls.partID) || '';
          parts.set(cls.partID, cls.full);
          const delta = cls.full.slice(prev.length);
          if (delta) emitEvent(cls.type, delta, { opencodeType: payload?.type, partID: cls.partID });
          return;
        }
        if (cls.text && cls.partID) parts.set(cls.partID, (parts.get(cls.partID) || '') + cls.text);
        if (cls.text) emitEvent(cls.type, cls.text, { opencodeType: payload?.type, partID: cls.partID });
        else if (payload?.type && cls.type === EventType.LOG) emitEvent(EventType.LOG, '', { opencodeType: payload.type });

        if (cls.type === EventType.ERROR) {
          streamError = cls.text;
          idleSignal?.resolve();
        }
        if (payload?.type === 'session.idle' && (!cls.sessionId || String(cls.sessionId) === String(sessionId))) {
          idleSignal?.resolve();
        }
      },
    }).catch((err) => {
      emitEvent(EventType.LOG, `event stream ended: ${err?.message ?? err}`, {});
      idleSignal?.resolve();
    });

    /** @type {string|undefined} */
    let error;
    try {
      if (useAsync) {
        // 204 No Content, then the answer arrives on /event.
        await postJson({
          url: this.#path('sessionPromptAsync', { id: sessionId }),
          body: this.#promptBody(text),
          headers: this.#headers(),
          timeoutMs: 120_000,
          signal,
        });
        const timer = setTimeout(() => idleSignal?.resolve(), timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
        await idle;
        clearTimeout(timer);
      } else {
        const res = await postJson({
          url: this.#path('sessionPrompt', { id: sessionId }),
          body: this.#promptBody(text),
          headers: this.#headers(),
          timeoutMs,
          signal,
        });
        const direct = extractOpencodeText(res);
        if (direct) parts.set('__sync__', direct);
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      emitEvent(EventType.ERROR, error, {});
    } finally {
      streamCtl.abort();
      if (signal) signal.removeEventListener('abort', onOuterAbort);
      void eventStream;
    }

    const answer = [...parts.values()].join('').trim();
    if (streamError && !error) error = streamError;
    return {
      state: error ? TaskState.FAILED : TaskState.COMPLETED,
      text: answer,
      contextId: sessionId,
      remoteTaskId: null,
      ...(error ? { error } : {}),
    };
  }

  /**
   * Park a `permission.asked` event as an approval the operator can answer from C.
   * @param {any} props
   * @param {string} sessionId
   * @param {string|undefined} taskId
   * @param {((ev:any)=>void)|undefined} onEvent
   */
  #parkPermission(props, sessionId, taskId, onEvent) {
    const requestId = String(props.id ?? '');
    const options = [
      { optionId: 'allow_once', kind: 'allow_once', name: '允许一次' },
      { optionId: 'allow_always', kind: 'allow_always', name: '总是允许' },
      { optionId: 'deny', kind: 'reject_once', name: '拒绝' },
    ];
    const record = {
      // Globally unique: opencode permission ids (`per_...`) are only unique within
      // one server run, so a derived id could collide with a stored row and hide the
      // new request behind the approvals primary key.
      id: newId('appr'),
      requestId,
      nodeId: this.node.id,
      taskId: taskId ?? null,
      sessionId,
      title: `opencode permission: ${props.permission ?? '?'}${Array.isArray(props.patterns) && props.patterns.length ? ` (${props.patterns.join(', ')})` : ''}`,
      toolCallId: props.tool?.callID ?? null,
      options,
      policy: this.permissionPolicy,
      requestedAt: new Date().toISOString(),
    };
    this.parked.set(requestId, { record, sessionId, permissionId: requestId });

    const policy = this.permissionPolicy;
    const auto =
      policy === 'allow-once' ? 'once' : policy === 'allow-always' ? 'always' : policy === 'deny' ? 'reject' : null;

    if (auto) {
      const ev = makeEvent({
        nodeId: this.node.id,
        taskId: taskId ?? null,
        type: EventType.APPROVAL_RESOLVED,
        text: `auto ${auto}: ${record.title}`,
        data: { ...record, optionId: REPLY_TO_OPTION[auto] || auto, auto: true },
      });
      this.emit(ev);
      // Fire and forget: the agent is blocked until this lands.
      void this.answerPermission(sessionId, requestId, auto).catch(() => {});
      this.parked.delete(requestId);
      return;
    }

    const ev = makeEvent({
      nodeId: this.node.id,
      taskId: taskId ?? null,
      type: EventType.APPROVAL_REQUESTED,
      text: `needs approval: ${record.title}`,
      data: record,
    });
    this.emit(ev);
  }

  /** @returns {any[]} */
  listParked() {
    return [...this.parked.values()].map((p) => p.record);
  }

  /**
   * @param {any} requestId
   * @param {string|null} optionId
   * @returns {boolean}
   */
  resolveApproval(requestId, optionId) {
    const entry = this.parked.get(String(requestId));
    if (!entry) return false;
    this.parked.delete(String(requestId));
    const reply = optionId ? OPTION_TO_REPLY[optionId] || 'reject' : 'reject';
    void this.answerPermission(entry.sessionId, entry.permissionId, reply).catch((err) => {
      this.emit(makeEvent({ nodeId: this.node.id, taskId: entry.record.taskId, type: EventType.ERROR, text: `failed to answer opencode permission: ${err.message}` }));
    });
    this.emit(
      makeEvent({
        nodeId: this.node.id,
        taskId: entry.record.taskId,
        type: EventType.APPROVAL_RESOLVED,
        text: `answered ${reply}`,
        data: { ...entry.record, optionId: optionId ?? null },
      }),
    );
    return true;
  }

  /**
   * @param {string} sessionId
   * @param {string} permissionId
   * @param {'once'|'always'|'reject'} response
   */
  async answerPermission(sessionId, permissionId, response) {
    return postJson({
      url: this.#path('permissionAnswer', { id: sessionId, permissionID: permissionId }),
      // v1.18.31 accepts ONLY `response` (additionalProperties: false).
      body: { response },
      headers: this.#headers(),
      timeoutMs: 30_000,
    });
  }

  /**
   * @param {string} sessionId
   */
  async cancel(sessionId) {
    return postJson({ url: this.#path('sessionAbort', { id: sessionId }), body: undefined, headers: this.#headers(), timeoutMs: 30_000 });
  }

  async disconnect() {
    this.parked.clear();
  }
}

/**
 * Pull assistant text out of a synchronous `POST /session/:id/message` response:
 * `{info: AssistantMessage, parts: Part[]}`.
 * @param {any} res
 * @returns {string}
 */
export function extractOpencodeText(res) {
  if (!res) return '';
  if (Array.isArray(res)) return res.map(extractOpencodeText).filter(Boolean).join('\n');
  if (Array.isArray(res.parts)) {
    return res.parts
      .filter((/** @type {any} */ p) => p?.type === 'text')
      .map((/** @type {any} */ p) => String(p.text ?? ''))
      .join('');
  }
  if (typeof res.text === 'string') return res.text;
  return '';
}
