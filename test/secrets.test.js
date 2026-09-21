// Saved secrets: ~/.agentmesh/secrets.env.
//
// The password rule in this project used to be absolute — never on disk — and the cost was that
// every restart of `mesh serve` needed the password retyped, which is the kind of friction that
// ends with someone choosing a short memorable password instead. So secrets get one file, mode
// 0600, and this test is what keeps that concession bounded:
//
//   * `nodes.json` still must not contain a value (asserted against its raw bytes, as elsewhere)
//   * the file is the only place, and only when the operator explicitly puts it there
//   * loading is idempotent, because a report that says "shadowed by the environment" for a
//     variable nothing set is worse than no report
//   * a value that cannot round-trip (a line break, both kinds of quote) is refused, because a
//     secret silently mangled into a different secret is the one failure nobody can debug
//
// Run: node test/secrets.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseSecrets, loadSecrets, writeSecret, removeSecret, listSecrets, secretsPath } from '../src/core/secrets.js';

/** A throwaway secrets file path. */
function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), 'agentmesh-secrets-'));
  return { dir, path: join(dir, 'secrets.env') };
}

test('a saved value round-trips exactly, including spaces and quotes', () => {
  const { dir, path } = tempFile();
  try {
    // The values a real password plausibly has. `'` and `"` both appear in generated passwords,
    // and `$` and `#` are the two characters a shell-style file would otherwise interpret.
    const values = [
      'nas1230.',
      'hunter2 with spaces and $dollar',
      'has#hash',
      'double"quote',
      "single'quote",
      'leading and trailing ',
      'tab\tinside',
    ];
    for (const [i, value] of values.entries()) {
      const name = `PW_${i}`;
      writeSecret(name, value, { path });
      const env = {};
      loadSecrets({ path, env });
      assert.equal(env[name], value, `${name} must round-trip exactly; file was:\n${readFileSync(path, 'utf8')}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loading twice does not make the file look like it came from the environment', () => {
  // The bug this exists for: `bin/mesh.js` loads secrets at startup, then `mesh secrets list`
  // loads them again. The second call found its own values already in `process.env`, concluded
  // the environment had provided them, and reported every entry as "shadowed" — for variables
  // nothing had ever set.
  const { dir, path } = tempFile();
  try {
    writeSecret('MESH_TEST_PW', 'round-trip', { path });
    const env = {};
    const first = loadSecrets({ path, env });
    const second = loadSecrets({ path, env });
    assert.deepEqual(first.loaded, ['MESH_TEST_PW']);
    assert.deepEqual(first.skipped, []);
    assert.deepEqual(second.loaded, ['MESH_TEST_PW'], 'a repeat load must still report the file as the source');
    assert.deepEqual(second.skipped, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a variable the operator really set wins over the file', () => {
  const { dir, path } = tempFile();
  try {
    writeSecret('MESH_TEST_PW', 'from-the-file', { path });
    const env = { MESH_TEST_PW: 'from-the-environment' };
    const r = loadSecrets({ path, env });
    assert.equal(env.MESH_TEST_PW, 'from-the-environment');
    assert.deepEqual(r.loaded, []);
    assert.deepEqual(r.skipped, ['MESH_TEST_PW']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the file is created 0600 where that means anything', () => {
  const { dir, path } = tempFile();
  try {
    writeSecret('MESH_TEST_PW', 'x', { path });
    if (process.platform === 'win32') {
      // mode is not a real permission model on Windows; the protection there is the per-user ACL
      // on the profile directory, which is what the docs say. Nothing to assert.
      assert.ok(true);
      return;
    }
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a value that cannot round-trip is refused rather than mangled', () => {
  const { dir, path } = tempFile();
  try {
    // A line break would append an assignment of its own and quietly define a second variable.
    assert.throws(() => writeSecret('MESH_TEST_PW', 'good\nMESH_OTHER=x', { path }), /line break/);
    // Both quote kinds cannot be quoted unambiguously by a parser that does no escape handling.
    assert.throws(() => writeSecret('MESH_TEST_PW', `both"and'`, { path }), /both kinds of quote/);
    assert.throws(() => writeSecret('not a name', 'x', { path }), /not a valid environment variable name/);
    assert.throws(() => writeSecret('MESH_TEST_PW', '', { path }), /non-empty/);
    // Nothing was written by any of the above.
    assert.deepEqual(listSecrets({ path }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('editing one entry preserves the rest of the file, comments included', () => {
  const { dir, path } = tempFile();
  try {
    writeFileSync(
      path,
      ['# my notes', 'export KEEP_ME=first', 'MESH_TEST_PW=old', '', '# trailing note', ''].join('\n'),
      'utf8',
    );
    const { replaced } = writeSecret('MESH_TEST_PW', 'new', { path });
    assert.equal(replaced, true);
    const text = readFileSync(path, 'utf8');
    assert.match(text, /# my notes/);
    assert.match(text, /export KEEP_ME=first/);
    assert.match(text, /^MESH_TEST_PW=new$/m);
    assert.match(text, /# trailing note/);
    assert.doesNotMatch(text, /old/);

    // And the values parse back.
    assert.deepEqual(parseSecrets(text).map((e) => e.name), ['KEEP_ME', 'MESH_TEST_PW']);

    assert.equal(removeSecret('MESH_TEST_PW', { path }), true);
    assert.equal(removeSecret('MESH_TEST_PW', { path }), false, 'removing twice reports that it is gone');
    const after = readFileSync(path, 'utf8');
    assert.match(after, /KEEP_ME=first/);
    assert.doesNotMatch(after, /MESH_TEST_PW/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a loaded secret is what a node resolves, and it never lands in nodes.json', async () => {
  const { dir, path } = tempFile();
  const home = mkdtempSync(join(tmpdir(), 'agentmesh-secrets-home-'));
  const previousHome = process.env.AGENTMESH_HOME;
  try {
    const value = 'the-real-password-with spaces';
    writeSecret('MESH_TEST_SSH_PW', value, { path });
    // The end-to-end path: the file loads into the environment, and the registry reads the
    // variable the node NAMES. That indirection is why nothing in the registry or the adapters
    // had to change for a password to survive a restart.
    process.env.AGENTMESH_HOME = home;
    loadSecrets({ path });
    const { Registry } = await import('../src/core/registry.js');
    const registry = new Registry();
    registry.add({ name: 'nas', transport: 'acp', host: 'h', user: 'u', ssh: { passwordEnv: 'MESH_TEST_SSH_PW' } });
    assert.equal(registry.hasSshPassword(registry.get('nas')), true);
    assert.equal(registry.resolveSshPassword(registry.get('nas')), value);

    // The node still stores only the NAME, and the raw bytes of the registry never hold it.
    const raw = readFileSync(join(home, 'nodes.json'), 'utf8');
    assert.ok(raw.includes('MESH_TEST_SSH_PW'), 'the variable name is what persists');
    assert.ok(!raw.includes('the-real-password'), 'the password must not reach nodes.json');
  } finally {
    if (previousHome === undefined) delete process.env.AGENTMESH_HOME;
    else process.env.AGENTMESH_HOME = previousHome;
    delete process.env.MESH_TEST_SSH_PW;
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('a hand-edited line with an unterminated quote is reported, not guessed at', () => {
  // Found by running the real CLI against a deliberately broken file. `NAME="p@ss` has no correct
  // reading when there is no escape processing: taken literally it yields the password `"p@ss`,
  // and the operator then gets "permission denied" from the host and goes looking at the host. So
  // the entry is left unloaded and named, which fails as "no password available" instead.
  const { dir, path } = tempFile();
  try {
    writeFileSync(path, ['GOOD_ONE="fine"', 'BROKEN_ONE="p@ss', "MIDDLE_QUOTE=abc\"def", ''].join('\n'), 'utf8');
    const env = {};
    const r = loadSecrets({ path, env });

    assert.deepEqual(r.loaded, ['GOOD_ONE', 'MIDDLE_QUOTE'], 'only the readable entries may load');
    assert.deepEqual(r.problems, [{ name: 'BROKEN_ONE', reason: 'unterminated quote' }]);
    assert.equal(env.BROKEN_ONE, undefined, 'a value we cannot read must not be used at all');
    // A quote in the *middle* is an ordinary character and must keep working: only a leading,
    // unclosed quote is ambiguous.
    assert.equal(env.MIDDLE_QUOTE, 'abc"def');
    assert.equal(env.GOOD_ONE, 'fine');
    // It is still listed, so the operator can see the name to fix it.
    assert.deepEqual(listSecrets({ path }), ['GOOD_ONE', 'BROKEN_ONE', 'MIDDLE_QUOTE']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writing an entry is what repairs a malformed line', () => {
  const { dir, path } = tempFile();
  try {
    writeFileSync(path, 'NAS_SSH_PW="typo\n', 'utf8');
    assert.deepEqual(loadSecrets({ path, env: {} }).problems.length, 1);
    writeSecret('NAS_SSH_PW', 'the-real-one', { path });
    const env = {};
    const r = loadSecrets({ path, env });
    assert.deepEqual(r.problems, []);
    assert.equal(env.NAS_SSH_PW, 'the-real-one');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the secrets path lives next to the rest of the state, and no listing returns a value', () => {
  const previous = process.env.AGENTMESH_HOME;
  const home = mkdtempSync(join(tmpdir(), 'agentmesh-secrets-path-'));
  try {
    process.env.AGENTMESH_HOME = home;
    assert.equal(secretsPath(), join(home, 'secrets.env'));
    writeSecret('MESH_TEST_PW', 'a-secret-value', { path: secretsPath() });
    const names = listSecrets();
    assert.deepEqual(names, ['MESH_TEST_PW']);
    assert.ok(!JSON.stringify(names).includes('a-secret-value'), 'listing must return names only');
  } finally {
    if (previous === undefined) delete process.env.AGENTMESH_HOME;
    else process.env.AGENTMESH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
