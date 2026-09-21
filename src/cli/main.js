/**
 * AgentMesh CLI.
 * @module cli/main
 */

import { createInterface } from 'node:readline/promises';
import { Fleet } from '../core/fleet.js';
import { Registry, PRESETS } from '../core/registry.js';
import { Store } from '../core/store.js';
import { EventType } from '../protocol/events.js';
import { TaskState, isTerminal, WAITING_STATES } from '../protocol/states.js';
import { PermissionPolicy } from '../protocol/acp.js';
import { summarizeCard, cardSkillLines } from '../protocol/a2a.js';
import { fmtDuration, pad, truncate, meshHome } from '../protocol/util.js';
import { parseArgs, envPairs, bool, int, valuelessFlags, HELP } from './args.js';
import { renderEvent, table, die, info, ok, color, stateBadge } from './render.js';
import { runAgent, READ_ONLY_TOOLS, DISPATCH_TOOLS, AGENT_TOOLS } from '../core/orchestrator.js';
import { llmConfig, listModels, llmReady, llmConfigPath, readLlmConfigFile } from '../core/llm.js';
import { loadSecrets, listSecrets, writeSecret, removeSecret, secretsPath } from '../core/secrets.js';

const VERSION = '0.1.0';

/**
 * @param {string[]} argv
 */
export async function main(argv) {
  /** @type {ReturnType<typeof parseArgs>} */
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    // A malformed flag is a usage error, not a crash: keep the stack trace off the
    // screen and keep the CLI's exit-code contract.
    process.stderr.write(`${color.red('error')} ${err instanceof Error ? err.message : String(err)}\n`);
    process.stderr.write(`run 'mesh help' for usage\n`);
    return 2;
  }
  const { _: pos, flags } = parsed;
  const cmd = pos[0] || (flags.help ? 'help' : 'help');
  const rest = pos.slice(1);

  if (flags.version || cmd === 'version') {
    process.stdout.write(`agentmesh ${VERSION} (node ${process.version}, state: ${meshHome()})\n`);
    return 0;
  }
  if (flags.help && cmd === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  switch (cmd) {
    case 'help':
      process.stdout.write(HELP);
      return 0;
    case 'presets':
      return cmdPresets();
    case 'node':
      return cmdNode(rest, flags);
    case 'probe':
      return cmdProbe(rest, flags);
    case 'send':
      return cmdSend(rest, flags);
    case 'broadcast':
      return cmdBroadcast(rest, flags);
    case 'cancel':
      return cmdCancel(rest, flags);
    case 'tasks':
      return cmdTasks(rest, flags);
    case 'task':
      return cmdTask(rest, flags);
    case 'watch':
      return cmdWatch(rest, flags);
    case 'status':
      return cmdStatus(rest, flags);
    case 'approvals':
      return cmdApprovals(rest, flags);
    case 'approve':
      return cmdApprove(rest, flags);
    case 'serve':
      return cmdServe(rest, flags);
    case 'secrets':
      return cmdSecrets(rest, flags);
    case 'agent':
      return cmdAgent(rest, flags);
    default:
      process.stderr.write(`${color.red('error:')} unknown command '${cmd}'\n\n`);
      process.stderr.write(HELP);
      return 2;
  }
}

// ---------------------------------------------------------------------------
// node management
// ---------------------------------------------------------------------------

/**
 * @param {string[]} rest
 * @param {Record<string, any>} flags
 */
function cmdNode(rest, flags) {
  const sub = rest[0];
  const registry = new Registry();
  switch (sub) {
    case 'add': {
      const name = rest[1];
      if (!name) die('usage: mesh node add <name> [--kind <preset>] [--transport <t>] ...');
      /** @type {any} */
      const input = { name, ...nodeInputFromFlags(flags) };
      rejectValuelessFlags(flags);
      // `add` needs a concrete local/remote answer; `edit` must leave it alone unless
      // the user said something, or editing a port would silently flip a remote node
      // into a local one.
      if (input.local === undefined) {
        input.local = flags.ssh ? false : input.transport === 'a2a' || input.transport === 'opencode' ? undefined : true;
      }
      validateNodeInput(input, { requireTarget: true });
      const node = registry.add(input);
      ok(`added node ${color.bold(node.name)} (${node.kind}/${node.transport})`);
      info(`  id: ${node.id}`);
      info(`  registry: ${registry.file}`);
      reportSshAuth(node, registry);
      if (flags.json) process.stdout.write(`${JSON.stringify(node, null, 2)}\n`);
      return 0;
    }
    case 'edit': {
      const ref = rest[1];
      if (!ref) die('usage: mesh node edit <node|id> [--ssh <host>] [--ssh-user <u>] [--ssh-port <p>] ...');
      const patch = nodeInputFromFlags(flags);
      // A password is never part of the persisted patch — it goes to the in-memory side
      // table. `--ssh-clear-secret` drops whatever this process is holding.
      const clearSecret = Boolean(patch.ssh?.clearSecret);
      if (patch.ssh) delete patch.ssh.clearSecret;
      // `--unset` alone is a legitimate edit, so do not let it count as "empty".
      if (Object.keys(patch).length === 0 && !clearSecret) die('nothing to change: pass at least one option (see mesh help)');
      rejectValuelessFlags(flags);
      const before = registry.mustGet(ref);
      validateNodeInput({ ...before, ...patch }, { requireTarget: false });
      const node = registry.update(ref, patch);
      if (clearSecret) {
        registry.setSecret(node.id, { sshPassword: '' });
        info('  ssh password: cleared (nothing was ever written to disk)');
      }
      ok(`updated node ${color.bold(node.name)} (${node.kind}/${node.transport})`);
      for (const key of Object.keys(patch)) {
        if (key === 'ssh' || key === 'unset') continue;
        const a = JSON.stringify(before[key]);
        const b = JSON.stringify(node[key]);
        if (a !== b) info(`  ${key}: ${a === undefined ? '(unset)' : a} → ${b === undefined ? '(unset)' : b}`);
      }
      for (const key of Object.keys(patch.ssh || {})) {
        const a = JSON.stringify(before.ssh?.[key]);
        const b = JSON.stringify(node.ssh?.[key]);
        if (a !== b) info(`  ssh.${key}: ${a === undefined ? '(unset)' : a} → ${b === undefined ? '(unset)' : b}`);
      }
      for (const key of patch.unset || []) {
        info(`  ${key}: removed`);
      }
      reportSshAuth(node, registry);
      if (flags.json) process.stdout.write(`${JSON.stringify(node, null, 2)}\n`);
      return 0;
    }
    case 'list': {
      const nodes = registry.list();
      if (!nodes.length) {
        info(`no nodes registered yet. Registry: ${registry.file}`);
        info('try: mesh node add hermes-local --kind hermes --local');
        return 0;
      }
      if (flags.json) {
        process.stdout.write(`${JSON.stringify(nodes, null, 2)}\n`);
        return 0;
      }
      const rows = nodes.map((n) => [
        n.name,
        n.kind,
        n.transport,
        n.ssh ? `ssh://${n.ssh.user ? `${n.ssh.user}@` : ''}${n.ssh.host}` : n.url ? n.url : n.command || '-',
        n.approvalPolicy || 'deny',
        (n.capabilities || []).join(','),
      ]);
      process.stdout.write(`${table(['NAME', 'KIND', 'TRANSPORT', 'TARGET', 'APPROVAL', 'CAPS'], rows)}\n`);
      return 0;
    }
    case 'show': {
      const node = registry.mustGet(rest[1]);
      process.stdout.write(`${JSON.stringify(node, null, 2)}\n`);
      return 0;
    }
    case 'remove': {
      const node = registry.mustGet(rest[1]);
      registry.remove(node.id);
      ok(`removed node ${node.name}`);
      return 0;
    }
    case 'check':
      return cmdNodeCheck(rest[1], flags);
    default:
      die(`unknown subcommand 'node ${sub ?? ''}'. Try: mesh node add|edit|list|show|remove|check`);
  }
}

/**
 * @param {any} input
 */
/**
 * Build a node payload from ONLY the flags the caller actually passed.
 *
 * Every field is conditional on purpose. `mesh node edit --ssh-port 2222` must change
 * the port and nothing else; a builder that filled in defaults would also reset the
 * user, the command, and the approval policy to undefined.
 *
 * @param {Record<string, any>} flags
 * @returns {Record<string, any>}
 */
export function nodeInputFromFlags(flags) {
  /** @type {Record<string, any>} */
  const out = {};
  const set = (key, value) => {
    if (value !== undefined) out[key] = value;
  };
  const list = (v) => (Array.isArray(v) ? v : v !== undefined ? [v] : undefined);

  set('description', flags.description);
  if (flags.local) out.local = true;
  else if (flags.ssh) out.local = false;
  set('kind', flags.kind);
  set('transport', flags.transport);
  set('command', flags.command);
  set('args', list(flags.arg));
  set('cwd', flags.cwd);
  if (flags.env !== undefined) {
    const pairs = envPairs(list(flags.env));
    if (Object.keys(pairs).length) out.env = pairs;
  }
  if (flags.shell) out.shell = true;
  set('url', flags.url);
  set('token', flags.token);
  set('tenant', flags.tenant);
  set('username', flags.username);
  set('password', flags.password);
  set('approvalPolicy', flags.approval);
  set('clientRoot', flags.clientRoot);
  set('tags', list(flags.tag));
  set('capabilities', list(flags.capability));
  if (flags.clientFs) out.clientFs = true;
  if (flags.clientTerminal) out.clientTerminal = true;

  const sshHost = flags.ssh;
  /** @type {Record<string, any>} */
  const ssh = {};
  if (sshHost !== undefined) ssh.host = sshHost;
  if (flags['ssh-user'] !== undefined) ssh.user = flags['ssh-user'];
  if (flags['ssh-port'] !== undefined) ssh.port = int(flags['ssh-port'], 22);
  if (flags['ssh-key'] !== undefined) ssh.identityFile = flags['ssh-key'];
  if (flags['ssh-binary'] !== undefined) ssh.binary = flags['ssh-binary'];
  const binArgs = list(flags['ssh-binary-arg']);
  if (binArgs !== undefined) ssh.binaryArgs = binArgs;
  // BatchMode=yes is the safe default (never prompt, so the ACP pipe can never be read
  // as a password). `no` is for hosts that only accept a password, answered through an
  // SSH_ASKPASS helper.
  if (flags['ssh-batch-mode'] !== undefined) ssh.batchMode = bool(flags['ssh-batch-mode']);
  const opts = list(flags['ssh-opt']);
  if (opts !== undefined) ssh.extraOptions = opts;
  // A NAME, never the secret itself: this is what lets a password-only host work again
  // after a restart without any credential being written to nodes.json.
  let namedPasswordEnv = false;
  if (flags['ssh-password-env'] !== undefined) {
    const name = String(flags['ssh-password-env']);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      die(`--ssh-password-env must be an environment variable NAME, not the password itself (got ${name.length} chars)`);
    }
    ssh.passwordEnv = name;
    namedPasswordEnv = true;
  }
  // Naming a password source implies the host is password-only, and `BatchMode=yes` makes
  // ssh refuse to use a password at all — the node would be configured with a credential
  // it can never spend, and would fail with "the prompt has nothing to answer it". The Web
  // console already did this; the CLI did not, so the same node behaved differently
  // depending on where it was created. An explicit `--ssh-batch-mode` still wins.
  if (namedPasswordEnv && flags['ssh-batch-mode'] === undefined) ssh.batchMode = false;
  // `mesh node edit <n> --ssh-clear-secret` drops a password held in this process.
  if (flags['ssh-clear-secret']) ssh.clearSecret = true;
  if (Object.keys(ssh).length) out.ssh = ssh;
  // Repeated `--unset <field>` removes persisted fields, including nested `ssh.user`.
  const unset = list(flags.unset);
  if (unset !== undefined) out.unset = unset.map(String);
  return out;
}

/**
 * Refuse value flags that were given no value.
 *
 * `parseArgs` yields `true` for a value-taking flag with nothing after it. That is how
 * `--token ""` — an attempt to clear a leaked password, made through PowerShell, which
 * drops empty string arguments — silently wrote `"token": true` into a real registry
 * instead of clearing it, and how a valueless `--ssh-port` becomes port 1 (`Number(true)
 * === 1`) rather than an error.
 *
 * Checked against the raw flags, because the built payload cannot distinguish `--local`
 * (a genuine switch) from a flag that was meant to carry a value.
 *
 * @param {Record<string, any>} flags
 */
function rejectValuelessFlags(flags) {
  const bad = valuelessFlags(flags);
  if (!bad.length) return;
  die(`--${bad[0]} needs a value (it was given none). Use --unset ${bad[0]} to remove the field instead.`);
}

/**
 * Tell the operator, right at registration time, whether this node's SSH auth can
 * actually work. Getting this wrong is what produced the original bug report: the
 * console had no field for a username or a port, so ssh silently used the local Windows
 * user and port 22, and the only feedback was `process exited (code=255)`.
 *
 * @param {any} node
 * @param {Registry} registry
 */
function reportSshAuth(node, registry) {
  if (!node.ssh || node.local === true) return;
  const s = node.ssh;
  const missing = [];
  if (!s.user) missing.push('--ssh-user');
  if (!s.port) missing.push('--ssh-port');
  if (missing.length) {
    info('');
    info(`${color.yellow('warning')} no ${missing.join(' / ')} set, so ssh will use the local username (${process.env.USERNAME || process.env.USER || '?'}) and port 22.`);
    info(`          If the host listens elsewhere, add it: mesh node edit ${node.name} ${missing.map((m) => `${m} <value>`).join(' ')}`);
  }
  if (s.batchMode === false) {
    if (registry.hasSshPassword(node)) {
      info(`  ssh auth: password (from ${s.passwordEnv ? `$${s.passwordEnv}` : 'this process only'})`);
    } else {
      info('');
      info(`${color.yellow('warning')} ssh.batchMode is 'no' but no password is available, so the prompt has nothing to answer it.`);
      info(`          Set ${s.passwordEnv ? `$${s.passwordEnv}` : 'a password'} in the environment before starting mesh, or set one from the Web console.`);
    }
  } else {
    info('  ssh auth: key/agent only (BatchMode=yes). Use --ssh-batch-mode no for password-only hosts.');
  }
}

/**
 * @param {Record<string, any>} input
 * @param {{requireTarget?:boolean}} [opts]
 */
function validateNodeInput(input, opts = {}) {
  const t = input.transport || (input.kind && PRESETS[input.kind]?.transport);
  if (t === 'a2a' && !input.url) die('transport a2a requires --url (e.g. --url http://10.0.0.5:9900)');
  if (t === 'opencode' && !input.url) die('transport opencode requires --url (e.g. --url http://10.0.0.6:4096)');
  if ((t === 'acp' || t === 'cli') && !input.ssh && input.local === false) die('remote acp/cli node requires --ssh <host>');
  if ((t === 'acp' || t === 'cli') && input.ssh && !input.command && !(input.kind && PRESETS[input.kind]?.command)) {
    die(`transport ${t} over ssh requires --command`);
  }
  // A remote node with a host but no port is legal (22 is a fine default) but it is
  // exactly the trap the console fell into, so say so out loud rather than failing later.
  if (opts.requireTarget && input.ssh && !input.ssh.host) die('--ssh needs a host');
}

/**
 * @param {string} ref
 * @param {Record<string, any>} flags
 */
async function cmdNodeCheck(ref, flags) {
  if (!ref) die('usage: mesh node check <node>');
  const fleet = new Fleet();
  try {
    const node = fleet.registry.mustGet(ref);
    info(`checking ${node.name} (${node.transport}) …`);
    const adapter = fleet.adapterFor(node.name);
    const result = await adapter.probe();
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ node: node.name, ...result }, null, 2)}\n`);
    } else {
      renderProbe(node.name, result);
    }
    await fleet.close();
    return result?.reachable === false ? 1 : 0;
  } catch (err) {
    await fleet.close().catch(() => {});
    die(err);
  }
}

/**
 * @param {string} name
 * @param {any} result
 */
function renderProbe(name, result) {
  ok(`${name}: reachable`);
  if (result.transport === 'a2a') {
    const s = result.summary || summarizeCard(result.card);
    process.stdout.write(`  card      ${s.name} v${s.version}${s.provider ? ` — ${s.provider}` : ''}\n`);
    process.stdout.write(`  desc      ${s.description}\n`);
    process.stdout.write(`  rpc       ${result.rpcUrl}${result.tenant ? `  tenant=${result.tenant}` : ''}\n`);
    process.stdout.write(`  interface ${s.interface}\n`);
    process.stdout.write(`  streaming ${s.streaming}   push=${s.pushNotifications}   auth=${s.authRequired}\n`);
    process.stdout.write(`  skills:\n${cardSkillLines(result.card)}\n`);
    // A card that names a private RPC address is a real, common misconfiguration.
    // Saying nothing would leave the operator thinking the probe proved end-to-end
    // reachability, when all it proved is that the card could be fetched.
    for (const w of result.warnings || []) process.stderr.write(`  ! ${w}\n`);
    return;
  }
  if (result.transport === 'acp') {
    const ai = result.agentInfo || {};
    process.stdout.write(`  agent     ${ai.name || '?'} ${ai.title ? `(${ai.title})` : ''} v${ai.version || '?'}\n`);
    process.stdout.write(`  protocol  ACP v${result.protocolVersion ?? '?'}\n`);
    const caps = result.capabilities || {};
    process.stdout.write(`  caps      loadSession=${Boolean(caps.loadSession)} streaming=${Boolean(caps.promptCapabilities)}\n`);
    if (result.authMethods?.length) {
      process.stdout.write(`  auth      ${result.authMethods.map((/** @type {any} */ m) => `${m.id}(${m.type ?? '?'})`).join(', ')}\n`);
    } else {
      process.stdout.write('  auth      none advertised\n');
    }
    return;
  }
  if (result.transport === 'opencode') {
    process.stdout.write(`  server    ${result.title} ${result.version ?? ''} (${result.pathCount} paths in OpenAPI)\n`);
    const missing = Object.entries(result.endpointsFound || {}).filter(([, v]) => !v).map(([k]) => k);
    process.stdout.write(`  endpoints ${missing.length ? `missing: ${missing.join(', ')}` : 'all expected endpoints found'}\n`);
    return;
  }
  process.stdout.write(`  ${JSON.stringify(result)}\n`);
}

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------

/**
 * @param {string[]} rest
 * @param {Record<string, any>} flags
 */
async function cmdProbe(rest, flags) {
  const ref = rest[0];
  if (!ref) die('usage: mesh probe <node>');
  const fleet = new Fleet();
  try {
    const node = fleet.registry.mustGet(ref);
    const result = await fleet.probe(node.name);
    if (flags.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else renderProbe(node.name, result);
    await fleet.close();
    return 0;
  } catch (err) {
    await fleet.close().catch(() => {});
    die(err);
  }
}

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------

/**
 * @param {string[]} rest
 * @param {Record<string, any>} flags
 */
async function cmdSend(rest, flags) {
  const ref = rest[0];
  const prompt = rest.slice(1).join(' ').trim();
  if (!ref || !prompt) die('usage: mesh send <node> "<prompt>" [--continue] [--with-history] [--json]');

  const fleet = new Fleet();
  const json = bool(flags.json);
  const quiet = bool(flags.quiet);
  const policy = normalizePolicy(flags.approval);

  /** @type {Promise<void>[]} */
  const interactive = [];
  const rl = policy === PermissionPolicy.ASK && process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stderr }) : null;

  /** @type {(ev:any)=>void} */
  const onEvent = (ev) => {
    if (json) {
      process.stdout.write(`${JSON.stringify(ev)}\n`);
      return;
    }
    if (ev.type === EventType.CHUNK) {
      process.stdout.write(ev.text || '');
      return;
    }
    if (ev.type === EventType.APPROVAL_REQUESTED && rl) {
      interactive.push(
        (async () => {
          const opts = ev.data?.options || [];
          process.stderr.write(`\n${color.yellow('⚠️  approval required:')} ${ev.data?.title}\n`);
          opts.forEach((/** @type {any} */ o, /** @type {number} */ i) => process.stderr.write(`   [${i + 1}] ${o.name || o.kind} (${o.kind})\n`));
          const ans = await rl.question('choose (number), or Enter to deny: ');
          const idx = Number(ans.trim()) - 1;
          const chosen = Number.isInteger(idx) && opts[idx] ? opts[idx].optionId : null;
          const deny = opts.find((/** @type {any} */ o) => String(o.kind).startsWith('reject'));
          const optionId = chosen || (deny ? deny.optionId : null);
          fleet.resolveApproval(ev.data.id, optionId);
        })(),
      );
      return;
    }
    const line = renderEvent(ev, { showLog: bool(flags.verbose) || bool(flags.logs) });
    if (line) process.stderr.write(`${line}\n`);
  };

  const started = Date.now();
  let task;
  try {
    task = await fleet.send({
      nodeRef: ref,
      prompt,
      continueSession: bool(flags.continue),
      // A2A continuity depends on the peer keeping server-side context. `--with-history`
      // makes the client carry it, which is the only way to hold a real conversation
      // with a peer that answers each message in isolation.
      replayHistory: bool(flags['with-history']),
      // Off by default, and deliberately so: a node never hears about another node unless asked.
      // When several agents work on one job, this is how the operator lets each of them see what
      // the others were asked and answered.
      shareContext: bool(flags['share-context']),
      shareLimit: flags['share-limit'] ? int(flags['share-limit'], 6) : undefined,
      cwd: flags.cwd,
      stream: flags.stream === undefined ? undefined : bool(flags.stream),
      timeoutMs: flags.timeout ? int(flags.timeout, 0) : undefined,
      permissionPolicy: policy,
      onEvent,
    });
  } catch (err) {
    if (rl) rl.close();
    await fleet.close().catch(() => {});
    die(err);
  }
  await Promise.all(interactive);
  if (rl) rl.close();
  await fleet.close();

  if (!json && !quiet) {
    const dur = fmtDuration(Date.now() - started);
    process.stderr.write(`\n${color.dim('─'.repeat(60))}\n`);
    process.stderr.write(
      `${stateBadge(task.state)}  ${color.dim(`task=${task.id}`)}${task.sessionId ? `  ${color.dim(`session=${task.sessionId}`)}` : ''}${task.contextId ? `  ${color.dim(`context=${task.contextId}`)}` : ''}  ${color.dim(dur)}\n`,
    );
    if (task.error) process.stderr.write(`${color.red(task.error)}\n`);
    // A waiting state is not a failure and not a success: it means the remote stopped and is
    // waiting for a person. Printing the state name alone left the operator looking at a task
    // that appeared stuck, so say what was asked and give the exact command that answers it.
    if (WAITING_STATES.has(task.state)) {
      process.stderr.write(`${color.yellow('远端在等你回应')} —— 它没有失败，是停下来等人做决定。\n`);
      const question = String(task.result || '').trim();
      if (question) {
        process.stderr.write(`${color.dim('它问的是：')}\n`);
        for (const line of question.split(/\r?\n/).slice(0, 20)) process.stderr.write(`  ${line}\n`);
      } else {
        process.stderr.write(`${color.dim('它没有说明要什么。')}\n`);
      }
      process.stderr.write(`${color.dim('回答它（会带着同一个会话发回去）：')}\n`);
      process.stderr.write(`  mesh send ${ref} "<你的回答>" --continue\n`);
      if (!task.contextId) {
        // Without a context the follow-up starts a fresh conversation, which would reach the peer
        // as an unrelated request. Worth flagging rather than silently doing something different.
        process.stderr.write(
          `${color.yellow('注意')} 这次没有拿到 contextId，--continue 可能会开一段新会话；\n` +
            `     如果对端不支持续接，需要在它那一侧改（或改用 ACP 节点，见 USAGE §6.5）。\n`,
        );
      }
    }
  }
  return task.state === TaskState.COMPLETED ? 0 : 1;
}

/**
 * @param {any} value
 * @returns {'deny'|'allow-once'|'allow-always'|'ask'|undefined}
 */
function normalizePolicy(value) {
  if (!value) return undefined;
  const v = String(value);
  if (!['deny', 'allow-once', 'allow-always', 'ask'].includes(v)) die(`invalid --approval '${v}' (deny|allow-once|allow-always|ask)`);
  return /** @type {any} */ (v);
}

// ---------------------------------------------------------------------------
// broadcast
// ---------------------------------------------------------------------------

/**
 * @param {string[]} rest
 * @param {Record<string, any>} flags
 */
async function cmdBroadcast(rest, flags) {
  const prompt = rest.join(' ').trim();
  if (!prompt) die('usage: mesh broadcast "<prompt>" [--node a --node b | --capability c] [--mode all|first|best]');
  const fleet = new Fleet();
  const rawRefs = Array.isArray(flags.node) ? flags.node : flags.node ? [flags.node] : [];
  // `--node` with no value (or a flag-like one) must not turn into a hunt for a
  // node named "true".
  const refs = rawRefs.map((r) => String(r));
  if (refs.some((r) => !r || r === 'true')) {
    die('usage: mesh broadcast "<prompt>" [--node <name> ...] — every --node needs a node name (use --node=<name> if it starts with "-")');
  }
  const json = bool(flags.json);
  const results = await fleet.broadcast({
    prompt,
    refs,
    capability: flags.capability,
    mode: flags.mode,
    onEvent: (ev) => {
      if (json) {
        process.stdout.write(`${JSON.stringify(ev)}\n`);
        return;
      }
      if (ev.type === EventType.CHUNK && ev.text) process.stderr.write(`${color.dim(`[${ev.nodeId.slice(0, 12)}]`)} ${truncate(ev.text, 400)}\n`);
    },
  });
  await fleet.close();

  if (json) {
    process.stdout.write(`${JSON.stringify(results.map((r) => ({ node: r.node.name, state: r.task.state, taskId: r.task.id, result: r.task.result, error: r.task.error })), null, 2)}\n`);
    return results.every((r) => r.task.state === TaskState.COMPLETED) ? 0 : 1;
  }
  for (const { node, task } of results) {
    process.stdout.write(`\n${color.bold(`── ${node.name} `)}${stateBadge(task.state)}\n`);
    process.stdout.write(`${task.result || task.error || color.dim('(no output)')}\n`);
  }
  return results.every((r) => r.task.state === TaskState.COMPLETED) ? 0 : 1;
}

// ---------------------------------------------------------------------------
// cancel / tasks / task / watch
// ---------------------------------------------------------------------------

/**
 * Cancellation has to be written back over the **live connection**, so only the
 * process that owns the task can actually stop the agent. This used to build a
 * fresh Fleet, find the task in the shared store, call `adapter.cancel()` on a
 * brand-new (never connected) adapter — a silent no-op thanks to `this.#peer?.` —
 * and then mark the row `canceled` anyway, printing "✓ canceled" and exiting 0.
 * The agent kept working while every listing said it had stopped: the same
 * "who holds the connection" trap that `mesh approve` already handles correctly.
 * Now it asks the daemon that holds the task, and says so plainly when there is none.
 *
 * @param {string[]} rest
 * @param {Record<string, any>} flags
 */
async function cmdCancel(rest, flags) {
  const id = rest[0];
  if (!id) die('usage: mesh cancel <taskId> [--port 7331]');
  const port = int(flags.port, 7331);

  /** @type {string|null} */
  let daemonError = null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: id }),
    });
    if (res.ok) {
      ok(`canceled ${id}`);
      return 0;
    }
    const text = await res.text();
    if (res.status === 404) die(`unknown task ${id}`);
    daemonError = `daemon answered HTTP ${res.status}: ${text.slice(0, 200)}`;
  } catch {
    /* no daemon on that port — fall through to the honest explanation */
  }

  const store = openStore({ quiet: true });
  const task = store.findTask(id) || store.findTask(`task_${id}`);
  const state = task?.state;
  store.close();
  if (!task) die(`unknown task ${id}`);
  if (isTerminal(state)) {
    info(`task ${id} is already ${state} — nothing to cancel`);
    return 0;
  }
  die(
    `cannot cancel ${id}: no live connection holds it, and a cancellation is only\n` +
      `  delivered over that connection. The agent may still be working — this task is\n` +
      `  NOT marked canceled, because doing so would be a lie.\n` +
      `  task state: ${state}\n` +
      `  find or start the process that owns it:  mesh serve --port ${port}\n` +
      (daemonError ? `  (${daemonError})\n` : '') +
      `  if that process is gone for good, this row is an orphan: AgentMesh reconciles\n` +
      `  tasks whose owner pid is dead to failed(interrupted) on the next command.`,
  );
}

/**
 * Open the store and reconcile tasks orphaned by a dead control-plane process.
 *
 * Without this, a task whose dispatcher was killed shows as `working` forever and
 * every listing (CLI, dashboard, `mesh status` counters) reports a live task that
 * nobody is working on.
 *
 * @param {{quiet?:boolean}} [opts]
 * @returns {Store}
 */
function openStore({ quiet = false } = {}) {
  const store = new Store();
  try {
    const fixed = store.reconcileOrphans();
    if (fixed && !quiet) info(`reconciled ${fixed} task(s) abandoned by a dead process`);
  } catch {
    /* reconciliation is best-effort; never block a command on it */
  }
  return store;
}

/**
 * @param {string[]} rest
 * @param {Record<string, any>} flags
 */
function cmdTasks(rest, flags) {
  const store = openStore();
  // `--node` parses into an array (repeatable flag); `tasks` filters by one node.
  const nodeRef = Array.isArray(flags.node) ? flags.node[0] : flags.node;
  let nodeId;
  if (nodeRef) {
    const registry = new Registry();
    nodeId = registry.mustGet(nodeRef).id;
  }
  const tasks = store.listTasks({ nodeId, state: flags.state, limit: int(flags.limit, 30), activeOnly: bool(flags.active) });
  if (bool(flags.json)) {
    process.stdout.write(`${JSON.stringify(tasks, null, 2)}\n`);
    store.close();
    return 0;
  }
  if (!tasks.length) {
    info('no tasks yet');
    store.close();
    return 0;
  }
  const registry = new Registry();
  const rows = tasks.map((t) => [
    t.id.replace('task_', ''),
    registry.get(t.nodeId)?.name || t.nodeId.slice(0, 10),
    stateBadge(t.state),
    truncate(t.prompt.replace(/\s+/g, ' '), 46),
    t.createdAt.slice(11, 19),
    String(t.eventCount),
  ]);
  process.stdout.write(`${table(['TASK', 'NODE', 'STATE', 'PROMPT', 'STARTED', 'EV'], rows)}\n`);
  store.close();
  return 0;
}

/**
 * @param {string[]} rest
 * @param {Record<string, any>} flags
 */
function cmdTask(rest, flags) {
  const id = rest[0];
  if (!id) die('usage: mesh task <taskId> [--events]');
  const store = openStore({ quiet: true });
  const task = store.findTask(id) || store.findTask(`task_${id}`);
  if (!task) die(`unknown task ${id}`);
  if (bool(flags.json)) {
    const events = bool(flags.events) ? store.eventsForTask(task.id) : undefined;
    process.stdout.write(`${JSON.stringify({ ...task, events }, null, 2)}\n`);
    store.close();
    return 0;
  }
  process.stdout.write(`${color.bold('task')}      ${task.id}\n`);
  process.stdout.write(`node      ${task.nodeId}\n`);
  process.stdout.write(`state     ${stateBadge(task.state)}\n`);
  process.stdout.write(`prompt    ${truncate(task.prompt, 200)}\n`);
  if (task.sessionId) process.stdout.write(`session   ${task.sessionId}\n`);
  if (task.contextId) process.stdout.write(`context   ${task.contextId}\n`);
  if (task.remoteTaskId) process.stdout.write(`remote    ${task.remoteTaskId}\n`);
  process.stdout.write(`created   ${task.createdAt}\n`);
  process.stdout.write(`ended     ${task.endedAt || '-'}\n`);
  if (task.result) process.stdout.write(`\n${color.bold('result')}\n${task.result}\n`);
  if (task.error) process.stdout.write(`\n${color.red(task.error)}\n`);
  if (bool(flags.events)) {
    const events = store.eventsForTask(task.id);
    process.stdout.write(`\n${color.bold(`events (${events.length})`)}\n`);
    for (const ev of events) {
      const line = renderEvent(ev, { showLog: true });
      if (line) process.stdout.write(`${color.dim(ev.ts.slice(11, 19))} ${line}\n`);
    }
  }
  store.close();
  return 0;
}

/**
 * @param {string[]} rest
 * @param {Record<string, any>} flags
 */
async function cmdWatch(rest, flags) {
  const fleet = new Fleet();
  const taskFilter = flags.task;
  info(`watching fleet events${taskFilter ? ` for task ${taskFilter}` : ''} — Ctrl-C to stop`);
  if (bool(flags.follow) && taskFilter) {
    for (const ev of fleet.store.eventsForTask(String(taskFilter))) {
      const line = renderEvent(ev, { showLog: true });
      if (line) process.stdout.write(`${color.dim(ev.ts.slice(11, 19))} ${line}\n`);
    }
  }
  fleet.subscribe((ev) => {
    if (taskFilter && ev.taskId !== taskFilter && !String(ev.taskId || '').startsWith(String(taskFilter))) return;
    if (bool(flags.json)) {
      process.stdout.write(`${JSON.stringify(ev)}\n`);
      return;
    }
    const line = renderEvent(ev, { showLog: true });
    if (line) process.stdout.write(`${color.dim(String(ev.ts).slice(11, 19))} ${color.dim(`[${ev.nodeId.slice(5, 13)}]`)} ${line}\n`);
  });
  await new Promise(() => {});
  return 0;
}

/**
 * @param {string[]} rest
 * @param {Record<string, any>} flags
 */
function cmdStatus(rest, flags) {
  const registry = new Registry();
  const store = openStore({ quiet: true });
  const stats = store.stats();
  if (bool(flags.json)) {
    process.stdout.write(`${JSON.stringify({ registry: registry.file, store: store.file, nodes: registry.list().length, ...stats }, null, 2)}\n`);
    store.close();
    return 0;
  }
  process.stdout.write(`${color.bold('AgentMesh')} ${VERSION}\n`);
  process.stdout.write(`state dir   ${meshHome()}\n`);
  process.stdout.write(`nodes       ${registry.list().length}\n`);
  process.stdout.write(`tasks       ${stats.totalTasks}\n`);
  const states = Object.entries(stats.byState)
    .map(([s, n]) => `${stateBadge(s)}=${n}`)
    .join('  ');
  if (states) process.stdout.write(`by state    ${states}\n`);
  process.stdout.write(`approvals   ${stats.pendingApprovals} pending\n`);
  process.stdout.write(`events      ${stats.lastSeq}\n`);
  store.close();
  return 0;
}

// ---------------------------------------------------------------------------
// secrets
// ---------------------------------------------------------------------------

/**
 * `mesh secrets` — the sanctioned way to make an SSH password survive a restart.
 *
 * The password is written to `~/.agentmesh/secrets.env` (mode 0600) and loaded into the
 * environment at startup, which is what makes the existing `ssh.passwordEnv` route work without
 * retyping. A node still stores only the variable NAME, so nothing about the node model, the
 * registry's secret handling or the adapters changes.
 *
 * @param {string[]} rest
 * @param {Record<string, any>} flags
 */
async function cmdSecrets(rest, flags) {
  const sub = rest[0] || 'list';
  const name = rest[1];
  const path = secretsPath();

  if (sub === 'path') {
    process.stdout.write(`${path}\n`);
    return 0;
  }

  if (sub === 'list' || sub === 'ls') {
    const names = listSecrets();
    const report = loadSecrets();
    const loadedNames = new Set(report.loaded);
    const problemFor = new Map(report.problems.map((p) => [p.name, p.reason]));
    if (bool(flags.json)) {
      process.stdout.write(
        `${JSON.stringify({ path, names, loadedFromFile: [...loadedNames], problems: report.problems }, null, 2)}\n`,
      );
      return 0;
    }
    process.stdout.write(`${color.bold('secrets')}  ${path}\n`);
    if (!names.length) {
      process.stdout.write(`  (empty) — add one with: mesh secrets set NAS_SSH_PW\n`);
      return 0;
    }
    for (const n of names) {
      // Presence, never the value. `from file` means it is what a fresh process would use;
      // `shadowed` means the environment already had it, so the file entry is not in effect.
      // A malformed line is called out loudly rather than shown as a usable entry: the value is
      // NOT in effect, and the reason it is not is a typo in this file rather than anything about
      // the host, which is where an authentication failure would otherwise send you.
      const problem = problemFor.get(n);
      const state = problem
        ? color.red(`NOT USED — ${problem} (fix the line, or re-set it: mesh secrets set ${n})`)
        : loadedNames.has(n)
          ? 'in effect'
          : 'shadowed by the environment';
      process.stdout.write(`  ${pad(n, 24)} ${state}\n`);
    }
    return 0;
  }

  if (sub === 'set') {
    if (!name) {
      process.stderr.write(`${color.red('error:')} usage: mesh secrets set NAME [VALUE]\n`);
      return 2;
    }
    let value = rest[2];
    if (value === undefined && bool(flags.stdin)) {
      value = (await readAllStdin()).trim();
    } else if (value === undefined) {
      // Not echoed, and not in the shell history, which is where a password on the command line
      // ends up. `--stdin` exists for scripts; the prompt is for people.
      if (!process.stdin.isTTY) {
        value = (await readAllStdin()).trim();
      } else {
        value = await promptHidden(`value for ${name} (input hidden): `);
        const again = await promptHidden('repeat to confirm: ');
        if (value !== again) {
          process.stderr.write(`${color.red('error:')} the two entries did not match; nothing was written\n`);
          return 1;
        }
      }
    }
    const { path: written, replaced } = writeSecret(name, value);
    ok(`${replaced ? 'updated' : 'saved'} ${name} in ${written}`);
    process.stdout.write(`  a node uses it with: ssh.passwordEnv = ${name}\n`);
    process.stdout.write(`  or:  mesh node edit <node> --ssh-password-env ${name}\n`);
    process.stdout.write(color.yellow(`  note: this file is plain text protected by its permissions (0600). An SSH key avoids the secret entirely.\n`));
    return 0;
  }

  if (sub === 'rm' || sub === 'remove') {
    if (!name) {
      process.stderr.write(`${color.red('error:')} usage: mesh secrets rm NAME\n`);
      return 2;
    }
    const removed = removeSecret(name);
    if (!removed) {
      process.stderr.write(`${color.red('error:')} ${name} is not in ${path}\n`);
      return 1;
    }
    ok(`removed ${name}`);
    return 0;
  }

  process.stderr.write(`${color.red('error:')} unknown 'secrets' subcommand '${sub}'\n`);
  process.stderr.write(`usage: mesh secrets [list | set NAME [VALUE] | rm NAME | path]\n`);
  return 2;
}

/**
 * Read a password without echoing it. Raw mode is the only way to do that without a dependency,
 * and it also keeps the value out of the shell history and off the screen.
 * @param {string} label
 * @returns {Promise<string>}
 */
function promptHidden(label) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let out = '';
    const done = (/** @type {Error|null} */ err) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      if (err) reject(err);
      else resolve(out);
    };
    /** @param {string} chunk */
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(null);
        if (ch === '\u0003') return done(new Error('cancelled'));       // ctrl-c
        if (ch === '\u007f' || ch === '\b') { out = out.slice(0, -1); continue; }
        if (ch === '\u001b') continue;                                   // ignore escape sequences
        out += ch;
      }
    };
    stdin.on('data', onData);
  });
}

/** @returns {Promise<string>} */
async function readAllStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

// ---------------------------------------------------------------------------
// approvals
// ---------------------------------------------------------------------------

/**
 * @param {string[]} rest
 * @param {Record<string, any>} flags
 */
function cmdApprovals(rest, flags) {
  const store = openStore({ quiet: true });
  // `null` (not undefined) disables the filter; undefined would fall back to a
  // default and make `--all` a no-op.
  const list = store.listApprovals({ status: flags.all ? null : 'pending', limit: int(flags.limit, 50) });
  if (bool(flags.json)) {
    process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
    store.close();
    return 0;
  }
  if (!list.length) {
    info('no approvals');
    store.close();
    return 0;
  }
  const rows = list.map((a) => [
    a.id,
    a.status,
    a.title,
    a.taskId ? a.taskId.replace('task_', '') : '-',
    a.createdAt.slice(11, 19),
    a.options.map((/** @type {any} */ o) => o.kind).join('/'),
  ]);
  process.stdout.write(`${table(['APPROVAL', 'STATUS', 'TITLE', 'TASK', 'AT', 'OPTIONS'], rows)}\n`);
  store.close();
  return 0;
}

/**
 * `mesh approve` talks to a running `mesh serve` when one is up (that process
 * holds the live ACP/opencode connection), and otherwise explains what to do.
 * @param {string[]} rest
 * @param {Record<string, any>} flags
 */
async function cmdApprove(rest, flags) {
  const id = rest[0];
  if (!id) die('usage: mesh approve <approvalId> [--allow|--deny] [--option <optionId>] [--port 7331]');
  const store = openStore({ quiet: true });
  const approval = store.listApprovals({ status: null, limit: 500 }).find((a) => a.id === id || a.id.startsWith(id));
  const port = int(flags.port, 7331);
  const url = `http://127.0.0.1:${port}/api/approvals/${id}`;
  const body = {
    optionId: flags.option ? String(flags.option) : flags.deny ? null : pickAllow(approval),
  };
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) die(`daemon rejected the approval: HTTP ${res.status} ${text.slice(0, 300)}`);
    ok(`approval ${id} ${body.optionId ? `approved (${body.optionId})` : 'denied'}`);
    store.close();
    return 0;
  } catch (err) {
    store.close();
    die(
      `could not reach the AgentMesh daemon on port ${port} (${err instanceof Error ? err.message : String(err)}).\n` +
        `  Approvals are held by the process that owns the live connection.\n` +
        `  Start one with:  mesh serve --port ${port}\n` +
        (approval ? `  (known approval: ${approval.title} — options: ${approval.options.map((/** @type {any} */ o) => o.optionId).join(', ')})` : ''),
    );
  }
}

/**
 * @param {any} approval
 * @returns {string|null}
 */
function pickAllow(approval) {
  if (!approval) return null;
  const opts = approval.options || [];
  const once = opts.find((/** @type {any} */ o) => o.kind === 'allow_once') || opts.find((/** @type {any} */ o) => o.kind === 'allow_always');
  return once ? once.optionId : null;
}

// ---------------------------------------------------------------------------
// serve / presets
// ---------------------------------------------------------------------------

/**
 * `mesh agent [prompt]` — talk to the LOCAL orchestrator.
 *
 * With a prompt it runs once. Without one it opens a session, because the thing being
 * built here is "say one sentence to a local agent and it decides what to do", and
 * retyping the whole command each turn is not that.
 *
 * @param {string[]} rest
 * @param {Record<string, any>} flags
 */
async function cmdAgent(rest, flags) {
  const sub = rest[0];

  // ---- `mesh agent models` : what can this gateway actually serve -----------------
  if (sub === 'models') {
    await withLlmFlags(flags, async () => {
      const models = await listModels();
      if (bool(flags.json)) {
        process.stdout.write(`${JSON.stringify(models)}\n`);
        return;
      }
      const filter = flags.filter ? String(flags.filter).toLowerCase() : '';
      const shown = filter ? models.filter((m) => m.toLowerCase().includes(filter)) : models;
      const cfg = llmConfig();
      process.stderr.write(`${color.bold(String(shown.length))} model(s) at ${cfg.baseUrl}${filter ? ` matching '${filter}'` : ''}\n\n`);
      for (const m of shown) process.stdout.write(`${m}\n`);
    });
    return 0;
  }

  // ---- `mesh agent save` : persist the non-secret settings -------------------------
  if (sub === 'save') {
    const { saveLlmConfig, llmConfigPath: cfgPath, readLlmConfigFile: readCfg } = await import('../core/llm.js');
    if (flags['api-key']) {
      die('--api-key is not accepted: a key on the command line is visible to every process on this machine.\n' +
        '       Put it in an environment variable and pass --api-key-env <NAME>.');
    }
    try {
      const path = saveLlmConfig({
        baseUrl: flags['base-url'] ? String(flags['base-url']) : undefined,
        model: flags.model ? String(flags.model) : undefined,
        apiKeyEnv: flags['api-key-env'] ? String(flags['api-key-env']) : undefined,
      });
      ok(`saved ${cfgPath()}`);
      const saved = readCfg();
      info(`  base_url ${saved.baseUrl ?? '(unset)'}`);
      info(`  model    ${saved.model ?? '(unset)'}`);
      info(`  api_key  ${saved.apiKeyEnv ? `read from $${saved.apiKeyEnv}` : '(none)'}`);
      info('');
      info('The file never contains the key itself, only the name of the variable to read it from.');
      return 0;
    } catch (err) {
      die(err instanceof Error ? err.message : String(err));
    }
  }

  // ---- `mesh agent config` : show what is resolved, never the key ------------------
  if (sub === 'config') {
    const cfg = { ...llmConfig() };
    const ready = llmReady(cfg);
    const file = readLlmConfigFile();
    process.stdout.write(`${color.bold('orchestrator LLM')}\n`);
    process.stdout.write(`  base_url  ${cfg.baseUrl || color.red('(unset)')}\n`);
    process.stdout.write(`  model     ${cfg.model || color.red('(unset)')}\n`);
    // The key is reported as presence + length only. A key that ends up in a log, a
    // screenshot or a bug report is a key that has to be rotated.
    process.stdout.write(`  api_key   ${cfg.apiKey ? `(set, ${cfg.apiKey.length} chars)` : '(none)'}\n`);
    process.stdout.write(`  status    ${ready.ok ? color.green('ready') : color.red(`missing ${ready.missing.join(', ')}`)}\n`);
    process.stdout.write(`  config    ${llmConfigPath()}\n`);
    if (file.ignoredApiKey) {
      process.stdout.write(`  ${color.yellow('warning')}   that file contains an "apiKey" field, which is IGNORED. Use "apiKeyEnv" to name an env var instead.\n`);
    }
    if (file.apiKeyEnv && !process.env[file.apiKeyEnv]) {
      process.stdout.write(`  ${color.yellow('warning')}   the file names $${file.apiKeyEnv}, but that variable is not set in this shell.\n`);
    }
    process.stdout.write(`\nsources: --base-url/--model > AGENTMESH_LLM_* env vars > ${llmConfigPath()}\n`);
    if (ready.ok) {
      try {
        const models = await listModels();
        process.stdout.write(`gateway reachable: ${models.length} model(s)\n`);
      } catch (err) {
        process.stdout.write(`${color.yellow('gateway unreachable')}: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    return 0;
  }

  // ---- one-shot or interactive ---------------------------------------------------
  const prompt = rest.join(' ').trim();
  return withLlmFlags(flags, async () => {
    const fleet = new Fleet();
    try {
      const policy = agentPolicy(flags);
      if (bool(flags.confirm)) policy.onConfirm = makeConfirmHook();
      if (!prompt) return await agentRepl(fleet, policy, flags);

      const res = await runAgent({
        fleet,
        prompt,
        policy,
        llm: llmOverrides(flags),
        onEvent: makeAgentRenderer(flags),
      });
      return reportAgentRun(res, flags);
    } finally {
      await fleet.close();
    }
  });
}

/**
 * Apply `--base-url` / `--model` / `--api-key-env` to the module-level LLM config, run
 * the body, and restore. Using the module override (rather than passing config
 * everywhere) keeps `mesh agent models` and `config` on the exact same resolution path
 * as a real run — a config that reports one thing and sends another is worse than none.
 *
 * @param {Record<string, any>} flags
 * @param {() => Promise<any>} body
 */
async function withLlmFlags(flags, body) {
  const previous = process.env.AGENTMESH_LLM_BASE_URL;
  const previousModel = process.env.AGENTMESH_LLM_MODEL;
  if (flags['base-url']) process.env.AGENTMESH_LLM_BASE_URL = String(flags['base-url']);
  if (flags.model) process.env.AGENTMESH_LLM_MODEL = String(flags.model);
  // `--api-key-env NAME` keeps the secret out of the process table: a key passed as
  // `--api-key sk-...` is visible to every other process on the machine.
  if (flags['api-key-env']) {
    const name = String(flags['api-key-env']);
    const value = process.env[name];
    if (!value) die(`--api-key-env ${name}: that environment variable is empty or unset`);
    process.env.AGENTMESH_LLM_API_KEY = value;
  }
  try {
    return await body();
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  } finally {
    if (flags['base-url']) process.env.AGENTMESH_LLM_BASE_URL = previous;
    if (flags.model) process.env.AGENTMESH_LLM_MODEL = previousModel;
  }
}

/** @param {Record<string, any>} flags */
function llmOverrides(flags) {
  /** @type {Record<string, any>} */
  const llm = {};
  if (flags['base-url']) llm.baseUrl = String(flags['base-url']);
  if (flags.model) llm.model = String(flags.model);
  return llm;
}

/**
 * Ask before each dispatch, on the terminal. Reads from stdin, writes the question to
 * stderr, so a redirected stdout still captures only the answer.
 *
 * Defaults to NO when stdin is not a terminal: an unattended run must not be able to
 * bootstrap its way into dispatching work by asking a question nobody can answer.
 */
function makeConfirmHook() {
  return async ({ node, prompt }) => {
    if (!process.stdin.isTTY) {
      process.stderr.write(`${color.yellow('refusing dispatch')} to ${node}: --confirm was given but stdin is not a terminal\n`);
      return false;
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = await rl.question(`  ${color.yellow('dispatch?')} ${color.bold(node)} ${color.dim(truncate(prompt.replace(/\s+/g, ' '), 120))} ${color.dim('[y/N]')} `);
      return /^y(es)?$/i.test(answer.trim());
    } catch {
      return false;
    } finally {
      rl.close();
    }
  };
}

/**
 * The permission gate. These flags ARE the permission model, so they are resolved in one
 * place and the unknown-tool case is rejected loudly rather than silently ignored.
 * @param {Record<string, any>} flags
 */
function agentPolicy(flags) {
  /** @type {any} */
  const policy = {
    maxSteps: int(flags['max-steps'], 8),
    maxDispatches: int(flags['max-dispatches'], 8),
    dryRun: bool(flags['dry-run']),
  };
  if (flags.tools) {
    const names = String(flags.tools).split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = names.filter((n) => !AGENT_TOOLS.includes(/** @type {any} */ (n)));
    if (unknown.length) die(`--tools: unknown tool(s) ${unknown.join(', ')}. Known: ${AGENT_TOOLS.join(', ')}`);
    policy.allow = names;
  } else if (bool(flags['read-only'])) {
    policy.allow = READ_ONLY_TOOLS;
  }
  return policy;
}

/**
 * Turn orchestrator events into terminal output. Progress goes to stderr and the answer
 * to stdout, so `mesh agent "…" > answer.md` captures the answer and nothing else.
 * @param {Record<string, any>} flags
 */
function makeAgentRenderer(flags) {
  const json = bool(flags.json);
  const verbose = bool(flags.verbose) || bool(flags.logs);
  return (ev) => {
    if (json) {
      process.stdout.write(`${JSON.stringify(ev)}\n`);
      return;
    }
    switch (ev.type) {
      case 'agent-start':
        process.stderr.write(`${color.dim(`orchestrator ${ev.data?.model ?? ''} · nodes: ${(ev.data?.nodes || []).join(', ') || '(none)'}${ev.data?.dryRun ? ' · DRY RUN' : ''}`)}\n`);
        break;
      case 'agent-thought':
        process.stderr.write(`${color.dim(truncate(String(ev.text).replace(/\s+/g, ' '), 200))}\n`);
        break;
      case 'agent-tool-call':
        process.stderr.write(`${color.cyan('→')} ${color.bold(String(ev.text))} ${color.dim(truncate(JSON.stringify(ev.data?.args ?? {}), 160))}\n`);
        break;
      case 'agent-tool-result':
        if (verbose) process.stderr.write(`${color.dim(`  ← ${truncate(String(ev.data?.result ?? '').replace(/\s+/g, ' '), 300)}`)}\n`);
        break;
      case 'agent-dispatch':
        process.stderr.write(`  ${color.green('✓')} ${ev.data?.node} ${stateBadge(String(ev.data?.state))} ${color.dim(`task=${String(ev.data?.taskId ?? '').slice(0, 12)}`)}\n`);
        break;
      case 'agent-final':
        break;
      default:
        break;
    }
  };
}

/**
 * Print the outcome of a run and return an exit code. An unfinished run must not look
 * like a successful empty answer, so the step limit is reported as a failure.
 * @param {any} res
 * @param {Record<string, any>} flags
 */
function reportAgentRun(res, flags) {
  if (bool(flags.json)) {
    process.stdout.write(`${JSON.stringify({ type: 'agent-result', ...res, toolCalls: res.toolCalls.length })}\n`);
    return res.stopReason === 'step-limit' ? 1 : 0;
  }
  if (res.stopReason === 'step-limit') {
    process.stderr.write(`${color.red('error:')} the orchestrator hit the step limit (${res.steps}) without finishing. Nothing was reported as done.\n`);
    return 1;
  }
  if (res.text) process.stdout.write(`${res.text}\n`);
  if (!bool(flags.quiet)) {
    const parts = [`${res.steps} step(s)`];
    if (res.dispatchCount) parts.push(`${res.dispatchCount} dispatched`);
    if (res.usage?.total_tokens) parts.push(`${res.usage.total_tokens} tokens`);
    process.stderr.write(`${color.dim(`— ${parts.join(' · ')}`)}\n`);
  }
  return 0;
}

/**
 * An interactive orchestration session.
 * @param {import('../core/fleet.js').Fleet} fleet
 * @param {any} policy
 * @param {Record<string, any>} flags
 */
async function agentRepl(fleet, policy, flags) {
  if (!process.stdin.isTTY) {
    die('no prompt given and stdin is not a terminal. Usage: mesh agent "<what you want done>"');
  }
  const cfg = llmConfig();
  process.stderr.write(`${color.bold('AgentMesh orchestrator')} ${color.dim(`(${cfg.model} @ ${cfg.baseUrl})`)}\n`);
  const names = fleet.registry.list().map((n) => n.name);
  process.stderr.write(`${color.dim(`nodes: ${names.join(', ') || '(none registered)'}`)}\n`);
  process.stderr.write(`${color.dim('说一句话让它去办。/help 帮助，/exit 退出。')}\n\n`);

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    for (;;) {
      let line;
      try {
        line = (await rl.question(color.cyan('agent> '))).trim();
      } catch {
        break; // EOF / ctrl-c
      }
      if (!line) continue;
      if (line === '/exit' || line === '/quit') break;
      if (line === '/help') {
        process.stderr.write(`  /nodes   list nodes\n  /exit    quit\n  anything else is sent to the orchestrator\n`);
        continue;
      }
      if (line === '/nodes') {
        for (const n of fleet.registry.list()) process.stderr.write(`  ${n.name} ${color.dim(`[${n.transport}] ${n.transport === 'a2a' ? n.url : n.ssh ? `ssh://${n.ssh.host}` : n.command}`)}\n`);
        continue;
      }
      try {
        const res = await runAgent({ fleet, prompt: line, policy, llm: llmOverrides(flags), onEvent: makeAgentRenderer(flags) });
        if (res.text) process.stdout.write(`\n${res.text}\n\n`);
        if (res.stopReason === 'step-limit') process.stderr.write(`${color.red('step limit reached; the run did not finish')}\n\n`);
      } catch (err) {
        // One bad turn must not end the session.
        process.stderr.write(`${color.red('error:')} ${err instanceof Error ? err.message : String(err)}\n\n`);
      }
    }
  } finally {
    rl.close();
  }
  return 0;
}

/**
 * @param {string[]} rest
 * @param {Record<string, any>} flags
 */
async function cmdServe(rest, flags) {
  const { startServer } = await import('../web/server.js');
  return startServer({ port: int(flags.port, 7331), host: flags.host || '127.0.0.1', open: bool(flags.open, false) });
}

function cmdPresets() {
  process.stdout.write(`${color.bold('Built-in agent presets')}\n\n`);
  const rows = Object.entries(PRESETS).map(([name, p]) => [
    name,
    p.transport || '-',
    p.kind || '-',
    p.command || p.url || '-',
    p.hint,
  ]);
  process.stdout.write(`${table(['PRESET', 'TRANSPORT', 'KIND', 'DEFAULT TARGET', 'NOTE'], rows)}\n`);
  return 0;
}
