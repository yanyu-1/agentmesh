// Protocol-layer tests. No network, no child processes — pure wire-format logic.
// Run: node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createNdJsonDecoder, encodeMessage, classifyUpdate, summarizeUpdate, permissionOutcome, pickPermissionOption, PermissionPolicy, stateFromStopReason, textBlock } from '../src/protocol/acp.js';
import { createSseParser, parseStreamPayload, buildSendMessageParams, textMessage, normalizeSendResult, extractText, cardRpcTarget, summarizeCard, agentCardUrls, isPrivateHost, prefersLegacyMethods, isMethodNotFound, withConversationHistory, ROLES } from '../src/protocol/a2a.js';
import { fromA2A, fromAcpStopReason, TaskState, isTerminal } from '../src/protocol/states.js';
import { JsonRpcPeer, JsonRpcError, ErrorCodes } from '../src/protocol/jsonrpc.js';

// ---------------------------------------------------------------------------
// ACP framing
// ---------------------------------------------------------------------------

test('ACP nd-JSON decoder splits on newlines and tolerates CRLF', () => {
  const seen = [];
  const dec = createNdJsonDecoder((m) => seen.push(m));
  dec.push('{"jsonrpc":"2.0","id":1,"result":{"a":1}}\n{"jsonrpc":"2.0","method":"x"}\r\n');
  assert.equal(seen.length, 2);
  assert.equal(seen[0].id, 1);
  assert.equal(seen[1].method, 'x');
});

test('ACP nd-JSON decoder buffers partial messages and reports bad JSON', () => {
  const seen = [];
  const errors = [];
  const dec = createNdJsonDecoder((m) => seen.push(m), (e) => errors.push(e.message));
  dec.push('{"jsonrpc":"2.0","id":');
  assert.equal(seen.length, 0);
  dec.push('7,"result":null}\n');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].id, 7);
  dec.push('not json\n');
  assert.equal(errors.length, 1);
});

test('ACP encoder emits exactly one line and never an embedded newline', () => {
  const line = encodeMessage({ jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { prompt: [textBlock('a\nb')] } });
  assert.equal(line.endsWith('\n'), true);
  assert.equal(line.trimEnd().includes('\n'), false, 'embedded newline must be escaped by JSON.stringify');
  assert.equal(JSON.parse(line).params.prompt[0].text, 'a\nb');
});

// --- the exact shapes the ACP v1 schema defines -----------------------------

test('ACP session/update classification matches the schema discriminators', () => {
  const chunk = classifyUpdate({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'hello' } });
  assert.equal(chunk.kind, 'agent_message_chunk');
  assert.equal(chunk.text, 'hello');
  assert.equal(chunk.messageId, 'm1');

  const thought = classifyUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } });
  assert.equal(thought.kind, 'agent_thought_chunk');
  assert.equal(thought.text, 'hmm');

  const tool = classifyUpdate({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Read file', kind: 'read', status: 'pending' });
  assert.equal(tool.toolCallId, 'c1');
  assert.equal(tool.title, 'Read file');
  assert.equal(tool.status, 'pending');

  const toolUpdate = classifyUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'c1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'file body' } }],
  });
  assert.equal(toolUpdate.status, 'completed');
  assert.equal(toolUpdate.text, 'file body');

  const usage = classifyUpdate({ sessionUpdate: 'usage_update', used: 100, size: 200, cost: { amount: 0.01, currency: 'USD' } });
  assert.match(usage.text, /used=100/);
  assert.match(usage.text, /USD/);
});

test('ACP summarizeUpdate renders one line per update kind', () => {
  assert.equal(summarizeUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'x' } }), null);
  assert.match(String(summarizeUpdate({ sessionUpdate: 'tool_call', toolCallId: 'c', title: 'T', status: 'pending' })), /🔧 T/);
  assert.match(String(summarizeUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'z' } })), /💭 z/);
});

test('ACP permission policy picks the right option kind', () => {
  const options = [
    { optionId: 'a1', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'a2', name: 'Allow always', kind: 'allow_always' },
    { optionId: 'r1', name: 'Reject', kind: 'reject_once' },
  ];
  assert.equal(pickPermissionOption(options, PermissionPolicy.DENY).optionId, 'r1');
  assert.equal(pickPermissionOption(options, PermissionPolicy.ALLOW_ONCE).optionId, 'a1');
  assert.equal(pickPermissionOption(options, PermissionPolicy.ALLOW_ALWAYS).optionId, 'a2');
  assert.equal(pickPermissionOption(options, PermissionPolicy.ASK).optionId, null, 'ask must park the request');
  // The response MUST nest: {outcome: <RequestPermissionOutcome>}. Agents duck-type
  // `response.outcome.outcome == "selected"`, so a flat object silently turns every
  // human approval into a denial (this bug survived a real Hermes run once).
  assert.deepEqual(permissionOutcome('a1'), { outcome: { outcome: 'selected', optionId: 'a1' } });
  assert.deepEqual(permissionOutcome(null), { outcome: { outcome: 'cancelled' } });
  // Pin the discriminator path agents actually read.
  assert.equal(permissionOutcome('a1').outcome.outcome, 'selected');
  assert.equal(permissionOutcome('a1').outcome.optionId, 'a1');
  assert.equal(permissionOutcome(null).outcome.outcome, 'cancelled');
});

test('ACP StopReason maps into the unified state model', () => {
  assert.equal(stateFromStopReason('end_turn'), TaskState.COMPLETED);
  assert.equal(stateFromStopReason('cancelled'), TaskState.CANCELED);
  assert.equal(stateFromStopReason('refusal'), TaskState.FAILED);
  assert.equal(stateFromStopReason('max_tokens'), TaskState.FAILED);
  assert.equal(fromAcpStopReason('weird'), TaskState.COMPLETED);
});

// ---------------------------------------------------------------------------
// A2A wire format — pinned to what Hermes actually emits
// ---------------------------------------------------------------------------

test('A2A text Part uses member-presence discrimination (no `kind` field)', () => {
  const params = buildSendMessageParams({ text: 'hi' });
  const part = params.message.parts[0];
  assert.equal(part.text, 'hi');
  assert.equal(part.mediaType, 'text/plain');
  assert.equal('kind' in part, false, 'A2A v1.0 Parts must NOT carry a kind field');
  assert.equal(params.message.role, ROLES.USER);
  assert.ok(params.message.messageId);
});

test('A2A contextId lives inside the Message, not at params top level', () => {
  const params = buildSendMessageParams({ text: 'hi', contextId: 'ctx-1' });
  assert.equal(params.message.contextId, 'ctx-1');
  assert.equal('contextId' in params, false);
});

test('A2A extractText handles v1 text, file, raw and data parts', () => {
  assert.equal(extractText({ parts: [{ text: 'a' }, { text: 'b' }] }), 'a\nb');
  assert.match(extractText({ parts: [{ url: 'http://x/y.pdf', filename: 'y.pdf', mediaType: 'application/pdf' }] }), /\[file: y\.pdf\] http:\/\/x\/y\.pdf/);
  assert.match(extractText({ parts: [{ raw: 'AAAA', filename: 'z.bin' }] }), /4 bytes base64/);
  assert.match(extractText({ parts: [{ data: { k: 1 }, mediaType: 'application/json' }] }), /"k":1/);
});

test('A2A SendMessageResponse unwraps the task|message oneof', () => {
  const taskResult = {
    task: {
      id: 'task-1',
      contextId: 'ctx-1',
      status: { state: 'TASK_STATE_COMPLETED', message: { role: 'ROLE_AGENT', parts: [{ text: 'status text' }] } },
      artifacts: [{ artifactId: 'a', parts: [{ text: 'artifact text' }] }],
    },
  };
  const norm = normalizeSendResult(taskResult);
  assert.equal(norm.shape, 'task');
  assert.equal(norm.state, TaskState.COMPLETED);
  assert.equal(norm.text, 'artifact text', 'artifacts win over the status message');
  assert.equal(norm.contextId, 'ctx-1');
  assert.equal(norm.taskId, 'task-1');

  const msgResult = { message: { role: 'ROLE_AGENT', parts: [{ text: 'direct' }], contextId: 'ctx-2' } };
  const norm2 = normalizeSendResult(msgResult);
  assert.equal(norm2.shape, 'message');
  assert.equal(norm2.text, 'direct');
  assert.equal(norm2.state, TaskState.COMPLETED);
});

test('A2A Agent Card RPC target prefers supportedInterfaces, falls back to card.url', () => {
  const card = { url: 'http://legacy', supportedInterfaces: [{ url: 'http://v1/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: 't1' }] };
  assert.deepEqual(cardRpcTarget(card, 'http://base'), { url: 'http://v1/rpc', tenant: 't1', protocolVersion: '1.0' });
  assert.equal(cardRpcTarget({ url: 'http://only-legacy' }, 'http://base').url, 'http://only-legacy');
  assert.equal(cardRpcTarget(null, 'http://base/').url, 'http://base');
});

test('A2A Agent Card discovery tries v1.0 path before the legacy alias', () => {
  assert.deepEqual(agentCardUrls('http://h:9900/'), ['http://h:9900/.well-known/agent-card.json', 'http://h:9900/.well-known/agent.json']);
});

test('A2A card summary reports the Hermes-style card correctly', () => {
  // Shape taken from Hermes plugins/platforms/a2a/protocol.py build_agent_card()
  const card = {
    name: 'hermes-b',
    description: 'Hermes agent on box B',
    url: 'http://10.0.0.5:9900',
    version: '1.0.0',
    provider: { organization: 'Hermes Agent', url: 'http://10.0.0.5:9900' },
    supportedInterfaces: [{ url: 'http://10.0.0.5:9900', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false, extendedAgentCard: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{ id: 'toolset.web', name: 'web', description: "Hermes 'web' capabilities", tags: ['web'] }],
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    security: [{ bearer: [] }],
  };
  const s = summarizeCard(card);
  assert.equal(s.name, 'hermes-b');
  assert.equal(s.authRequired, true);
  assert.equal(s.streaming, false);
  assert.equal(s.skills.length, 1);
  assert.match(s.interface, /JSONRPC v1\.0/);
});

// ---------------------------------------------------------------------------
// SSE — shared by A2A streaming and opencode /event
// ---------------------------------------------------------------------------

test('SSE parser handles multi-line data, comments, event names and CRLF', () => {
  const p = createSseParser();
  const frames = p.push(': ping\n\nevent: message\ndata: {"a":\ndata: 1}\n\nid: 5\ndata: [DONE]\n\n');
  assert.equal(frames.length, 2);
  assert.equal(frames[0].event, 'message');
  assert.equal(frames[0].data, '{"a":\n1}');
  assert.equal(frames[1].id, '5');
  assert.equal(frames[1].data, '[DONE]');
});

test('SSE parser survives a frame split across chunk boundaries', () => {
  const p = createSseParser();
  const a = p.push('data: {"jsonrpc":"2.0","id":1,"resu');
  const b = p.push('lt":{"statusUpdate":{"taskId":"t","contextId":"c","status":{"state":"TASK_STATE_WORKING"}}}}\n\n');
  assert.equal(a.length, 0);
  assert.equal(b.length, 1);
  const ev = parseStreamPayload(b[0].data);
  assert.equal(ev.type, 'status');
  assert.equal(ev.state, TaskState.WORKING);
  assert.equal(ev.taskId, 't');
});

test('A2A stream payloads normalize status/artifact/task/DONE', () => {
  const status = parseStreamPayload(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { statusUpdate: { taskId: 't1', contextId: 'c1', status: { state: 'TASK_STATE_WORKING', message: { parts: [{ text: 'working on it' }] } } } } }));
  assert.equal(status.type, 'status');
  assert.equal(status.text, 'working on it');

  const artifact = parseStreamPayload(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { artifactUpdate: { taskId: 't1', contextId: 'c1', artifact: { parts: [{ text: 'final' }] } } } }));
  assert.equal(artifact.type, 'artifact');
  assert.equal(artifact.text, 'final');

  const task = parseStreamPayload(JSON.stringify({ result: { task: { id: 't1', contextId: 'c1', status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [{ parts: [{ text: 'done' }] }] } } }));
  assert.equal(task.type, 'task');
  assert.equal(task.state, TaskState.COMPLETED);
  assert.equal(task.text, 'done');

  assert.equal(parseStreamPayload('[DONE]').type, 'done');
  assert.equal(parseStreamPayload('{"error":{"message":"boom"}}').state, 'failed');
});

// ---------------------------------------------------------------------------
// unified states
// ---------------------------------------------------------------------------

test('A2A wire states map to the unified model, in every spelling', () => {
  assert.equal(fromA2A('TASK_STATE_SUBMITTED'), TaskState.SUBMITTED);
  assert.equal(fromA2A('working'), TaskState.WORKING);
  assert.equal(fromA2A('TASK_STATE_INPUT_REQUIRED'), TaskState.INPUT_REQUIRED);
  assert.equal(fromA2A('input-required'), TaskState.INPUT_REQUIRED);
  assert.equal(fromA2A('TASK_STATE_AUTH_REQUIRED'), TaskState.AUTH_REQUIRED);
  assert.equal(fromA2A('TASK_STATE_CANCELED'), TaskState.CANCELED);
  assert.equal(fromA2A('cancelled'), TaskState.CANCELED);
  assert.equal(fromA2A('TASK_STATE_REJECTED'), TaskState.REJECTED);
  assert.equal(fromA2A('TASK_STATE_COMPLETED'), TaskState.COMPLETED);
  assert.equal(fromA2A('TASK_STATE_FAILED'), TaskState.FAILED);
  assert.equal(fromA2A('TASK_STATE_UNSPECIFIED'), TaskState.WORKING);
});

test('terminal states are exactly the four that stop a task', () => {
  assert.equal(isTerminal(TaskState.COMPLETED), true);
  assert.equal(isTerminal(TaskState.FAILED), true);
  assert.equal(isTerminal(TaskState.CANCELED), true);
  assert.equal(isTerminal(TaskState.REJECTED), true);
  assert.equal(isTerminal(TaskState.WORKING), false);
  assert.equal(isTerminal(TaskState.INPUT_REQUIRED), false);
});

// ---------------------------------------------------------------------------
// JSON-RPC peer — bidirectional, which ACP requires
// ---------------------------------------------------------------------------

test('JsonRpcPeer correlates responses and dispatches inbound requests', async () => {
  /** @type {any[]} */
  const written = [];
  const peer = new JsonRpcPeer({ send: (m) => written.push(m), name: 'test' });

  peer.onRequest('client/ask', (params) => ({ echo: params.value * 2 }));
  peer.onNotification('note', () => {});

  const p = peer.request('session/prompt', { sessionId: 's1' });
  assert.equal(written[0].method, 'session/prompt');
  assert.equal(written[0].jsonrpc, '2.0');

  peer.accept({ jsonrpc: '2.0', id: written[0].id, result: { stopReason: 'end_turn' } });
  assert.deepEqual(await p, { stopReason: 'end_turn' });

  // inbound request -> we answer on the wire
  peer.accept({ jsonrpc: '2.0', id: 99, method: 'client/ask', params: { value: 21 } });
  await new Promise((r) => setImmediate(r));
  const reply = written.find((m) => m.id === 99);
  assert.deepEqual(reply.result, { echo: 42 });
});

test('JsonRpcPeer answers unknown methods with -32601 instead of dying', async () => {
  const written = [];
  const peer = new JsonRpcPeer({ send: (m) => written.push(m) });
  peer.accept({ jsonrpc: '2.0', id: 5, method: 'nope/nope', params: {} });
  await new Promise((r) => setImmediate(r));
  assert.equal(written[0].error.code, ErrorCodes.METHOD_NOT_FOUND);
});

test('JsonRpcPeer surfaces protocol errors as JsonRpcError', async () => {
  const written = [];
  const peer = new JsonRpcPeer({ send: (m) => written.push(m) });
  const p = peer.request('initialize', {});
  peer.accept({ jsonrpc: '2.0', id: written[0].id, error: { code: -32000, message: 'auth required', data: { methodId: 'x' } } });
  await assert.rejects(p, (err) => {
    assert.ok(err instanceof JsonRpcError);
    assert.equal(err.code, -32000);
    assert.equal(err.data.methodId, 'x');
    return true;
  });
});

test('JsonRpcPeer close rejects in-flight requests', async () => {
  const peer = new JsonRpcPeer({ send: () => {} });
  const p = peer.request('session/prompt', {});
  peer.close('agent died');
  await assert.rejects(p, /agent died/);
  assert.equal(peer.closed, true);
});

test('a parked (async) inbound handler can be answered later — the approval path', async () => {
  const written = [];
  const peer = new JsonRpcPeer({ send: (m) => written.push(m) });
  let release;
  peer.onRequest('session/request_permission', () => new Promise((res) => { release = res; }));

  peer.accept({ jsonrpc: '2.0', id: 7, method: 'session/request_permission', params: { sessionId: 's', toolCall: {}, options: [] } });
  await new Promise((r) => setImmediate(r));
  assert.equal(written.length, 0, 'nothing must be written while the approval is parked');

  release({ outcome: 'selected', optionId: 'a1' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(written[0], { jsonrpc: '2.0', id: 7, result: { outcome: 'selected', optionId: 'a1' } });
});

// ---------------------------------------------------------------------------
// A2A real-world interop: private addresses and protocol-revision naming
//
// These three helpers exist because of what a live third-party A2A server actually did:
// it advertised its RPC at a private address (172.24.225.207) and answered the v1.0
// method name with -32601, implementing only v0.3 `message/send`.
// ---------------------------------------------------------------------------

test('isPrivateHost classifies the ranges that matter in practice', () => {
  // Private / unroutable — the case that broke a real deployment.
  for (const h of [
    '172.24.225.207', // the real one: RFC1918 172.16/12
    '10.0.0.5',
    '10.0.0.5',
    '127.0.0.1',
    '169.254.1.1', // link-local
    '100.64.0.1', // CGNAT
    '0.0.0.0',
    '224.0.0.1', // multicast
    'localhost',
    'nas.local',
    'box.internal',
    '::1',
    'fd00::1', // ULA
    'fe80::1', // link-local
    '::ffff:192.168.1.1', // IPv4-mapped
  ]) {
    assert.equal(isPrivateHost(h), true, `${h} must be treated as private`);
  }
  // Routable — must NOT be overridden, or we would break a correctly configured peer.
  for (const h of ['123.56.124.199', '8.8.8.8', '172.32.0.1', '172.15.0.1', '192.169.0.1', 'agent.example.com', '2001:db8::1']) {
    assert.equal(isPrivateHost(h), false, `${h} must be treated as routable`);
  }
  // 172.16–172.31 is the private block; its immediate neighbours are not.
  assert.equal(isPrivateHost('172.16.0.1'), true);
  assert.equal(isPrivateHost('172.31.255.255'), true);
});

test('prefersLegacyMethods follows the card shape', () => {
  const v1 = { supportedInterfaces: [{ protocolBinding: 'JSONRPC', url: 'http://x/rpc', protocolVersion: '1.0' }] };
  const v03 = { supportedInterfaces: [{ protocolBinding: 'JSONRPC', url: 'http://x/rpc', protocolVersion: '0.3' }] };
  const legacy = { name: 'hermes-b', url: 'http://x/' }; // no supportedInterfaces at all

  assert.equal(prefersLegacyMethods(v1), false, 'a v1.0 card gets v1.0 method names');
  assert.equal(prefersLegacyMethods(v03), true, 'a 0.x binding gets legacy method names');
  assert.equal(prefersLegacyMethods(legacy), true, 'a card with no interfaces is legacy-shaped');
  // An explicit target revision wins over the card.
  assert.equal(prefersLegacyMethods(legacy, { protocolVersion: '1.0' }), false);
  assert.equal(prefersLegacyMethods(v1, { protocolVersion: '0.3' }), true);
  assert.equal(prefersLegacyMethods(undefined), true, 'no card at all defaults to the tolerant choice');
});

test('isMethodNotFound recognises -32601 and the textual form', () => {
  assert.equal(isMethodNotFound({ code: -32601, message: 'x' }), true);
  assert.equal(isMethodNotFound({ code: '-32601' }), true, 'a string code counts too');
  assert.equal(isMethodNotFound({ message: 'Method not found: SendMessage' }), true, 'the real server said exactly this');
  assert.equal(isMethodNotFound({ message: 'method  not  found' }), true);
  assert.equal(isMethodNotFound({ code: -32602, message: 'Invalid params' }), false);
  assert.equal(isMethodNotFound({ code: -32603, message: 'Internal error' }), false);
  assert.equal(isMethodNotFound(null), false);
  assert.equal(isMethodNotFound(undefined), false);
  assert.equal(isMethodNotFound('Method not found'), false, 'a bare string is not a JSON-RPC error object');
});

test('withConversationHistory folds prior turns in, and labels the new message last', () => {
  const history = [
    { role: 'user', text: '你是谁？' },
    { role: 'assistant', text: '我是 hermes-b。' },
  ];
  const out = withConversationHistory('那你能写文件吗？', history);

  assert.match(out, /<earlier conversation>/);
  assert.match(out, /user: 你是谁？/);
  assert.match(out, /assistant: 我是 hermes-b。/);
  // The ordering matters: the transcript must come first and the new message LAST, or
  // the peer answers the previous turn instead of the current one.
  assert.ok(out.indexOf('你是谁？') < out.indexOf('那你能写文件吗？'));
  assert.ok(out.trimEnd().endsWith('user: 那你能写文件吗？'));
  assert.equal(out.split('那你能写文件吗？').length - 1, 1, 'the current message must appear exactly once');
});

test('withConversationHistory is a no-op without usable history', () => {
  assert.equal(withConversationHistory('hi'), 'hi');
  assert.equal(withConversationHistory('hi', null), 'hi');
  assert.equal(withConversationHistory('hi', []), 'hi');
  assert.equal(withConversationHistory('hi', [{ role: 'user', text: '   ' }]), 'hi', 'blank turns must not produce an empty frame');
  // An unknown role degrades to `user` rather than being dropped.
  assert.match(withConversationHistory('hi', [{ role: 'system', text: 'ctx' }]), /user: ctx/);
});
