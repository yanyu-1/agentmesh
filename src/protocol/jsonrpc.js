/**
 * A minimal, transport-agnostic JSON-RPC 2.0 peer.
 *
 * Both protocols AgentMesh speaks use JSON-RPC 2.0:
 *   - ACP  over stdio (newline-delimited JSON)
 *   - A2A  over HTTP (one request per POST) and SSE for streaming
 *
 * This class only implements correlation + dispatch; framing and IO live in the
 * transports. It is bidirectional on purpose: ACP agents send *requests* back to
 * the client (`session/request_permission`, `fs/*`, `terminal/*`).
 *
 * @module protocol/jsonrpc
 */

export const ErrorCodes = /** @type {const} */ ({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // ACP/JSON-RPC application-level
  REQUEST_CANCELLED: -32800,
  AUTH_REQUIRED: -32000,
  RESOURCE_NOT_FOUND: -32002,
});

export class JsonRpcError extends Error {
  /**
   * @param {number} code
   * @param {string} message
   * @param {any} [data]
   */
  constructor(code, message, data) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
    this.data = data;
  }
}

/**
 * @typedef {object} JsonRpcPeerOptions
 * @property {(msg: object) => void|Promise<void>} send  how to write a message to the wire
 * @property {string} [name]                              label used in error messages
 * @property {number} [defaultTimeoutMs]                  0 = no timeout
 * @property {(err: Error) => void} [onError]
 */

export class JsonRpcPeer {
  /** @type {Map<string|number, {resolve:(v:any)=>void, reject:(e:Error)=>void, timer:any, method:string}>} */
  #pending = new Map();
  /** @type {Map<string, (params:any, ctx:{id:any,method:string})=>any>} */
  #requestHandlers = new Map();
  /** @type {Map<string, (params:any)=>void>} */
  #notificationHandlers = new Map();
  /** @type {Set<(reason:string)=>void>} */
  #closeHandlers = new Set();
  #nextId = 1;
  #closed = false;
  /** @type {string|null} */
  #closeReason = null;

  /**
   * @param {JsonRpcPeerOptions} opts
   */
  constructor({ send, name = 'peer', defaultTimeoutMs = 0, onError }) {
    this.send = send;
    this.name = name;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.onError = onError || (() => {});
  }

  get closed() {
    return this.#closed;
  }

  get closeReason() {
    return this.#closeReason;
  }

  /** Number of in-flight outbound requests (useful for liveness/debug output). */
  get pendingCount() {
    return this.#pending.size;
  }

  /**
   * Send a request and await its result.
   * @param {string} method
   * @param {any} [params]
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [opts]
   * @returns {Promise<any>}
   */
  request(method, params, opts = {}) {
    if (this.#closed) {
      return Promise.reject(new JsonRpcError(ErrorCodes.INTERNAL_ERROR, `${this.name} is closed (${this.#closeReason})`));
    }
    const id = this.#nextId++;
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    return new Promise((resolve, reject) => {
      /** @type {any} */
      let timer = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        this.#pending.delete(id);
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        cleanup();
        // Best-effort protocol-level cancel; ACP defines $/cancel_request.
        this.notify('$/cancel_request', { requestId: id }).catch(() => {});
        reject(new JsonRpcError(ErrorCodes.REQUEST_CANCELLED, `${method} aborted`));
      };
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          cleanup();
          reject(new JsonRpcError(ErrorCodes.INTERNAL_ERROR, `${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }
      if (opts.signal) {
        if (opts.signal.aborted) return onAbort();
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
      this.#pending.set(id, { resolve, reject, timer, method });
      // Write synchronously: ordering matters on a single stdio pipe. If this
      // were deferred to a microtask, a `notify()` issued right after `request()`
      // (e.g. session/cancel straight after session/prompt) could hit the wire first.
      try {
        const maybe = this.send({ jsonrpc: '2.0', id, method, params: params ?? {} });
        if (maybe && typeof maybe.then === 'function') {
          maybe.catch((err) => {
            cleanup();
            reject(err instanceof Error ? err : new Error(String(err)));
          });
        }
      } catch (err) {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Send a notification (no response expected).
   * @param {string} method
   * @param {any} [params]
   * @returns {Promise<void>}
   */
  async notify(method, params) {
    if (this.#closed) return;
    await this.send({ jsonrpc: '2.0', method, params: params ?? {} });
  }

  /**
   * Register a handler for an inbound request from the peer.
   * Return a value to respond with `result`; throw `JsonRpcError` to respond with `error`.
   * @param {string} method
   * @param {(params:any, ctx:{id:any,method:string})=>any} handler
   */
  onRequest(method, handler) {
    this.#requestHandlers.set(method, handler);
    return this;
  }

  /**
   * Register a handler for an inbound notification.
   * @param {string} method
   * @param {(params:any)=>void} handler
   */
  onNotification(method, handler) {
    this.#notificationHandlers.set(method, handler);
    return this;
  }

  /**
   * @param {(reason:string)=>void} cb
   */
  onClose(cb) {
    this.#closeHandlers.add(cb);
    return this;
  }

  /**
   * Feed one decoded inbound JSON-RPC message into the peer.
   * @param {any} msg
   */
  accept(msg) {
    if (!msg || typeof msg !== 'object') return;
    // --- response to one of our requests -------------------------------------
    if (msg.id !== undefined && msg.id !== null && (msg.result !== undefined || msg.error !== undefined) && msg.method === undefined) {
      const entry = this.#pending.get(msg.id);
      if (!entry) return; // late/duplicate response; ignore
      this.#pending.delete(msg.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (msg.error) {
        const e = msg.error || {};
        entry.reject(new JsonRpcError(typeof e.code === 'number' ? e.code : ErrorCodes.INTERNAL_ERROR, String(e.message ?? 'unknown error'), e.data));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    // --- inbound request from the peer ---------------------------------------
    if (typeof msg.method === 'string' && msg.id !== undefined && msg.id !== null) {
      const handler = this.#requestHandlers.get(msg.method);
      if (!handler) {
        this.#respondError(msg.id, ErrorCodes.METHOD_NOT_FOUND, `method not found: ${msg.method}`);
        return;
      }
      Promise.resolve()
        .then(() => handler(msg.params ?? {}, { id: msg.id, method: msg.method }))
        .then((result) => this.send({ jsonrpc: '2.0', id: msg.id, result: result ?? null }))
        .catch((err) => {
          if (err instanceof JsonRpcError) this.#respondError(msg.id, err.code, err.message, err.data);
          else this.#respondError(msg.id, ErrorCodes.INTERNAL_ERROR, err?.message ? String(err.message) : String(err));
        });
      return;
    }

    // --- inbound notification ------------------------------------------------
    if (typeof msg.method === 'string') {
      const handler = this.#notificationHandlers.get(msg.method);
      if (handler) {
        try {
          handler(msg.params ?? {});
        } catch (err) {
          this.onError(err instanceof Error ? err : new Error(String(err)));
        }
      }
      return;
    }
  }

  /**
   * Mark the peer closed and reject everything still in flight.
   * @param {string} [reason]
   */
  close(reason = 'closed') {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeReason = reason;
    for (const [, entry] of this.#pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new JsonRpcError(ErrorCodes.INTERNAL_ERROR, `${this.name} closed: ${reason}`));
    }
    this.#pending.clear();
    for (const cb of this.#closeHandlers) {
      try {
        cb(reason);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * @param {any} id
   * @param {number} code
   * @param {string} message
   * @param {any} [data]
   */
  #respondError(id, code, message, data) {
    const error = { code, message };
    if (data !== undefined) error.data = data;
    Promise.resolve()
      .then(() => this.send({ jsonrpc: '2.0', id, error }))
      .catch(() => {});
  }
}
