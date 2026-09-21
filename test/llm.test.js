// LLM client tests: wire format, normalisation, and error diagnosis.
//
// The four failure bodies below are copied verbatim from the real gateway we talk to
// (see ACCEPTANCE §3.8). They matter because it answers **401 for all of them** — an
// unknown model, a plan-restricted model, a missing key and a bad key are
// indistinguishable by status, so the diagnosis has to come from the body.
//
// Run: node test/llm.test.js

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { listenOnFetchablePort } from '../src/core/transport/net.js';

const {
  normalizeCompletion,
  parseToolArgs,
  joinUrl,
  llmReady,
  rethrowLlmError,
  gatewayMessage,
  chat,
  listModels,
} = await import('../src/core/llm.js');
const { HttpError } = await import('../src/core/transport/http.js');

// ---------------------------------------------------------------- normalisation

test('normalizeCompletion reads the standard OpenAI tool-call shape', () => {
  const r = normalizeCompletion({
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          content: '',
          tool_calls: [
            { id: 'call_a', type: 'function', function: { name: 'send_task', arguments: '{"node":"nas","prompt":"hi"}' } },
          ],
        },
      },
    ],
    usage: { total_tokens: 42 },
  });
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].name, 'send_task');
  assert.deepEqual(r.toolCalls[0].args, { node: 'nas', prompt: 'hi' });
  assert.equal(r.finishReason, 'tool_calls');
  assert.equal(r.usage.total_tokens, 42);
});

test('normalizeCompletion tolerates the variations local servers actually emit', () => {
  // arguments already decoded into an object
  const asObject = normalizeCompletion({
    choices: [{ message: { tool_calls: [{ id: 'x', function: { name: 'f', arguments: { a: 1 } } }] } }],
  });
  assert.deepEqual(asObject.toolCalls[0].args, { a: 1 });
  assert.equal(asObject.toolCalls[0].raw, '{"a":1}');

  // arguments omitted entirely -> empty object, never a throw
  const noArgs = normalizeCompletion({ choices: [{ message: { tool_calls: [{ function: { name: 'f' } }] } }] });
  assert.deepEqual(noArgs.toolCalls[0].args, {});
  assert.equal(noArgs.toolCalls[0].id, 'call_0', 'a missing id must still be addressable');

  // legacy single function_call
  const legacy = normalizeCompletion({ choices: [{ message: { function_call: { name: 'old', arguments: '{"b":2}' } } }] });
  assert.equal(legacy.toolCalls.length, 1);
  assert.equal(legacy.toolCalls[0].name, 'old');
  assert.deepEqual(legacy.toolCalls[0].args, { b: 2 });

  // no choices at all / null message must not throw
  assert.deepEqual(normalizeCompletion({}).toolCalls, []);
  assert.equal(normalizeCompletion({ choices: [{}] }).content, '');
  assert.equal(normalizeCompletion({ choices: [{ message: { content: null } }] }).content, '');
  // non-string content is preserved rather than silently dropped
  assert.equal(normalizeCompletion({ choices: [{ message: { content: [{ type: 'text', text: 'hi' }] } }] }).content, '[{"type":"text","text":"hi"}]');
});

test('parseToolArgs reports malformed JSON as data instead of throwing', () => {
  assert.deepEqual(parseToolArgs(''), {});
  assert.deepEqual(parseToolArgs('   '), {});
  assert.deepEqual(parseToolArgs('{"a":1}'), { a: 1 });
  const broken = parseToolArgs('{"a":');
  assert.ok(broken.__parseError, 'a malformed argument string must be surfaced, not swallowed');
  assert.equal(broken.__parseError, '{"a":');
});

test('joinUrl handles trailing and leading slashes', () => {
  assert.equal(joinUrl('http://h/v1', '/chat/completions'), 'http://h/v1/chat/completions');
  assert.equal(joinUrl('http://h/v1/', '/chat/completions'), 'http://h/v1/chat/completions');
  assert.equal(joinUrl('http://h/v1/', 'chat/completions'), 'http://h/v1/chat/completions');
  assert.equal(joinUrl('http://h/v1///', '//models'), 'http://h/v1/models');
});

test('llmReady names exactly what is missing', () => {
  assert.deepEqual(llmReady({ baseUrl: 'u', model: 'm' }), { ok: true, missing: [] });
  assert.deepEqual(llmReady({ model: 'm' }).missing, ['baseUrl']);
  assert.deepEqual(llmReady({ baseUrl: 'u' }).missing, ['model']);
  assert.deepEqual(llmReady({}).missing, ['baseUrl', 'model']);
});

// ---------------------------------------------------------------- error routing

test('gateway failures are told apart by BODY, because the status is 401 for all of them', () => {
  const unknownModel = new HttpError(
    401,
    'http://gw/v1/chat/completions',
    '{"error":{"message":"Model/provider not recognized: anthropic:no/such-model-xyz","type":"authentication_error","code":"FORBIDDEN"}}',
  );
  assert.throws(
    () => rethrowLlmError(unknownModel, 'no/such-model-xyz'),
    /does not recognise model 'no\/such-model-xyz'.*mesh agent models/s,
    'a typo must not be reported as a billing problem',
  );

  const notInPlan = new HttpError(
    401,
    'http://gw/v1/chat/completions',
    '{"error":{"message":"MODEL_NOT_IN_PLAN: GPT-5.5 available in Pro and above plans or extra on demand usage","type":"authentication_error","code":"FORBIDDEN"}}',
  );
  assert.throws(() => rethrowLlmError(notInPlan, 'gpt-5.5'), /plan does not include it/);

  const noKey = new HttpError(
    401,
    'http://gw/v1/chat/completions',
    '{"error":{"message":"Missing API key. Send in Authorization: Bearer <key> or x-api-key header","type":"auth_error"}}',
  );
  assert.throws(() => rethrowLlmError(noKey, 'm'), /rejected our credentials.*AGENTMESH_LLM_API_KEY/s);
});

test('gateway error routing keeps the gateway\'s own wording and covers the other statuses', () => {
  const badBody = new HttpError(
    400,
    'http://gw/v1/chat/completions',
    '{"error":{"message":"Invalid request error. HINT: Validation error: Too big: expected number to be <=1 at \\"params.temperature\\"","type":"invalid_request_error"}}',
  );
  assert.throws(() => rethrowLlmError(badBody, 'm'), /HTTP 400.*params\.temperature/s, "the gateway's HINT is the useful part");

  assert.throws(() => rethrowLlmError(new HttpError(429, 'u', '{}'), 'm'), /rate-limited/);
  assert.throws(() => rethrowLlmError(new HttpError(503, 'u', '{"error":{"message":"upstream down"}}'), 'm'), /upstream down.*server-side/s);

  // A non-HTTP error (timeout, DNS) must pass through untouched — it is already a
  // better message than anything we could invent here.
  const plain = new Error('cannot reach http://gw: ECONNREFUSED');
  assert.throws(() => rethrowLlmError(plain, 'm'), /ECONNREFUSED/);
});

test('gatewayMessage extracts a readable message from any body shape', () => {
  assert.equal(gatewayMessage('{"error":{"message":"boom"}}'), 'boom');
  assert.equal(gatewayMessage('{"message":"boom2"}'), 'boom2');
  assert.equal(gatewayMessage('{"error":"boom3"}'), 'boom3');
  assert.equal(gatewayMessage('plain text'), 'plain text');
  assert.equal(gatewayMessage(''), '');
  assert.equal(gatewayMessage('not json but ' + 'x'.repeat(400)).length, 300, 'must not return an unbounded body');
  assert.ok(!gatewayMessage('{"error":{"message":"a\\nb"}}').includes('\n'), 'newlines are collapsed so one error stays one line');
});

// ---------------------------------------------------------------- over real HTTP

const servers = [];
after(async () => {
  // `fetch()` pools keep-alive sockets, so a bare close() waits for connections that
  // never end by themselves. The old workaround was `--test-force-exit`, which crashes
  // libuv on Windows (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`,
  // src/win/async.c) when it races a handle that is mid-close. Destroy the sockets
  // first and this file exits on its own.
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise((r) => s.close(() => r(undefined)));
  }
});

/**
 * A fake OpenAI-compatible endpoint that records what it received.
 * @param {{status?:number, body?:any, reply?:any, delayMs?:number}} opts
 */
async function fakeGateway(opts = {}) {
  /** @type {{url:string, method:string, headers:any, body:any}[]} */
  const seen = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      let parsed = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        parsed = raw;
      }
      seen.push({ url: req.url, method: req.method, headers: req.headers, body: parsed });
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (req.url?.endsWith('/models') && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(opts.reply ?? { data: [{ id: 'm-b' }, { id: 'm-a' }] }));
        return;
      }
      res.writeHead(opts.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(opts.body ?? opts.reply ?? { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] }));
    });
  });
  await listenOnFetchablePort(server, '127.0.0.1');
  servers.push(server);
  const port = /** @type {any} */ (server.address()).port;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, seen };
}

test('chat() posts a well-formed request and normalises the reply', async () => {
  const gw = await fakeGateway({
    reply: {
      choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'list_nodes', arguments: '{}' } }] } }],
      usage: { total_tokens: 7 },
    },
  });
  const r = await chat({
    config: { baseUrl: gw.baseUrl, model: 'm-a', apiKey: 'sekret' },
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'list_nodes', description: 'd', parameters: { type: 'object', properties: {} } } }],
  });

  const req = gw.seen.at(-1);
  assert.equal(req.url, '/v1/chat/completions', 'the /v1 prefix must survive url joining');
  assert.equal(req.method, 'POST');
  assert.equal(req.body.model, 'm-a');
  assert.equal(req.body.stream, false);
  assert.equal(req.body.tool_choice, 'auto');
  assert.equal(req.body.tools[0].function.name, 'list_nodes');
  assert.deepEqual(req.body.messages, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]);
  assert.equal(req.headers.authorization, 'Bearer sekret');
  assert.equal(r.toolCalls[0].name, 'list_nodes');
});

test('chat() omits the auth header when no key is configured', async () => {
  // Many local gateways reject a bare `Authorization: Bearer ` outright, so an absent
  // key must mean an absent header.
  const gw = await fakeGateway();
  await chat({ config: { baseUrl: gw.baseUrl, model: 'm-a', apiKey: '' }, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(gw.seen.at(-1).headers.authorization, undefined);
});

test('chat() with no tools omits the tools/tool_choice fields entirely', async () => {
  const gw = await fakeGateway();
  await chat({ config: { baseUrl: gw.baseUrl, model: 'm-a' }, messages: [{ role: 'user', content: 'hi' }] });
  const b = gw.seen.at(-1).body;
  assert.equal(b.tools, undefined);
  assert.equal(b.tool_choice, undefined);
});

test('chat() turns a real gateway 401 into an actionable error', async () => {
  const gw = await fakeGateway({
    status: 401,
    body: { error: { message: 'Model/provider not recognized: anthropic:typo-model', type: 'authentication_error' } },
  });
  await assert.rejects(
    () => chat({ config: { baseUrl: gw.baseUrl, model: 'typo-model' }, messages: [{ role: 'user', content: 'x' }] }),
    /does not recognise model 'typo-model'/,
  );
});

test('chat() refuses to guess when it is not configured', async () => {
  await assert.rejects(
    () => chat({ config: { baseUrl: '', model: '' }, messages: [{ role: 'user', content: 'x' }] }),
    /LLM not configured.*baseUrl.*model/s,
  );
});

test('listModels returns sorted ids and surfaces a bad endpoint usefully', async () => {
  const gw = await fakeGateway();
  const models = await listModels({ baseUrl: gw.baseUrl, apiKey: '' });
  assert.deepEqual(models, ['m-a', 'm-b']);

  // An endpoint that answers /models with something else is NOT OpenAI-compatible.
  // Reporting an empty list there would send the user hunting for the wrong problem.
  const notOpenai = await fakeGateway({ reply: { ok: true, result: 'whatever' } });
  await assert.rejects(() => listModels({ baseUrl: notOpenai.baseUrl, apiKey: '' }), /did not return a model list.*OpenAI-compatible/s);

  // Nothing listening: the transport's own diagnosis must reach the caller intact.
  await assert.rejects(() => listModels({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: '' }), /ECONNREFUSED|cannot reach/);
});
