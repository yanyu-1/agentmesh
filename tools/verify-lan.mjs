#!/usr/bin/env node
/**
 * verify-lan — end-to-end acceptance against a REAL node over SSH.
 *
 * Where `tools/verify-ssh-acp.mjs` substitutes a fake ssh binary to prove AgentMesh's
 * own argv plumbing, this one drives a real host: a real sshd, a real login, a real
 * `hermes-acp`, a real model. It answers the two questions a mock cannot:
 *
 *   1. Does an ACP session survive a real network, and does the artifact actually land
 *      on the remote disk — verified by reading the remote filesystem directly rather
 *      than trusting what the agent says it did?
 *   2. Can a human decide a real remote approval, one raised by the remote agent's own
 *      security scanner rather than by a test fixture?
 *
 * Usage:
 *   node tools/verify-lan.mjs [--node nas-hermes] [--dir /srv/work] [--log logs/lan.txt]
 *
 * Env:
 *   MESH_ASKPASS_SECRET  password for password-only hosts (read by tools/ssh-askpass.mjs)
 *   AGENTMESH_HOME       state directory holding nodes.json (default ~/.agentmesh)
 */
import { Fleet } from '../src/core/fleet.js';
import { EventType } from '../src/protocol/events.js';
import { sshExec } from '../src/core/transport/ssh.js';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : dflt;
};

const NODE = flag('node', 'nas-hermes');
const DIR = flag('dir', '/srv/work');
const LOG = flag('log', '');
const FILE = `${DIR}/agentmesh-hello.txt`;
const DEMO = '/tmp/mesh-approval-demo.txt';
const SEND_TIMEOUT_MS = 300_000;

/** Every line is echoed to the console and, when --log is given, to a UTF-8 file. */
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

const fleet = new Fleet();
const node = (() => {
  try {
    return fleet.registry.mustGet(NODE);
  } catch {
    return null;
  }
})();

if (!node) {
  process.stderr.write(`verify-lan: no node named '${NODE}' in the registry (AGENTMESH_HOME=${process.env.AGENTMESH_HOME || '~/.agentmesh'})\n`);
  await fleet.close().catch(() => {});
  process.exit(2);
}

const target = node.ssh;

/** Collect a task's events while it runs. */
async function run(prompt, policy, { onApproval } = {}) {
  /** @type {any[]} */
  const events = [];
  /** @type {any[]} */
  const approvals = [];
  let task;
  task = await fleet.send({
    nodeRef: NODE,
    prompt,
    cwd: node.cwd,
    timeoutMs: SEND_TIMEOUT_MS,
    permissionPolicy: policy,
    onEvent: (ev) => {
      events.push(ev);
      if (ev.type === EventType.APPROVAL_REQUESTED) {
        approvals.push(ev.data);
        if (onApproval) onApproval(ev.data);
      }
    },
  });
  return { task, events, approvals };
}

try {
  section(`node: ${node.name} (${node.kind}/${node.transport})  ssh ${target?.user}@${target?.host}:${target?.port ?? 22}`);
  check(node.transport === 'acp', 'node speaks ACP');
  check(Boolean(target?.host), 'node is remote (has an ssh target)');

  // ── 1. handshake ────────────────────────────────────────────────────────────
  section('1. live ACP handshake over SSH');
  const probe = await fleet.probe(NODE);
  check(probe.connected === true, 'connected', `protocolVersion=${probe.protocolVersion}`);
  check(probe.protocolVersion === 1, 'protocol version is 1');
  check(typeof probe.agentInfo?.name === 'string', 'agent identified itself', `${probe.agentInfo?.name} ${probe.agentInfo?.version ?? ''}`);

  // ── 2. a real task, auto-approved ───────────────────────────────────────────
  section('2. real task dispatched with policy allow-once');
  const first = await run(
    `请在 ${DIR} 目录下创建文本文件 agentmesh-hello.txt，内容用中文写明：本文件由 AgentMesh 远程派发创建、操作者 user、` +
      `管理端 AgentMesh 运行在 10.0.0.9 并通过 SSH 端口 2222 管理本机、被管智能体是 Hermes Agent、` +
      `用 date 取当前时间、结尾写“已成功在此创建文本文件，Hello world”。创建后用 ls -l 和 cat 回读确认。`,
    'allow-once',
  );
  const types = [...new Set(first.events.map((e) => e.type))];
  check(first.task.state === 'completed', 'task completed', `state=${first.task.state} stopReason=${first.task.stopReason ?? '-'}`);
  check(first.task.sessionId !== null && first.task.sessionId !== undefined, 'a session id was established', String(first.task.sessionId));
  check(types.includes(EventType.THOUGHT), 'reasoning/thought updates flowed');
  check(types.includes(EventType.TOOL_CALL), 'tool calls flowed');
  const autoResolved = first.events.filter((e) => e.type === EventType.APPROVAL_RESOLVED).pop();
  check(autoResolved !== undefined, 'the remote agent raised an approval of its own accord');
  check(autoResolved?.data?.auto === true, 'policy allow-once answered it without an operator', `auto=${autoResolved?.data?.auto}`);
  check(autoResolved?.data?.policy === 'allow-once', 'the record names the policy that decided it', String(autoResolved?.data?.policy));
  check(typeof autoResolved?.data?.title === 'string' && autoResolved.data.title.length > 0, 'the request carries the agent\u2019s own justification', String(autoResolved?.data?.title ?? '').slice(0, 90));

  // ── 3. the artifact, read off the remote disk ourselves ─────────────────────
  section('3. artifact verified on the remote filesystem (not from the agent\u2019s summary)');
  const meta = await sshExec({
    target,
    command: `md5sum ${FILE}; wc -c ${FILE}; stat -c '%s %Y' ${FILE}`,
    timeoutMs: 30_000,
  });
  const content = await sshExec({ target, command: `cat ${FILE}`, timeoutMs: 30_000 });
  check(meta.code === 0, 'remote read exited 0', `code=${meta.code}`);
  check(content.code === 0, 'remote cat exited 0', `code=${content.code}`);
  const body = content.stdout;
  check(body.trim().length > 0, 'file exists and is readable');
  check(body.includes('Hello world'), 'contains the Hello world sentence');
  check(body.includes('user'), 'names the operating account');
  check(body.includes('10.0.0.9'), 'names the managing host');
  check(body.includes('2222'), 'names the SSH port');

  // Integrity of the transport itself: the bytes that crossed ssh must hash to the
  // digest the remote computed locally. A mismatch here means the pipe mangled the
  // file (encoding, line endings), not that the agent was wrong.
  const md5Remote = meta.stdout.match(/^([0-9a-f]{32})/m)?.[1];
  const md5Local = createHash('md5').update(body, 'utf8').digest('hex');
  check(Boolean(md5Remote), 'md5 computed remotely', md5Remote ?? '');
  check(md5Remote === md5Local, 'the bytes streamed back over ssh hash to the remote digest', `${md5Remote} vs ${md5Local}`);

  // Freshness proves THIS run produced it rather than a previous one.
  const mtime = Number(meta.stdout.match(/^\d+ (\d+)$/m)?.[1] ?? 0);
  const ageSec = mtime ? Math.round(Date.now() / 1000 - mtime) : Number.NaN;
  check(mtime > 0 && ageSec >= 0 && ageSec < 900, 'the artifact was (re)written by this run', `${ageSec}s old`);

  // The agent's own md5 claim is checked only when it actually labelled one: prose is
  // the agent's business, and an unlabelled 32-hex run can be any hash it printed.
  const claimed = first.events
    .filter((e) => e.type === EventType.CHUNK)
    .map((e) => e.text || '')
    .join('')
    .match(/md5[^0-9a-f]{0,20}([0-9a-f]{32})/i)?.[1];
  check(
    claimed === undefined || claimed === md5Remote,
    'the md5 the agent labelled matches the one we read',
    claimed === undefined ? '(agent labelled none)' : `${claimed} vs ${md5Remote}`,
  );

  // ── 4. a real approval, decided by us ───────────────────────────────────────
  section('4. real remote approval parked and resolved by a human decision');
  /** @type {any} */
  let parked = null;
  let workingWhileParked = false;
  const second = await run(
    `请在 ${DEMO} 写入一段中文说明文字，内容为“AgentMesh 远程审批演示：本次写入需要人工批准”，写完后 cat 回读。`,
    'ask',
    {
      onApproval: (data) => {
        parked = data;
        // Answer on the event loop, as an interactive client does — the send() await is
        // still suspended, so this proves the approval is a parked, addressable resource
        // rather than something the adapter invented after the fact.
        setTimeout(() => {
          workingWhileParked = true;
          const chosen = (data.options || []).find((o) => o.kind === 'allow_once') || (data.options || [])[0];
          const res = fleet.resolveApproval(data.id, chosen?.optionId ?? null);
          say(`  ..   resolved ${data.id} -> ${chosen?.optionId} (${JSON.stringify(res)})`);
        }, 1500);
      },
    },
  );
  check(Boolean(parked), 'an approval request reached the console while the task was parked');
  check(workingWhileParked, 'the decision was made from the event loop, not after the fact');
  check((parked?.options || []).length >= 2, 'the request carried addressable options', `${(parked?.options || []).map((o) => o.kind).join(', ')}`);
  check(parked?.policy === 'ask', 'the request was parked under the ask policy', String(parked?.policy));
  check(parked?.taskId === second.task.id, 'the parked request is addressable by task id', String(parked?.taskId));
  const resolved = second.events.filter((e) => e.type === EventType.APPROVAL_RESOLVED).pop();
  check(resolved !== undefined, 'resolution was echoed back to the adapter');
  // A parked approval is resolved by an operator, so the adapter reports no `auto`
  // marker at all — only the policy path sets `auto: true` (asserted in section 2).
  check(resolved?.data?.auto !== true, 'this one was NOT auto-approved (an operator chose)', `auto=${resolved?.data?.auto}`);
  check(resolved?.data?.optionId === 'allow_once', 'the chosen option is the one we sent', String(resolved?.data?.optionId));
  check(resolved?.data?.approvalId === parked?.id, 'the resolution names the approval it answers', String(resolved?.data?.approvalId));
  check(second.task.state === 'completed', 'the task finished after approval', `state=${second.task.state}`);
  const demo = await sshExec({ target, command: `cat ${DEMO}`, timeoutMs: 30_000 });
  check(demo.code === 0 && demo.stdout.includes('远程审批演示'), 'the approved write took effect on the remote disk');

  section(`${pass} passed, ${failures.length} failed`);
  if (failures.length) say(`failed: ${failures.join(' | ')}`);
} catch (err) {
  const detail = err instanceof Error ? err.stack : String(err);
  say(`\nverify-lan crashed: ${detail}`);
  process.stderr.write(`\nverify-lan crashed: ${detail}\n`);
  failures.push('crash');
} finally {
  await fleet.close().catch(() => {});
  if (LOG) {
    try {
      const header = [
        `# AgentMesh live-node acceptance — ${new Date().toISOString()}`,
        `# node=${NODE} dir=${DIR} node=${process.version} platform=${process.platform}`,
        '',
      ].join('\n');
      writeFileSync(LOG, `${header}${transcript.join('\n')}\n`, 'utf8');
      process.stdout.write(`\ntranscript written to ${LOG}\n`);
    } catch (err) {
      process.stderr.write(`could not write ${LOG}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}

process.exit(failures.length ? 1 : 0);
