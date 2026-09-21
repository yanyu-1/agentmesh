/**
 * AgentMesh Web console + local API.
 *
 * This is the long-lived process that owns live adapter connections, which is why
 * it is also the thing that can answer parked approvals addressed by
 * `mesh approve` from another terminal.
 *
 * Routes
 *   GET  /                        single-page console
 *   GET  /api/status              fleet + store counters
 *   GET  /api/nodes               registered nodes
 *   POST /api/nodes               add a node (same fields as `mesh node add`)
 *   POST /api/nodes/:ref/update   change fields on an existing node (the same flags as
 *                                 `mesh node edit`; `sshPassword` goes to memory only)
 *   POST /api/nodes/:ref/secret   {sshPassword} set/clear an SSH password HELD IN THIS
 *                                 PROCESS (empty string clears; never written to disk)
 *   POST /api/nodes/:ref/delete   remove a node
 *   POST /api/nodes/:ref/probe    capability probe
 *   GET  /api/tasks[?node=&limit=]
 *   GET  /api/tasks/:id[?events=1]
 *   GET  /api/events?after=<seq>  event log (JSON)
 *   GET  /api/stream?after=<seq>  live event stream (SSE)
 *   POST /api/send                {node, prompt, continue?, shareContext?} -> {taskId}
 *   POST /api/agent               {prompt, dryRun?, tools?, maxSteps?, shareContext?} -> {runId}
 *   GET  /api/agent/config        resolved orchestrator provider settings (never the key)
 *   POST /api/agent/config        {baseUrl?, model?, apiKeyEnv?, apiKey?, persist?}
 *                                 baseUrl/model/apiKeyEnv persist when persist=true;
 *                                 apiKey is held in this process only, never written
 *   GET  /api/agent/models        models the configured gateway serves
 *   POST /api/agent/models        {baseUrl?, model?, apiKey?, apiKeyEnv?} — probe with the
 *                                 values currently in the form, without persisting or
 *                                 changing anything (this is how the console's "拉取模型列表"
 *                                 works before the settings have been saved)
 *   POST /api/cancel              {taskId}
 *   GET  /api/approvals[?status=]
 *   POST /api/approvals/:id       {optionId|null}
 *   GET  /healthz
 *
 * @module web/server
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Fleet } from '../core/fleet.js';
import { PRESETS } from '../core/registry.js';
import { EventType } from '../protocol/events.js';
import { newId } from '../protocol/util.js';
import { color } from '../cli/render.js';
import { runAgent, AGENT_TOOLS } from '../core/orchestrator.js';
import { llmConfig, llmReady, listModels, applyLlmRuntime } from '../core/llm.js';
import { listenOnFetchablePort } from '../core/transport/net.js';

const UI_PATH = fileURLToPath(new URL('./ui.html', import.meta.url));

/**
 * @param {{port?:number, host?:string, open?:boolean}} opts
 * @returns {Promise<number>} exit code (never resolves under normal operation)
 */
export async function createConsole({ port = 7331, host = '127.0.0.1' } = {}) {
  const fleet = new Fleet();
  // Tasks whose owning process died while an agent was blocked on an approval would
  // otherwise sit in `working` forever and the console would keep claiming they run.
  try {
    const fixed = fleet.store.reconcileOrphans();
    if (fixed) console.error(color.dim(`reconciled ${fixed} task(s) abandoned by a dead process`));
  } catch {
    /* best-effort */
  }
  const ui = readFileSync(UI_PATH, 'utf8');

  /** @type {Set<import('node:http').ServerResponse>} */
  const sseClients = new Set();

  // A fresh identity per boot. Without it, a stale daemon still holding the port
  // from an earlier run silently answers as if it were the one you just started
  // (which is exactly how a fixed build can appear to still be broken).
  const bootId = newId('boot');
  const startedAt = new Date().toISOString();

  // Broadcast every fleet event to connected consoles.
  /** @param {any} ev */
  const broadcast = (ev) => {
    const payload = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(payload);
      } catch {
        sseClients.delete(res);
      }
    }
  };
  fleet.subscribe(broadcast);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;
    try {
      if (path === '/' || path === '/index.html') return send(res, 200, ui, 'text/html; charset=utf-8');
      if (path === '/healthz') return sendJson(res, 200, { ok: true, nodes: fleet.registry.list().length, bootId, startedAt, pid: process.pid });

      if (path === '/api/status') {
        return sendJson(res, 200, {
          registry: fleet.registry.file,
          store: fleet.store.file,
          ...fleet.store.stats(),
        });
      }

      if (path === '/api/presets') return sendJson(res, 200, PRESETS);

      if (path === '/api/nodes' && req.method === 'GET') {
        return sendJson(res, 200, fleet.registry.list().map((n) => publicNode(n, fleet.registry)));
      }
      if (path === '/api/nodes' && req.method === 'POST') {
        const body = await readJson(req);
        // `sshPassword` (if present) is diverted to this process's memory by the
        // registry, so it is never persisted; `add` returns the stored node either way.
        const node = fleet.registry.add(body);
        return sendJson(res, 201, publicNode(node, fleet.registry));
      }

      const nodeAction = path.match(/^\/api\/nodes\/([^/]+)\/(probe|delete|update|secret)$/);
      if (nodeAction) {
        const ref = decodeURIComponent(nodeAction[1]);
        if (nodeAction[2] === 'delete') {
          const node = fleet.registry.mustGet(ref);
          await fleet.adapters.get(node.id)?.disconnect?.('node removed');
          fleet.adapters.delete(node.id);
          fleet.registry.remove(node.id);
          return sendJson(res, 200, { removed: node.name });
        }

        if (nodeAction[2] === 'update') {
          const body = await readJson(req);
          if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'a JSON object of fields to change is required' });
          const patch = { ...body };
          // A password is never part of the persisted patch.
          const sshPassword = patch.sshPassword ?? patch.ssh?.password ?? null;
          delete patch.sshPassword;
          if (patch.ssh) delete patch.ssh.password;
          const node = fleet.registry.update(ref, patch);
          if (sshPassword !== null) fleet.registry.setSecret(node.id, { sshPassword: String(sshPassword) });
          // Cached adapters captured their config (and their route to the password) at
          // construction, so an edit that does not drop them appears to save and then
          // keeps using the old settings.
          fleet.invalidate(node.id);
          return sendJson(res, 200, publicNode(node, fleet.registry));
        }

        if (nodeAction[2] === 'secret') {
          const body = await readJson(req);
          if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'a JSON object is required' });
          const node = fleet.registry.mustGet(ref);
          // Empty string clears it. This is process memory only — the response says so,
          // because a UI that silently forgets the password on restart is a support call.
          fleet.registry.setSecret(node.id, { sshPassword: body.sshPassword ?? '' });
          fleet.invalidate(node.id);
          return sendJson(res, 200, { ...publicNode(node, fleet.registry), restartsRequired: true });
        }

        const node = fleet.registry.mustGet(ref);
        const result = await fleet.probe(node.name);
        return sendJson(res, 200, result);
      }

      if (path === '/api/tasks') {
        return sendJson(res, 200, fleet.store.listTasks({ nodeId: url.searchParams.get('node') || undefined, limit: Number(url.searchParams.get('limit') || 50) }));
      }

      const taskMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
      if (taskMatch) {
        const id = decodeURIComponent(taskMatch[1]);
        const task = fleet.store.findTask(id) || fleet.store.findTask(`task_${id}`);
        if (!task) return sendJson(res, 404, { error: 'unknown task' });
        const events = url.searchParams.get('events') ? fleet.store.eventsForTask(task.id) : undefined;
        return sendJson(res, 200, { ...task, events });
      }

      if (path === '/api/events') {
        const after = Number(url.searchParams.get('after') || 0);
        return sendJson(res, 200, { lastSeq: fleet.store.lastSeq(), events: fleet.store.eventsSince({ after, limit: 1000 }) });
      }

      if (path === '/api/stream') {
        const after = Number(url.searchParams.get('after') || 0);
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.write(`retry: 3000\n\n`);
        for (const ev of fleet.store.eventsSince({ after, limit: 500 })) {
          res.write(`data: ${JSON.stringify({ ...ev, replay: true })}\n\n`);
        }
        sseClients.add(res);
        const keepAlive = setInterval(() => {
          try {
            res.write(': ping\n\n');
          } catch {
            clearInterval(keepAlive);
          }
        }, 15_000);
        req.on('close', () => {
          clearInterval(keepAlive);
          sseClients.delete(res);
        });
        return undefined;
      }

      if (path === '/api/send' && req.method === 'POST') {
        const body = await readJson(req);
        if (!body?.node || !body?.prompt) return sendJson(res, 400, { error: 'node and prompt are required' });
        const node = fleet.registry.mustGet(String(body.node));
        // Fire and forget: progress arrives on /api/stream.
        const promise = fleet
          .send({
            nodeRef: node.name,
            prompt: String(body.prompt),
            continueSession: Boolean(body.continue),
            // Off unless the operator ticks it: by default a node hears nothing about another
            // node, which is what keeps two agents from bleeding into each other's work.
            shareContext: Boolean(body.shareContext),
            shareLimit: Number.isFinite(Number(body.shareLimit)) ? Number(body.shareLimit) : undefined,
            cwd: body.cwd ? String(body.cwd) : undefined,
            permissionPolicy: body.approval,
          })
          .catch(() => null);
        const task = fleet.store.listTasks({ nodeId: node.id, limit: 1 })[0];
        void promise;
        return sendJson(res, 202, { taskId: task?.id ?? null, node: node.name });
      }

      if (path === '/api/agent/config' && req.method === 'POST') {
        const body = await readJson(req);
        if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'a JSON object is required' });
        const wantsPersist = Boolean(body.persist);
        const patch = {};
        // An empty field means "leave it alone", not "clear it" — the rule the key field has
        // always had, and which baseUrl/model did not. The asymmetry was a real trap: the
        // console sends every field on every save, so filling in the address and the key while
        // leaving the model box untouched blanked the model in the live process and left
        // `ready:false, missing:["model"]` — an unusable agent, from a save where that box
        // looked like it had not been touched. Clearing is still expressible for the one field
        // that has a button for it (`apiKey: ''`, below).
        if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) patch.baseUrl = body.baseUrl.trim();
        if (typeof body.model === 'string' && body.model.trim()) patch.model = body.model.trim();
        if (typeof body.apiKeyEnv === 'string' && body.apiKeyEnv.trim()) patch.apiKeyEnv = body.apiKeyEnv.trim();
        try {
          // Base URL / model / the NAME of a key variable are safe to persist. Writing them
          // means the console does not have to be reconfigured after a restart.
          if (Object.keys(patch).length && wantsPersist) {
            const { saveLlmConfig, readLlmConfigFile } = await import('../core/llm.js');
            const existing = readLlmConfigFile();
            saveLlmConfig({
              baseUrl: patch.baseUrl ?? existing.baseUrl,
              model: patch.model ?? existing.model,
              apiKeyEnv: patch.apiKeyEnv ?? existing.apiKeyEnv,
            });
          }
        } catch (err) {
          return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        // Apply to the live process FIRST (so the fields below report the new state), then
        // handle the key — which lives in this process only. There is deliberately no code
        // path that writes the key itself to a file.
        /** @type {Record<string, any>} */
        const runtime = {};
        if (patch.baseUrl !== undefined) runtime.baseUrl = patch.baseUrl;
        if (patch.model !== undefined) runtime.model = patch.model;
        if (patch.apiKeyEnv !== undefined) runtime.apiKey = process.env[patch.apiKeyEnv] ?? '';
        let keyNote = null;
        if (typeof body.apiKey === 'string') {
          if (body.apiKey === '') {
            runtime.apiKey = '';
            keyNote = 'cleared';
          } else {
            runtime.apiKey = body.apiKey;
            keyNote = `held in this process only (${body.apiKey.length} chars)`;
          }
        }
        // `applyLlmRuntime` layers onto the resolved config, so submitting only a key does
        // not blank the endpoint. See the note on that function.
        if (Object.keys(runtime).length) applyLlmRuntime(runtime);
        const cfg = { ...llmConfig() };
        const ready = llmReady(cfg);
        return sendJson(res, 200, {
          baseUrl: cfg.baseUrl,
          model: cfg.model,
          apiKey: cfg.apiKey ? `set:${cfg.apiKey.length}` : null,
          ready: ready.ok,
          missing: ready.missing,
          persisted: wantsPersist && Object.keys(patch).length > 0,
          keyNote,
        });
      }

      if (path === '/api/agent/config') {
        const cfg = { ...llmConfig() };
        const ready = llmReady(cfg);
        // Same rule as the CLI: presence and length, never the value.
        return sendJson(res, 200, {
          baseUrl: cfg.baseUrl,
          model: cfg.model,
          apiKey: cfg.apiKey ? `set:${cfg.apiKey.length}` : null,
          ready: ready.ok,
          missing: ready.missing,
          tools: AGENT_TOOLS,
        });
      }

      // Asking for the model list is the step you take *because* you do not know the model
      // name yet, so it happens before anything has been saved — and the GET form below can
      // only see what is already configured. A console user who typed an address and a key and
      // then pressed "拉取模型列表" got back
      //   `LLM not configured: set AGENTMESH_LLM_BASE_URL or pass --base-url.`
      // an error naming an environment variable they had never touched, which points away from
      // the real fix (press save first). POST takes the values as they currently stand in the
      // form and uses them for this one call: nothing is persisted, `applyLlmRuntime` is not
      // called, so "just show me the list" cannot change any state.
      if (path === '/api/agent/models' && req.method === 'POST') {
        const body = await readJson(req);
        /** @type {Record<string, any>} */
        const overrides = {};
        // Only fields that were actually supplied. Spreading `{apiKey: undefined}` over the
        // resolved config would drop a credential that is already configured.
        if (typeof body?.baseUrl === 'string' && body.baseUrl.trim()) overrides.baseUrl = body.baseUrl.trim();
        if (typeof body?.model === 'string' && body.model.trim()) overrides.model = body.model.trim();
        if (typeof body?.apiKey === 'string' && body.apiKey) overrides.apiKey = body.apiKey;
        if (typeof body?.apiKeyEnv === 'string' && body.apiKeyEnv.trim()) {
          const named = process.env[body.apiKeyEnv.trim()];
          if (named) overrides.apiKey = named;
        }
        try {
          return sendJson(res, 200, { models: await listModels(overrides) });
        } catch (err) {
          return sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
        }
      }

      if (path === '/api/agent/models' && req.method === 'GET') {
        try {
          return sendJson(res, 200, { models: await listModels() });
        } catch (err) {
          return sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
        }
      }

      if (path === '/api/agent' && req.method === 'POST') {
        const body = await readJson(req);
        if (!body?.prompt) return sendJson(res, 400, { error: 'prompt is required' });
        const ready = llmReady();
        if (!ready.ok) {
          return sendJson(res, 400, {
            error: `orchestrator LLM not configured (missing ${ready.missing.join(', ')}). Set AGENTMESH_LLM_BASE_URL / AGENTMESH_LLM_MODEL.`,
          });
        }
        const tools = Array.isArray(body.tools) && body.tools.length ? body.tools.map(String) : null;
        if (tools) {
          const unknown = tools.filter((t) => !AGENT_TOOLS.includes(/** @type {any} */ (t)));
          if (unknown.length) return sendJson(res, 400, { error: `unknown tool(s): ${unknown.join(', ')}` });
        }

        // Fire and forget, exactly like /api/send: the console follows the run on
        // /api/stream. Agent reasoning is broadcast but NOT persisted — the durable
        // record is the dispatched tasks, which land in the store through the normal
        // path. That split is deliberate: thinking is ephemeral, actions are auditable.
        const runPromise = runAgent({
          fleet,
          prompt: String(body.prompt),
          llm: body.model ? { model: String(body.model) } : undefined,
          policy: {
            dryRun: Boolean(body.dryRun),
            shareContext: Boolean(body.shareContext),
            shareLimit: Number.isFinite(Number(body.shareLimit)) ? Number(body.shareLimit) : undefined,
            allow: tools ?? undefined,
            maxSteps: Number.isFinite(Number(body.maxSteps)) ? Number(body.maxSteps) : undefined,
            maxDispatches: Number.isFinite(Number(body.maxDispatches)) ? Number(body.maxDispatches) : undefined,
          },
          onEvent: (ev) => broadcast({ ...ev, scope: 'agent', ts: new Date().toISOString() }),
        }).catch((err) => {
          broadcast({
            scope: 'agent',
            type: 'agent-error',
            ts: new Date().toISOString(),
            text: err instanceof Error ? err.message : String(err),
          });
          return null;
        });
        void runPromise;
        return sendJson(res, 202, { accepted: true, dryRun: Boolean(body.dryRun) });
      }

      if (path === '/api/cancel' && req.method === 'POST') {
        const body = await readJson(req);
        const task = body?.taskId ? fleet.store.findTask(String(body.taskId)) : null;
        if (!task) return sendJson(res, 404, { error: 'unknown task' });
        const adapter = fleet.adapterFor(task.nodeId);
        if (typeof adapter.cancel === 'function') {
          if (task.remoteTaskId) await adapter.cancel(task.remoteTaskId);
          else if (task.sessionId) await adapter.cancel(task.sessionId);
        }
        fleet.store.updateTask(task.id, { state: 'canceled' });
        fleet.emit({ ts: new Date().toISOString(), nodeId: task.nodeId, taskId: task.id, type: EventType.TASK_STATE, text: 'canceled', data: { state: 'canceled' } });
        return sendJson(res, 200, { canceled: task.id });
      }

      if (path === '/api/approvals' && req.method === 'GET') {
        const status = url.searchParams.get('status');
        const live = fleet.pendingApprovals().map((p) => p.id);
        // `null` (not undefined) is what disables the filter: undefined would fall
        // back to listApprovals' own 'pending' default and `?status=all` would lie.
        const rows = fleet.store.listApprovals({ status: status === 'all' ? null : status || 'pending', limit: 200 });
        return sendJson(res, 200, rows.map((a) => ({ ...a, live: live.includes(a.id) })));
      }

      const approvalMatch = path.match(/^\/api\/approvals\/([^/]+)$/);
      if (approvalMatch && req.method === 'POST') {
        const id = decodeURIComponent(approvalMatch[1]);
        const body = await readJson(req);
        const optionId = body?.optionId === undefined ? null : body.optionId;
        const result = fleet.resolveApproval(id, optionId);
        if (!result.ok) {
          return sendJson(res, 409, { error: result.reason || 'no live connection holds this approval' });
        }
        return sendJson(res, 200, { ok: true, optionId });
      }

      return sendJson(res, 404, { error: `no route for ${req.method} ${path}` });
    } catch (err) {
      return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  if (port === 0) {
    // `--port 0` means "any free port". Asking the OS directly can hand back a port the
    // fetch spec forbids, which would produce a console that is genuinely listening and
    // that every `fetch` client refuses to talk to. See core/transport/net.js.
    await listenOnFetchablePort(server, host);
  } else {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve(undefined));
    });
  }

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;

  return {
    server,
    fleet,
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    /** Shut the console down and release the port. */
    async close() {
      for (const res of sseClients) {
        try {
          res.end();
        } catch {
          /* already gone */
        }
      }
      sseClients.clear();
      await fleet.close();
      // `close()` alone waits for open sockets, and an SSE client or a keep-alive
      // connection never ends on its own — the same trap that made the LLM tests exit
      // with a libuv assertion while every test had passed. Destroy them explicitly.
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}

/**
 * Start the console and keep the process alive serving it.
 *
 * Split from `createConsole` so tests can drive the real HTTP surface on an ephemeral
 * port and then close it; a function that never resolves is untestable by construction.
 *
 * @param {{port?:number, host?:string}} [opts]
 * @returns {Promise<never>}
 */
export async function startServer(opts = {}) {
  const { fleet, url, close } = await createConsole(opts);
  process.stdout.write(`${color.green('AgentMesh console')}  ${url}\n`);
  process.stdout.write(`${color.dim(`registry: ${fleet.registry.file}`)}\n`);
  process.stdout.write(`${color.dim(`store:    ${fleet.store.file}`)}\n`);
  process.stdout.write(`${color.dim('Ctrl-C to stop')}\n`);

  const shutdown = async () => {
    process.stdout.write('\nshutting down…\n');
    await close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Never resolve: the caller's process stays alive serving requests.
  return new Promise(() => {});
}

/**
 * Strip secrets before sending a node to the browser.
 * @param {any} node
 */
function publicNode(node, registry) {
  const { token, password, ...rest } = node;
  return {
    ...rest,
    hasToken: Boolean(token),
    hasPassword: Boolean(password),
    // Whether SSH auth can actually work, and where the secret comes from. Reporting the
    // NAME of the env var (never a value) is what lets the console say "restart with
    // $NAS_SSH_PW set" instead of showing a node that looks configured but cannot log in.
    hasSshPassword: registry ? registry.hasSshPassword(node) : undefined,
    sshPasswordSource: registry
      ? registry.secretFor(node.id).sshPassword
        ? 'memory'
        : node.ssh?.passwordEnv
          ? 'env'
          : null
      : undefined,
  };
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {any} body
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} body
 * @param {string} type
 */
function send(res, status, body, type) {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit]
 * @returns {Promise<any>}
 */
async function readJson(req, limit = 1_000_000) {
  let size = 0;
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return null;
  return JSON.parse(text);
}
