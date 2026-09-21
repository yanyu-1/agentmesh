// Orchestrator tests.
//
// The LLM is replaced by a scripted fake: each call returns the next canned assistant
// turn. That makes the loop itself the thing under test — how many turns it takes, what
// it feeds back, when it stops — without depending on any model's mood.
//
// The fleet is real (real Fleet + Store + registry + a real loopback A2A peer), because
// the whole point of the orchestrator is that dispatches go through the ordinary path.
//
// Run: node test/orchestrator.test.js

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenOnFetchablePort } from '../src/core/transport/net.js';

const HOMES = [];
function freshHome() {
  const dir = mkdtempSync(join(tmpdir(), 'agentmesh-orch-'));
  HOMES.push(dir);
  process.env.AGENTMESH_HOME = dir;
  return dir;
}
freshHome();

// Every fake peer and Fleet is tracked here and torn down in `after()`. Doing the
// cleanup per-test instead would leak an HTTP server the moment an assertion fails,
// and a leaked listener keeps the whole test process alive forever.
const PEERS = [];
const FLEETS = [];

/**
 * Close an HTTP server for real.
 *
 * `fetch()` (undici) pools keep-alive sockets, so a bare `server.close()` waits for
 * connections that will never end on their own: the process then hangs, and the old
 * workaround — `--test-force-exit` — crashes libuv on Windows
 * (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`, src/win/async.c) when it
 * force-exits while a handle is mid-close. Destroying the sockets first makes the file
 * exit on its own, so no force-exit flag is needed at all.
 * @param {import('node:http').Server} server
 */
async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(() => r(undefined)));
}

const { Fleet } = await import('../src/core/fleet.js');
const { runAgent, executeTool, toolDefinitions, systemPrompt, READ_ONLY_TOOLS, DISPATCH_TOOLS } = await import('../src/core/orchestrator.js');

after(async () => {
  for (const f of FLEETS) {
    try {
      await f.close();
    } catch {
      /* already closed */
    }
  }
  for (const p of PEERS) {
    try {
      await p.close();
    } catch {
      /* already closed */
    }
  }
  for (const d of HOMES) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* windows file locks: best effort */
    }
  }
});

// ------------------------------------------------------------------ fake LLM server

/**
 * An HTTP endpoint that replays a scripted list of assistant turns. Every request is
 * recorded so tests can assert on the exact conversation the orchestrator built.
 * @param {any[]} turns
 */
async function scriptedLlm(turns) {
  /** @type {any[]} */
  const requests = [];
  let i = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      requests.push(body);
      const turn = turns[Math.min(i, turns.length - 1)];
      i += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ finish_reason: turn.toolCalls?.length ? 'tool_calls' : 'stop', message: { role: 'assistant', content: turn.content ?? null, ...(turn.toolCalls ? { tool_calls: turn.toolCalls } : {}) } }],
          usage: { total_tokens: 10 },
        }),
      );
    });
  });
  await listenOnFetchablePort(server, '127.0.0.1');
  const port = /** @type {any} */ (server.address()).port;
  PEERS.push({ close: () => closeServer(server) });
  return {
    config: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'scripted', apiKey: '' },
    requests,
    close: () => closeServer(server),
    get calls() {
      return i;
    },
  };
}

/** A tool call as the model would emit it. */
const call = (name, args, id = `c_${name}`) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args ?? {}) },
});

/**
 * Find the tool result fed back for a given call id, across every request. Indexing
 * `requests[n]` directly is a trap: a turn with two tool calls produces both results in
 * one request, while two separate turns produce them in different requests.
 */
const toolResult = (llm, id) => {
  for (const req of llm.requests) {
    const m = req.messages?.find((x) => x.role === 'tool' && x.tool_call_id === id);
    if (m) return m;
  }
  return undefined;
};

// ------------------------------------------------------------------ fake A2A peer

/**
 * Minimal A2A peer that answers every task with a fixed string and records prompts.
 */
async function fakePeer(reply = 'REMOTE ANSWER') {
  const prompts = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      if (req.url?.includes('agent-card') || req.url?.includes('agent.json')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ name: 'peer', version: '1.0', capabilities: { streaming: false }, skills: [{ id: 's', name: 'Echo', description: 'echo', tags: ['echo'] }], supportedInterfaces: [{ protocolBinding: 'JSONRPC', protocolVersion: '1.0', url: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}/rpc` }] }));
        return;
      }
      const text = body?.params?.message?.parts?.[0]?.text ?? '';
      prompts.push(text);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: { kind: 'task', id: `t_${prompts.length}`, contextId: body?.params?.message?.contextId ?? 'ctx', status: { state: 'completed' }, artifacts: [{ artifactId: 'a', parts: [{ text: reply }] }] },
        }),
      );
    });
  });
  await listenOnFetchablePort(server, '127.0.0.1');
  const port = /** @type {any} */ (server.address()).port;
  const peer = { url: `http://127.0.0.1:${port}`, prompts, close: () => closeServer(server) };
  PEERS.push(peer);
  return peer;
}

/**
 * A Fleet with one registered A2A node pointing at the peer.
 *
 * The registry is a *file* under AGENTMESH_HOME, so each Fleet needs its own home —
 * otherwise the second test to register `worker` collides with the first one's file.
 */
async function makeFleet(peer, nodeName = 'worker') {
  freshHome();
  const fleet = new Fleet();
  fleet.registry.add({ name: nodeName, transport: 'a2a', url: peer.url, capabilities: ['echo'] });
  FLEETS.push(fleet);
  return fleet;
}

// ------------------------------------------------------------------ tool definitions

test('toolDefinitions exposes the expected surface and honours an allow-list', () => {
  const all = toolDefinitions().map((t) => t.function.name);
  assert.deepEqual(all, ['list_nodes', 'probe_node', 'send_task', 'broadcast', 'list_tasks', 'get_task']);

  const limited = toolDefinitions(['list_nodes', 'send_task']).map((t) => t.function.name);
  assert.deepEqual(limited, ['list_nodes', 'send_task']);

  // Every tool must declare an object-rooted schema, or strict servers reject the call.
  for (const t of toolDefinitions()) {
    assert.equal(t.type, 'function');
    assert.equal(t.function.parameters.type, 'object');
    assert.ok(t.function.description.length > 20, `${t.function.name} needs a real description`);
  }
  assert.deepEqual(toolDefinitions([]).map((t) => t.function.name), []);
});

test('systemPrompt injects the real node names, because guessing them is the classic failure', () => {
  const p = systemPrompt({ nodes: [{ name: 'nas-hermes', kind: 'hermes', transport: 'acp', target: 'ssh://user@10.0.0.5', capabilities: ['files'] }] });
  assert.match(p, /nas-hermes/);
  assert.match(p, /capabilities=\[files\]/);
  assert.match(p, /self-contained/i, 'the remote prompt rule must be stated');
  // With no nodes registered the prompt must say so rather than render an empty list.
  assert.match(systemPrompt({ nodes: [] }), /no nodes are registered/);
});

// ------------------------------------------------------------------ the loop

test('a single dispatch reaches the peer and its answer comes back through the loop', async () => {
  const peer = await fakePeer('def is_prime(n): ...');
  const fleet = await makeFleet(peer);
  const llm = await scriptedLlm([
    { toolCalls: [call('send_task', { node: 'worker', prompt: '写一个判断素数的函数' })] },
    { content: '已在 worker 上完成，代码如下：\ndef is_prime(n): ...' },
  ]);

  const res = await runAgent({ fleet, prompt: '让 worker 写一个判断素数的函数', llm: llm.config });

  assert.equal(res.text, '已在 worker 上完成，代码如下：\ndef is_prime(n): ...');
  assert.equal(res.steps, 2, 'one tool turn plus one answer turn');
  assert.equal(res.dispatchCount, 1);
  assert.deepEqual(peer.prompts, ['写一个判断素数的函数'], 'the remote agent receives exactly the prompt the model wrote');
  assert.equal(res.tasks.length, 1);
  assert.equal(res.tasks[0].state, 'completed');

  // The conversation the orchestrator built must contain the tool result, or the model
  // could not have answered from it.
  const second = llm.requests[1].messages;
  const toolMsg = second.find((m) => m.role === 'tool');
  assert.ok(toolMsg, 'a tool result message must be fed back');
  assert.match(toolMsg.content, /def is_prime/);

});

test('a dispatch lands in the SAME store as a hand-typed run', async () => {
  const peer = await fakePeer('ok');
  const fleet = await makeFleet(peer);
  const llm = await scriptedLlm([{ toolCalls: [call('send_task', { node: 'worker', prompt: 'do the thing' }, 'a')] }, { content: 'done' }]);
  await runAgent({ fleet, prompt: 'go', llm: llm.config });

  const tasks = fleet.store.listTasks({ limit: 10 });
  assert.equal(tasks.length, 1, 'the orchestrator must have no private side channel');
  assert.equal(tasks[0].prompt, 'do the thing');
  assert.equal(tasks[0].state, 'completed');

});

test('a failing tool is fed back as data so the model can correct itself', async () => {
  const peer = await fakePeer('second try worked');
  const fleet = await makeFleet(peer);
  const llm = await scriptedLlm([
    { toolCalls: [call('send_task', { node: 'nas-hermes', prompt: 'x' }, 'bad')] },
    { toolCalls: [call('send_task', { node: 'worker', prompt: 'x' }, 'good')] },
    { content: 'recovered' },
  ]);

  const res = await runAgent({ fleet, prompt: 'go', llm: llm.config });
  assert.equal(res.text, 'recovered');

  // The wrong node name must come back as an error listing the real ones.
  const firstResult = llm.requests[1].messages.find((m) => m.role === 'tool' && m.tool_call_id === 'bad');
  assert.match(firstResult.content, /unknown node 'nas-hermes'/);
  assert.match(firstResult.content, /worker/, 'the error must name the nodes that DO exist');
  assert.equal(res.dispatchCount, 1, 'the failed attempt must not count as a dispatch');
  assert.equal(peer.prompts.length, 1);

});

test('malformed tool arguments are reported back instead of throwing', async () => {
  const peer = await fakePeer('ok');
  const fleet = await makeFleet(peer);
  const llm = await scriptedLlm([
    { toolCalls: [{ id: 'broken', type: 'function', function: { name: 'send_task', arguments: '{"node":' } }] },
    { content: 'give up gracefully' },
  ]);
  const res = await runAgent({ fleet, prompt: 'go', llm: llm.config });
  assert.equal(res.text, 'give up gracefully');
  const toolMsg = llm.requests[1].messages.find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /not valid JSON/);
  assert.equal(peer.prompts.length, 0, 'nothing may be dispatched from unparseable arguments');

});

test('a model that never calls a tool is caught by the step limit, not reported as success', async () => {
  const peer = await fakePeer();
  const fleet = await makeFleet(peer);
  // Always asks for a tool, never finishes.
  const llm = await scriptedLlm([{ toolCalls: [call('list_nodes', {})] }]);
  const res = await runAgent({ fleet, prompt: 'go', llm: llm.config, policy: { maxSteps: 3 } });

  assert.equal(res.stopReason, 'step-limit');
  assert.equal(res.steps, 3);
  assert.equal(res.text, '', 'an unfinished run must not look like an answer');
  assert.equal(llm.requests.length, 3, 'the cap must actually stop the calls');

});

test('dry run validates and reports the plan without dispatching anything', async () => {
  const peer = await fakePeer();
  const fleet = await makeFleet(peer);
  const llm = await scriptedLlm([
    { toolCalls: [call('send_task', { node: 'worker', prompt: 'would do this' }, 'd1')] },
    { toolCalls: [call('send_task', { node: 'ghost', prompt: 'nope' }, 'd2')] },
    { content: 'plan ready' },
  ]);
  const res = await runAgent({ fleet, prompt: 'go', llm: llm.config, policy: { dryRun: true } });

  assert.equal(res.dispatchCount, 0);
  assert.equal(peer.prompts.length, 0, 'a dry run must not touch the network');
  assert.equal(fleet.store.listTasks({ limit: 5 }).length, 0, 'a dry run must not write tasks');

  const d1 = toolResult(llm, 'd1');
  assert.match(d1.content, /dryRun|wouldSend/);
  // Even in a dry run the node is validated: a plan naming a nonexistent node is worse
  // than no plan.
  const d2 = toolResult(llm, 'd2');
  assert.match(d2.content, /unknown node 'ghost'/);

});

test('the dispatch limit stops a runaway fan-out', async () => {
  const peer = await fakePeer();
  const fleet = await makeFleet(peer);
  const llm = await scriptedLlm([{ toolCalls: [call('send_task', { node: 'worker', prompt: 'again' })] }]);
  const res = await runAgent({ fleet, prompt: 'go', llm: llm.config, policy: { maxSteps: 6, maxDispatches: 2 } });

  assert.equal(res.dispatchCount, 2);
  const limited = llm.requests.at(-1).messages.filter((m) => m.role === 'tool').at(-1);
  assert.match(limited.content, /dispatch limit reached/);

});

test('the confirmation hook can refuse a dispatch', async () => {
  const peer = await fakePeer();
  const fleet = await makeFleet(peer);
  const llm = await scriptedLlm([{ toolCalls: [call('send_task', { node: 'worker', prompt: 'risky' })] }, { content: 'user declined' }]);
  const asked = [];
  const res = await runAgent({
    fleet,
    prompt: 'go',
    llm: llm.config,
    policy: { onConfirm: async (info) => { asked.push(info); return false; } },
  });

  assert.equal(asked.length, 1);
  assert.equal(asked[0].node, 'worker');
  assert.equal(res.dispatchCount, 0);
  assert.equal(peer.prompts.length, 0, 'a refused dispatch must not reach the network');
  assert.match(llm.requests[1].messages.find((m) => m.role === 'tool').content, /refused/);

});

test('every tool call is recorded with its name and arguments for the audit trail', async () => {
  const peer = await fakePeer('x');
  const fleet = await makeFleet(peer);
  const llm = await scriptedLlm([
    { toolCalls: [call('list_nodes', {}, 'n1'), call('send_task', { node: 'worker', prompt: 'p' }, 'n2')] },
    { content: 'done' },
  ]);
  const res = await runAgent({ fleet, prompt: 'go', llm: llm.config });
  assert.deepEqual(res.toolCalls.map((c) => c.name), ['list_nodes', 'send_task']);
  assert.deepEqual(res.toolCalls[1].args, { node: 'worker', prompt: 'p' });

});

test('a large remote answer is capped and the cap is stated', async () => {
  const peer = await fakePeer('Z'.repeat(60_000));
  const fleet = await makeFleet(peer);
  const llm = await scriptedLlm([{ toolCalls: [call('send_task', { node: 'worker', prompt: 'big' })] }, { content: 'got it' }]);
  await runAgent({ fleet, prompt: 'go', llm: llm.config });

  const toolMsg = llm.requests[1].messages.find((m) => m.role === 'tool');
  assert.ok(toolMsg.content.length < 25_000, 'the context must not be flooded');
  assert.match(toolMsg.content, /truncated: full result was \d+ chars/, 'silent truncation is not allowed');

});

test('runAgent refuses to start when the LLM is not configured', async () => {
  const peer = await fakePeer();
  const fleet = await makeFleet(peer);
  await assert.rejects(() => runAgent({ fleet, prompt: 'go', llm: { baseUrl: '', model: '' } }), /LLM not configured/);
});

// ------------------------------------------------------------------ tool units

test('executeTool: get_task and list_tasks report honestly', async () => {
  const peer = await fakePeer();
  const fleet = await makeFleet(peer);
  const ctx = { policy: {}, dryRun: false, toolCalls: [], dispatched: [], countDispatch: () => {} };

  assert.match((await executeTool('get_task', { task_id: 'nope' }, fleet, ctx)).error, /no task 'nope'/);
  assert.match((await executeTool('get_task', {}, fleet, ctx)).error, /task_id is required/);
  assert.match((await executeTool('probe_node', {}, fleet, ctx)).error, /node is required/);
  assert.match((await executeTool('send_task', { node: 'worker' }, fleet, ctx)).error, /prompt is required/);
  assert.match((await executeTool('broadcast', {}, fleet, ctx)).error, /prompt is required/);
  assert.match((await executeTool('nonsense', {}, fleet, ctx)).error, /unknown tool 'nonsense'/);

  // list_tasks on an unknown node reports it rather than returning everything, which
  // would look like a plausible empty history.
  assert.match((await executeTool('list_tasks', { node: 'ghost' }, fleet, ctx)).error, /unknown node 'ghost'/);
  const listed = await executeTool('list_tasks', {}, fleet, ctx);
  assert.deepEqual(listed.tasks, []);

});

test('executeTool: probe_node turns an unreachable host into a readable answer', async () => {
  freshHome();
  const fleet = new Fleet();
  FLEETS.push(fleet);
  fleet.registry.add({ name: 'dead', transport: 'a2a', url: 'http://127.0.0.1:1' });
  const ctx = { policy: {}, dryRun: false, toolCalls: [], dispatched: [], countDispatch: () => {} };
  const r = await executeTool('probe_node', { node: 'dead' }, fleet, ctx);
  assert.equal(r.reachable, false);
  assert.ok(r.error, 'an unreachable node must be reported as such, not as "no skills"');
});

test('the read-only and dispatch tool sets together cover every tool', () => {
  assert.deepEqual([...READ_ONLY_TOOLS, ...DISPATCH_TOOLS].sort(), toolDefinitions().map((t) => t.function.name).sort());
});
