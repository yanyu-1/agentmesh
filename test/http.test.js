// Transport-level tests for src/core/transport/http.js.
//
// `describeFetchError` exists because a bare `TypeError: fetch failed` is useless: the
// real reason lives in `err.cause`, and the difference between ECONNREFUSED and
// ETIMEDOUT is the difference between "nothing is listening" and "a firewall is
// dropping your packets" — two completely different fixes. It was added while
// diagnosing a live A2A endpoint that was unreachable and reported only "fetch failed".
//
// Run: node test/http.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { authHeaders, describeFetchError, withTimeout, HttpError } from '../src/core/transport/http.js';

/**
 * Build the shape undici actually throws: a TypeError whose `cause` carries the code.
 * @param {string} code
 * @param {string} [message]
 */
function fetchFailure(code, message = 'fetch failed') {
  const err = new TypeError(message);
  // @ts-expect-error -- cause is set after construction, exactly as undici does
  err.cause = Object.assign(new Error(`connect ${code} 1.2.3.4:9900`), { code });
  return err;
}

// ---------------------------------------------------------------------------
// authHeaders
// ---------------------------------------------------------------------------

test('authHeaders: a token becomes a Bearer header', () => {
  assert.deepEqual(authHeaders({ token: 'secret' }), { Authorization: 'Bearer secret' });
});

test('authHeaders: a password becomes Basic, defaulting the user to opencode', () => {
  assert.deepEqual(authHeaders({ password: 'pw' }), {
    Authorization: `Basic ${Buffer.from('opencode:pw').toString('base64')}`,
  });
  assert.deepEqual(authHeaders({ username: 'me', password: 'pw' }), {
    Authorization: `Basic ${Buffer.from('me:pw').toString('base64')}`,
  });
});

test('authHeaders: a token wins over a password, and extra headers survive', () => {
  const h = authHeaders({ token: 't', password: 'p', extra: { 'A2A-Version': '1.0' } });
  assert.equal(h.Authorization, 'Bearer t');
  assert.equal(h['A2A-Version'], '1.0');
});

test('authHeaders: nothing configured is an empty header set', () => {
  assert.deepEqual(authHeaders(), {});
  assert.deepEqual(authHeaders({}), {});
});

// ---------------------------------------------------------------------------
// describeFetchError
// ---------------------------------------------------------------------------

test('ECONNREFUSED says the host answered but nothing is listening', () => {
  const out = describeFetchError(fetchFailure('ECONNREFUSED'), 'http://h:9900/card');
  assert.match(out.message, /ECONNREFUSED/);
  assert.match(out.message, /nothing is listening/);
  assert.match(out.message, /http:\/\/h:9900\/card/, 'the URL must be part of the message');
});

test('a connect timeout is reported as packets being DROPPED, not as a dead server', () => {
  for (const code of ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']) {
    const out = describeFetchError(fetchFailure(code), 'http://h:9900/card');
    assert.match(out.message, /DROPPING packets/, `${code} must be explained as a firewall symptom`);
    assert.match(out.message, /refused instead/, 'the contrast with a closed port is what makes it actionable');
  }
});

test('DNS failures are named as DNS failures', () => {
  assert.match(describeFetchError(fetchFailure('ENOTFOUND'), 'http://h/').message, /DNS could not resolve/);
  assert.match(describeFetchError(fetchFailure('EAI_AGAIN'), 'http://h/').message, /DNS lookup failed/);
});

test('an unknown code still surfaces the cause instead of the bare "fetch failed"', () => {
  const out = describeFetchError(fetchFailure('ESOMETHINGNEW'), 'http://h/');
  assert.match(out.message, /cannot reach http:\/\/h\//);
  assert.match(out.message, /ESOMETHINGNEW/, 'the underlying detail must not be swallowed');
});

test('an HttpError is passed through untouched', () => {
  const original = new HttpError(401, 'http://h/card', '{"error":"unauthorized"}');
  assert.equal(describeFetchError(original, 'http://h/card'), original);
});

test('an error with no cause is returned as-is, never rewritten', () => {
  const original = new Error('timed out after 15000ms');
  assert.equal(describeFetchError(original, 'http://h/'), original);
});

test('an abort is never rewritten into a reachability failure', () => {
  // A cancelled task must not be reported as "cannot reach http://…". Regression
  // guard for the misattribution class this function exists to eliminate.
  const abort = new Error('This operation was aborted');
  abort.name = 'AbortError';

  assert.equal(describeFetchError(abort, 'http://h/'), abort, 'a bare AbortError passes through');

  const wrapped = new TypeError('fetch failed');
  // @ts-expect-error -- undici wraps the abort reason in `cause`
  wrapped.cause = abort;
  assert.equal(describeFetchError(wrapped, 'http://h/'), wrapped, 'an AbortError hidden in cause also passes through');

  const viaCode = new Error('aborted');
  // @ts-expect-error -- Node exposes the abort code on the error itself
  viaCode.code = 'ABORT_ERR';
  assert.equal(describeFetchError(viaCode, 'http://h/'), viaCode);

  const timeoutAbort = new Error('The operation was aborted due to timeout');
  timeoutAbort.name = 'TimeoutError';
  assert.equal(describeFetchError(timeoutAbort, 'http://h/'), timeoutAbort, 'AbortSignal.timeout() reports TimeoutError');
});

// ---------------------------------------------------------------------------
// withTimeout
// ---------------------------------------------------------------------------

test('withTimeout aborts and reports the timeout', async () => {
  const { signal, cleanup, timedOut } = withTimeout(undefined, 20);
  assert.equal(timedOut(), false);
  await new Promise((resolve) => {
    signal?.addEventListener('abort', resolve, { once: true });
    setTimeout(resolve, 500); // safety net so a broken timer fails fast, not hangs
  });
  assert.equal(timedOut(), true, 'a fired timer must be distinguishable from a caller abort');
  assert.equal(signal?.aborted, true);
  cleanup();
});

test('withTimeout with no timeout leaves the caller signal alone', () => {
  const inner = new AbortController();
  const { signal, timedOut } = withTimeout(inner.signal, 0);
  assert.equal(signal, inner.signal, 'a zero timeout must not wrap the signal');
  assert.equal(timedOut(), false);
});

test('withTimeout propagates an external abort without claiming a timeout', async () => {
  const inner = new AbortController();
  const { signal, cleanup, timedOut } = withTimeout(inner.signal, 10_000);
  inner.abort(new Error('caller went away'));
  assert.equal(signal?.aborted, true);
  assert.equal(timedOut(), false, 'an operator cancel is not a timeout');
  cleanup();
});
