#!/usr/bin/env node
/**
 * End-to-end verification of the remote-approval loop, driven entirely over the
 * Web console's HTTP API (so it also verifies the console's API surface).
 *
 *   1. wait for `mesh serve` to be healthy, and record its bootId (a stale daemon
 *      from an earlier run must never be mistaken for the one we just started)
 *   2. dispatch a task that makes the agent propose a file edit
 *   3. wait for the adapter to PARK a session/request_permission  (hard failure if
 *      it never appears -- an agent silently working around a denial must not be
 *      allowed to look like a pass)
 *   4. answer it remotely through POST /api/approvals/:id
 *   5. wait for the task to reach a terminal state
 *   6. assert the file appeared on disk *because of* the approval
 *
 * Usage: node tools/verify-approval.mjs [port] [nodeName]
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const PORT = Number(process.argv[2] || 7331);
const NODE = process.argv[3] || 'hermes-local';
const BASE = `http://127.0.0.1:${PORT}`;
const STAMP = Date.now().toString(36);
const FILE_NAME = `probe-approved-${STAMP}.txt`;
const TARGET_FILE = `D:\\工作\\${FILE_NAME}`;
const EXPECTED = `hello from agentmesh ${STAMP}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, opts = {}, timeoutMs = 30_000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error(`client timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    const res = await fetch(BASE + path, { ...opts, signal: ctl.signal });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text.slice(0, 200) };
    }
    return { status: res.status, ok: res.ok, body, contentType: res.headers.get('content-type') || '' };
  } catch (err) {
    return { status: 0, ok: false, body: null, error: err instanceof Error ? err.message : String(err), contentType: '' };
  } finally {
    clearTimeout(timer);
  }
}

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// --- 1. health, with boot identity ------------------------------------------
let health = null;
for (let i = 0; i < 60; i += 1) {
  const r = await api('/healthz', {}, 3000);
  if (r.ok && r.body?.ok) {
    health = r.body;
    break;
  }
  await sleep(500);
}
record('console /healthz reachable', Boolean(health), health ? `bootId=${health.bootId} pid=${health.pid} startedAt=${health.startedAt}` : 'no response');
if (!health) {
  console.log('\nconsole never came up; aborting. (Check for a stale process on the port.)');
  process.exit(1);
}

// --- 1b. UI + registry -------------------------------------------------------
const ui = await fetch(`${BASE}/`).then((r) => r.text()).catch(() => '');
record('console serves the SPA at /', ui.includes('AgentMesh'), `${ui.length} bytes`);

const nodes = await api('/api/nodes');
const node = (nodes.body || []).find((n) => n.name === NODE);
record(`node '${NODE}' is registered`, Boolean(node), node ? `${node.kind}/${node.transport}` : 'missing');
if (!node) process.exit(1);

// --- 1c. SSE endpoint is reachable (must not hang the harness) ---------------
const sseCtl = new AbortController();
const sseTimer = setTimeout(() => sseCtl.abort(), 4000);
let sseStatus = 0;
let sseType = '';
try {
  const res = await fetch(`${BASE}/api/stream`, { signal: sseCtl.signal });
  sseStatus = res.status;
  sseType = res.headers.get('content-type') || '';
  const reader = res.body?.getReader();
  await reader?.read(); // first frame proves the stream really flows
} catch {
  /* aborted after reading, which is expected for an endless stream */
} finally {
  clearTimeout(sseTimer);
}
record('SSE /api/stream delivers an event-stream', sseStatus === 200 && sseType.includes('text/event-stream'), `status=${sseStatus} type=${sseType}`);

// --- 2. clean slate + dispatch ----------------------------------------------
try {
  rmSync(TARGET_FILE, { force: true });
} catch {
  /* ignore */
}

const prompt = `请在当前工作目录创建文件 ${FILE_NAME}，内容为一行：${EXPECTED}。然后只回复"done"。`;
const dispatch = await api('/api/send', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ node: NODE, prompt, approval: 'ask' }),
});
record('POST /api/send accepted the task', dispatch.status === 202 && Boolean(dispatch.body?.taskId), `taskId=${dispatch.body?.taskId} status=${dispatch.status}`);
const taskId = dispatch.body?.taskId;
if (!taskId) process.exit(1);

// --- 3. the agent must PARK a permission request -----------------------------
/** @type {any} */
let approval = null;
let finishedEarly = null;
for (let i = 0; i < 240; i += 1) {
  await sleep(500);
  const list = await api('/api/approvals?status=pending', {}, 10_000);
  const mine = (list.body || []).find((a) => a.taskId === taskId);
  if (mine) {
    approval = mine;
    break;
  }
  const t = await api(`/api/tasks/${taskId}`, {}, 10_000);
  if (['completed', 'failed', 'canceled'].includes(t.body?.state)) {
    finishedEarly = t.body;
    break;
  }
}

if (approval) {
  record(
    'agent parked a session/request_permission (durable + queryable)',
    true,
    `"${approval.title}" options=[${(approval.options || []).map((o) => `${o.kind}:${o.optionId}`).join(', ')}] status=${approval.status}`,
  );
  record('the parked approval is live on the holding connection', approval.live === true, `live=${approval.live}`);
  record('the edit has NOT happened yet (nothing ran without approval)', !existsSync(TARGET_FILE), existsSync(TARGET_FILE) ? 'file already existed before approval' : 'absent, as expected');
} else {
  record('agent parked a session/request_permission (durable + queryable)', false, finishedEarly ? `task finished (${finishedEarly.state}) without ever asking` : 'timed out waiting for the approval to appear');
}

// --- 4. answer it remotely ---------------------------------------------------
if (approval) {
  const allow = (approval.options || []).find((o) => o.kind === 'allow_once') || (approval.options || []).find((o) => o.kind === 'allow_always');
  const answer = await api(`/api/approvals/${encodeURIComponent(approval.id)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ optionId: allow ? allow.optionId : 'allow_once' }),
  });
  record('POST /api/approvals/:id resumed the agent', answer.ok, `http=${answer.status} ${JSON.stringify(answer.body)}`);
}

// --- 5. terminal state -------------------------------------------------------
/** @type {any} */
let final = null;
for (let i = 0; i < 240; i += 1) {
  await sleep(500);
  const t = await api(`/api/tasks/${taskId}`, {}, 10_000);
  if (['completed', 'failed', 'canceled'].includes(t.body?.state)) {
    final = t.body;
    break;
  }
}
record('task reached a terminal state', Boolean(final), final ? `state=${final.state}` : 'timed out');
if (final) {
  record('task completed successfully', final.state === 'completed', `state=${final.state}${final.error ? ` error=${final.error}` : ''}`);
  record('the task result text is stored, not lost', Boolean((final.result || '').trim()), `result=${JSON.stringify((final.result || '').slice(0, 120))}`);
}

// --- 6. the approved action really happened ---------------------------------
let onDisk = '';
try {
  onDisk = readFileSync(TARGET_FILE, 'utf8').trim();
} catch {
  onDisk = '';
}
record('approved edit took effect on disk', onDisk.includes(EXPECTED), onDisk ? `${FILE_NAME}: ${onDisk.slice(0, 80)}` : 'file not created');

// --- 7. the event log tells the whole story ---------------------------------
const withEvents = await api(`/api/tasks/${taskId}?events=1`, {}, 15_000);
const types = [...new Set((withEvents.body?.events || []).map((e) => e.type))];
const needed = ['task-created', 'task-state', 'approval-requested', 'approval-resolved', 'done'];
record('event log recorded the whole lifecycle', needed.every((n) => types.includes(n)), `missing=[${needed.filter((n) => !types.includes(n)).join(', ')}] seen=[${types.join(', ')}]`);

// `?status=all` matters: the default list is pending-only, so an approved row
// would look like it was never recorded.
const approvalRows = (await api('/api/approvals?status=all', {}, 10_000)).body || [];
const mineRow = approvalRows.find((a) => a.taskId === taskId);
record('the approval is durably recorded with its outcome', mineRow?.status === 'approved', mineRow ? `status=${mineRow.status} optionId=${mineRow.optionId}` : 'no row for this task');

// --- summary -----------------------------------------------------------------
const passed = results.filter((r) => r.pass).length;
console.log(`\n==== ${passed}/${results.length} checks passed (bootId=${health.bootId}) ====`);
const failed = results.filter((r) => !r.pass);
if (failed.length) {
  console.log('failed checks:');
  for (const f of failed) console.log(`  - ${f.name} (${f.detail})`);
}
process.exit(failed.length ? 1 : 0);
