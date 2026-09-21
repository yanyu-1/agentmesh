#!/usr/bin/env node
/**
 * A minimal ACP v1 agent over nd-JSON stdio, for tests that need a REAL child process.
 *
 * The other adapter tests inject hand-written fake adapters, which cannot express the
 * bug class this file exists to guard: lifecycle mistakes around the agent PROCESS
 * (stale exit listeners, a superseded connection tearing down its replacement). Only a
 * real spawn reproduces those.
 *
 * Speaks just enough of ACP v1: initialize, session/new, session/prompt (streaming one
 * agent_message_chunk) and session/cancel.
 */
let buf = '';

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function handle(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      return send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: 'fake-acp', version: '1.0.0' },
          agentCapabilities: { loadSession: false },
          authMethods: [],
        },
      });
    case 'session/new':
      return send({ jsonrpc: '2.0', id, result: { sessionId: 'fake-session-1' } });
    case 'session/prompt': {
      const sessionId = params?.sessionId;
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fake answer' } },
        },
      });
      return send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
    }
    case 'session/cancel':
      return undefined; // notification, no reply
    default:
      if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
      return undefined;
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl = buf.indexOf('\n');
  while (nl >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) {
      try {
        handle(JSON.parse(line));
      } catch {
        /* ignore malformed input */
      }
    }
    nl = buf.indexOf('\n');
  }
});
process.stdin.on('end', () => process.exit(0));
