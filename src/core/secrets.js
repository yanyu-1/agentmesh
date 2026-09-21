/**
 * The one sanctioned place where a secret may be written to disk.
 *
 * `nodes.json` must never contain a password: `quarantineSecrets` moves one out of the registry
 * on the way in, and a test asserts it against the raw bytes of the file. But "the SSH password
 * lives only in this process's memory" means retyping it after every restart of `mesh serve`, and
 * a control plane you have to re-key every time is one people end up leaving running with
 * something short and memorable instead. The strict rule was protecting the wrong thing.
 *
 * So secrets get a file of their own: `~/.agentmesh/secrets.env`, mode 0600, read into the
 * environment at startup. This is the convention `~/.netrc`, `~/.pgpass` and
 * `~/.aws/credentials` already use, and it has the same security property theirs has — **the file
 * permissions are the protection**. It is deliberately not "encryption": a key sitting next to
 * the ciphertext is obfuscation, and implying otherwise would be worse than saying this plainly.
 *
 * Loading goes through `process.env` on purpose. `Registry.resolveSshPassword` already reads the
 * variable a node names in `ssh.passwordEnv`, so a loaded secret makes the existing
 * `--ssh-password-env` route survive a restart with no new plumbing in the registry, the fleet or
 * any adapter. The node still stores only a NAME; nothing about the node model changes.
 *
 * @module core/secrets
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { meshHome } from '../protocol/util.js';

/** A variable name, which is all a node ever stores. */
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * What this process sourced from the file, with the value it set.
 *
 * Without this, calling `loadSecrets` twice is self-defeating: the first call puts the value into
 * `process.env`, and the second sees it there, concludes the environment provided it and reports
 * every entry as "skipped". That is not cosmetic — `mesh secrets list` said
 * `shadowed by the environment` for a variable nothing had set. Remembering what we wrote makes
 * the function idempotent and its report true, while still letting a genuine environment variable
 * win (the comparison below notices when the value is no longer ours).
 * @type {Map<string,string>}
 */
const sourcedByUs = new Map();

/**
 * @returns {string} path of the secrets file
 */
export function secretsPath() {
  return join(meshHome(), 'secrets.env');
}

/**
 * Parse `NAME=value` lines. Accepts `export NAME=value`, `#` comments, blank lines, and single or
 * double quoted values, so a file people already have from a shell or a Netrc-style tool loads
 * as-is.
 *
 * The last assignment wins, which is what a shell does when it sources the same file.
 *
 * A value that *starts* with a quote and never closes it is reported as a problem rather than
 * accepted. This module does no escape processing, so `NAME="p@ss` has no correct interpretation:
 * taking it literally yields the password `"p@ss`, and the operator then sees an authentication
 * failure that points at the host rather than at this file. There is no way to guess which they
 * meant, and this is exactly the "secret silently changed into a different secret" case the
 * module refuses to allow, so the entry is marked and `loadSecrets` leaves it unloaded.
 *
 * @param {string} text
 * @returns {{name:string, value:string, problem?:string}[]} in file order
 */
export function parseSecrets(text) {
  /** @type {{name:string, value:string, problem?:string}[]} */
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    const quoted = /^(['"])([\s\S]*)\1$/.exec(value);
    if (quoted) {
      value = quoted[2];
      out.push({ name: m[1], value });
      continue;
    }
    if (/^['"]/.test(value)) {
      out.push({ name: m[1], value, problem: 'unterminated quote' });
      continue;
    }
    out.push({ name: m[1], value });
  }
  return out;
}

/**
 * Read the secrets file into `env`.
 *
 * A variable that is already set in the environment wins, matching Node's own `--env-file`
 * behaviour: it makes a one-off `$env:NAME=…; mesh send …` override possible without editing the
 * file, and it means a file entry can never silently shadow what the operator explicitly set.
 * Nothing here ever returns or logs a value — only names.
 *
 * @param {{path?:string, env?:Record<string,string|undefined>, required?:boolean}} [opts]
 * @returns {{path:string, loaded:string[], skipped:string[], problems:{name:string, reason:string}[], missing:boolean}}
 */
export function loadSecrets(opts = {}) {
  const path = opts.path ?? secretsPath();
  const env = opts.env ?? process.env;
  /** @type {{path:string, loaded:string[], skipped:string[], problems:{name:string, reason:string}[], missing:boolean}} */
  const result = { path, loaded: [], skipped: [], problems: [], missing: false };
  if (!existsSync(path)) {
    result.missing = true;
    return result;
  }
  for (const { name, value, problem } of parseSecrets(readFileSync(path, 'utf8'))) {
    if (problem) {
      // Deliberately not loaded. A value we cannot read unambiguously would authenticate with the
      // wrong password, and "permission denied" sends the operator to the host instead of to the
      // one line in this file that is malformed. Better to have no password at all, which fails
      // with a message that says no password is available.
      result.problems.push({ name, reason: problem });
      continue;
    }
    const key = `${path}\u0000${name}`;
    const ours = sourcedByUs.get(key);
    const current = env[name];
    // Ours to set when the variable is empty, when we are the ones who put it there, or when the
    // value is still the one we put there. Anything else was set by the operator, who wins.
    const available = current === undefined || current === '' || (ours !== undefined && current === ours);
    if (!available) {
      result.skipped.push(name);
      continue;
    }
    env[name] = value;
    sourcedByUs.set(key, value);
    if (!result.loaded.includes(name)) result.loaded.push(name);
  }
  return result;
}

/**
 * @param {string} name
 * @param {{path?:string}} [opts]
 * @returns {string[]} names present in the file, in file order, never values
 */
export function listSecrets(opts = {}) {
  const path = opts.path ?? secretsPath();
  if (!existsSync(path)) return [];
  return parseSecrets(readFileSync(path, 'utf8')).map((e) => e.name);
}

/**
 * @param {string} name
 * @param {{path?:string}} [opts]
 * @returns {boolean} whether the name was present
 */
export function hasSecret(name, opts = {}) {
  return listSecrets(opts).includes(name);
}

/**
 * @param {string} name
 * @param {{path?:string}} [opts]
 * @returns {boolean} whether anything was removed
 */
export function removeSecret(name, opts = {}) {
  assertName(name);
  const path = opts.path ?? secretsPath();
  if (!existsSync(path)) return false;
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const kept = lines.filter((line) => {
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line.trim());
    return !(m && m[1] === name);
  });
  if (kept.length === lines.length) return false;
  writeSecretFile(path, kept);
  return true;
}

/**
 * Set one variable, preserving every other line in the file verbatim — including comments and
 * anything this module does not understand, so an operator's own notes survive an edit.
 *
 * @param {string} name
 * @param {string} value
 * @param {{path?:string}} [opts]
 * @returns {{path:string, replaced:boolean}}
 */
export function writeSecret(name, value, opts = {}) {
  assertName(name);
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${name} must have a non-empty value`);
  }
  // A newline in a value would append an assignment of its own and quietly define a second
  // variable. Refuse rather than escape: no real credential contains a line break, so a value
  // that does is a mistake or an injection attempt, and both deserve an error.
  if (/[\r\n]/.test(value)) {
    throw new Error(`${name} must not contain a line break`);
  }
  const path = opts.path ?? secretsPath();
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : [];
  // Drop a single trailing empty line so repeated writes do not grow blank lines.
  while (lines.length && lines[lines.length - 1] === '') lines.pop();

  let replaced = false;
  const next = lines.map((line) => {
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line.trim());
    if (m && m[1] === name) {
      replaced = true;
      return `${name}=${quoteIfNeeded(value)}`;
    }
    return line;
  });
  if (!replaced) next.push(`${name}=${quoteIfNeeded(value)}`);

  writeSecretFile(path, next);
  return { path, replaced };
}

/**
 * @param {string} path
 * @param {string[]} lines
 */
function writeSecretFile(path, lines) {
  writeFileSync(path, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  // `mode` on writeFileSync only applies when the file is created, so an existing file with
  // looser permissions would keep them. On Windows this is a no-op and the protection is the
  // per-user ACL on the profile directory, which is what the docs say.
  try {
    chmodSync(path, 0o600);
  } catch {
    /* not POSIX, or not ours to change */
  }
}

/**
 * Quote only when leaving the value bare would change how it reads back.
 *
 * `parseSecrets` deliberately does no escape processing — so anything written here has to
 * round-trip by construction. Wrapping in whichever quote character the value does not contain
 * achieves that; a value containing both cannot be written unambiguously and is refused rather
 * than mangled into a different secret.
 * @param {string} value
 */
function quoteIfNeeded(value) {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  if (value.includes('"') && value.includes("'")) {
    throw new Error('the value contains both kinds of quote, so it cannot be written unambiguously');
  }
  const q = value.includes('"') ? "'" : '"';
  return `${q}${value}${q}`;
}

/**
 * @param {string} name
 */
function assertName(name) {
  if (!NAME_RE.test(String(name))) {
    throw new Error(`'${name}' is not a valid environment variable name (use letters, digits and _)`);
  }
}
