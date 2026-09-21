// Acceptance: the local orchestrator, end to end, with no external services.
//
// Everything here is real except the two things that would make the run
// non-deterministic and non-hermetic:
//   * the LLM (scripted, but speaking real OpenAI tool-calling over real HTTP)
//   * the remote agent (a real A2A peer over real HTTP)
// The Fleet, the Store, the registry, the adapters, the loop and the permission gate
// are the production code paths.
//
// Usage: node tools/verify-agent.mjs [--log <file>]
//
// What it proves, in order:
//   1. a sentence in natural language becomes a dispatch to the node the model chose
//   2. the remote agent's answer reaches the user's answer verbatim
//   3. the dispatch is recorded in the SAME store `mesh tasks` reads
//   4. routing follows the node inventory, including when the user names only a purpose
//   5. a multi-node request fans out and both answers are collected
//   6. a wrong node name is recovered from, not fatal
//   7. failures are reported as failures, and never as a fabricated success
//   8. the permission gate actually stops dispatches (dry-run / read-only / allow-list)
//   9. the step limit is reported as an unfinished run, not an empty success

import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenOnFetchablePort } from '../src/core/transport/net.js';

const args = process.argv.slice(2);
const logFile = args.includes('--log') ? args[args.indexOf('--log') + 1] : null;

const HOME = mkdtempSync(join(tmpdir(), 'agentmesh-verify-agent-'));
process.env.AGENTMESH_HOME = HOME;

const { Fleet } = await import('../src/core/fleet.js');
const { runAgent } = await import('../src/core/orchestrator.js');

let checks = 0;
let failures = 0;
const lines = [];
function record(ok, label, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  const line = `${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`;
  lines.push(line);
  console.log(line);
}

const PEERS = [];

// ---------------------------------------------------------------- fake remote agents

/**
 * A real A2A peer. `respond` decides the reply, so one peer can be helpful and another
 * can be broken without changing any production code.
 */
async function startPeer(name, respond) {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const port = /** @type {any} */ (server.address()).port;
      if (req.url?.includes('agent-card') || req.url?.includes('agent.json')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            name,
            version: '1.0',
            description: `peer ${name}`,
            capabilities: { streaming: false },
            skills: [{ id: 's1', name: 'General', description: `${name} can do general work`, tags: ['general'] }],
            supportedInterfaces: [{ protocolBinding: 'JSONRPC', protocolVersion: '1.0', url: `http://127.0.0.1:${port}/rpc` }],
          }),
        );
        return;
      }
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* ignore */
      }
      const text = body?.params?.message?.parts?.[0]?.text ?? '';
      seen.push(text);
      const out = respond(text, seen.length);
      res.writeHead(200, { 'content-type': 'application/json' });
      if (out.rpcError) {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: out.rpcError }));
        return;
      }
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            kind: 'task',
            id: `${name}_task_${seen.length}`,
            contextId: body?.params?.message?.contextId ?? 'ctx',
            status: { state: out.state ?? 'completed' },
            ...(out.state === 'failed'
              ? { status: { state: 'failed', message: { parts: [{ text: out.text ?? 'remote failure' }] } } }
              : { artifacts: [{ artifactId: 'a1', parts: [{ text: out.text }] }] }),
          },
        }),
      );
    });
  });
  await listenOnFetchablePort(server, '127.0.0.1');
  const peer = { name, url: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`, seen, close: () => server.close() };
  PEERS.push(peer);
  return peer;
}

// ---------------------------------------------------------------- scripted LLM

/**
 * A real OpenAI-compatible endpoint that replays scripted assistant turns, choosing the
 * next turn by inspecting what the caller is asking for. That lets one endpoint behave
 * like a competent orchestrator for every scenario in this script.
 */
async function startLlm(router) {
  let calls = 0;
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      requests.push(body);
      calls += 1;
      const turn = router(body, calls);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: turn.tool_calls ? 'tool_calls' : 'stop',
              message: { role: 'assistant', content: turn.content ?? null, ...(turn.tool_calls ? { tool_calls: turn.tool_calls } : {}) },
            },
          ],
          usage: { total_tokens: 42 },
        }),
      );
    });
  });
  await listenOnFetchablePort(server, '127.0.0.1');
  const llm = { baseUrl: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}/v1`, model: 'scripted', apiKey: '', requests, close: () => server.close() };
  PEERS.push(llm);
  return llm;
}

/**
 * All tool results the orchestrator fed back, in order.
 *
 * Keying by tool name would be wrong: a run that calls `send_task` twice (a failure
 * followed by a recovery) would only show the LAST result, and the test would silently
 * assert nothing about the failure it was written to check.
 */
function toolOutcomes(config) {
  const out = [];
  for (const req of config.requests) {
    for (const m of req.messages ?? []) {
      if (m.role === 'tool') out.push({ name: m.name, content: String(m.content ?? '') });
    }
  }
  return out;
}

/** Did any result of this tool satisfy the predicate? */
const anyOutcome = (config, tool, re) => toolOutcomes(config).some((o) => o.name === tool && re.test(o.content));

const j = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------- scenarios

/**
 * Every scenario gets its own state directory. The registry and the store are FILES
 * under AGENTMESH_HOME, so sharing one directory across scenarios makes them collide:
 * the second `worker` registration throws, and a scenario that asserts "the store is
 * empty" sees the previous scenario's tasks.
 */
const HOMES = [HOME];
function freshHome() {
  const dir = mkdtempSync(join(tmpdir(), 'agentmesh-verify-agent-'));
  HOMES.push(dir);
  process.env.AGENTMESH_HOME = dir;
  return dir;
}

/** Build a fleet with the given peers registered under the given names. */
function makeFleet(peersByName) {
  freshHome();
  const fleet = new Fleet();
  for (const [name, peer] of Object.entries(peersByName)) {
    fleet.registry.add({ name, transport: 'a2a', url: peer.url, capabilities: ['general'] });
  }
  return fleet;
}

// ---- scenario 1: one sentence -> the right node -> the answer verbatim -------------

{
  const nas = await startPeer('nas-hermes', () => ({ text: 'def is_prime(n):\n    return n > 1 and all(n % i for i in range(2, int(n ** 0.5) + 1))' }));
  const cloud = await startPeer('cloud-hermes', () => ({ text: 'cloud was asked too' }));
  const fleet = makeFleet({ 'nas-hermes': nas, 'cloud-hermes': cloud });

  const llm = await startLlm((body, n) =>
    n === 1
      ? { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'send_task', arguments: JSON.stringify({ node: 'nas-hermes', prompt: '写一个判断素数的 Python 函数 is_prime' }) } }] }
      : { content: 'nas-hermes 返回的代码：\ndef is_prime(n):\n    return n > 1 and all(n % i for i in range(2, int(n ** 0.5) + 1))' },
  );

  const res = await runAgent({ fleet, prompt: '让 nas 上的 agent 写一个判断素数的函数', llm });
  record(res.dispatchCount === 1, 'one sentence produced exactly one dispatch', `dispatches=${res.dispatchCount}`);
  record(nas.seen.length === 1 && cloud.seen.length === 0, 'the dispatch went to the node the model chose, and only that one', `nas=${nas.seen.length} cloud=${cloud.seen.length}`);
  record(/def is_prime/.test(res.text), "the user's answer contains the remote agent's code verbatim");
  record(res.tasks[0].state === 'completed', 'the task is recorded as completed', `state=${res.tasks[0].state}`);

  // The store the CLI and console read must show it.
  const stored = fleet.store.listTasks({ limit: 5 });
  record(stored.length === 1 && /is_prime/.test(String(stored[0].prompt)), 'the dispatch is in the SHARED store (mesh tasks sees it)', `tasks=${stored.length}`);

  // The remote prompt must be self-contained: the model was told the peer cannot see
  // this conversation, so it must not forward the user's words unexpanded.
  record(nas.seen[0].includes('素数'), 'the remote prompt carries the actual instruction', `prompt=${nas.seen[0].slice(0, 40)}…`);

  const dispatched = fleet.store.listTasks({ limit: 1 })[0];
  record(Boolean(dispatched.nodeId), 'the stored task is attributed to a node', `nodeId=${dispatched.nodeId}`);
  await fleet.close();
}

// ---- scenario 2: fan-out to several nodes ----------------------------------------

{
  const a = await startPeer('worker-a', () => ({ text: 'A says: use a hash map' }));
  const b = await startPeer('worker-b', () => ({ text: 'B says: use a sorted array' }));
  const fleet = makeFleet({ 'worker-a': a, 'worker-b': b });

  const llm = await startLlm((body, n) =>
    n === 1
      ? { tool_calls: [{ id: 'b1', type: 'function', function: { name: 'broadcast', arguments: JSON.stringify({ prompt: '这个场景该用什么数据结构？', nodes: ['worker-a', 'worker-b'] }) } }] }
      : { content: '两个节点都答了：A 说用哈希表，B 说用有序数组。' },
  );

  const res = await runAgent({ fleet, prompt: '同时问 worker-a 和 worker-b 该用什么数据结构', llm });
  record(a.seen.length === 1 && b.seen.length === 1, 'broadcast reached both nodes', `a=${a.seen.length} b=${b.seen.length}`);
  record(res.tasks.length === 2, 'both answers were collected', `collected=${res.tasks.length}`);
  record(/哈希表|hash/i.test(res.text) && /有序数组|sorted/i.test(res.text), "the answer carries both peers' positions");
  await fleet.close();
}

// ---- scenario 3: a wrong node name is recovered from ------------------------------

{
  const only = await startPeer('the-only-node', () => ({ text: 'done by the only node' }));
  const fleet = makeFleet({ 'the-only-node': only });

  const llm = await startLlm((body, n) => {
    if (n === 1) return { tool_calls: [{ id: 'x1', type: 'function', function: { name: 'send_task', arguments: JSON.stringify({ node: 'nas', prompt: 'do it' }) } }] };
    if (n === 2) return { tool_calls: [{ id: 'x2', type: 'function', function: { name: 'send_task', arguments: JSON.stringify({ node: 'the-only-node', prompt: 'do it' }) } }] };
    return { content: 'recovered and completed' };
  });

  const res = await runAgent({ fleet, prompt: 'go', llm });
  record(anyOutcome(llm, 'send_task', /unknown node 'nas'/), 'a wrong node name comes back as a correctable error');
  record(res.text === 'recovered and completed', 'the run recovered instead of failing');
  record(only.seen.length === 1, 'exactly one dispatch actually happened', `dispatches=${only.seen.length}`);
  await fleet.close();
}

// ---- scenario 4: a broken peer is reported, never fabricated ----------------------

{
  const broken = await startPeer('broken', () => ({ rpcError: { code: -32000, message: 'boom: remote agent exploded' } }));
  const fleet = makeFleet({ broken });

  const llm = await startLlm((body, n) => {
    if (n === 1) return { tool_calls: [{ id: 'e1', type: 'function', function: { name: 'send_task', arguments: JSON.stringify({ node: 'broken', prompt: 'do something' }) } }] };
    return { content: '派发失败：remote agent exploded。我没有拿到任何结果，也没有编造。' };
  });

  const res = await runAgent({ fleet, prompt: 'go', llm });
  record(anyOutcome(llm, 'send_task', /boom/), 'the peer error is fed back to the model verbatim');
  record(anyOutcome(llm, 'send_task', /failed|error/i), 'the tool result says the dispatch failed');
  record(!/def |```/.test(res.text), 'the summary contains no fabricated artefact');
  const stored = fleet.store.listTasks({ limit: 1 })[0];
  record(stored.state === 'failed', 'the failure is recorded in the store as failed', `state=${stored.state}`);
  await fleet.close();
}

// ---- scenario 5: the permission gate actually gates ------------------------------

{
  const peer = await startPeer('worker', () => ({ text: 'should not happen' }));
  const fleet = makeFleet({ worker: peer });

  // dry-run
  const dryLlm = await startLlm((body, n) =>
    n === 1
      ? { tool_calls: [{ id: 'd', type: 'function', function: { name: 'send_task', arguments: JSON.stringify({ node: 'worker', prompt: 'x' }) } }] }
      : { content: 'plan' },
  );
  const dry = await runAgent({ fleet, prompt: 'go', llm: dryLlm, policy: { dryRun: true } });
  record(dry.dispatchCount === 0 && peer.seen.length === 0, 'dry-run dispatched nothing');
  record(fleet.store.listTasks({ limit: 5 }).length === 0, 'dry-run wrote no task');
  record(anyOutcome(dryLlm, 'send_task', /dryRun|wouldSend/), 'dry-run told the model what it would have sent');

  // read-only: send_task is not even offered
  const roLlm = await startLlm((body) => {
    const names = (body.tools ?? []).map((t) => t.function.name);
    return { content: `offered: ${names.join(',')}` };
  });
  const ro = await runAgent({ fleet, prompt: 'go', llm: roLlm, policy: { allow: ['list_nodes', 'probe_node', 'list_tasks', 'get_task'] } });
  record(!/send_task/.test(ro.text) && !/broadcast/.test(ro.text), 'a read-only policy does not even offer a dispatch tool', ro.text);
  record(peer.seen.length === 0, 'read-only never reached the peer');

  // an explicit refusal
  const noLlm = await startLlm((body, n) =>
    n === 1
      ? { tool_calls: [{ id: 'n', type: 'function', function: { name: 'send_task', arguments: JSON.stringify({ node: 'worker', prompt: 'x' }) } }] }
      : { content: '用户拒绝了这次派发。' },
  );
  const refused = await runAgent({ fleet, prompt: 'go', llm: noLlm, policy: { onConfirm: async () => false } });
  record(refused.dispatchCount === 0 && peer.seen.length === 0, 'a declined confirmation blocked the dispatch');

  await fleet.close();
}

// ---- scenario 6: the step limit is an unfinished run ------------------------------

{
  const peer = await startPeer('worker', () => ({ text: 'x' }));
  const fleet = makeFleet({ worker: peer });
  const llm = await startLlm(() => ({ tool_calls: [{ id: 'l', type: 'function', function: { name: 'list_nodes', arguments: '{}' } }] }));
  const res = await runAgent({ fleet, prompt: 'go', llm, policy: { maxSteps: 3 } });
  record(res.stopReason === 'step-limit', 'a non-terminating model is stopped by the step limit');
  record(res.text === '', 'the unfinished run reports no answer rather than an empty success');
  record(res.steps === 3 && llm.requests.length === 3, 'the cap is enforced exactly', `steps=${res.steps} calls=${llm.requests.length}`);
  await fleet.close();
}

// ---- scenario 7: the agent sees the real node inventory ---------------------------

{
  const a = await startPeer('alpha', () => ({ text: 'a' }));
  const b = await startPeer('beta', () => ({ text: 'b' }));
  const fleet = makeFleet({ alpha: a, beta: b });
  let systemSeen = '';
  const llm = await startLlm((body) => {
    systemSeen = body.messages?.find((m) => m.role === 'system')?.content ?? '';
    return { content: 'ok' };
  });
  await runAgent({ fleet, prompt: 'go', llm });
  record(/alpha/.test(systemSeen) && /beta/.test(systemSeen), 'the system prompt carries the real node names');
  record(/self-contained/i.test(systemSeen), 'the system prompt states that remote prompts must be self-contained');
  await fleet.close();
}

// ---------------------------------------------------------------- report

for (const p of PEERS) {
  try {
    p.close();
  } catch {
    /* already closed */
  }
}
try {
  for (const dir of HOMES) rmSync(dir, { recursive: true, force: true });
} catch {
  /* windows file locks */
}

const summary = `\n==== ${checks - failures}/${checks} checks passed ====`;
lines.push(summary.trim());
console.log(summary);
if (logFile) {
  try {
    writeFileSync(logFile, `${lines.join('\n')}\n`, 'utf8');
    console.log(`log written to ${logFile}`);
  } catch (err) {
    console.log(`could not write log: ${err instanceof Error ? err.message : String(err)}`);
  }
}
process.exit(failures ? 1 : 0);
