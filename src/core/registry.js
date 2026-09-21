/**
 * Node registry — the list of managed agents, persisted as JSON.
 *
 * A "node" is one managed agent endpoint. The flat shape keeps the CLI simple and
 * the file human-editable; `transport` decides which adapter is used.
 *
 * @module core/registry
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { meshHome, newId, nowIso } from '../protocol/util.js';

/**
 * @typedef {object} NodeConfig
 * @property {string} id
 * @property {string} name
 * @property {string} kind            hermes | opencode | gemini | claude | codex | generic-acp
 * @property {'acp'|'a2a'|'opencode'|'cli'} transport
 * @property {string} [description]
 * @property {boolean} [local]        acp/cli: run on this machine instead of over ssh
 * @property {{host:string,user?:string,port?:number,identityFile?:string,batchMode?:boolean,extraOptions?:string[],binary?:string,binaryArgs?:string[],passwordEnv?:string}} [ssh]
 *   `passwordEnv` names an ENVIRONMENT VARIABLE to read the SSH password from. It is a
 *   name, not a secret, so it is safe to persist. A password typed into the console is
 *   held only in this process's memory (see `Registry.setSecret`) and never reaches disk.
 * @property {string} [command]       acp/cli: executable
 * @property {string[]} [args]
 * @property {string} [cwd]           session working directory (remote path when over ssh)
 * @property {Record<string,string>} [env]
 * @property {boolean} [shell]        run command through a shell
 * @property {string} [url]           a2a/opencode: base URL
 * @property {string} [token]         a2a: bearer token
 * @property {string} [tenant]        a2a: routing key echoed from the Agent Card
 * @property {string} [username]      opencode: basic-auth user (default 'opencode')
 * @property {string} [password]      opencode: OPENCODE_SERVER_PASSWORD
 * @property {'deny'|'allow-once'|'allow-always'|'ask'} [approvalPolicy]
 * @property {boolean} [clientFs]     ACP: advertise fs/* to the agent (default false)
 * @property {boolean} [clientTerminal] ACP: advertise terminal/* (default false)
 * @property {string} [clientRoot]    ACP: sandbox root for clientFs
 * @property {string[]} [tags]
 * @property {string[]} [capabilities] free-form labels used by `mesh broadcast --capability`
 * @property {boolean} [enabled]
 * @property {string} [createdAt]
 * @property {string} [updatedAt]
 */

/** Known agent presets — keeps `mesh node add` short and correct. */
export const PRESETS = /** @type {Record<string, Partial<NodeConfig> & {hint:string}>} */ ({
  hermes: {
    hint: 'Nous Research Hermes Agent (has both ACP and native A2A)',
    kind: 'hermes',
    transport: 'acp',
    command: 'hermes-acp',
    approvalPolicy: 'deny',
  },
  opencode: {
    hint: 'opencode (headless HTTP server + ACP facade)',
    kind: 'opencode',
    transport: 'opencode',
    url: 'http://127.0.0.1:4096',
    approvalPolicy: 'deny',
  },
  gemini: {
    hint: 'Google Gemini CLI (ACP mode)',
    kind: 'gemini',
    transport: 'acp',
    command: 'gemini',
    args: ['--experimental-acp'],
    approvalPolicy: 'deny',
  },
  claude: {
    hint: 'Claude Code via the official ACP adapter',
    kind: 'claude',
    transport: 'acp',
    command: 'claude-agent-acp',
    approvalPolicy: 'deny',
  },
  codex: {
    hint: 'OpenAI Codex via the ACP adapter',
    kind: 'codex',
    transport: 'acp',
    command: 'codex-acp',
    approvalPolicy: 'deny',
  },
  'generic-acp': {
    hint: 'Any ACP-speaking agent over stdio',
    kind: 'generic-acp',
    transport: 'acp',
    command: '',
    approvalPolicy: 'deny',
  },
});

export class Registry {
  /** @type {string} */
  #file;
  /** @type {Map<string, NodeConfig>} */
  #nodes = new Map();
  /**
   * Secrets held for this process only, keyed by node id. Never part of a node object,
   * so `save()` cannot serialise one.
   * @type {Map<string, {sshPassword?:string}>}
   */
  #secrets = new Map();

  /** @param {string} [file] */
  constructor(file) {
    this.#file = file || join(meshHome(), 'nodes.json');
    this.reload();
  }

  get file() {
    return this.#file;
  }

  reload() {
    this.#nodes.clear();
    if (!existsSync(this.#file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.#file, 'utf8'));
      const list = Array.isArray(parsed?.nodes) ? parsed.nodes : [];
      /** @type {string[]} */
      const scrubbed = [];
      for (const n of list) {
        if (!n || !n.id) continue;
        // A registry written by an older build (or hand-edited) can carry a plaintext SSH
        // password. Loading it as-is would let the next `save()` write the credential
        // straight back out, so it is moved to memory here — the node keeps working and
        // the file stops holding the secret. The file itself is rewritten immediately,
        // because "we noticed and did nothing until the next edit" is not a fix.
        const { found, clean } = quarantineSecrets(n);
        if (found.sshPassword) {
          this.#secrets.set(n.id, { sshPassword: found.sshPassword });
          scrubbed.push(n.name || n.id);
        }
        this.#nodes.set(n.id, clean);
      }
      if (scrubbed.length) {
        try {
          this.save();
        } catch {
          /* a read-only registry is still usable; the secret is at least only in memory */
        }
        process.stderr.write(
          `agentmesh: moved a plaintext SSH password out of ${this.#file} for node(s) ${scrubbed.join(', ')}.\n` +
            '           It is now held in this process only — set ssh.passwordEnv to keep it across restarts.\n',
        );
      }
    } catch (err) {
      throw new Error(`cannot read node registry ${this.#file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** @returns {NodeConfig[]} */
  list() {
    return [...this.#nodes.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Look up by id, or by name, or by an unambiguous prefix.
   * @param {string} ref
   * @returns {NodeConfig|undefined}
   */
  get(ref) {
    if (!ref) return undefined;
    if (this.#nodes.has(ref)) return this.#nodes.get(ref);
    const byName = this.list().find((n) => n.name === ref);
    if (byName) return byName;
    const byPrefix = this.list().filter((n) => n.id.startsWith(ref) || n.name.startsWith(ref));
    return byPrefix.length === 1 ? byPrefix[0] : undefined;
  }

  /**
   * @param {string} ref
   * @returns {NodeConfig}
   */
  mustGet(ref) {
    const node = this.get(ref);
    if (!node) throw new Error(`unknown node '${ref}' (try: mesh node list)`);
    return node;
  }

  /**
   * @param {Partial<NodeConfig> & {name:string, kind?:string, transport?:string}} input
   * @returns {NodeConfig}
   */
  add(input) {
    const preset = input.kind && PRESETS[input.kind] ? PRESETS[input.kind] : {};
    const { hint, ...presetFields } = preset;
    const now = nowIso();
    const name = String(input.name || '').trim();
    if (!name) throw new Error('node name is required');
    if (this.list().some((n) => n.name === name)) throw new Error(`a node named '${name}' already exists`);
    const transport = input.transport || presetFields.transport || 'acp';
    // Anything secret is diverted to memory before the node object is built, so a
    // caller that passes `ssh.password` cannot get it written to disk. This is the
    // belt-and-braces half of the fix for the console putting a server password into
    // `token`, where it was both useless and persisted in cleartext.
    const { found, clean } = quarantineSecrets(input);
  delete clean.unset;
    /** @type {NodeConfig} */
    const node = {
      ...presetFields,
      ...stripUndefined(clean),
      id: input.id || newId('node'),
      name,
      // Default the label from the transport. Hardcoding 'generic-acp' meant an A2A
      // node showed up as `generic-acp/a2a` in `mesh node list` and the console — a
      // label that described neither the preset nor the transport. (Nothing reads
      // `kind` functionally; it is a display/label field plus a preset lookup key.)
      kind: input.kind || presetFields.kind || `generic-${transport}`,
      transport,
      enabled: input.enabled !== false,
      tags: input.tags || [],
      capabilities: input.capabilities || [],
      createdAt: now,
      updatedAt: now,
    };
    // A preset's `ssh` (there is none today, but this keeps the merge honest) must not
    // be dropped when the caller also supplies one.
    if (presetFields.ssh && clean.ssh) node.ssh = { ...presetFields.ssh, ...stripUndefined(clean.ssh) };
    this.#nodes.set(node.id, node);
    if (found.sshPassword) this.setSecret(node.id, { sshPassword: found.sshPassword });
    this.save();
    return node;
  }

  /**
   * @param {string} ref
   * @param {Partial<NodeConfig>} patch
   * @returns {NodeConfig}
   */
  update(ref, patch) {
    const node = this.mustGet(ref);
    const { found, clean } = quarantineSecrets(patch);
    const next = { ...node, ...stripUndefined(clean), id: node.id, name: patch.name || node.name, updatedAt: nowIso() };
    // `ssh` is merged rather than replaced: editing just the port must not silently drop
    // the user, the askpass wrapper, or the known_hosts options.
    if (clean.ssh) next.ssh = { ...(node.ssh || {}), ...stripUndefined(clean.ssh) };
    // Explicit removal. Merging can only ever add or overwrite, so without this there is
    // no way to take a field back off a node — which is how a leaked password would have
    // been stuck in the registry forever, and why `--token ""` was attempted in the first
    // place (a shell that drops empty arguments turned it into `token: true`).
    if (Array.isArray(patch.unset)) {
      for (const key of patch.unset) removePath(next, String(key));
    }
    delete next.unset;
    this.#nodes.set(node.id, next);
    if (found.sshPassword) this.setSecret(node.id, { sshPassword: found.sshPassword });
    this.save();
    return next;
  }

  /**
   * Hold a secret for this process only.
   *
   * Secrets live in a side table keyed by node id, deliberately NOT on the node object:
   * `save()` serialises the node list wholesale, so a secret that is not part of a node
   * cannot leak to disk even by mistake. Restarting drops it, which is the tradeoff the
   * user chose — the alternative is a plaintext credential in every backup and paste.
   *
   * @param {string} ref
   * @param {{sshPassword?:string}} patch
   */
  setSecret(ref, patch) {
    const node = this.mustGet(ref);
    const current = this.#secrets.get(node.id) || {};
    const next = { ...current };
    for (const [k, v] of Object.entries(patch || {})) {
      if (v === null || v === '') delete next[/** @type {keyof typeof next} */ (k)];
      else next[/** @type {keyof typeof next} */ (k)] = String(v);
    }
    if (Object.keys(next).length === 0) this.#secrets.delete(node.id);
    else this.#secrets.set(node.id, next);
    return { ...next };
  }

  /**
   * The in-memory secret for a node, if any.
   * @param {string} nodeId
   * @returns {{sshPassword?:string}}
   */
  secretFor(nodeId) {
    return { ...(this.#secrets.get(nodeId) || {}) };
  }

  /** Does this node have a usable password, from memory or from a named env var? */
  hasSshPassword(/** @type {NodeConfig} */ node) {
    return Boolean(this.resolveSshPassword(node));
  }

  /**
   * Resolve the SSH password for a node: an explicitly set secret wins, otherwise the
   * environment variable the node names. The env-var route survives a restart without
   * ever putting the secret in a file.
   * @param {NodeConfig} node
   * @returns {string}
   */
  resolveSshPassword(node) {
    const held = this.#secrets.get(node.id)?.sshPassword;
    if (held) return held;
    const name = node.ssh?.passwordEnv;
    if (name && process.env[name]) return process.env[name];
    return '';
  }

  /**
   * A node as the runtime should see it: the persisted config plus any secret that is
   * held in memory. Always a COPY, so handing it to an adapter can neither put the secret
   * back onto the object that `save()` walks nor let an adapter mutate the live registry
   * entry by accident.
   * @param {string} ref
   * @returns {NodeConfig}
   */
  runtimeNode(ref) {
    const node = this.mustGet(ref);
    const shallow = { ...node, ssh: node.ssh ? { ...node.ssh } : node.ssh };
    const password = this.resolveSshPassword(node);
    if (password && shallow.ssh) shallow.ssh.password = password;
    return shallow;
  }

  /**
   * @param {string} ref
   * @returns {boolean}
   */
  remove(ref) {
    const node = this.get(ref);
    if (!node) return false;
    this.#nodes.delete(node.id);
    this.#secrets.delete(node.id);
    this.save();
    return true;
  }

  save() {
    const payload = { version: 1, updatedAt: nowIso(), nodes: this.list() };
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.#file);
  }
}

/**
 * Remove keys whose value is `undefined` so spreads don't clobber presets.
 * @param {Record<string, any>} obj
 * @returns {Record<string, any>}
 */
function stripUndefined(obj) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * Delete a (possibly nested, dot-separated) key, tidying up an `ssh` object that becomes
 * empty so the registry does not accumulate `"ssh": {}` husks.
 * @param {Record<string, any>} obj
 * @param {string} path
 */
function removePath(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    cur = cur?.[parts[i]];
    if (!cur || typeof cur !== 'object') return;
  }
  delete cur[parts[parts.length - 1]];
  if (parts[0] === 'ssh' && obj.ssh && Object.keys(obj.ssh).length === 0) delete obj.ssh;
}

/**
 * Split a node payload into the part that may be persisted and the part that must not.
 *
 * Recognises every spelling a caller might use for an SSH password (`sshPassword`,
 * `ssh.password`, `password` on an ssh node) and removes it from the persisted shape.
 * Accepting the aliases is the point: the console used to send the password as `token`,
 * which was persisted AND ignored by the ssh path, so the user got a plaintext server
 * password sitting in `nodes.json` that did not even make the node work.
 *
 * @param {Record<string, any>} input
 * @returns {{found:{sshPassword?:string}, clean:Record<string, any>}}
 */
function quarantineSecrets(input) {
  const clean = { ...(input || {}) };
  /** @type {{sshPassword?:string}} */
  const found = {};

  if (typeof clean.sshPassword === 'string' && clean.sshPassword) found.sshPassword = clean.sshPassword;
  delete clean.sshPassword;
  // An instruction list, not node configuration.
  delete clean.unset;

  if (clean.ssh && typeof clean.ssh === 'object') {
    const ssh = { ...clean.ssh };
    // `ssh.password` is not a supported persisted field. If someone sends it anyway we
    // take the value to memory and drop it, rather than writing a credential to disk.
    if (typeof ssh.password === 'string' && ssh.password) found.sshPassword = ssh.password;
    delete ssh.password;
    // A command-level instruction, not node configuration.
    delete ssh.clearSecret;
    clean.ssh = ssh;
  }

  // A bare `password` only means "SSH password" when the node really goes over ssh;
  // for opencode it is the documented OPENCODE_SERVER_PASSWORD and stays persisted.
  if (clean.ssh && typeof clean.password === 'string' && clean.password) {
    found.sshPassword = clean.password;
    delete clean.password;
  }

  return { found, clean };
}
