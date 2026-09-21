// Argv parser tests.
//
// This file exists because of a real bug: repeatable flags were excluded from
// "consume the next token as the value", so `--env K=V`, `--tag alpha`,
// `--capability c` and `--node a` all became the bare boolean `true` and their
// values were left behind as positional arguments. `--node a --node b` — the
// documented way to fan out — silently selected nodes named "true".
//
// Run: node test/args.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseArgs, envPairs, bool, int, valuelessFlags } = await import('../src/cli/args.js');

test('a repeated value flag collects every value', () => {
  const { flags, _ } = parseArgs(['broadcast', 'review this', '--node', 'a', '--node', 'b']);
  assert.deepEqual(flags.node, ['a', 'b'], 'both node names must survive');
  assert.deepEqual(_, ['broadcast', 'review this'], 'values must not leak into positionals');
});

test('--env K=V reaches the node config instead of becoming `true`', () => {
  const { flags, _ } = parseArgs(['node', 'add', 'n1', '--env', 'FOO=bar', '--env', 'A=b c']);
  assert.deepEqual(flags.env, ['FOO=bar', 'A=b c']);
  assert.deepEqual(envPairs(flags.env), { FOO: 'bar', A: 'b c' });
  assert.deepEqual(_, ['node', 'add', 'n1']);
});

test('--tag and --capability are collected as values', () => {
  const { flags } = parseArgs(['--tag', 'gpu', '--tag', 'eu-west', '--capability', 'review']);
  assert.deepEqual(flags.tag, ['gpu', 'eu-west']);
  assert.deepEqual(flags.capability, ['review']);
});

test('the ssh passthrough flags accumulate too, values intact', () => {
  // Regression: these two were added as flags but not to REPEATABLE, so a second
  // occurrence silently overwrote the first — the node ended up with only its last
  // `-o` option, and a dropped UserKnownHostsFile sends ssh looking in ~/.ssh.
  const { flags } = parseArgs([
    '--ssh-opt', 'UserKnownHostsFile=D:\\proj\\.ssh\\known_hosts',
    '--ssh-opt', 'StrictHostKeyChecking=accept-new',
    '--ssh-opt', 'ProxyJump=bastion',
    // plink-style values begin with "-", so they must be attached.
    '--ssh-binary-arg=-batch',
    '--ssh-binary-arg=-noagent',
  ]);
  assert.deepEqual(flags['ssh-opt'], [
    'UserKnownHostsFile=D:\\proj\\.ssh\\known_hosts',
    'StrictHostKeyChecking=accept-new',
    'ProxyJump=bastion',
  ]);
  assert.deepEqual(flags['ssh-binary-arg'], ['-batch', '-noagent']);
});

test('a repeatable flag with no value is a loud error, never a silent `true`', () => {
  // `true` is never a usable value for these flags, and storing it silently threw
  // the real value away as a positional (broadcast then hunted for a node named
  // "true"). Fail instead.
  for (const flag of ['node', 'tag', 'capability', 'env', 'arg', 'ssh-opt', 'ssh-binary-arg']) {
    assert.throws(() => parseArgs([`--${flag}`, '--json']), /requires a value/, `--${flag} must be rejected`);
  }
  // A flag-like value is still expressible, attached.
  assert.deepEqual(parseArgs(['--arg=--verbose']).flags.arg, ['--verbose']);
  // And a normal value still works both ways.
  assert.deepEqual(parseArgs(['--tag', 'gpu']).flags.tag, ['gpu']);
  assert.deepEqual(parseArgs(['--tag=gpu']).flags.tag, ['gpu']);
});

test('--ssh-batch-mode parses as a boolean-ish value, not a bare flag', () => {
  assert.equal(bool(parseArgs(['--ssh-batch-mode', 'no']).flags['ssh-batch-mode']), false);
  assert.equal(bool(parseArgs(['--ssh-batch-mode', 'yes']).flags['ssh-batch-mode']), true);
  assert.equal(parseArgs([]).flags['ssh-batch-mode'], undefined, 'unset must stay unset, not become false');
});

test('a value beginning with - must be attached with =', () => {
  const attached = parseArgs(['--arg=--verbose', '--arg', 'acp']);
  assert.deepEqual(attached.flags.arg, ['--verbose', 'acp']);
  // Written as a separate token it cannot be a value, so the flag would have none —
  // which is now reported rather than quietly stored as `true`.
  assert.throws(() => parseArgs(['--arg', '--verbose']), /--arg requires a value/);
});

test('the = form works for every flag and wins over the following token', () => {
  const { flags, _ } = parseArgs(['--env=K=V', 'positional']);
  assert.deepEqual(flags.env, ['K=V'], '= is the way to repeat with an explicit value');
  assert.deepEqual(_, ['positional']);
});

test('boolean flags never eat the next token', () => {
  const { flags, _ } = parseArgs(['send', 'node-a', '--json', 'hello', '--quiet']);
  assert.equal(flags.json, true);
  assert.equal(flags.quiet, true);
  assert.deepEqual(_, ['send', 'node-a', 'hello'], 'the prompt must survive --json');
});

test('no-<flag> negates a boolean', () => {
  const { flags } = parseArgs(['--no-stream']);
  assert.equal(flags.stream, false);
});

test('-- stops flag parsing', () => {
  const { flags, _ } = parseArgs(['send', 'node', '--', '--not-a-flag']);
  assert.deepEqual(_, ['send', 'node', '--not-a-flag']);
  assert.equal(flags['not-a-flag'], undefined);
});

test('short flags parse and can take values', () => {
  const { flags } = parseArgs(['-n', '5']);
  assert.equal(flags.n, '5');
});

test('helpers coerce the way callers expect', () => {
  assert.equal(bool('true'), true);
  assert.equal(bool(undefined, true), true);
  assert.equal(bool('false'), false);
  assert.equal(int('42', 0), 42);
  assert.equal(int('nonsense', 7), 7);
});

test('envPairs ignores junk rather than producing a bogus variable', () => {
  assert.deepEqual(envPairs([true, 'NOEQUALS', '=noname', 'OK=1']), { OK: '1' });
  assert.deepEqual(envPairs(undefined), {});
  // A value containing = keeps everything after the first one.
  assert.deepEqual(envPairs(['URL=http://x/?a=b']), { URL: 'http://x/?a=b' });
});

test('boolean switches never swallow the following token', () => {
  // `mesh agent` takes the user's sentence as a positional, so a switch missing from the
  // BOOLEAN set eats the start of the prompt. `--confirm 让 nas 干活` silently became
  // prompt="nas 干活" with confirm="让" — a corrupted instruction is worse than an error,
  // because the agent then acts on something the user never said.
  for (const flag of ['--dry-run', '--read-only', '--confirm', '--quiet', '--json']) {
    const r = parseArgs(['agent', flag, '让 nas 干活']);
    assert.equal(r.flags[flag.slice(2)], true, `${flag} must be a boolean`);
    // The prompt is one quoted argument, exactly as the shell delivers it.
    assert.deepEqual(r._, ['agent', '让 nas 干活'], `${flag} must not consume the prompt`);
  }
  // Order must not matter.
  const after = parseArgs(['agent', '让 nas 干活', '--dry-run']);
  assert.equal(after.flags['dry-run'], true);
  assert.deepEqual(after._, ['agent', '让 nas 干活']);
  // Unquoted multi-word prompts are joined by the command itself, so every word must
  // survive as its own positional.
  assert.deepEqual(parseArgs(['agent', '--dry-run', '让', 'nas', '干活'])._, ['agent', '让', 'nas', '干活']);
});

test('--tools takes a value, and --allow stays the boolean mesh approve needs', () => {
  const r = parseArgs(['agent', '干活', '--tools', 'list_nodes,send_task']);
  assert.equal(r.flags.tools, 'list_nodes,send_task');
  assert.deepEqual(r._, ['agent', '干活']);

  // `--allow` belongs to `mesh approve` and must stay valueless: if it started taking a
  // value, `mesh approve <id> --allow` would eat whatever token followed it.
  const approve = parseArgs(['approve', 'ap_1', '--allow']);
  assert.equal(approve.flags.allow, true);

  const attached = parseArgs(['agent', '干活', '--tools=list_nodes']);
  assert.equal(attached.flags.tools, 'list_nodes');
});

test('--unset and --ssh-clear-secret are registered, so neither eats the next token', () => {
  // Both are new. `--ssh-clear-secret` is a switch and must be in BOOLEAN; `--unset` takes
  // a value and must not be. Getting either wrong corrupts the command rather than failing.
  const clear = parseArgs(['node', 'edit', 'nas', '--ssh-clear-secret', '--ssh-port', '2222']);
  assert.equal(clear.flags['ssh-clear-secret'], true, '--ssh-clear-secret must be a boolean');
  assert.equal(clear.flags['ssh-port'], '2222', 'it must not swallow the flag that follows');

  const unset = parseArgs(['node', 'edit', 'nas', '--unset', 'token', '--unset', 'ssh.passwordEnv']);
  assert.deepEqual(unset.flags.unset, ['token', 'ssh.passwordEnv'], '--unset is repeatable');
  assert.deepEqual(unset._, ['node', 'edit', 'nas'], 'the field names must not leak into positionals');

  const env = parseArgs(['node', 'edit', 'nas', '--ssh-password-env', 'NAS_SSH_PW']);
  assert.equal(env.flags['ssh-password-env'], 'NAS_SSH_PW');
});

test('a value flag given no value yields `true`, which callers must reject', () => {
  // This is the mechanism behind a real accident. PowerShell drops an empty string
  // argument, so `--token ""` reached the CLI as a bare `--token`. The parser turns that
  // into `true`, and `token: true` was then written to a live registry. The parser is
  // left as-is (some callers legitimately test a flag's presence) but the node commands
  // reject boolean values for string fields; this pins the behaviour they are guarding.
  const r = parseArgs(['node', 'edit', 'nas', '--token', '--ssh-user', 'user']);
  assert.equal(r.flags.token, true, 'the parser reports a valueless flag as true');
  assert.equal(r.flags['ssh-user'], 'user', 'and the following flag still parses normally');
});

test('an ssh password is never accepted as a command-line value', () => {
  // `--ssh-password-env` names a variable; there is deliberately no flag that carries the
  // secret itself, because a command line is visible to every process on the machine.
  const r = parseArgs(['node', 'add', 'nas', '--ssh-password-env', 'NAS_SSH_PW']);
  assert.deepEqual(r._, ['node', 'add', 'nas']);
  assert.equal(r.flags['ssh-password-env'], 'NAS_SSH_PW');
  assert.equal(r.flags.password, undefined, 'no SSH password flag exists');
});

test('valuelessFlags names every value flag that was given no value', () => {
  // The parser stores `true` for these. Callers that build config out of flags must
  // reject them: `token: true` was written to a live registry, and `int(true, 22)` is 1,
  // so a bare `--ssh-port` silently meant port 1.
  const r = parseArgs(['node', 'edit', 'nas', '--token', '--ssh-port', '--ssh-user', 'user']);
  assert.deepEqual(valuelessFlags(r.flags).sort(), ['ssh-port', 'token']);

  // A flag that really is a switch must never be reported, or `mesh node add x --local`
  // breaks — which is exactly what the first version of this check did.
  const switches = parseArgs(['node', 'add', 'x', '--kind', 'hermes', '--local', '--shell']);
  assert.deepEqual(valuelessFlags(switches.flags), [], '--local and --shell are switches');
  assert.equal(switches.flags.local, true);

  // Global switches too.
  assert.deepEqual(valuelessFlags(parseArgs(['agent', 'go', '--dry-run', '--read-only']).flags), []);
  assert.deepEqual(valuelessFlags(parseArgs(['node', 'list', '--json']).flags), []);

  // And a well-formed command reports nothing.
  const good = parseArgs(['node', 'edit', 'nas', '--ssh-port', '2222', '--ssh-clear-secret']);
  assert.deepEqual(valuelessFlags(good.flags), []);
  assert.deepEqual(valuelessFlags(undefined), [], 'no flags is not an error');
  assert.deepEqual(valuelessFlags({}), []);
});

test('naming a password source turns BatchMode off, so the password can actually be used', async () => {
  // Regression: `--ssh-password-env` used to be recorded while the node kept the safe
  // default `BatchMode=yes`, and ssh refuses to use a password in that mode. The node was
  // therefore configured with a credential it could never spend and failed with "the
  // prompt has nothing to answer it" — while the Web console, which does turn BatchMode
  // off, worked. The same node behaved differently depending on where it was created.
  const { nodeInputFromFlags } = await import('../src/cli/main.js');

  const withEnv = nodeInputFromFlags({ ssh: 'nas', 'ssh-user': 'u', 'ssh-port': '2222', 'ssh-password-env': 'NAS_SSH_PW' });
  assert.equal(withEnv.ssh.passwordEnv, 'NAS_SSH_PW');
  assert.equal(withEnv.ssh.batchMode, false, 'a password-only host needs BatchMode off');
  assert.equal(withEnv.ssh.password, undefined, 'the secret itself must never be a flag');

  // An explicit choice still wins, so a key-based host with a password fallback is expressible.
  const explicit = nodeInputFromFlags({ ssh: 'nas', 'ssh-password-env': 'X', 'ssh-batch-mode': 'yes' });
  assert.equal(explicit.ssh.batchMode, true);

  const explicitNo = nodeInputFromFlags({ ssh: 'nas', 'ssh-batch-mode': 'no' });
  assert.equal(explicitNo.ssh.batchMode, false);
  assert.equal(explicitNo.ssh.passwordEnv, undefined);

  // No password source and no flag: leave it unset so the documented safe default applies.
  const plain = nodeInputFromFlags({ ssh: 'nas', 'ssh-user': 'u' });
  assert.equal(plain.ssh.batchMode, undefined, 'never invent a value the user did not ask for');
});

test('nodeInputFromFlags only sets the fields it was actually given', async () => {
  // `mesh node edit --ssh-port 2222` must change the port and nothing else. Sending a
  // default (a blank command, an empty env) would silently wipe real configuration.
  const { nodeInputFromFlags } = await import('../src/cli/main.js');

  const patch = nodeInputFromFlags({ 'ssh-port': '2222' });
  assert.deepEqual(Object.keys(patch.ssh), ['port'], `only the port was passed, got ${JSON.stringify(patch.ssh)}`);
  assert.equal(patch.name, undefined);
  assert.equal(patch.local, undefined);

  const full = nodeInputFromFlags({ kind: 'hermes', local: true, command: 'hermes-acp', cwd: '/srv' });
  assert.equal(full.kind, 'hermes');
  assert.equal(full.local, true);
  assert.equal(full.command, 'hermes-acp');
  assert.equal(full.cwd, '/srv');
  assert.equal(full.ssh, undefined, 'no ssh fields were passed, so no ssh object should appear');
  // The node NAME is a positional argument (`mesh node add <name>`), never a flag, so this
  // mapping function must not invent one — the caller assigns it.
  assert.equal(full.name, undefined);

  // A valueless switch is honoured as a switch, and `--ssh` implies "not local".
  assert.equal(nodeInputFromFlags({ ssh: 'h', 'ssh-user': 'u' }).local, false);
  assert.equal(nodeInputFromFlags({ local: true }).local, true);
});

test('the password environment NAME never turns into a value on a command line', async () => {
  // Env pairs are folded into the remote command line, and a command line is readable by
  // every process on the machine — the classic way a credential leaks. The password
  // travels through MESH_ASKPASS_SECRET instead (see ssh.test.js).
  const { nodeInputFromFlags } = await import('../src/cli/main.js');
  const input = nodeInputFromFlags({ ssh: 'nas', 'ssh-user': 'u', 'ssh-password-env': 'NAS_SSH_PW', env: ['A=1'] });
  assert.ok(!JSON.stringify(input).includes('NAS_SSH_PW='), 'the name must not be turned into an env value');
  assert.equal(input.env.A, '1');
});
