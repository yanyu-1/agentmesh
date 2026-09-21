/**
 * Tiny argv parser (zero dependencies).
 *
 *   mesh send node-a "do the thing" --continue --timeout 600000
 *   mesh node add hermes-b --kind hermes --ssh host --arg acp
 *   mesh broadcast "review this" --node hermes-a --node hermes-b
 *
 * Repeatable flags: --arg, --tag, --capability, --env.
 *
 * @module cli/args
 */

/**
 * Repeatable flags.
 *
 * A flag that may legitimately appear more than once and is missing from this set silently
 * keeps only its LAST value: a second `--ssh-opt` discarded the first, which sent ssh
 * looking in the wrong known_hosts. Every new accumulating flag belongs here.
 */
const REPEATABLE = new Set(['arg', 'tag', 'capability', 'env', 'node', 'ssh-opt', 'ssh-binary-arg', 'unset']);

/**
 * Flags that legitimately carry no value.
 *
 * Everything else that arrives as the boolean `true` was a value flag the caller left
 * empty — see `valuelessFlags`. Node fields that really are switches (`--local`,
 * `--shell`) belong here; getting that wrong breaks `mesh node add x --local`, which is
 * exactly what happened when this check was first written against the built payload
 * instead of against the raw flags.
 */
const VALUELESS_OK = new Set([
  // global switches
  'help', 'version', 'json', 'quiet', 'verbose', 'force', 'yes', 'all', 'allow', 'deny',
  'stream', 'no-stream', 'events', 'logs', 'follow', 'dry-run', 'read-only', 'confirm',
  // node fields that are genuinely boolean
  'local', 'shell', 'client-fs', 'client-terminal', 'enabled', 'ssh-clear-secret',
]);

/**
 * Flags that never take a value.
 *
 * Anything that is a switch but is missing from this set swallows the next token, which
 * for `mesh agent` is the user's prompt: `mesh agent --confirm 让 nas 干活` silently became
 * prompt="nas 干活" with confirm="让". So every new boolean flag must be listed here.
 *
 * `allow`/`deny` are here for `mesh approve`, which is why the agent's tool allow-list is
 * spelled `--tools`: `--allow` cannot take a value.
 */
const BOOLEAN = new Set([
  'help', 'version', 'json', 'quiet', 'verbose', 'continue', 'stream', 'no-stream',
  'local', 'yes', 'allow', 'deny', 'all', 'force', 'events', 'logs', 'follow',
  'dry-run', 'read-only', 'confirm', 'ssh-clear-secret', 'stdin', 'share-context',
]);

/**
 * @param {string[]} argv
 * @returns {{_:string[], flags:Record<string, any>, raw:string[]}}
 */
export function parseArgs(argv) {
  /** @type {string[]} */
  const positional = [];
  /** @type {Record<string, any>} */
  const flags = {};
  const raw = [...argv];

  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!tok.startsWith('-')) {
      positional.push(tok);
      continue;
    }
    const isLong = tok.startsWith('--');
    let key = isLong ? tok.slice(2) : tok.slice(1);
    let value;
    const eq = key.indexOf('=');
    if (eq >= 0) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    const negated = key.startsWith('no-') && BOOLEAN.has(key.slice(3));
    if (negated) key = key.slice(3);

    // A repeatable flag consumes the next token exactly like any other value flag.
    // Excluding repeatable flags here was a bug: `--env K=V`, `--tag alpha`,
    // `--capability c` and `--node a` all became the bare boolean `true`, and the
    // real value was left behind as a positional argument. `--node a --node b`
    // (the documented way to fan out) selected nodes literally named "true".
    // A value that itself starts with `-` still needs `--flag=--value`.
    if (value === undefined && !BOOLEAN.has(key)) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        value = next;
        i += 1;
      }
    }

    if (negated) {
      flags[key] = false;
      continue;
    }
    if (REPEATABLE.has(key)) {
      // A repeatable flag with no value is always a mistake: it would be stored as
      // the bare boolean `true` and the real value left behind as a positional.
      // (`--node a --node b` used to hunt for nodes named "true".) A value that
      // genuinely starts with "-" must be attached: --ssh-binary-arg=-batch.
      if (value === undefined) {
        throw new Error(`--${key} requires a value (write --${key}=<value> if the value itself starts with "-")`);
      }
      if (!Array.isArray(flags[key])) flags[key] = [];
      flags[key].push(value);
      continue;
    }
    if (value === undefined) flags[key] = true;
    else flags[key] = value;
  }
  return { _: positional, flags, raw };
}

/**
 * Read `--env KEY=VAL` pairs into an object.
 * @param {string[]|undefined} list
 * @returns {Record<string,string>}
 */
export function envPairs(list) {
  /** @type {Record<string,string>} */
  const out = {};
  for (const item of list || []) {
    const s = String(item);
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    out[s.slice(0, eq)] = s.slice(eq + 1);
  }
  return out;
}

/**
 * Parse a boolean-ish CLI value.
 * @param {any} v
 * @param {boolean} [dflt]
 * @returns {boolean}
 */
export function bool(v, dflt = false) {
  if (v === undefined) return dflt;
  if (typeof v === 'boolean') return v;
  return !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase());
}

/**
 * Parse an integer with a default.
 * @param {any} v
 * @param {number} dflt
 * @returns {number}
 */
export function int(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : dflt;
}

/**
 * Names of flags that were written without a value and are not switches.
 *
 * A value flag at the end of argv, or immediately followed by another `--flag`, is stored
 * as the boolean `true`. That is usually an accident, and a costly one: PowerShell drops
 * empty string arguments, so `--token ""` arrives as a bare `--token`, and `token: true`
 * was written into a live registry while the caller believed they were clearing it.
 *
 * The same coercion quietly corrupts numbers — `int(true, 22)` is `1`, because
 * `Number(true) === 1` — so a valueless `--ssh-port` becomes port 1 rather than an error.
 *
 * This is checked against the RAW flags, not against the built payload: a payload check
 * cannot tell `--local` (a real switch) from a switch that was meant to take a value.
 *
 * @param {Record<string, any>} flags
 * @returns {string[]} offending flag names, in the order they appear
 */
export function valuelessFlags(flags) {
  return Object.entries(flags || {})
    .filter(([key, value]) => value === true && !VALUELESS_OK.has(key))
    .map(([key]) => key);
}

export const HELP = `AgentMesh — one console for agents on many machines

USAGE
  mesh <command> [options]

NODES
  mesh node add <name> [options]     register an agent endpoint
  mesh node edit <node> [options]    change fields (only the ones you pass)
  mesh node list                     list nodes
  mesh node show <node>              show one node's full config
  mesh node remove <node>            unregister
  mesh node check <node>             connectivity / version check

  node edit also takes:
  --unset <field>                    remove a field (repeatable; e.g. --unset token,
                                     --unset ssh.passwordEnv)
  --ssh-password-env <NAME>          read the SSH password from $NAME at connect time.
                                     The registry stores the NAME, never the password.
  --ssh-clear-secret                 drop a password held in the running process

TASKS
  mesh probe <node>                  capability probe (Agent Card / ACP handshake)
  mesh send <node> "<prompt>"        send a task to one node
  mesh broadcast "<prompt>"          fan out to many nodes
  mesh cancel <taskId>               cancel a running task
  mesh tasks [--node <n>]            recent tasks
  mesh task <taskId> [--events]      one task, optionally with its event log
  mesh watch [--task <id>]           live event stream
  mesh status                        fleet + store summary

  send/broadcast also take:
  --continue                         reuse that node's last session/context
  --with-history                     also replay that node's earlier turns into the prompt
  --share-context                    prepend recent turns from OTHER nodes, so a peer can see
                                     what another agent was told and answered (off by default:
                                     sessions are per-node and never bleed into each other)
  --share-limit <n>                  how many recent turns to include (default 6)

SECRETS
  mesh secrets                       what is saved, and whether it is in effect
  mesh secrets set NAME [VALUE]      save a value (prompts without echoing; --stdin for scripts)
  mesh secrets rm NAME               forget one
  mesh secrets path                  where the file is

  Saved values live in ~/.agentmesh/secrets.env (mode 0600) and are loaded into the
  environment at startup, so 'ssh.passwordEnv = NAME' survives a restart without retyping.
  The file is plain text protected by its permissions — an SSH key avoids the secret entirely.

APPROVALS
  mesh approvals                     parked approvals awaiting a decision
  mesh approve <approvalId> --allow  answer one (or --deny / --option <id>)

AGENT (local orchestrator)
  mesh agent "<sentence>"            say what you want; it decides which node does it
  mesh agent                         interactive session (same thing, multi-turn)
  mesh agent models [--filter <s>]   models the configured gateway serves
  mesh agent config                  resolved provider settings (never prints the key)
  mesh agent save --base-url <u> --model <m> [--api-key-env <NAME>]
                                     persist provider settings under .agentmesh/

AGENT OPTIONS
  --model <id>           provider model to drive the agent
  --base-url <url>       OpenAI-compatible endpoint (…/v1)
  --api-key-env <NAME>   read the key from this env var (never pass a key inline)
  --max-steps <n>        LLM turns before giving up (default 8)
  --max-dispatches <n>   cap on tasks actually dispatched in one run (default 8)
  --dry-run              decide and report the plan, dispatch nothing
  --read-only            only list/probe/inspect tools; nothing can be dispatched
  --tools <t1,t2>        explicit tool allow-list (list_nodes,probe_node,send_task,
                         broadcast,list_tasks,get_task)
  --confirm              ask before each dispatch

SERVE
  mesh serve [--port 7331]           Web console + approval API
  mesh presets                       list built-in agent presets

COMMON OPTIONS
  --json                 machine-readable output (NDJSON events / JSON results)
  --quiet                suppress progress lines
  --help                 this text

NODE ADD OPTIONS
  --kind <preset>        hermes|opencode|gemini|claude|codex|generic-acp
  --transport <t>        acp|a2a|opencode|cli
  --local                run the agent on this machine (default for acp/cli)
  --ssh <host>           run the agent on a remote host over SSH
  --ssh-user <u> --ssh-port <p> --ssh-key <path>
  --ssh-binary <path>    use a different ssh client (e.g. plink.exe)
  --ssh-binary-arg <a>   (repeatable) args placed before the ssh args
  --ssh-batch-mode <y|n> default yes: never prompt, so the ACP stdio pipe can never be
                         read as a password. Use 'no' only with an SSH_ASKPASS helper
                         on hosts that accept nothing but a password.
  --ssh-opt <o>          (repeatable) verbatim -o passthrough, e.g.
                         --ssh-opt UserKnownHostsFile=/path/known_hosts
                         --ssh-opt StrictHostKeyChecking=accept-new
                         --ssh-opt ProxyJump=bastion
  --command <cmd> --arg <a> (repeatable) --cwd <dir> --env K=V (repeatable)
  --url <url>            for a2a / opencode transports
  --token <t>            A2A bearer token
  --username <u> --password <p>   opencode basic auth
  --approval <policy>    deny|allow-once|allow-always|ask
  --capability <c>       (repeatable) used by broadcast
  --tag <t>              (repeatable)
  --description <text>
  --local / --shell      switches (they take no value)

  A value that itself begins with "-" must be attached: --arg=--verbose

EXAMPLES
  # local Hermes over ACP (works today on this machine)
  mesh node add hermes-local --kind hermes --local --cwd D:\\工作
  mesh send hermes-local "say hello in one short sentence"

  # remote Hermes over SSH, no inbound port needed
  mesh node add hermes-b --kind hermes --ssh 10.0.0.5 --ssh-user root --cwd /srv/work

  # a NAS that only accepts a password: the registry stores the VARIABLE NAME, never the
  # password itself, so the node keeps working across restarts without any secret on disk
  mesh node add nas --kind hermes --ssh 10.0.0.5 --ssh-user me --ssh-port 2222 \\
    --ssh-batch-mode no --ssh-password-env NAS_SSH_PW \\
    --command /opt/hermes/bin/hermes-acp --cwd /srv/work

  # fix the port later, and drop a field that should never have been there
  mesh node edit nas --ssh-port 22
  mesh node edit nas --unset token

  # remote Hermes over its native A2A port
  mesh node add hermes-a2a --transport a2a --url http://10.0.0.5:9900 --token <secret>

  # opencode headless server
  mesh node add oc-a --transport opencode --url http://10.0.0.6:4096 --password <pass>
`;
