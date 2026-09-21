#!/usr/bin/env node
/**
 * A real A2A v1.0 peer, for testing AgentMesh against something that genuinely speaks
 * the protocol over real sockets — Agent Card discovery, JSON-RPC `SendMessage`, and
 * `SendStreamingMessage` as SSE.
 *
 * This is NOT a stub of our own client: it is a standalone HTTP server that enforces
 * bearer auth, serves a v1.0 card on a non-root RPC path, and returns both the
 * `task`-shaped (blocking) and streamed-artifact responses. Use it as the remote peer
 * when the real one is unreachable, and to exercise the CLI's card rendering.
 *
 * As a library:
 *   const { startA2AServer } = await import('./fake-a2a-server.mjs');
 *   const srv = await startA2AServer({ token: 'CHANGE_ME', streaming: true, name: 'hermes-b' });
 *   srv.url      // http://127.0.0.1:<random>
 *   srv.requests // every request it received, with headers and parsed body
 *   await srv.close();
 *
 * Standalone:
 *   node tools/fake-a2a-server.mjs [--port 9900] [--token CHANGE_ME] [--name hermes-b]
 *                                  [--no-streaming]
 *
 * Prints `listening <url>` on the first line so a script can pick the port up.
 */

import { createServer } from 'node:http';

/**
 * @param {string} s
 * @returns {any}
 */
function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/**
 * @param {{token?:string, streaming?:boolean, name?:string}} [opts]
 */
export async function startA2AServer({ token = 'CHANGE_ME', streaming = true, name = 'hermes-b' } = {}) {
  /** @type {any[]} */
  const requests = [];

  const card = {
    name,
    description: 'AgentMesh test A2A peer (real HTTP, real JSON-RPC, real SSE)',
    version: '1.0.0-test',
    provider: { organization: 'AgentMesh' },
    capabilities: { streaming, pushNotifications: false },
    // A2A v1.0 uses supportedInterfaces; the JSONRPC binding carries the RPC URL.
    // Serving the RPC on a NON-root path also proves the client honours the card's
    // advertised URL instead of just appending to the base URL it was given.
    supportedInterfaces: [{ protocolBinding: 'JSONRPC', protocolVersion: '1.0', url: '' }],
    skills: [{ id: 'echo', name: 'Echo', description: 'returns what you send', tags: ['test'] }],
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    security: [{ bearer: [] }],
  };

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const record = {
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization ?? null,
        a2aVersion: req.headers['a2a-version'] ?? null,
        body: raw ? safeJson(raw) : null,
      };
      requests.push(record);

      // Real auth: the card is protected too, so a missing/wrong token is a 401.
      if (record.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized', got: record.authorization }));
        return;
      }

      if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(card));
        return;
      }

      if (req.method === 'POST' && req.url === '/rpc') {
        const method = record.body?.method;
        const rpcId = record.body?.id ?? 1;
        const text = record.body?.params?.message?.parts?.[0]?.text ?? '';

        if (method === 'SendStreamingMessage' || method === 'message/stream') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          const frame = (/** @type {any} */ result) => res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpcId, result })}\n\n`);
          frame({ statusUpdate: { taskId: 'task_srv_1', contextId: 'ctx_srv_1', status: { state: 'TASK_STATE_WORKING' } } });
          // Two artifact fragments with `append` — the second MUST concatenate, not
          // replace. Getting this wrong silently drops half the answer.
          frame({ artifactUpdate: { taskId: 'task_srv_1', contextId: 'ctx_srv_1', append: false, artifact: { artifactId: 'a1', parts: [{ text: `echo[stream]:${text}` }] } } });
          frame({ artifactUpdate: { taskId: 'task_srv_1', contextId: 'ctx_srv_1', append: true, artifact: { artifactId: 'a1', parts: [{ text: ' +tail' }] } } });
          frame({ statusUpdate: { taskId: 'task_srv_1', contextId: 'ctx_srv_1', status: { state: 'TASK_STATE_COMPLETED' } } });
          res.end();
          return;
        }

        if (method === 'SendMessage' || method === 'message/send') {
          // The `task` member of the v1.0 oneof, with artifacts.
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: rpcId,
              result: {
                task: {
                  id: 'task_srv_2',
                  contextId: 'ctx_srv_2',
                  status: { state: 'TASK_STATE_COMPLETED' },
                  artifacts: [{ artifactId: 'a2', parts: [{ text: `echo[blocking]:${text}` }] }],
                },
              },
            }),
          );
          return;
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpcId, error: { code: -32601, message: `unknown method ${method}` } }));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `no route for ${req.method} ${req.url}` }));
    });
  });

  const port = Number(process.env.A2A_TEST_PORT || 0);
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actual = /** @type {any} */ (server.address()).port;
  card.supportedInterfaces[0].url = `http://127.0.0.1:${actual}/rpc`;

  return {
    url: `http://127.0.0.1:${actual}`,
    card,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  };
}

// ---------------------------------------------------------------------------
// standalone entry
// ---------------------------------------------------------------------------

const invokedDirectly = (() => {
  try {
    return import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href || process.argv[1]?.endsWith('fake-a2a-server.mjs');
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const opt = (/** @type {string} */ k, /** @type {string} */ d) => {
    const i = argv.findIndex((a) => a === `--${k}` || a.startsWith(`--${k}=`));
    if (i < 0) return d;
    const eq = argv[i].indexOf('=');
    return eq >= 0 ? argv[i].slice(eq + 1) : (argv[i + 1] ?? d);
  };
  process.env.A2A_TEST_PORT = opt('port', '0');
  const srv = await startA2AServer({
    token: opt('token', 'CHANGE_ME'),
    name: opt('name', 'hermes-b'),
    streaming: !argv.includes('--no-streaming'),
  });
  process.stdout.write(`listening ${srv.url}\n`);
  process.stdout.write(`  card   ${srv.url}/.well-known/agent-card.json\n`);
  process.stdout.write(`  rpc    ${srv.url}/rpc\n`);
  process.stdout.write(`  token  ${opt('token', 'CHANGE_ME')}\n`);
}
