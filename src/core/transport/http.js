/**
 * HTTP transport: JSON-RPC POSTs, SSE streams, and a small auth helper.
 *
 * Uses global `fetch` (Node 18+). Note that on some locked-down Windows hosts the
 * OS TLS stack (schannel) is unusable while Node's bundled OpenSSL works fine —
 * which is exactly why this project uses fetch/undici rather than spawning curl.
 *
 * @module core/transport/http
 */

import { createSseParser } from '../../protocol/a2a.js';

export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} url
   * @param {string} body
   */
  constructor(status, url, body) {
    super(`HTTP ${status} from ${url}${body ? `: ${body.slice(0, 300)}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/**
 * Combine a caller signal with a timeout into one AbortSignal.
 * @param {AbortSignal|undefined} signal
 * @param {number} timeoutMs
 * @returns {{signal:AbortSignal|undefined, cleanup:()=>void, timedOut:()=>boolean}}
 */
export function withTimeout(signal, timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0) return { signal, cleanup: () => {}, timedOut: () => false };
  const ctl = new AbortController();
  let timedOut = false;
  const onAbort = () => ctl.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) ctl.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort(new Error(`timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    signal: ctl.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    },
    timedOut: () => timedOut,
  };
}

/**
 * @param {{username?:string, password?:string, token?:string, extra?:Record<string,string>}} auth
 * @returns {Record<string,string>}
 */
export function authHeaders(auth = {}) {
  /** @type {Record<string,string>} */
  const headers = { ...(auth.extra || {}) };
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  else if (auth.password) {
    const user = auth.username || 'opencode';
    headers.Authorization = `Basic ${Buffer.from(`${user}:${auth.password}`).toString('base64')}`;
  }
  return headers;
}

/**
 * Turn undici's opaque `fetch failed` into something an operator can act on.
 *
 * When a TCP connect never completes, `fetch` rejects with a bare `TypeError:
 * fetch failed` and hides the real reason in `err.cause`. Seeing only "fetch failed"
 * costs an operator the single most useful distinction there is:
 *
 *   - `ECONNREFUSED` — the packet REACHED the host and the host refused it: nothing
 *     is listening on that port (or it is bound to 127.0.0.1 only).
 *   - `ETIMEDOUT` / `UND_ERR_CONNECT_TIMEOUT` — nothing came back at all: something
 *     in front is DROPPING packets (cloud security group, iptables DROP). A closed
 *     port would have been refused instead, so this is a firewall, not a dead server.
 *   - `ENOTFOUND` / `EAI_AGAIN` — DNS, before any connection was attempted.
 *
 * The distinction is diagnostic gold: "connection timed out" and "connection refused"
 * mean completely different fixes.
 *
 * @param {unknown} err
 * @param {string} url
 * @returns {Error}
 */
export function describeFetchError(err, url) {
  if (err instanceof HttpError) return err;
  const message = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cause = /** @type {any} */ (err)?.cause;
  const code = cause?.code || cause?.errno || '';
  const detail = cause?.message || '';

  // An abort is a deliberate cancellation, not a reachability failure. Rewriting it
  // would report "cannot reach <url>" for a task the operator just cancelled — the
  // same class of misattribution this function exists to remove.
  const isAbort = (/** @type {any} */ e) =>
    Boolean(e) && (e.name === 'AbortError' || e.code === 'ABORT_ERR' || e.name === 'TimeoutError');
  if (isAbort(err) || isAbort(cause)) return err instanceof Error ? err : new Error(message);

  /** @type {Record<string,string>} */
  const hints = {
    ECONNREFUSED: 'the host answered but nothing is listening on that port (or the service is bound to 127.0.0.1 only)',
    ETIMEDOUT: 'the connection attempt timed out with no reply — a firewall or cloud security group is DROPPING packets to this port (a merely-closed port would be refused instead)',
    UND_ERR_CONNECT_TIMEOUT: 'the connection attempt timed out with no reply — a firewall or cloud security group is DROPPING packets to this port (a merely-closed port would be refused instead)',
    ENOTFOUND: 'DNS could not resolve this host',
    EAI_AGAIN: 'DNS lookup failed (temporary resolver failure)',
    ECONNRESET: 'the peer reset the connection',
    EHOSTUNREACH: 'no route to the host',
    ENETUNREACH: 'no route to the network',
    CERT_HAS_EXPIRED: 'the TLS certificate has expired',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'the TLS certificate is self-signed',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'the TLS certificate chain could not be verified',
  };

  const hint = hints[code];
  if (hint) return new Error(`cannot reach ${url}: ${code} — ${hint}`);
  if (cause && detail && detail !== message) return new Error(`cannot reach ${url}: ${message} (${detail})`);
  return err instanceof Error ? err : new Error(message);
}

/**
 * POST a JSON body and return the parsed JSON response.
 * @param {object} opts
 * @param {string} opts.url
 * @param {any} opts.body
 * @param {Record<string,string>} [opts.headers]
 * @param {number} [opts.timeoutMs]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<any>}
 */
export async function postJson({ url, body, headers = {}, timeoutMs = 0, signal }) {
  const { signal: sig, cleanup, timedOut } = withTimeout(signal, timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: sig,
    });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, url, text);
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`invalid JSON from ${url}: ${text.slice(0, 200)}`);
    }
  } catch (err) {
    if (timedOut()) throw new Error(`POST ${url} timed out after ${timeoutMs}ms`);
    throw describeFetchError(err, url);
  } finally {
    cleanup();
  }
}

/**
 * GET and parse JSON.
 * @param {object} opts
 * @param {string} opts.url
 * @param {Record<string,string>} [opts.headers]
 * @param {number} [opts.timeoutMs]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<any>}
 */
export async function getJson({ url, headers = {}, timeoutMs = 0, signal }) {
  const { signal: sig, cleanup, timedOut } = withTimeout(signal, timeoutMs);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: sig });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, url, text);
    return text ? JSON.parse(text) : null;
  } catch (err) {
    if (timedOut()) throw new Error(`GET ${url} timed out after ${timeoutMs}ms`);
    throw describeFetchError(err, url);
  } finally {
    cleanup();
  }
}

/**
 * GET a raw text body (used to sniff non-JSON error pages).
 * @param {object} opts
 * @param {string} opts.url
 * @param {Record<string,string>} [opts.headers]
 * @param {number} [opts.timeoutMs]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{status:number, ok:boolean, text:string, contentType:string}>}
 */
export async function getText({ url, headers = {}, timeoutMs = 15_000, signal }) {
  const { signal: sig, cleanup } = withTimeout(signal, timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: sig });
    return { status: res.status, ok: res.ok, text: await res.text(), contentType: res.headers.get('content-type') || '' };
  } catch (err) {
    throw describeFetchError(err, url);
  } finally {
    cleanup();
  }
}

/**
 * Stream Server-Sent Events from a GET or POST endpoint.
 *
 * Used for:
 *   - A2A `SendStreamingMessage` (POST, SSE response)
 *   - opencode `GET /event` (long-lived SSE)
 *
 * Resolves when the stream ends. `onFrame` gets `{event, data, id}` per SSE frame.
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {'GET'|'POST'} [opts.method]
 * @param {any} [opts.body]
 * @param {Record<string,string>} [opts.headers]
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.idleTimeoutMs]  abort when no bytes arrive for this long (0 = never)
 * @param {(frame:{event:string|null,data:string,id:string|null})=>void} opts.onFrame
 * @returns {Promise<{frames:number}>}
 */
export async function streamSse({ url, method = 'GET', body, headers = {}, signal, idleTimeoutMs = 0, onFrame }) {
  /** @type {AbortController} */
  const ctl = new AbortController();
  const onAbort = () => ctl.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) ctl.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  /** @type {any} */
  let idleTimer = null;
  const armIdle = () => {
    if (!idleTimeoutMs) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ctl.abort(new Error(`SSE idle for ${idleTimeoutMs}ms`)), idleTimeoutMs);
    if (typeof idleTimer.unref === 'function') idleTimer.unref();
  };

  try {
    armIdle();
    const res = await fetch(url, {
      method,
      headers: { accept: 'text/event-stream', 'cache-control': 'no-cache', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new HttpError(res.status, url, text);
    }
    if (!res.body) throw new Error(`no response body from ${url}`);

    const reader = res.body.getReader();
    const parser = createSseParser();
    const decoder = new TextDecoder();
    let frames = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdle();
      const chunk = decoder.decode(value, { stream: true });
      for (const frame of parser.push(chunk)) {
        frames += 1;
        onFrame(frame);
      }
    }
    for (const frame of parser.push(decoder.decode())) {
      frames += 1;
      onFrame(frame);
    }
    for (const frame of parser.flush()) {
      frames += 1;
      onFrame(frame);
    }
    return { frames };
  } catch (err) {
    throw describeFetchError(err, url);
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}
