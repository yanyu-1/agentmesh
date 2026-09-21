// A2A adapter integration test against a mock peer that replicates the EXACT wire
// format Hermes emits (shapes copied from
// %LOCALAPPDATA%\hermes\hermes-agent\plugins\platforms\a2a\protocol.py).
//
// Real HTTP over a loopback socket, real SSE, real adapter + fleet + store.
//
// Run: node test/a2a-adapter.test.js

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { listenOnFetchablePort } from '../src/core/transport/net.js';

const HOMES = [];
/** Each test gets an isolated registry + store. */
function freshHome() {
  const dir = mkdtempSync(join(tmpdir(), 'agentmesh-a2a-'));
  HOMES.push(dir);
  process.env.AGENTMESH_HOME = dir;
  return dir;
}
freshHome();

const { Fleet } = await import('../src/core/fleet.js');
const { TaskState } = await import('../src/protocol/states.js');
const { EventType } = await import('../src/protocol/events.js');

/** @type {import('node:http').Server} */
let server;
let base = '';
/** What the mock recorded about the last request. */
const seen = { requests: [], lastAuth: null, lastBody: null };

// --- Hermes-shaped helpers --------------------------------------------------

/** Mirrors protocol.text_part() */
const textPart = (text) => ({ text, mediaType: 'text/plain' });
/** Mirrors protocol.text_message() */
const textMessage = (role, text, contextId) => ({ role, parts: [textPart(text)], messageId: randomUUID().replace(/-/g, ''), ...(contextId ? { contextId } : {}) });
/** Mirrors protocol.build_agent_card() */
const agentCard = (url, { auth = false, streaming = true } = {}) => ({
  name: 'hermes-mock',
  description: 'Mock Hermes agent used to pin the A2A wire format',
  url,
  version: '1.0.0',
  provider: { organization: 'Hermes Agent', url },
  supportedInterfaces: [{ url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
  capabilities: { streaming, pushNotifications: false, stateTransitionHistory: false, extendedAgentCard: false },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [{ id: 'toolset.web', name: 'web', description: "Hermes 'web' capabilities", tags: ['web'] }],
  ...(auth ? { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } }, security: [{ bearer: [] }] } : {}),
});

const rpcResult = (id, result) => JSON.stringify({ jsonrpc: '2.0', id, result });
const sse = (payload, id) => `data: ${rpcResult(id, payload)}\n\n`;

/** Mirrors protocol.build_task() */
const buildTask = (taskId, contextId, state, agentText) => ({
  id: taskId,
  contextId,
  status: { state, timestamp: new Date().toISOString(), ...(agentText ? { message: textMessage('ROLE_AGENT', agentText, contextId) } : {}) },
  ...(agentText && state === 'TASK_STATE_COMPLETED' ? { artifacts: [{ artifactId: randomUUID().replace(/-/g, ''), parts: [textPart(agentText)] }] } : {}),
});

before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    seen.lastAuth = req.headers.authorization || null;

    if (req.method === 'GET' && url.pathname === '/.well-known/agent-card.json') {
      const body = JSON.stringify(agentCard(base, { streaming: true }));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(body);
    }

    if (req.method === 'POST' && url.pathname === '/') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seen.requests.push(body);
      seen.lastBody = body;

      // Header required by the spec.
      assert.equal(req.headers['a2a-version'], '1.0', 'client must send the A2A-Version header');

      const msg = body.params?.message ?? {};
      const incoming = (msg.parts || []).map((p) => p.text).filter(Boolean).join('\n');
      const contextId = msg.contextId || `ctx-${randomUUID().slice(0, 8)}`;

      if (body.method === 'SendMessage') {
        if (incoming.includes('NEEDS_INPUT')) {
          const task = buildTask(`task-${randomUUID().slice(0, 8)}`, contextId, 'TASK_STATE_INPUT_REQUIRED', '[INPUT_REQUIRED] which branch?');
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(rpcResult(body.id, { task }));
        }
        if (incoming.includes('FAIL')) {
          const task = buildTask(`task-${randomUUID().slice(0, 8)}`, contextId, 'TASK_STATE_FAILED', 'nope');
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(rpcResult(body.id, { task }));
        }
        // Hermes answers a plain message with a bare Message too; use the Task path
        // because that is what a long-running agent returns.
        const task = buildTask(`task-${randomUUID().slice(0, 8)}`, contextId, 'TASK_STATE_COMPLETED', `echo: ${incoming}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(rpcResult(body.id, { task }));
      }

      if (body.method === 'SendStreamingMessage') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        res.write(sse({ task: buildTask(taskId, contextId, 'TASK_STATE_SUBMITTED') }, body.id));
        res.write(sse({ statusUpdate: { taskId, contextId, status: { state: 'TASK_STATE_WORKING', timestamp: new Date().toISOString() } } }, body.id));
        res.write(sse({ artifactUpdate: { taskId, contextId, artifact: { artifactId: 'a1', parts: [textPart('streamed ')] } } }, body.id));
        res.write(sse({ artifactUpdate: { taskId, contextId, append: true, artifact: { artifactId: 'a1', parts: [textPart('answer')] } } }, body.id));
        res.write(sse({ statusUpdate: { taskId, contextId, status: { state: 'TASK_STATE_COMPLETED', timestamp: new Date().toISOString() } } }, body.id));
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      if (body.method === 'CancelTask') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(rpcResult(body.id, buildTask(body.params.id, 'ctx', 'TASK_STATE_CANCELED')));
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `method not found: ${body.method}` } }));
    }

    res.writeHead(404).end('nope');
  });

  await listenOnFetchablePort(server, '127.0.0.1');
  const addr = server.address();
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server?.close();
  for (const dir of HOMES) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/** @returns {Fleet} */
function makeFleet() {
  freshHome();
  const fleet = new Fleet();
  fleet.registry.add({ name: 'mock', kind: 'generic-acp', transport: 'a2a', url: base, token: 'test-token' });
  return fleet;
}

test('A2A: discovers the Agent Card from /.well-known/agent-card.json', async () => {
  const fleet = makeFleet();
  const result = await fleet.probe('mock');
  assert.equal(result.reachable, true);
  assert.equal(result.summary.name, 'hermes-mock');
  assert.equal(result.summary.streaming, true);
  assert.equal(result.summary.skills[0].id, 'toolset.web');
  assert.equal(result.rpcUrl, base);
  await fleet.close();
});

test('A2A: SendMessage returns the task result and persists a completed task', async () => {
  const fleet = makeFleet();
  const events = [];
  fleet.subscribe((ev) => events.push(ev));

  const task = await fleet.send({ nodeRef: 'mock', prompt: 'hello world', stream: false });

  assert.equal(task.state, TaskState.COMPLETED);
  assert.equal(task.result, 'echo: hello world');
  assert.ok(task.contextId, 'contextId must be captured for session continuation');
  assert.equal(seen.lastAuth, 'Bearer test-token', 'bearer token must be sent');
  assert.equal(seen.lastBody.method, 'SendMessage');
  assert.equal(seen.lastBody.params.message.role, 'ROLE_USER');
  assert.deepEqual(seen.lastBody.params.message.parts, [{ text: 'hello world', mediaType: 'text/plain' }]);

  // state machine + store
  const states = events.filter((e) => e.type === EventType.TASK_STATE).map((e) => e.data.state);
  assert.deepEqual(states, [TaskState.SUBMITTED, TaskState.WORKING]);
  assert.ok(events.some((e) => e.type === EventType.CHUNK && e.text === 'echo: hello world'));
  assert.ok(events.some((e) => e.type === EventType.DONE));

  const stored = fleet.store.getTask(task.id);
  assert.equal(stored.state, TaskState.COMPLETED);
  assert.equal(stored.eventCount, events.length - 1 + 1 || stored.eventCount); // events are appended
  assert.ok(stored.eventCount > 0);
  assert.equal(fleet.store.eventsForTask(task.id).length, stored.eventCount);
  await fleet.close();
});

test('A2A: streaming path consumes statusUpdate/artifactUpdate SSE frames', async () => {
  const fleet = makeFleet();
  const events = [];
  fleet.subscribe((ev) => events.push(ev));

  const task = await fleet.send({ nodeRef: 'mock', prompt: 'stream please', stream: true });
  assert.equal(task.state, TaskState.COMPLETED);
  assert.equal(task.result, 'streamed answer');
  assert.ok(seen.requests.some((r) => r.method === 'SendStreamingMessage'));
  assert.ok(events.some((e) => e.type === EventType.CHUNK && e.text === 'streamed '));
  await fleet.close();
});

test('A2A: INPUT_REQUIRED is surfaced as input-required, not completed', async () => {
  const fleet = makeFleet();
  const task = await fleet.send({ nodeRef: 'mock', prompt: 'NEEDS_INPUT now', stream: false });
  assert.equal(task.state, TaskState.INPUT_REQUIRED);
  await fleet.close();
});

test('A2A: FAILED task state is surfaced as failed', async () => {
  const fleet = makeFleet();
  const task = await fleet.send({ nodeRef: 'mock', prompt: 'FAIL hard', stream: false });
  assert.equal(task.state, TaskState.FAILED);
  await fleet.close();
});

test('A2A: continued sessions reuse the stored contextId', async () => {
  const fleet = makeFleet();
  const first = await fleet.send({ nodeRef: 'mock', prompt: 'first', stream: false });
  const second = await fleet.send({ nodeRef: 'mock', prompt: 'second', continueSession: true, stream: false });
  assert.equal(second.contextId, first.contextId, '--continue must reuse the context');
  assert.equal(seen.lastBody.params.message.contextId, first.contextId);
  await fleet.close();
});

test('A2A: continued sends WITHOUT history carry only the new message', async () => {
  // The default must not silently rewrite the prompt: a peer that keeps real
  // server-side context would otherwise receive every earlier turn twice.
  const fleet = makeFleet();
  await fleet.send({ nodeRef: 'mock', prompt: 'first', stream: false });
  await fleet.send({ nodeRef: 'mock', prompt: 'second', continueSession: true, stream: false });

  assert.equal(seen.lastBody.params.message.parts[0].text, 'second');
  await fleet.close();
});

test('A2A: replayHistory makes the client carry the conversation for a stateless peer', async () => {
  // A live third-party peer accepted and echoed our contextId while building each
  // prompt from the latest message alone, so the "conversation" had no memory of
  // earlier turns. With replayHistory the client sends them itself.
  const fleet = makeFleet();
  await fleet.send({ nodeRef: 'mock', prompt: 'first question', stream: false });
  await fleet.send({ nodeRef: 'mock', prompt: 'second question', continueSession: true, replayHistory: true, stream: false });

  const sent = seen.lastBody.params.message.parts[0].text;
  assert.match(sent, /first question/, 'the earlier user turn must be replayed');
  assert.match(sent, /echo: first question/, 'the earlier assistant answer must be replayed too');
  assert.ok(sent.indexOf('first question') < sent.indexOf('second question'), 'history precedes the new message');
  assert.ok(sent.trimEnd().endsWith('user: second question'), 'the new message comes last');
  assert.equal(seen.lastBody.params.message.contextId, (await fleet.store.lastSession(fleet.registry.mustGet('mock').id)).contextId);
  await fleet.close();
});

test('A2A: replayHistory reaches the wire on the STREAMING path too', async () => {
  // A streaming-capable peer with no server-side context would otherwise silently
  // drop the conversation whenever `--stream` was in play — the same "looks like it
  // worked" failure the blocking-path fix exists to prevent.
  const fleet = makeFleet();
  await fleet.send({ nodeRef: 'mock', prompt: 'streamed first', stream: true });
  await fleet.send({ nodeRef: 'mock', prompt: 'streamed second', continueSession: true, replayHistory: true, stream: true });

  assert.equal(seen.lastBody.method, 'SendStreamingMessage', 'the streaming method must be the one carrying the history');
  const sent = seen.lastBody.params.message.parts[0].text;
  assert.match(sent, /streamed first/);
  assert.match(sent, /assistant: streamed answer/, 'the streamed answer must be replayed, not the blocking echo');
  assert.ok(sent.trimEnd().endsWith('user: streamed second'));
  await fleet.close();
});

// ---------------------------------------------------------------------------
// The v0.3-shaped peer — which is what a REAL Hermes v0.14 A2A bridge looked like on
// first contact with this code:
//   * its card had no `supportedInterfaces` (legacy shape) and advertised its RPC at a
//     PRIVATE address (`http://172.24.225.207:9900/`), and
//   * its server answered the v1.0 method name `SendMessage` with `-32601 Method not
//     found`, implementing only the legacy `message/send`.
// Both behaviours below were observed against that live endpoint, not invented.
// ---------------------------------------------------------------------------

/**
 * Start a legacy peer. Returns its base URL plus a log of the methods it was asked for.
 * @param {{privateUrl?:boolean}} [opts]
 */
async function startLegacyPeer({ privateUrl = false } = {}) {
  /** @type {string[]} */
  const methods = [];
  /** Set once we know our own port; until then the card cannot be served. */
  let selfUrl = '';
  const srv = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/.well-known/agent-card.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      // Note: no supportedInterfaces, and `url` optionally names an unroutable host.
      return res.end(
        JSON.stringify({
          name: 'hermes-b',
          description: 'Hermes Agent bridge exposed via A2A (placeholder responder).',
          url: privateUrl ? 'http://172.24.225.207:9900/' : selfUrl,
          version: '0.14.0',
          capabilities: { streaming: false },
          skills: [{ id: 'echo', name: 'Echo', description: 'placeholder', tags: ['echo'] }],
        }),
      );
    }
    if (req.method === 'POST' && url.pathname === '/') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      methods.push(body.method);
      res.writeHead(200, { 'content-type': 'application/json' });
      if (body.method !== 'message/send') {
        return res.end(
          JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `Method not found: ${body.method}` } }),
        );
      }
      const incoming = (body.params?.message?.parts || []).map((p) => p.text).filter(Boolean).join('\n');
      return res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: { role: 'ROLE_AGENT', parts: [{ text: `[placeholder] received: ${incoming}` }], messageId: 'm1' },
        }),
      );
    }
    res.writeHead(404).end('nope');
  });
  await listenOnFetchablePort(srv, '127.0.0.1');
  const port = /** @type {any} */ (srv.address()).port;
  selfUrl = `http://127.0.0.1:${port}`;
  return { base: selfUrl, methods, close: () => new Promise((r) => srv.close(() => r(null))) };
}

test('A2A: a legacy peer is driven with message/send, retrying after -32601', async () => {
  const peer = await startLegacyPeer();
  try {
    freshHome();
    const fleet = new Fleet();
    fleet.registry.add({ name: 'legacy', transport: 'a2a', url: peer.base, token: 't' });

    const task = await fleet.send({ nodeRef: 'legacy', prompt: 'ping', stream: false });

    assert.equal(task.state, TaskState.COMPLETED);
    assert.equal(task.result, '[placeholder] received: ping');
    // The card says legacy, so we lead with the legacy name; and if a card lies about
    // its revision, the -32601 retry must still land on a method the peer implements.
    assert.equal(peer.methods.at(-1), 'message/send', 'the peer must ultimately be asked with message/send');
    assert.ok(
      peer.methods.every((m) => m === 'message/send' || m === 'SendMessage'),
      'only the two known send methods may ever be tried',
    );
    await fleet.close();
  } finally {
    await peer.close();
  }
});

test('A2A: a card naming a PRIVATE RPC address is not followed blindly', async () => {
  const peer = await startLegacyPeer({ privateUrl: true });
  try {
    freshHome();
    const fleet = new Fleet();
    // We reach the card on loopback; the card claims its RPC lives at 172.24.225.207.
    fleet.registry.add({ name: 'legacy', transport: 'a2a', url: peer.base, token: 't' });

    const probe = await fleet.probe('legacy');
    assert.equal(probe.rpcUrl, peer.base, 'the proven-reachable origin must be used, not the private one');
    assert.equal(probe.advertisedUrl, 'http://172.24.225.207:9900/', 'the card claim is still reported');
    assert.equal(probe.warnings.length, 1, 'the operator must be told the card is misconfigured');
    assert.match(probe.warnings[0], /private address/);

    // Had the adapter followed the card literally, this POST would have gone to an
    // unroutable host and this server would never have been asked — so a completed task
    // here is itself the proof of the fallback.
    const task = await fleet.send({ nodeRef: 'legacy', prompt: 'ping', stream: false });
    assert.equal(task.state, TaskState.COMPLETED);
    assert.equal(task.result, '[placeholder] received: ping');
    await fleet.close();
  } finally {
    await peer.close();
  }
});
