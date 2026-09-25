/**
 * Console accounts: who may open the control plane.
 *
 * `mesh serve` binds to `127.0.0.1` by default, which is why this did not exist for so long — on a
 * single machine the operator *is* the network boundary. It stops being true the moment the console
 * is bound anywhere else, and at that point an unauthenticated console is worse than no console:
 * it can dispatch arbitrary tasks to arbitrary agents, approve the dangerous ones, and rewrite the
 * node registry. So the moment the bind address leaves loopback, accounts become mandatory rather
 * than optional (see `createConsole`, which refuses to start).
 *
 * Two decisions worth stating, because the obvious alternative is wrong in a way that is easy to
 * miss:
 *
 * **Passwords are hashed, and cannot be recovered.** This is the opposite of the rule in
 * `core/secrets.js`, and deliberately so. An SSH password has to be handed to `ssh`, so it must be
 * recoverable and is therefore plaintext in a 0600 file. A login password only has to be
 * *verified* — nothing ever needs it back — so storing it irreversibly is strictly better and costs
 * nothing. Putting both in one file would have meant the weaker rule for both.
 *
 * **Authentication cannot be disabled.** There is no `--no-auth` and no "skip if no users" path:
 * a server with no accounts refuses to bind a public interface, and a corrupt account file denies
 * everyone rather than admitting everyone. A flag that turns this off is a flag that ends up in a
 * service definition.
 *
 * The honest limit: this console speaks plain HTTP. Hashing protects the file, and the session
 * cookie protects the API, but **a password typed over plain HTTP crosses the network in the
 * clear**. Authentication here defends against casual access, not against an observer on the same
 * wire. See USAGE §7.8 for the tunnel and reverse-proxy options.
 *
 * @module core/auth
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

import { meshHome } from '../protocol/util.js';

/** Usernames appear in a JSON object and in a log line; keep them boring. */
const USER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

/**
 * A login password floor. Short enough not to be an obstacle for a local tool, long enough that it
 * is not the weak link once this console is reachable from another machine. Eight is the usual
 * minimum; the point of the constant is that it is enforced rather than assumed.
 */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * scrypt parameters. N=16384/r=8 needs 16 MiB, under Node's default `maxmem` of 32 MiB, and costs
 * tens of milliseconds — enough to make offline guessing expensive, not enough to make login feel
 * slow. Stored per user so the parameters can be raised later without invalidating old hashes.
 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/** @returns {string} path of the accounts file */
export function usersPath() {
  return join(meshHome(), 'console-users.json');
}

/** @param {unknown} name */
export function assertUserName(name) {
  const s = String(name ?? '');
  if (!USER_RE.test(s)) {
    throw new Error(
      `invalid user name ${JSON.stringify(s)}: use 1-32 characters from A-Z a-z 0-9 . _ - (must start with a letter or digit)`,
    );
  }
  return s;
}

/** @param {unknown} password */
export function assertPassword(password) {
  const s = String(password ?? '');
  if (s.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (/^\s|\s$/.test(s)) throw new Error('password must not begin or end with whitespace');
  return s;
}

/**
 * @typedef {object} StoredUser
 * @property {string} salt      hex
 * @property {string} hash      hex, scrypt(password, salt)
 * @property {string} createdAt ISO
 * @property {string} changedAt ISO — when the password last changed
 * @property {boolean} admin
 */

/**
 * Read the accounts file.
 *
 * Throws on anything unreadable or malformed. That is the point: every caller treats a throw as
 * "authenticate nobody", so a truncated file locks the console rather than opening it. A registry
 * that fails open would be the single worst bug this module could have.
 *
 * @param {{path?:string}} [opts]
 * @returns {{version:number, users:Record<string, StoredUser>}}
 */
export function readUsers(opts = {}) {
  const path = opts.path ?? usersPath();
  if (!existsSync(path)) return { version: 1, users: {} };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read the accounts file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.users !== 'object' || parsed.users === null) {
    throw new Error(`the accounts file ${path} is not in the expected shape ({"version":1,"users":{...}})`);
  }
  /** @type {Record<string, StoredUser>} */
  const users = {};
  for (const [name, entry] of Object.entries(parsed.users)) {
    const u = /** @type {any} */ (entry);
    if (!u || typeof u.hash !== 'string' || typeof u.salt !== 'string' || !u.hash || !u.salt) {
      throw new Error(`account '${name}' in ${path} has no usable password hash`);
    }
    users[name] = {
      salt: String(u.salt),
      hash: String(u.hash),
      createdAt: String(u.createdAt ?? ''),
      changedAt: String(u.changedAt ?? u.createdAt ?? ''),
      admin: u.admin !== false,
    };
  }
  return { version: 1, users };
}

/** @param {{version:number, users:Record<string, StoredUser>}} data @param {{path?:string}} [opts] */
function writeUsers(data, opts = {}) {
  const path = opts.path ?? usersPath();
  mkdirSync(dirname(path), { recursive: true });
  // Same protection as secrets.env, and for the same reason: the file is what stands between
  // anyone with a shell account on this machine and the whole fleet.
  writeFileSync(path, `${JSON.stringify({ version: 1, users: data.users }, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows: the ACL on the user profile is the protection */
  }
  return path;
}

/** @param {string} password @param {string} saltHex */
function derive(password, saltHex) {
  return scryptSync(password, Buffer.from(saltHex, 'hex'), SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
}

/**
 * A hash that no password matches, used to spend the same time on an unknown user as on a known
 * one. Without it, "no such user" returns in microseconds while a wrong password takes ~40ms, and
 * that difference alone enumerates the account names.
 */
const DUMMY_SALT = '00'.repeat(16);

/**
 * @param {string} name
 * @param {string} password
 * @param {{path?:string}} [opts]
 * @returns {{ok:boolean, user?:string, hash?:string, reason?:'unknown'|'bad-password'|'unavailable'}}
 */
export function verifyPassword(name, password, opts = {}) {
  const user = String(name ?? '');
  let record;
  let lookupFailed = false;
  try {
    record = readUsers(opts).users[user];
  } catch {
    // Fail closed. A console that cannot read its accounts must let nobody in.
    lookupFailed = true;
  }
  if (lookupFailed) return { ok: false, reason: 'unavailable' };

  const salt = record ? record.salt : DUMMY_SALT;
  let derived;
  try {
    derived = derive(String(password ?? ''), salt);
  } catch {
    return { ok: false, reason: 'bad-password' };
  }
  if (!record) {
    // The comparison is against a value it cannot equal, purely to have done the work.
    const dummy = Buffer.alloc(SCRYPT.keylen);
    timingSafeEqual(derived, dummy);
    return { ok: false, reason: 'unknown' };
  }
  const expected = Buffer.from(record.hash, 'hex');
  if (expected.length !== derived.length) return { ok: false, reason: 'bad-password' };
  // The hash is returned so the session can record what it was issued against. That is what makes
  // "changing the password ends the old sessions" exact rather than a timestamp comparison, which
  // is wrong for two writes inside the same millisecond.
  return timingSafeEqual(derived, expected) ? { ok: true, user, hash: record.hash } : { ok: false, reason: 'bad-password' };
}

/**
 * Create an account, or replace its password when it already exists.
 * @param {string} name
 * @param {string} password
 * @param {{path?:string, admin?:boolean, requireNew?:boolean}} [opts]
 * @returns {{path:string, created:boolean, user:string}}
 */
export function setUserPassword(name, password, opts = {}) {
  const user = assertUserName(name);
  assertPassword(password);
  const data = readUsers(opts);
  const exists = Boolean(data.users[user]);
  if (opts.requireNew && exists) throw new Error(`user '${user}' already exists (use: mesh auth passwd ${user})`);

  const salt = randomBytes(16).toString('hex');
  const now = new Date().toISOString();
  data.users[user] = {
    salt,
    hash: derive(password, salt).toString('hex'),
    createdAt: exists ? data.users[user].createdAt : now,
    // Stamped on every write, so a running console can tell that a session opened before this
    // moment belongs to a password that no longer exists. See AccountDirectory.isStale.
    changedAt: now,
    admin: opts.admin ?? data.users[user]?.admin ?? true,
  };
  const path = writeUsers(data, opts);
  return { path, created: !exists, user };
}

/**
 * @param {string} name
 * @param {{path?:string}} [opts]
 * @returns {boolean} whether an account was removed
 */
export function removeUser(name, opts = {}) {
  const user = assertUserName(name);
  const data = readUsers(opts);
  if (!data.users[user]) return false;
  // Removing the last account would leave a console that cannot be opened and cannot be fixed
  // without a shell on the machine. Refusing is kinder than succeeding.
  if (Object.keys(data.users).length === 1) {
    throw new Error(`'${user}' is the only account; removing it would lock the console. Add another first.`);
  }
  delete data.users[user];
  writeUsers(data, opts);
  return true;
}

/**
 * Account names and creation dates. Never hashes, never passwords.
 * @param {{path?:string}} [opts]
 * @returns {{name:string, createdAt:string, admin:boolean}[]}
 */
export function listUsers(opts = {}) {
  return Object.entries(readUsers(opts).users)
    .map(([name, u]) => ({ name, createdAt: u.createdAt, admin: u.admin }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Is `host` an address only this machine can reach?
 *
 * Used to decide whether accounts are optional (loopback) or mandatory (anything else). Anything
 * unrecognised counts as public: guessing "probably fine" here means handing out the fleet.
 *
 * The check is a full-string match rather than a prefix test on purpose. `h.startsWith('127.')`
 * answers `true` for `127.0.0.1.evil.com`, which is an ordinary resolvable hostname — so a prefix
 * test would classify an attacker-controlled name as "this machine only" and let it start with no
 * accounts at all. The first version of this function did exactly that.
 *
 * @param {string|undefined} host
 */
export function isLoopbackHost(host) {
  const h = String(host ?? '').trim().toLowerCase();
  if (!h) return false;
  if (h === 'localhost' || h === '::1' || h === '[::1]') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!v4) return false;
  const octets = v4.slice(1).map(Number);
  if (octets.some((n) => n > 255)) return false;
  // 127.0.0.0/8 is the whole loopback block, not just 127.0.0.1.
  return octets[0] === 127;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * The accounts file, read once per request.
 *
 * This exists for one property that is otherwise very hard to get right: **changing a password has
 * to end the sessions that were opened with it**, and `mesh auth passwd` runs in a *different
 * process* from `mesh serve`. Neither process can reach into the other, so the file is the only
 * channel between them.
 *
 * The obvious optimization — cache the parsed file and re-read only when its mtime or size changes
 * — is wrong here, and wrong in a way that fails silently. Two password writes produce files of
 * **identical length** (every salt is the same number of hex characters), and two writes in the
 * same millisecond share an mtime. Such a change would be invisible, and the symptom would be a
 * session that keeps working after the password it was issued for was changed — the exact thing
 * someone changes a password to stop.
 *
 * The file is a couple of hundred bytes and this is read once per request on a console with one
 * operator, so it is read every time. That is a `readFileSync` next to the SQLite queries each
 * request already runs.
 *
 * An unreadable file is never an error here: it means **nobody is known**, which is the safe
 * direction. The server refuses to start at all if the file is unreadable at boot.
 */
export class AccountDirectory {
  /** @param {{path?:string}} [opts] */
  constructor(opts = {}) {
    this.#path = opts.path ?? usersPath();
  }

  #path;

  /** @returns {Record<string, StoredUser>} */
  #read() {
    try {
      return readUsers({ path: this.#path }).users;
    } catch {
      // Fail closed: keep nobody. Callers treat an empty directory as "no such account".
      return {};
    }
  }

  /** @param {string} name @returns {StoredUser|undefined} */
  get(name) {
    return this.#read()[name];
  }

  get size() {
    return Object.keys(this.#read()).length;
  }

  /** @returns {string[]} */
  names() {
    return Object.keys(this.#read()).sort();
  }

  /**
   * Has this session been revoked — password changed, or the account removed?
   *
   * Compared against the **hash the session was issued against**, not against a timestamp. The
   * timestamp version was wrong in a way that only shows up under load: two password writes produce
   * files of identical length and can share a millisecond boundary, so `session.createdAt <
   * changedAt` can be false for a session that must already be dead. A hash comparison has no such
   * gap — any password change produces a different hash, even one that sets the old password back,
   * because the salt is regenerated.
   *
   * A session with no recorded hash is treated as revoked, so a caller that forgets to pass one
   * fails closed rather than producing a session nothing can invalidate.
   *
   * @param {{user:string, hash?:string}} session
   */
  revoked(session) {
    const rec = this.get(session.user);
    if (!rec) return true;
    if (!session.hash) return true;
    return rec.hash !== session.hash;
  }

  /**
   * Kept for callers that only have the account record: was the password changed after `atMs`?
   * @param {string} user
   * @param {number} atMs
   */
  changedSince(user, atMs) {
    const rec = this.get(user);
    if (!rec) return true;
    const changed = Date.parse(rec.changedAt);
    return Number.isFinite(changed) && atMs < changed;
  }
}

/**
 * Live console sessions.
 *
 * Server-side and in memory, on purpose. A signed token the server cannot revoke means "log out"
 * is a lie and a stolen cookie is valid until it expires. Holding the sessions here makes logout
 * real and makes a restart log everyone out — correct for a control plane, and cheap.
 *
 * The token is a bearer credential, so it is compared by exact lookup of a 256-bit random value:
 * there is nothing to guess, and no reason to store or send anything derived from the password.
 */
export class SessionStore {
  /**
   * @param {{ttlMs?:number, max?:number}} [opts]
   */
  constructor({ ttlMs = 12 * 60 * 60 * 1000, max = 128 } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    /** @type {Map<string, {user:string, hash:string, createdAt:number, expiresAt:number, seenAt:number}>} */
    this.#sessions = new Map();
  }

  /** @type {Map<string, {user:string, hash:string, createdAt:number, expiresAt:number, seenAt:number}>} */
  #sessions;

  /**
   * @param {string} user
   * @param {{ttlMs?:number, hash?:string}} [opts] `hash` is the password hash this session was
   *   issued against; see `AccountDirectory.revoked`.
   * @returns {{token:string, expiresAt:number}}
   */
  create(user, opts = {}) {
    // A cap, so a loop of successful logins cannot grow this without bound.
    if (this.#sessions.size >= this.max) {
      const oldest = [...this.#sessions.entries()].sort((a, b) => a[1].seenAt - b[1].seenAt)[0];
      if (oldest) this.#sessions.delete(oldest[0]);
    }
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    const ttl = opts.ttlMs ?? this.ttlMs;
    this.#sessions.set(token, { user, hash: opts.hash ?? '', createdAt: now, expiresAt: now + ttl, seenAt: now });
    return { token, expiresAt: now + ttl };
  }

  /**
   * Look up a token, sliding its expiry forward when it has been alive for a while.
   * @param {string|undefined|null} token
   * @returns {{user:string, hash:string, createdAt:number, expiresAt:number}|null}
   */
  get(token) {
    if (!token) return null;
    const rec = this.#sessions.get(token);
    if (!rec) return null;
    const now = Date.now();
    if (rec.expiresAt <= now) {
      this.#sessions.delete(token);
      return null;
    }
    // Sliding renewal, but only past the halfway mark, so a busy page is not rewriting an entry on
    // every request.
    if (now - rec.seenAt > this.ttlMs / 2) {
      rec.expiresAt = now + this.ttlMs;
      rec.seenAt = now;
    }
    return { user: rec.user, hash: rec.hash, createdAt: rec.createdAt, expiresAt: rec.expiresAt };
  }

  /** @param {string|undefined|null} token @returns {boolean} whether a live session was removed */
  destroy(token) {
    if (!token) return false;
    return this.#sessions.delete(token);
  }

  /** Drop every session for a user — used when its password changes. @param {string} user */
  destroyUser(user) {
    let n = 0;
    for (const [token, rec] of this.#sessions) {
      if (rec.user === user) {
        this.#sessions.delete(token);
        n += 1;
      }
    }
    return n;
  }

  get size() {
    return this.#sessions.size;
  }
}

/**
 * Failed-login limiter.
 *
 * Two counters are kept — one per account name, one per client address — and **either** tripping
 * blocks the attempt. That has a deliberate consequence worth stating plainly: someone who knows an
 * account name can lock that account out for the lock window by failing a few times. It is accepted
 * because the alternative is worse. Address-only limits do nothing against an attempt spread over
 * many addresses, which is the shape online guessing actually takes; and the operator's remedy is
 * cheap — wait out the window, or restart the console. Name-only limits would be the real mistake:
 * those also let one attacker lock out every *other* account by name alone, with no address
 * involved at all.
 */
export class LoginThrottle {
  /** @param {{max?:number, windowMs?:number, lockMs?:number}} [opts] */
  constructor({ max = 5, windowMs = 15 * 60 * 1000, lockMs = 5 * 60 * 1000 } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.lockMs = lockMs;
    /** @type {Map<string, {count:number, first:number, until:number}>} */
    this.#hits = new Map();
  }

  /** @type {Map<string, {count:number, first:number, until:number}>} */
  #hits;

  /**
   * @param {...string} keys
   * @returns {{locked:boolean, retryAfterSec:number}}
   */
  check(...keys) {
    const now = Date.now();
    let until = 0;
    for (const key of keys) {
      const rec = this.#hits.get(key);
      if (!rec) continue;
      if (rec.until > now) until = Math.max(until, rec.until);
      else if (now - rec.first > this.windowMs) this.#hits.delete(key);
    }
    return until > now ? { locked: true, retryAfterSec: Math.ceil((until - now) / 1000) } : { locked: false, retryAfterSec: 0 };
  }

  /** @param {...string} keys */
  fail(...keys) {
    const now = Date.now();
    for (const key of keys) {
      const rec = this.#hits.get(key);
      if (!rec || now - rec.first > this.windowMs) {
        this.#hits.set(key, { count: 1, first: now, until: 0 });
        continue;
      }
      rec.count += 1;
      if (rec.count >= this.max) rec.until = now + this.lockMs;
    }
  }

  /** @param {...string} keys */
  succeed(...keys) {
    for (const key of keys) this.#hits.delete(key);
  }
}
