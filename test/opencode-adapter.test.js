// opencode adapter integration test against a mock `opencode serve` that speaks the
// exact v1.18.31 wire format documented in research/opencode-api.md:
//   - SSE `event:` field is always literally "message"; the type lives in the JSON
//     envelope {id, type, properties}
//   - streaming = POST /session/:id/prompt_async (204) then GET /event
//   - permission answer = POST /session/:id/permissions/:permissionID {response}
//   - directory scoping via ?directory=
//
// Run: node test/opencode-adapter.test.js

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenOnFetchablePort } from '../src/core/transport/net.js';

const HOMES = [];
function freshHome() {
  const dir = mkdtempSync(join(tmpdir(), 'agentmesh-oc-'));
  HOMES.push(dir);
  process.env.AGENTMESH_HOME = dir;
  return dir;
}
freshHome();

const { Fleet } = await import('../src/core/fleet.js');
const { TaskState } = await import('../src/protocol/states.js');
const { EventType } = await import('../src/protocol/events.js');

let server;
let base = '';
/** @type {string[]} */
const urls = [];
let permissionReply = null;
/** release the SSE continuation once the permission is answered */
let releaseStream = null;
let authHeard = null;
let promptBody = null;
/** whether the mock saw ?directory= on the /event subscribe */
let eventUrl = '';

const OPENAPI = {
  openapi: '3.1.0',
  info: { title: 'opencode', version: '1.18.31' },
  paths: {
    '/global/health': { get: {} },
    '/doc': { get: {} },
    '/event': { get: {} },
    '/session': { get: {}, post: {} },
    '/session/{id}/message': { get: {}, post: {} },
    '/session/{id}/prompt_async': { post: {} },
    '/session/{id}/abort': { post: {} },
    '/session/{id}/permissions/{permissionID}': { post: {} },
    '/permission': { get: {} },
    '/agent': { get: {} },
    '/provider': { get: {} },
  },
};

const sseFrame = (obj) => `event: message\ndata: ${JSON.stringify(obj)}\n\n`;

before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    urls.push(url.pathname + url.search);
    authHeard = req.headers.authorization || null;

    const json = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/global/health') return json(200, { healthy: true, version: '1.18.31' });
    if (url.pathname === '/doc') return json(200, OPENAPI);
    if (url.pathname === '/session' && req.method === 'POST') return json(200, { id: 'ses_mock1', directory: 'D:\\工作' });

    if (url.pathname === '/session/ses_mock1/prompt_async' && req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      promptBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      // opencode answers 204 No Content; the text arrives on /event.
      res.writeHead(204);
      return res.end();
    }

    if (url.pathname === '/event') {
      eventUrl = url.pathname + url.search;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const p = (o) => res.write(sseFrame(o));
      p({ id: 'evt_1', type: 'server.connected', properties: {} });
      p({ id: 'evt_2', type: 'message.part.updated', properties: { sessionID: 'ses_mock1', part: { id: 'prt_1', type: 'text', text: '我正在检查' }, time: Date.now() } });
      p({ id: 'evt_3', type: 'message.part.delta', properties: { sessionID: 'ses_mock1', messageID: 'msg_1', partID: 'prt_1', field: 'text', delta: '目录…' } });
      // A permission prompt blocks the agent until we answer over HTTP.
      p({ id: 'evt_4', type: 'permission.asked', properties: { id: 'per_abc', sessionID: 'ses_mock1', permission: 'bash', patterns: ['rm -rf build'], metadata: {}, always: [], tool: { messageID: 'msg_1', callID: 'call_1' } } });
      releaseStream = async () => {
        p({ id: 'evt_5', type: 'permission.replied', properties: { sessionID: 'ses_mock1', requestID: 'per_abc', reply: permissionReply } });
        p({ id: 'evt_6', type: 'message.part.updated', properties: { sessionID: 'ses_mock1', part: { id: 'prt_2', type: 'text', text: '已完成。' }, time: Date.now() } });
        p({ id: 'evt_7', type: 'session.idle', properties: { sessionID: 'ses_mock1' } });
        res.end();
      };
      return undefined;
    }

    const perm = url.pathname.match(/^\/session\/([^/]+)\/permissions\/([^/]+)$/);
    if (perm && req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.deepEqual(Object.keys(body), ['response'], 'v1.18.31 accepts ONLY `response` (additionalProperties:false)');
      permissionReply = body.response;
      await releaseStream?.();
      return json(200, true);
    }

    if (url.pathname.endsWith('/abort')) return json(200, true);

    return json(404, { error: 'not found' });
  });

  await listenOnFetchablePort(server, '127.0.0.1');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  for (const d of HOMES) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function makeFleet(extra = {}) {
  freshHome();
  const fleet = new Fleet();
  fleet.registry.add({
    name: 'oc',
    kind: 'opencode',
    transport: 'opencode',
    url: base,
    password: 'secret-pass',
    cwd: 'D:\\工作',
    ...extra,
  });
  return fleet;
}

test('opencode: probe reads /global/health and self-checks endpoints against /doc', async () => {
  const fleet = makeFleet();
  const info = await fleet.probe('oc');
  assert.equal(info.reachable, true, `probe failed: ${JSON.stringify(info.errors ?? info)}`);
  assert.equal(info.version, '1.18.31');
  assert.equal(info.pathCount, Object.keys(OPENAPI.paths).length);
  assert.equal(info.endpointsFound.sessionPromptAsync, true);
  assert.equal(info.endpointsFound.permissionAnswer, true);
  assert.equal(authHeard, `Basic ${Buffer.from('opencode:secret-pass').toString('base64')}`, 'HTTP Basic must be sent');
  await fleet.close();
});

test('opencode: streaming uses prompt_async + /event, scoped by ?directory=', async () => {
  const fleet = makeFleet({ approvalPolicy: 'ask' });
  const events = [];
  fleet.subscribe((ev) => events.push(ev));

  // Answer the parked permission from the "operator" side while send() is in flight.
  const answering = (async () => {
    for (let i = 0; i < 100; i += 1) {
      const pending = fleet.pendingApprovals();
      if (pending.length) {
        const r = fleet.resolveApproval(pending[0].id, 'allow_once');
        assert.equal(r.ok, true);
        return;
      }
      await new Promise((r2) => setTimeout(r2, 50));
    }
    throw new Error('no approval was ever parked');
  })();

  const task = await fleet.send({ nodeRef: 'oc', prompt: '帮我构建项目', taskId: 'task_x', onEvent: () => {} });
  await answering;

  assert.equal(permissionReply, 'once', 'allow_once must map to the `once` response');
  assert.deepEqual(promptBody.parts, [{ type: 'text', text: '帮我构建项目' }]);
  assert.equal(task.state, TaskState.COMPLETED);
  assert.match(task.result, /我正在检查/);
  assert.match(task.result, /已完成。/);
  // Derive the expectation instead of hardcoding the percent-encoding. The cwd here is a
  // deliberately non-ASCII path, and a baked-in encoding silently pins this test to one
  // exact directory name — it stopped matching the moment that example path was renamed,
  // which is a false alarm about working code.
  assert.ok(
    eventUrl.includes(`directory=${encodeURIComponent('D:\\工作')}`),
    `the /event subscription must carry the directory scope (got ${eventUrl})`,
  );

  // wire-level assertions
  assert.ok(urls.some((u) => u.startsWith('/session/ses_mock1/prompt_async')), 'must use prompt_async, not the sync /message');
  assert.ok(!urls.some((u) => u.startsWith('/session/ses_mock1/message')), 'must not use the non-streaming sync endpoint');

  // event mapping
  const types = events.map((e) => e.type);
  assert.ok(types.includes(EventType.CHUNK));
  assert.ok(types.includes(EventType.APPROVAL_REQUESTED));
  assert.ok(types.includes(EventType.APPROVAL_RESOLVED));
  assert.ok(types.includes(EventType.DONE));

  // the approval was durable, not just in adapter memory
  const rows = fleet.store.listApprovals({});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'approved');
  assert.match(rows[0].title, /bash/);
  assert.match(rows[0].title, /rm -rf build/);
  assert.deepEqual(rows[0].options.map((o) => o.optionId), ['allow_once', 'allow_always', 'deny']);

  await fleet.close();
});
