#!/usr/bin/env node
/**
 * A2A acceptance — against an embedded REAL A2A v1.0 server, or against any live
 * endpoint you point it at.
 *
 * Why both modes:
 *
 *   - `--url <live endpoint>` answers "can we actually talk to that server, and if
 *     not, why not?" — with the firewall/refused distinction spelled out instead of
 *     undici's bare `fetch failed`.
 *   - no `--url` starts a real `node:http` A2A server in-process (Agent Card +
 *     JSON-RPC `SendMessage` + `SendStreamingMessage` over SSE) and drives the whole
 *     Fleet path against it. That proves OUR client is correct, so when a remote port
 *     finally opens there is only one variable left.
 *
 * It is deliberately not a mock: real sockets, real HTTP, real SSE framing, and the
 * server verifies the auth header it received rather than assuming it.
 *
 * Usage:
 *   node tools/verify-a2a.mjs                                  # embedded server, both paths
 *   node tools/verify-a2a.mjs --url http://host:9900 --token T  # live endpoint
 *   node tools/verify-a2a.mjs --log logs/a2a.txt
 *
 * Exit code: 0 when every check passed, 1 otherwise.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Never touch the operator's real state directory.
process.env.AGENTMESH_HOME = mkdtempSync(join(tmpdir(), 'agentmesh-a2a-'));

import { startA2AServer } from './fake-a2a-server.mjs';

const { Fleet } = await import('../src/core/fleet.js');
const { EventType } = await import('../src/protocol/events.js');

/**
 * @param {string} key
 * @param {string} dflt
 */
function flag(key, dflt) {
  const hit = process.argv.slice(2).find((a) => a === `--${key}` || a.startsWith(`--${key}=`));
  if (!hit) return dflt;
  const eq = hit.indexOf('=');
  return eq >= 0 ? hit.slice(eq + 1) : (process.argv[process.argv.indexOf(hit) + 1] ?? dflt);
}

const REMOTE_URL = flag('url', '');
const TOKEN = flag('token', 'CHANGE_ME');
const AGENT_NAME = flag('name', 'hermes-b');
const LOG = flag('log', '');
const TIMEOUT_MS = Number(flag('timeout', '30000'));

// ---------------------------------------------------------------------------
// transcript
// ---------------------------------------------------------------------------

const transcript = [];
const say = (line) => {
  transcript.push(line);
  process.stdout.write(`${line}\n`);
};

let pass = 0;
const failures = [];
function check(ok, label, detail = '') {
  if (ok) {
    pass += 1;
    say(`  ok   ${label}${detail ? `  ${detail}` : ''}`);
  } else {
    failures.push(label);
    say(`  FAIL ${label}${detail ? `  ${detail}` : ''}`);
  }
  return ok;
}
const section = (t) => say(`\n${t}`);

// ---------------------------------------------------------------------------
// 1. reachability, when pointed at a live endpoint
// ---------------------------------------------------------------------------

/**
 * @param {Fleet} fleet
 * @param {string} nodeName
 * @param {string} label   shown in the section heading
 * @param {number} num     section number, so the transcript reads in order
 */
async function runCardChecks(fleet, nodeName, label, num) {
  section(`${num}. Agent Card discovery (${label})`);
  /** @type {any} */
  let probe = null;
  try {
    probe = await fleet.probe(nodeName);
    check(true, 'card fetched', `${probe?.summary?.name ?? '?'} v${probe?.summary?.version ?? '?'}`);
  } catch (err) {
    check(false, 'card fetched', err instanceof Error ? err.message : String(err));
    say('\n  This is the whole answer for a live endpoint: the reason above is the');
    say('  difference between "nothing is listening" (ECONNREFUSED) and "a firewall');
    say('  is dropping packets" (ETIMEDOUT / UND_ERR_CONNECT_TIMEOUT).');
    return null;
  }
  const s = probe.summary;
  check(Boolean(s.name), 'card names an agent', s.name);
  check(Boolean(s.version), 'card carries a version', s.version);
  check(s.streaming === true || s.streaming === false, 'card declares streaming', String(s.streaming));
  // 'legacy' is a legitimate answer: it means a v0.3-shaped card whose RPC lives at
  // `url` rather than a v1.0 `supportedInterfaces` binding. We support both, so
  // demanding a JSONRPC binding here would fail a perfectly workable peer.
  check(Boolean(s.interface), 'card declares an interface (v1.0 binding or legacy url)', s.interface);
  check(Array.isArray(s.skills), 'card lists skills', `${s.skills.length}`);
  check(Boolean(probe.rpcUrl), 'an RPC endpoint was resolved', probe.rpcUrl);
  for (const w of probe.warnings || []) say(`  ! ${w}`);
  return s;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const fleet = new Fleet();
/** @type {Awaited<ReturnType<typeof startA2AServer>>|null} */
let embedded = null;

try {
  if (REMOTE_URL) {
    // ── live endpoint mode ───────────────────────────────────────────────────
    say(`A2A acceptance against a LIVE endpoint`);
    say(`  url   ${REMOTE_URL}`);
    say(`  token ${TOKEN === 'CHANGE_ME' ? 'CHANGE_ME (the placeholder you configured)' : '(set)'}`);

    fleet.registry.add({ name: AGENT_NAME, transport: 'a2a', url: REMOTE_URL, token: TOKEN, approvalPolicy: 'deny' });

    section('0. transport reachability');
    const tcp = await tcpConnect(REMOTE_URL);
    check(tcp.ok, 'TCP connect', tcp.why ?? 'connected');

    const summary = await runCardChecks(fleet, AGENT_NAME, 'live endpoint', 1);
    if (summary) {
      section('2. a real task');
      const res = await fleet.send({ nodeRef: AGENT_NAME, prompt: 'hello from AgentMesh', timeoutMs: TIMEOUT_MS });
      check(res.state === 'completed', 'task completed', `state=${res.state}${res.error ? ` error=${res.error}` : ''}`);
      check(Boolean((res.result || '').trim()), 'a response came back', JSON.stringify(String(res.result || '').slice(0, 160)));
    }
  } else {
    // ── embedded real server: prove our client ───────────────────────────────
    say('A2A acceptance against an EMBEDDED REAL A2A v1.0 SERVER');
    say('  (real node:http, real JSON-RPC, real SSE — proves the client, not the remote)');

    section('1. the embedded server actually requires auth');
    embedded = await startA2AServer({ token: TOKEN, streaming: true, name: AGENT_NAME });
    const anon = await fetch(`${embedded.url}/.well-known/agent-card.json`).catch((e) => ({ status: 0, err: e }));
    check(anon.status === 401, 'an unauthenticated card request is refused', `status=${anon.status}`);
    const wrong = await fetch(`${embedded.url}/.well-known/agent-card.json`, { headers: { authorization: 'Bearer wrong' } }).catch((e) => ({ status: 0, err: e }));
    check(wrong.status === 401, 'a wrong token is refused', `status=${wrong.status}`);

    // Two nodes against the same server: one driven over the streaming path, one not.
    // The card decides which, exactly as it does in production.
    const streamingUrl = embedded.url;
    const blocking = await startA2AServer({ token: TOKEN, streaming: false, name: `${AGENT_NAME}-blocking` });

    fleet.registry.add({ name: 'a2a-stream', transport: 'a2a', url: streamingUrl, token: TOKEN, approvalPolicy: 'deny' });
    fleet.registry.add({ name: 'a2a-block', transport: 'a2a', url: blocking.url, token: TOKEN, approvalPolicy: 'deny' });

    const summary = await runCardChecks(fleet, 'a2a-stream', 'embedded', 2);
    if (summary) {
      check(summary.streaming === true, 'the card drove the streaming path', String(summary.streaming));
      // The embedded server serves a v1.0 card, so the v1.0 binding itself is pinned here.
      check(summary.interface !== 'legacy', 'the embedded card advertises a v1.0 JSONRPC binding', summary.interface);
    }

    section('4. the auth + protocol headers we actually send');
    // Take the LAST card request: the deliberate anon/wrong 401 probes above also hit
    // this URL, and asserting on the first match would grade the probe, not the client.
    const cardReqs = embedded.requests.filter((r) => r.url === '/.well-known/agent-card.json');
    const authReq = cardReqs.at(-1);
    check(cardReqs.length >= 3, 'the auth probes and the client request were all seen', `${cardReqs.length} card request(s)`);
    check(authReq?.authorization === `Bearer ${TOKEN}`, 'Authorization: Bearer <token>', String(authReq?.authorization));
    check(Boolean(authReq?.a2aVersion), 'A2A-Version header is sent', String(authReq?.a2aVersion));

    section('5. SendStreamingMessage over SSE (artifact append semantics)');
    const types = [];
    const streamed = await fleet.send({
      nodeRef: 'a2a-stream',
      prompt: 'ping',
      timeoutMs: TIMEOUT_MS,
      onEvent: (ev) => types.push(ev.type),
    });
    check(streamed.state === 'completed', 'streaming task completed', `state=${streamed.state}${streamed.error ? ` error=${streamed.error}` : ''}`);
    check(
      String(streamed.result || '').includes('echo[stream]:ping +tail'),
      'the appended artifact fragment was concatenated, not replaced',
      JSON.stringify(String(streamed.result || '').slice(0, 120)),
    );
    check(types.includes(EventType.CHUNK), 'chunks were emitted to the caller');
    check(types.includes(EventType.DONE), 'a done event closed the task');

    section('6. SendMessage (blocking) with a task-shaped result');
    const blocked = await fleet.send({ nodeRef: 'a2a-block', prompt: 'ping', timeoutMs: TIMEOUT_MS });
    check(blocked.state === 'completed', 'blocking task completed', `state=${blocked.state}${blocked.error ? ` error=${blocked.error}` : ''}`);
    check(
      String(blocked.result || '').includes('echo[blocking]:ping'),
      'the task artifact text came back as the result',
      JSON.stringify(String(blocked.result || '').slice(0, 120)),
    );

    section('7. the card\'s RPC url is honoured, not assumed');
    const rpcHits = embedded.requests.filter((r) => r.method === 'POST');
    check(rpcHits.length > 0, 'the RPC endpoint from the card was called', `${rpcHits.length} POST(s)`);
    check(rpcHits.every((r) => r.url === '/rpc'), 'every RPC went to the advertised path', [...new Set(rpcHits.map((r) => r.url))].join(', '));
    check(
      rpcHits.some((r) => r.body?.method === 'SendStreamingMessage'),
      'a JSON-RPC SendStreamingMessage was issued',
      [...new Set(rpcHits.map((r) => r.body?.method))].join(', '),
    );

    await blocking.close();
  }

  say('');
  section(`${pass} passed, ${failures.length} failed`);
  if (failures.length) say(`failed: ${failures.join(' | ')}`);
} catch (err) {
  const detail = err instanceof Error ? err.stack : String(err);
  say(`\nverify-a2a crashed: ${detail}`);
  process.stderr.write(`\nverify-a2a crashed: ${detail}\n`);
  failures.push('crash');
} finally {
  await fleet.close().catch(() => {});
  await embedded?.close().catch(() => {});
  if (LOG) {
    try {
      const header = [
        `# AgentMesh A2A acceptance — ${new Date().toISOString()}`,
        `# mode=${REMOTE_URL ? `live ${REMOTE_URL}` : 'embedded real server'} node=${process.version} platform=${process.platform}`,
        '',
      ].join('\n');
      writeFileSync(LOG, `${header}${transcript.join('\n')}\n`, 'utf8');
      process.stdout.write(`\ntranscript written to ${LOG}\n`);
    } catch (err) {
      process.stderr.write(`could not write ${LOG}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  process.exitCode = failures.length ? 1 : 0;
}

/**
 * Raw TCP reachability for the endpoint's host:port.
 * @param {string} rawUrl
 * @returns {Promise<{ok:boolean, why?:string}>}
 */
async function tcpConnect(rawUrl) {
  const { default: net } = await import('node:net');
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, why: `not a valid URL: ${rawUrl}` };
  }
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  return await new Promise((resolve) => {
    const sock = net.connect({ host: u.hostname, port });
    const done = (r) => {
      try {
        sock.destroy();
      } catch {
        /* already gone */
      }
      resolve(r);
    };
    sock.setTimeout(8000);
    sock.on('connect', () => done({ ok: true }));
    sock.on('timeout', () => done({ ok: false, why: `timed out after 8s (packets are being dropped, not refused)` }));
    sock.on('error', (e) => done({ ok: false, why: e.code || e.message }));
  });
}
