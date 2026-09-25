// Tests for console authentication (src/core/auth.js + the gate in src/web/server.js).
//
// The console can dispatch tasks to every registered agent, approve the dangerous ones and rewrite
// the node registry. Bound to loopback that is fine — the operator *is* the boundary — but the
// moment it is reachable from another machine it has to be worth something, and "worth something"
// is a set of specific properties rather than the presence of a login form:
//
//   * every route is closed, including `/api/stream`, which is the one that leaks the most and the
//     one a per-route gate always forgets
//   * signing out ends the **live** stream, not just the cookie
//   * changing a password ends the sessions issued under the old one, across processes
//   * "no such user" and "wrong password" are indistinguishable
//   * it cannot be turned off by a flag, and it fails closed when the accounts file is unreadable
//   * a public bind with no accounts refuses to start
//
// Run: node test/auth.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  setUserPassword,
  verifyPassword,
  listUsers,
  removeUser,
  readUsers,
  usersPath,
  isLoopbackHost,
  AccountDirectory,
  SessionStore,
  LoginThrottle,
  MIN_PASSWORD_LENGTH,
} from '../src/core/auth.js';

const GOOD = 'correct-horse-battery';

/** A throwaway AGENTMESH_HOME. Nothing here may ever touch the operator's real one. */
function freshHome() {
  const home = mkdtempSync(join(tmpdir(), 'agentmesh-auth-'));
  process.env.AGENTMESH_HOME = home;
  return home;
}

const CONSOLES = [];
/** Start a console against a throwaway home. `host` is a parameter because the bind guard is itself
 * part of what is being tested. */
async function console_({ host = '127.0.0.1', users = { tester: GOOD }, password, sessionTtlMs } = {}) {
  const home = freshHome();
  for (const [name, pw] of Object.entries(users)) setUserPassword(name, pw);
  const { createConsole } = await import(`../src/web/server.js?home=${encodeURIComponent(home)}`);
  const c = await createConsole({ port: 0, host, sessionTtlMs });
  CONSOLES.push(c);
  const url = c.url;
  /** @param {string} p @param {any} [init] */
  const raw = (p, init = {}) => fetch(url + p, init);
  /** @param {string} p @param {any} [init] */
  const anon = async (p, init = {}) => {
    const res = await raw(p, init);
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body, res };
  };
  /** Sign in for real and keep the cookie. */
  const signIn = async (user = 'tester', pw = GOOD) => {
    const res = await raw('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user, password: pw }),
    });
    const setCookie = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
    return { status: res.status, body: await res.json().catch(() => null), setCookie, rawCookie: setCookie[0] ?? '' };
  };
  const cookieOf = (setCookie) => setCookie.map((v) => String(v).split(';')[0]).join('; ');
  return { home, url, console: c, anon, raw, signIn, cookieOf, close: () => c.close() };
}

test.after(() => {
  for (const c of CONSOLES) c.close().catch(() => {});
  rmSync(process.env.AGENTMESH_HOME ?? '', { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The accounts file
// ---------------------------------------------------------------------------

test('a password is stored as a hash, and the file never contains it', () => {
  const home = freshHome();
  try {
    const { path, created } = setUserPassword('yanyu', GOOD);
    assert.equal(created, true);
    assert.equal(path, usersPath());

    const bytes = readFileSync(path, 'utf8');
    assert.ok(!bytes.includes(GOOD), 'the password itself must never be written');
    // Not a reversible encoding of it either — this is the whole difference from secrets.env, where
    // an SSH password has to be recoverable because `ssh` needs it.
    assert.ok(!bytes.includes(Buffer.from(GOOD).toString('hex')), 'not a hex copy either');
    assert.ok(!bytes.includes(Buffer.from(GOOD).toString('base64')), 'not a base64 copy either');

    const rec = JSON.parse(bytes).users.yanyu;
    assert.match(rec.hash, /^[0-9a-f]{128}$/, 'scrypt output, 64 bytes');
    assert.match(rec.salt, /^[0-9a-f]{32}$/);
    assert.ok(rec.changedAt, 'a change stamp is what lets a running console revoke sessions');

    // And it verifies.
    assert.equal(verifyPassword('yanyu', GOOD).ok, true);
    assert.equal(verifyPassword('yanyu', GOOD + 'x').ok, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the accounts file is not readable by other users', () => {
  const home = freshHome();
  try {
    const { path } = setUserPassword('yanyu', GOOD);
    // POSIX only; on Windows the profile ACL is the protection and this assertion is skipped rather
    // than faked, because a chmod that silently does nothing is worse than no claim at all.
    if (process.platform !== 'win32') {
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }
    assert.ok(readFileSync(path, 'utf8').length > 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a weak or malformed password is refused with a reason', () => {
  const home = freshHome();
  try {
    assert.throws(() => setUserPassword('yanyu', 'short'), new RegExp(`${MIN_PASSWORD_LENGTH} characters`));
    assert.throws(() => setUserPassword('yanyu', '1234567'), new RegExp(`${MIN_PASSWORD_LENGTH} characters`));
    assert.throws(() => setUserPassword('yanyu', '        '), /whitespace|at least/);
    assert.throws(() => setUserPassword('yanyu', GOOD + ' '), /whitespace/);
    assert.throws(() => setUserPassword('bad name', GOOD), /invalid user name/);
    assert.throws(() => setUserPassword('', GOOD), /invalid user name/);
    assert.throws(() => setUserPassword('-leading', GOOD), /invalid user name/);
    // Nothing was created by any of the failures.
    assert.deepEqual(listUsers(), []);
    // And exactly at the floor is accepted, so the boundary is where it says it is.
    assert.equal(setUserPassword('yanyu', 'x'.repeat(MIN_PASSWORD_LENGTH)).created, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the last account cannot be removed', () => {
  const home = freshHome();
  try {
    setUserPassword('a', GOOD);
    assert.throws(() => removeUser('a'), /only account/);
    setUserPassword('b', GOOD);
    assert.equal(removeUser('a'), true);
    assert.deepEqual(listUsers().map((u) => u.name), ['b']);
    // Re-adding replaces the hash and keeps the creation date.
    const before = listUsers()[0].createdAt;
    assert.equal(setUserPassword('b', 'another-long-one').created, false);
    assert.equal(listUsers()[0].createdAt, before);
    assert.equal(verifyPassword('b', 'another-long-one').ok, true);
    assert.equal(verifyPassword('b', GOOD).ok, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('an unreadable accounts file denies everyone instead of admitting everyone', () => {
  const home = freshHome();
  try {
    setUserPassword('yanyu', GOOD);
    writeFileSync(usersPath(), '{ this is not json', 'utf8');
    assert.throws(() => readUsers(), /cannot read the accounts file/);
    const dir = new AccountDirectory();
    assert.equal(dir.get('yanyu'), undefined, 'nobody is known');
    assert.equal(dir.size, 0);
    assert.equal(verifyPassword('yanyu', GOOD).ok, false, 'and the correct password still fails');
    assert.equal(verifyPassword('yanyu', GOOD).reason, 'unavailable');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('isLoopbackHost treats anything it does not recognise as public', () => {
  for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]', 'LOCALHOST']) {
    assert.equal(isLoopbackHost(h), true, `${h} is loopback`);
  }
  for (const h of ['0.0.0.0', '192.168.10.22', '::', '', undefined, 'example.com', '10.0.0.1']) {
    assert.equal(isLoopbackHost(h), false, `${h} must count as public`);
  }
  // The prefix-test trap: these are ordinary resolvable names, and a `startsWith('127.')` check
  // would classify them as "this machine only" and let them start with no accounts at all.
  for (const h of ['127.0.0.1.evil.com', '127.evil.com', '127.0.0.256', '1270.0.0.1', 'localhost.evil.com']) {
    assert.equal(isLoopbackHost(h), false, `${h} must count as public`);
  }
  assert.equal(isLoopbackHost('127.255.255.254'), true, 'the whole 127/8 block is loopback');
});

// ---------------------------------------------------------------------------
// Sessions and throttling, as units
// ---------------------------------------------------------------------------

test('a session expires, slides while in use, and can be destroyed', async () => {
  const s = new SessionStore({ ttlMs: 60 });
  const { token } = s.create('a');
  assert.equal(s.get(token)?.user, 'a');
  assert.equal(s.destroy(token), true);
  assert.equal(s.get(token), null, 'a destroyed session is gone, which is what makes logout real');
  assert.equal(s.destroy(token), false);

  const short = new SessionStore({ ttlMs: 20 });
  const t2 = short.create('b').token;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(short.get(t2), null, 'an expired session is refused');

  // The cap holds, so a loop of sign-ins cannot grow the map without bound.
  const capped = new SessionStore({ ttlMs: 1000, max: 3 });
  for (let i = 0; i < 10; i += 1) capped.create('c');
  assert.equal(capped.size, 3);

  const perUser = new SessionStore();
  const x = perUser.create('d').token;
  const y = perUser.create('d').token;
  assert.equal(perUser.destroyUser('d'), 2);
  assert.equal(perUser.get(x), null);
  assert.equal(perUser.get(y), null);
});

test('failed sign-ins lock both the account and the address', () => {
  const t = new LoginThrottle({ max: 3, windowMs: 1000, lockMs: 1000 });
  assert.equal(t.check('u:a', 'ip:1').locked, false);
  t.fail('u:a', 'ip:1');
  t.fail('u:a', 'ip:1');
  assert.equal(t.check('u:a', 'ip:1').locked, false, 'two is under the limit of three');
  t.fail('u:a', 'ip:1');
  assert.equal(t.check('u:a', 'ip:1').locked, true);
  assert.ok(t.check('u:a', 'ip:1').retryAfterSec >= 1);

  // Either counter tripping blocks, deliberately. The account name is keyed so a spread-out attempt
  // on one account cannot run unthrottled; the address is keyed so one address cannot keep guessing
  // across account names. The accepted cost is that a known account name can be locked for the lock
  // window by failing a few times — cheap for the operator to wait out, and much cheaper than the
  // alternative of no account-level limit at all.
  assert.equal(t.check('u:a', 'ip:2').locked, true, 'the account counter alone is enough');
  assert.equal(t.check('u:other', 'ip:1').locked, true, 'the address counter alone is enough');
  assert.equal(t.check('u:other', 'ip:2').locked, false, 'a different account from elsewhere is fine');

  t.succeed('u:a', 'ip:1');
  assert.equal(t.check('u:a', 'ip:1').locked, false, 'a good password clears the count');
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test('with no accounts the console stays open on loopback', async () => {
  const c = await console_({ users: {} });
  try {
    const { status, body } = await c.anon('/api/nodes');
    assert.equal(status, 200, 'loopback with no accounts is the pre-auth behaviour, unchanged');
    assert.ok(Array.isArray(body));
    const s = await c.anon('/api/session');
    assert.deepEqual(s.body, { authenticated: true, authRequired: false, user: null, expiresAt: null });
    // `/login` has nothing to ask, so it does not ask.
    const login = await c.raw('/login', { redirect: 'manual' });
    assert.equal(login.status, 302);
    assert.equal(login.headers.get('location'), '/');
  } finally {
    await c.close();
  }
});

test('every route is closed without a session — including the event stream', async () => {
  const c = await console_();
  try {
    // The page itself.
    const page = await c.raw('/', { redirect: 'manual' });
    assert.equal(page.status, 302);
    assert.equal(page.headers.get('location'), '/login?next=%2F');

    // And every API route, which is the part that matters: the page is a document, these are the
    // fleet. `/api/stream` is listed explicitly because it is the one a per-route gate forgets and
    // the one that would hand over every event, task and approval as it happens.
    for (const p of [
      '/api/status',
      '/api/nodes',
      '/api/tasks',
      '/api/events',
      '/api/stream',
      '/api/agent/config',
      '/api/agent/models',
      '/api/approvals',
    ]) {
      const r = await c.anon(p);
      assert.equal(r.status, 401, `${p} must require a session`);
      assert.equal(r.body.error, 'sign in first');
    }

    // State-changing ones too, and they must be refused before doing anything.
    for (const [p, body] of [
      ['/api/send', { node: 'x', prompt: 'y' }],
      ['/api/nodes', { name: 'x', transport: 'a2a', url: 'http://127.0.0.1:1' }],
      ['/api/agent', { prompt: 'hi' }],
      ['/api/cancel', { taskId: 't' }],
    ]) {
      const r = await c.anon(p, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(r.status, 401, `${p} must require a session`);
    }

    // A 404 route is not a way around it either.
    const nowhere = await c.anon('/api/nope');
    assert.equal(nowhere.status, 401, 'an unknown path is still behind the gate');
  } finally {
    await c.close();
  }
});

test('signing in returns a cookie with the attributes that make it a session', async () => {
  const c = await console_();
  try {
    const bad = await c.signIn('tester', 'wrong-password-here');
    assert.equal(bad.status, 401);
    assert.deepEqual(bad.setCookie, [], 'a failed sign-in sets no cookie at all');

    const good = await c.signIn();
    assert.equal(good.status, 200);
    assert.equal(good.body.user, 'tester');
    assert.match(good.rawCookie, /^mesh_session=/);
    assert.match(good.rawCookie, /HttpOnly/, 'script on the page must not read it');
    assert.match(good.rawCookie, /SameSite=Lax/, 'the main CSRF defence');
    assert.match(good.rawCookie, /Path=\//);
    // NOT Secure on plain HTTP. Marking it Secure here looks stricter and produces a cookie the
    // browser drops, so sign-in appears to succeed and every later request is anonymous.
    assert.doesNotMatch(good.rawCookie, /Secure/, 'Secure on plain HTTP would silently break sign-in');

    const authed = await c.raw('/api/nodes', { headers: { cookie: c.cookieOf(good.setCookie) } });
    assert.equal(authed.status, 200, 'the cookie is what opens the console');
  } finally {
    await c.close();
  }
});

test('behind a TLS proxy the cookie is marked Secure', async () => {
  const c = await console_();
  try {
    const res = await c.raw('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ user: 'tester', password: GOOD }),
    });
    assert.equal(res.status, 200);
    const setCookie = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
    assert.match(String(setCookie[0]), /Secure/);
  } finally {
    await c.close();
  }
});

test('an unknown account and a wrong password are indistinguishable', async () => {
  const c = await console_();
  try {
    const unknown = await c.signIn('no-such-person', GOOD);
    const wrong = await c.signIn('tester', 'not-the-password');
    assert.equal(unknown.status, 401);
    assert.equal(wrong.status, 401);
    assert.deepEqual(
      unknown.body,
      wrong.body,
      'differing answers here would hand an attacker the account list',
    );
    assert.deepEqual(unknown.setCookie, wrong.setCookie);
  } finally {
    await c.close();
  }
});

test('repeated failures lock the account out, and a success clears it', async () => {
  const c = await console_();
  try {
    let last;
    for (let i = 0; i < 6; i += 1) last = await c.signIn('tester', 'wrong-password-here');
    assert.equal(last.status, 429, 'guessing has to get slower than the guesser');
    assert.equal(last.setCookie.length, 0);
    // Even the right password is refused while the lock holds — otherwise the lock is decorative.
    const right = await c.signIn('tester', GOOD);
    assert.equal(right.status, 429);
  } finally {
    await c.close();
  }
});

test('a password change ends the sessions issued under the old one', async () => {
  const c = await console_();
  try {
    const { setCookie } = await c.signIn();
    const cookie = c.cookieOf(setCookie);
    assert.equal((await c.raw('/api/nodes', { headers: { cookie } })).status, 200);

    // `mesh auth passwd` runs in a different process; the file is the only channel between them.
    // Written from here to keep the test synchronous, which is the harder case for any cache.
    setUserPassword('tester', 'a-brand-new-password');

    const after = await c.raw('/api/nodes', { headers: { cookie } });
    assert.equal(after.status, 401, 'a session for a password that no longer exists must stop working');

    const fresh = await c.signIn('tester', 'a-brand-new-password');
    assert.equal(fresh.status, 200, 'and the new password works');
  } finally {
    await c.close();
  }
});

test('signing out ends the session and closes the live stream', async () => {
  const c = await console_();
  try {
    const { setCookie } = await c.signIn();
    const cookie = c.cookieOf(setCookie);

    // Open a real SSE stream and read its headers, so we know it is live.
    const ac = new AbortController();
    const stream = await c.raw('/api/stream', { headers: { cookie }, signal: ac.signal });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type') || '', /text\/event-stream/);
    const reader = stream.body.getReader();
    await reader.read(); // the `retry:` preamble

    const res = await c.raw('/api/logout', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 200);

    // The stream must actually end. An SSE connection outlives the request that opened it, so
    // without closing it "sign out" would leave a browser receiving every task and approval while
    // the header claimed it was signed out.
    const closed = await Promise.race([
      reader.read().then((r) => r.done).catch(() => true),
      new Promise((r) => setTimeout(() => r('timeout'), 3000)),
    ]);
    assert.equal(closed, true, 'signing out must close the stream, not just the cookie');

    const after = await c.raw('/api/nodes', { headers: { cookie } });
    assert.equal(after.status, 401, 'and the cookie is dead');
    ac.abort();
  } finally {
    await c.close();
  }
});

test('a state-changing request must be JSON from this console', async () => {
  const c = await console_();
  try {
    const cookie = c.cookieOf((await c.signIn()).setCookie);

    // A cross-site <form> cannot send application/json — that is the whole defence. It can send
    // these, so these are refused.
    for (const type of ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain', '']) {
      const res = await c.raw('/api/nodes', {
        method: 'POST',
        headers: { cookie, ...(type ? { 'content-type': type } : {}) },
        body: 'name=x',
      });
      assert.equal(res.status, 415, `content-type ${type || '(none)'} must not be accepted`);
    }

    // And an Origin that is not this console is refused even with a valid content type.
    const cross = await c.raw('/api/nodes', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ name: 'x', transport: 'a2a', url: 'http://127.0.0.1:1' }),
    });
    assert.equal(cross.status, 415);
    assert.match((await cross.json()).error, /does not match/);

    // Same origin is fine, and so is no Origin (curl, the tests, a CLI).
    const same = await c.raw('/api/nodes', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: `http://127.0.0.1:${c.console.port}` },
      body: JSON.stringify({ name: 'from-origin', transport: 'a2a', url: 'http://127.0.0.1:1' }),
    });
    assert.equal(same.status, 201);
  } finally {
    await c.close();
  }
});

test('sign-in cannot be used as an open redirect', async () => {
  const c = await console_();
  try {
    // The redirect only happens for someone already signed in, which is the case that matters:
    // they follow a link, sign in for real, and must not be handed to another site afterwards.
    const cookie = c.cookieOf((await c.signIn()).setCookie);
    // Allowing these would let a phishing link wear this console's address.
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', '/a\\b']) {
      const res = await c.raw(`/login?next=${encodeURIComponent(bad)}`, { redirect: 'manual', headers: { cookie } });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/', `next=${bad} must not be honoured`);
    }
    const good = await c.raw('/login?next=%2Fapi%2Ftasks', { redirect: 'manual', headers: { cookie } });
    assert.equal(good.headers.get('location'), '/api/tasks', 'a path on this console is honoured');

    // Signed out, /login is the form rather than a redirect, so there is nothing to misdirect.
    const anon = await c.raw('/login?next=https://evil.example', { redirect: 'manual' });
    assert.equal(anon.status, 200);
  } finally {
    await c.close();
  }
});

test('an anonymous visitor gets the sign-in page and learns nothing about the fleet', async () => {
  const c = await console_();
  try {
    const login = await c.anon('/login');
    assert.equal(login.status, 200);
    assert.match(String(login.body), /<form/);
    assert.match(String(login.body), /name="user"/);
    assert.match(String(login.body), /name="password"/);
    assert.match(String(login.body), /autocomplete="current-password"/, 'password managers must work');
    // The sign-in page obeys the console's own presentation rules — it is the page where a defect
    // costs the most, because a wrong-looking sign-in page is how a password gets typed into
    // something that is not this console.
    const inline = [...String(login.body).matchAll(/<[^>]*\sstyle="([^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(inline, [], `presentation must live in the stylesheet, found: ${inline.join(' | ')}`);
    for (const id of ['user', 'password', 'go', 'err']) {
      assert.ok(String(login.body).includes(`id="${id}"`), `the sign-in page must have #${id}`);
    }
    assert.ok(!/<input[^>]+value="/.test(String(login.body)), 'no field may be pre-filled');

    // The page's own script must compile. `check:ui` does this for the console page; without it
    // here, a typo in the sign-in script would be a button that silently does nothing, with the
    // browser console as the only place the reason appears.
    const script = /<script>([\s\S]*?)<\/script>/.exec(String(login.body));
    assert.ok(script, 'the sign-in page must carry its own script');
    await import(`data:text/javascript;base64,${Buffer.from(script[1]).toString('base64')}`)
      .then(() => {})
      .catch((err) => {
        // No DOM in Node, so a runtime error about `document` is expected; a SyntaxError is not.
        assert.ok(
          !(err instanceof SyntaxError),
          `the sign-in script must parse: ${err.message}`,
        );
      });
    // The console's own page is not what an anonymous visitor receives, so nothing about the nodes,
    // the store paths or the panels leaks through the page source.
    assert.ok(!String(login.body).includes('a-host'), 'the sign-in page is not the console page');
    assert.ok(!String(login.body).includes('lc-key'));

    const health = await c.anon('/healthz');
    assert.equal(health.status, 200, 'a monitor needs no credential');
    assert.equal(health.body.ok, true);
    assert.equal(health.body.nodes, undefined, 'but the node count is not a health check\'s business');
    assert.equal(health.body.pid, undefined);

    const session = await c.anon('/api/session');
    assert.equal(session.body.authenticated, false);
    assert.equal(session.body.authRequired, true);
    assert.equal(session.body.user, null);

    // Signed in, the same route does report the fleet.
    const cookie = c.cookieOf((await c.signIn()).setCookie);
    const authed = await c.raw('/healthz', { headers: { cookie } });
    const authedBody = await authed.json();
    assert.equal(typeof authedBody.nodes, 'number');
    assert.equal(typeof authedBody.pid, 'number');
  } finally {
    await c.close();
  }
});

test('adding the first account locks a running console without a restart', async () => {
  const c = await console_({ users: {} });
  try {
    assert.equal((await c.anon('/api/nodes')).status, 200, 'open to begin with');

    setUserPassword('late', GOOD);

    assert.equal((await c.anon('/api/nodes')).status, 401, 'and locked the moment an account exists');
    const signedIn = await c.signIn('late', GOOD);
    assert.equal(signedIn.status, 200);
    assert.equal((await c.raw('/api/nodes', { headers: { cookie: c.cookieOf(signedIn.setCookie) } })).status, 200);
  } finally {
    await c.close();
  }
});

// ---------------------------------------------------------------------------
// It cannot be started open
// ---------------------------------------------------------------------------

test('a public bind with no accounts refuses to start, and says how to fix it', async () => {
  freshHome();
  const { createConsole } = await import(`../src/web/server.js?home=none`);
  for (const host of ['0.0.0.0', '192.168.10.22', '::', 'example.com', '']) {
    await assert.rejects(
      () => createConsole({ port: 0, host }),
      /refusing to serve the console on .* with no accounts/s,
      `host ${JSON.stringify(host)} must not start unauthenticated`,
    );
  }
  // The message has to carry the fix, not just the refusal.
  await assert.rejects(() => createConsole({ port: 0, host: '0.0.0.0' }), /mesh auth add/);
});

test('an unreadable accounts file stops the server rather than opening it', async () => {
  const home = freshHome();
  try {
    setUserPassword('yanyu', GOOD);
    writeFileSync(usersPath(), 'not json at all', 'utf8');
    const { createConsole } = await import(`../src/web/server.js?home=broken`);
    await assert.rejects(() => createConsole({ port: 0, host: '127.0.0.1' }), /Refusing to start rather than starting open/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('with an account, a public bind does start — and warns about plain HTTP', async () => {
  const c = await console_({ host: '0.0.0.0' });
  try {
    assert.equal(c.console.auth.required, true);
    assert.ok(c.console.auth.users.includes('tester'));
    // Still closed to the network.
    assert.equal((await c.anon('/api/nodes')).status, 401);
    // And the sign-in page is reachable, or this would be a console nobody can enter.
    assert.equal((await c.anon('/login')).status, 200);
  } finally {
    await c.close();
  }
});
