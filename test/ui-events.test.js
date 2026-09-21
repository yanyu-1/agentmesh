// The event colour classes and the event vocabulary must agree exactly.
//
// Both the log panel and the chat panel render a line as `div.className = 'ev-' + ev.type`,
// so the stylesheet's `.ev-*` rules are a second, silent copy of the event vocabulary. It
// drifted in both directions without anything noticing: the console had no colour at all for
// `plan`, `usage`, `approval-resolved`, `agent-start`, `agent-final`, `agent-dispatch`,
// `agent-error` and `agent-result`, while carrying rules for `agent-done` and `agent-user`,
// which no code path has ever emitted. Neither failure is visible to any other check, and
// neither is visible in a browser unless the exact event happens to fire.
//
// The vocabulary has three homes, and they are **discovered rather than listed**:
//   * src/protocol/events.js — EventType, used by every adapter and the Fleet
//   * the adapters, the Fleet and src/core/orchestrator.js — the literals they emit
//   * src/web/ui.html — the events the page raises itself (`agent-user` for the operator's own
//     line, `agent-error` when its own request fails)
//
// The list used to be spelled out by hand, and that is exactly how `agent-user` was lost: the page
// was not on the list, so a type the page emits on every single turn looked dead and its colour
// rule was deleted. A hand-written list can silently omit a file; walking the tree cannot.
//
// The one exclusion is `src/cli/`, and it is a rule rather than a memory. The CLI **consumes**
// events (it renders them to stderr) and writes machine-readable records to stdout —
// `mesh agent --json` prints `{ "type": "agent-result", … }`, and no browser can ever receive
// `agent-result`. Scanning that directory would demand a `.ev-agent-result` rule that can never
// match, which is the mirror image of the same mistake. The test below pins both directions.
//
// Run: node --test test/ui-events.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { EventType, STREAMED_EVENTS } from '../src/protocol/events.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const ui = read('../src/web/ui.html');

/**
 * Every file that can put a console event on the wire, plus the page.
 * @returns {string[]} file contents
 */
function eventSources() {
  const out = [ui];
  /** @param {URL} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name !== 'cli') walk(new URL(`${entry.name}/`, dir));
      } else if (entry.name.endsWith('.js')) {
        out.push(readFileSync(new URL(entry.name, dir), 'utf8'));
      }
    }
  };
  walk(new URL('../src/', import.meta.url));
  return out;
}

/** Every event type the program can put on the wire. */
function emittedTypes() {
  const fromEnum = Object.values(EventType);
  const fromAgent = eventSources().flatMap((src) =>
    [...src.matchAll(/type:\s*'(agent-[a-z-]+)'/g)].map((m) => m[1]),
  );
  return new Set([...fromEnum, ...fromAgent]);
}

/** Every `ev-*` class the stylesheet gives a colour to. */
function styledTypes() {
  const style = /<style\b[^>]*>([\s\S]*?)<\/style>/i.exec(ui)[1];
  const out = new Set();
  for (const m of style.matchAll(/([^{}]+)\{/g)) {
    for (const c of m[1].matchAll(/\.ev-([a-z][a-z0-9-]*)/g)) out.add(c[1]);
  }
  return out;
}

test('every event type the code emits has a colour in the console', () => {
  const styled = styledTypes();
  const missing = [...emittedTypes()].filter((t) => !styled.has(t)).sort();
  assert.deepEqual(
    missing,
    [],
    `these events render with no colour because no .ev-* rule matches them: ${missing.join(', ')}`,
  );
});

test('every event colour corresponds to an event that can actually occur', () => {
  const emitted = emittedTypes();
  const dead = [...styledTypes()].filter((t) => !emitted.has(t)).sort();
  assert.deepEqual(
    dead,
    [],
    `these .ev-* rules can never match, because nothing emits the type: ${dead.join(', ')}`,
  );
});

test('the two event vocabularies are the ones this test was written against', () => {
  // Guards the guard: if the enum is renamed or emptied, the two checks above would pass
  // vacuously by comparing two empty sets.
  assert.ok(Object.keys(EventType).length >= 14, 'EventType should still list the full vocabulary');
  assert.ok(emittedTypes().size >= 20, 'the combined vocabulary should still be around twenty types');
  assert.ok(styledTypes().size >= 20, 'the stylesheet should still colour the whole vocabulary');
});

test('the audit reads the sources it thinks it reads', () => {
  // The premise that broke `agent-user` was "where do events come from", and the answer was a
  // hand-written list. This pins the premise itself, in both directions, so narrowing it again
  // fails here rather than silently deleting a live colour rule later.
  const sources = eventSources();
  assert.ok(sources.length >= 20, `expected the tree under src/, got ${sources.length} files`);
  assert.ok(sources.includes(ui), 'the page is an event source: it raises agent-user and agent-error');

  const emitted = emittedTypes();
  assert.ok(emitted.has('agent-user'), 'the page emits agent-user on every turn; it must stay in the audit');
  assert.ok(
    !emitted.has('agent-result'),
    'agent-result is a stdout record from src/cli, not a browser event — a rule for it could never match',
  );
  assert.ok(
    !sources.some((s) => s.includes('reportAgentRun')),
    'src/cli is a consumer that prints records; scanning it demands an impossible colour rule',
  );
});

// ---------------------------------------------------------------------------
// Streamed fragments must coalesce into one line
// ---------------------------------------------------------------------------

/**
 * A stub DOM covering the handful of things the panels touch.
 *
 * `textContent` reads back the text nodes that were appended, and is also assignable, because the
 * run summary is written with `= `while streamed fragments are appended to a text node.
 */
function makeStubDom() {
  let connected = true;
  const makeEl = () => {
    const el = {
      className: '',
      innerHTML: '',
      children: [],
      _text: undefined,
      open: false,
      get isConnected() {
        return connected;
      },
      get lastElementChild() {
        return el.children.at(-1) ?? null;
      },
      get textContent() {
        if (el._text !== undefined) return el._text;
        // Recursive, like the real thing: a real `textContent` includes descendants' text, and
        // the run summary is a span inside the <summary> rather than the <summary> itself.
        return el.children.map((c) => (c.nodeType === 3 ? c.data : c.textContent ?? '')).join('');
      },
      set textContent(v) {
        el._text = String(v);
      },
      appendChild(child) {
        el.children.push(child);
        return child;
      },
      removeChild(child) {
        el.children.splice(el.children.indexOf(child), 1);
        return child;
      },
      get childElementCount() {
        return el.children.length;
      },
      get firstChild() {
        return el.children[0] ?? null;
      },
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 0,
    };
    return el;
  };
  /** @type {Map<string, any>} */
  const byId = new Map();
  const document_ = {
    createElement: makeEl,
    // `data` has to be mutated on the returned node: capturing the argument in a closure would
    // leave `.data` at its initial value and make assertions read "".
    createTextNode: (t) => {
      const node = { nodeType: 3, data: String(t) };
      node.appendData = (s) => { node.data += s; };
      return node;
    },
  };
  return {
    document: document_,
    byId,
    el: (id) => {
      if (!byId.has(id)) byId.set(id, makeEl());
      return byId.get(id);
    },
    detach: () => { connected = false; },
  };
}

/**
 * Pull one function out of the page's own script and run it against the stub.
 *
 * The defects these cover are invisible to every static check — the markup was correct, the event
 * vocabulary was correct, and a browser renders the result happily — so the only honest way to
 * cover them without a browser is to run the shipped code. Both markers are asserted, because a
 * regex that silently matched nothing would make the tests pass while checking an empty string.
 * @param {string} startMarker
 * @param {string} endMarker
 * @param {string} returnExpr
 */
function loadFromPage(startMarker, endMarker, returnExpr) {
  const script = /<script\b[^>]*>([\s\S]*?)<\/script>/i.exec(ui)[1];
  const start = script.indexOf(startMarker);
  assert.ok(start > 0, `the page should still contain ${JSON.stringify(startMarker)}`);
  const end = script.indexOf(endMarker, start);
  assert.ok(end > start, `the page should still contain ${JSON.stringify(endMarker)} after that`);
  const source = script.slice(start, end);

  const dom = makeStubDom();
  /** @type {Record<string,string>} */
  const store = {};
  const localStorage_ = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  };
  const build = new Function(
    'document',
    '$',
    'esc',
    'nodeNames',
    'localStorage',
    `${source}\nreturn ${returnExpr};`,
  );
  const api = build(dom.document, dom.el, (s) => String(s), new Map(), localStorage_);
  return { ...api, ...dom, store };
}

/**
 * The log panel's fragment coalescing, taken from the page rather than copied from it.
 */
function loadAppendLog() {
  const loaded = loadFromPage('const STREAMING_LOG_TYPES', "\n$('log-clear')", '{ appendLog }');
  return { ...loaded, log: loaded.el('log') };
}

const chunk = (text, nodeId = 'node_a', taskId = 't1') => ({ type: 'chunk', text, nodeId, taskId, ts: '2026-01-01T05:48:29.000Z' });

test('consecutive streamed fragments become one line, and other events break it', () => {
  const { appendLog, log } = loadAppendLog();
  // Eight fragments, as ACP actually delivers them: a character or two at a time.
  for (const t of ['t', 'ini', ' --', ' ./', 'docker', '-entry', 'point', '.sh']) appendLog(chunk(t));
  assert.equal(log.children.length, 1, 'a streamed run must occupy exactly one line');
  assert.equal(log.children[0].textContent, 'tini -- ./docker-entrypoint.sh');
  assert.equal(log.children[0].className, 'ev-chunk');

  // A complete statement always starts its own line, and ends the stream.
  appendLog({ type: 'task-state', text: 'working', nodeId: 'node_a', taskId: 't1', ts: '2026-01-01T05:48:30.000Z' });
  assert.equal(log.children.length, 2);
  assert.equal(log.children[1].textContent, '· working');

  // ...so a later fragment cannot be appended to the line before it.
  appendLog(chunk('after'));
  assert.equal(log.children.length, 3, 'a fragment after another event must start a new line');
  assert.equal(log.children[2].textContent, 'after');

  // A different run is a different line, even back to back.
  appendLog(chunk('B', 'node_b'));
  appendLog(chunk('C', 'node_a', 't2'));
  assert.equal(log.children.length, 5);
});

test('a fragment cannot be appended to a line that is no longer in the panel', () => {
  // `log-clear` empties the panel while a task keeps streaming. Appending to the detached line
  // would drop that text with no visible symptom at all, so the panel itself decides: a line
  // that is no longer attached cannot be appended to.
  const { appendLog, log, detach } = loadAppendLog();
  appendLog(chunk('first'));
  assert.equal(log.children.length, 1);

  log.children.length = 0;   // what log-clear does to the DOM
  detach();                  // ...the old line is now disconnected
  appendLog(chunk('second'));
  assert.equal(log.children.length, 1, 'the text after a clear must land in a new line');
  assert.equal(log.children[0].textContent, 'second');
});

test('the panel and the protocol agree on which events stream', () => {
  const declared = /const STREAMING_LOG_TYPES = \[([^\]]*)\]/.exec(ui);
  assert.ok(declared, 'the page should declare its streaming types in one place');
  const fromPage = [...declared[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]).sort();
  const fromProtocol = [...STREAMED_EVENTS].sort();
  assert.ok(fromProtocol.length >= 2, 'STREAMED_EVENTS should still name the streaming types');
  assert.deepEqual(
    fromPage,
    fromProtocol,
    'the log panel coalesces a different set of events than the protocol streams',
  );
});

test('a parked task shows the remote\'s question with a way to answer it in this page', () => {
  // The deployment that produced this: a compliant A2A peer returned TASK_STATE_INPUT_REQUIRED with
  // a question, and the console showed the operator a task that simply looked stuck. The question
  // itself arrived as a normal streamed line; what was missing was any statement that a person was
  // the missing piece, and any instruction — a browser user should not be handed a shell command
  // when the panel on the same page can answer it.
  const { appendLog, log } = loadAppendLog();
  appendLog({
    type: 'needs-input',
    ts: '2026-01-01T07:01:43.000Z',
    nodeId: 'node_a',
    taskId: 't1',
    text: 'DANGEROUS COMMAND: 需要你确认是否执行 rm -rf /tmp/x',
    data: { state: 'input-required', question: 'DANGEROUS COMMAND: …', contextId: 'ctx-1' },
  });

  const line = log.children[0];
  assert.equal(line.className, 'ev-needs-input', 'it must get the class that out-shouts errors');
  assert.match(line.textContent, /DANGEROUS COMMAND/, 'the remote\'s own words must be shown');
  assert.match(line.textContent, /续接上次会话/, 'the page must say how to answer');
  assert.match(line.textContent, /给指定节点发任务/, 'and point at the panel that does it');
  // Not a streaming type: every parked task is one complete statement, and it must break any line
  // still being appended to rather than joining it.
  assert.ok(!STREAMED_EVENTS.has('needs-input'));

  // Without a context there is no conversation to continue, and the operator has to be told that
  // answering may start a fresh one rather than being quietly given a different result.
  const second = loadAppendLog();
  second.appendLog({
    type: 'needs-input',
    ts: '2026-01-01T07:01:44.000Z',
    nodeId: 'node_a',
    taskId: 't2',
    text: 'q',
    data: { state: 'input-required', question: 'q', contextId: null },
  });
  assert.match(second.log.children[0].textContent, /没拿到会话 id/);
  assert.doesNotMatch(second.log.children[0].textContent, /续接上次会话/);
});

// ---------------------------------------------------------------------------
// The chat panel folds the process away and keeps the reply
// ---------------------------------------------------------------------------

/** The chat panel's run folding, taken from the page rather than copied from it. */
function loadAppendAgent() {
  const loaded = loadFromPage('const AGENT_PROCESS_TYPES', '\nasync function sendAgent', '{ appendAgent }');
  return { ...loaded, chat: loaded.el('ag-chat') };
}

const runOf = (/** @type {any[]} */ events) => {
  const { appendAgent, chat } = loadAppendAgent();
  for (const ev of events) appendAgent(ev);
  return { chat, children: chat.children };
};

test('by default a run collapses to one summary line and the reply stays visible', () => {
  // What the panel is for: the person asked one thing and wants one answer. Thinking and tool
  // traffic is what you read when something goes wrong, and noise when it does not.
  const { children } = runOf([
    { type: 'agent-user', text: '检查一下磁盘' },
    { type: 'agent-start', data: { model: 'm', nodes: ['nas'] } },
    { type: 'agent-thought', text: '先看看 nas' },
    { type: 'agent-tool-call', text: 'send_task', data: { args: { node: 'nas' } } },
    { type: 'agent-tool-result', text: 'ok', data: { result: 'done' } },
    { type: 'agent-dispatch', data: { node: 'nas', state: 'completed' } },
    { type: 'agent-thought', text: '再确认一下' },
    { type: 'agent-final', text: '磁盘还剩 40%' },
  ]);

  // Three top-level things: your line, the folded run, the reply.
  assert.equal(children.length, 3, `expected user + run + reply, got ${children.map((c) => c.className).join(', ')}`);
  assert.equal(children[0].className, 'ev-agent-user');
  assert.equal(children[1].className, 'run');
  assert.equal(children[2].className, 'ev-agent-final', 'the reply must NOT be inside the fold');

  const run = children[1];
  assert.equal(run.open, false, 'the run must be collapsed by default');
  // Default: no thinking, no tool lines — the body holds only the "started" header.
  assert.equal(run.children[1].children.length, 1);

  // But the folded line still says that work happened, and how much. Hiding the detail must not
  // hide the fact, or a run with no visible activity is indistinguishable from a broken one.
  const summary = run.children[0].textContent;
  assert.match(summary, /思考 2/, `the summary should count the hidden thinking, got ${JSON.stringify(summary)}`);
  assert.match(summary, /调用 1/);
  assert.match(summary, /结果 1/);
  assert.match(summary, /派发 1/);

  // And the reply must not be inside the collapsed element.
  assert.ok(!run.children[1].children.some((c) => c.className === 'ev-agent-final'));
});

test('the display options decide what goes inside the fold, and are remembered', () => {
  const { appendAgent, chat, store } = loadAppendAgent();

  // The checkboxes write here; the panel reads it. Same shape the page uses.
  store['agentmesh.display'] = JSON.stringify({ thought: true, tools: false });
  appendAgent({ type: 'agent-start', data: { model: 'm', nodes: [] } });
  appendAgent({ type: 'agent-thought', text: '想想' });
  appendAgent({ type: 'agent-tool-call', text: 'send_task', data: { args: {} } });
  appendAgent({ type: 'agent-final', text: '答复' });

  const run = chat.children[0];
  const body = run.children[1].children;
  assert.equal(body.length, 2, 'thought on, tools off: the header plus exactly one thought line');
  assert.equal(body[1].className, 'ev-agent-thought');
  assert.ok(!body.some((c) => c.className === 'ev-agent-tool-call'));
  // The summary counts it either way.
  assert.match(run.children[0].textContent, /调用 1/);
});

test('a process event with no agent-start still lands in a fold, not loose in the panel', () => {
  // A resumed stream, or a reconnected console, can deliver a process event whose `agent-start`
  // was already sent. It must not appear as a bare line among the replies.
  const { appendAgent, chat } = loadAppendAgent();
  appendAgent({ type: 'agent-thought', text: 'orphan' });
  assert.equal(chat.children.length, 1);
  assert.equal(chat.children[0].className, 'run');
  assert.match(chat.children[0].children[0].textContent, /思考 1/);
});

test('every agent event is deliberately classified, so none can vanish silently', () => {
  // `appendAgent` ignores a type it does not know, which is the right default for an unknown
  // event but means a new one added to the orchestrator would disappear from the panel with no
  // error anywhere. Every emitted `agent-*` type must therefore be either folded as process or
  // handled as one of the always-visible ones. (There is an equivalent test for the log panel:
  // every emitted type must have a colour.)
  const declared = /const AGENT_PROCESS_TYPES = \[([^\]]*)\]/.exec(ui);
  assert.ok(declared, 'the page should declare its folded types in one place');
  const folded = new Set([...declared[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]));
  const alwaysVisible = new Set(['agent-start', 'agent-final', 'agent-error', 'agent-user']);

  assert.ok(folded.size >= 4, 'the folded set should still name the process events');
  const unclassified = [...emittedTypes()].filter((t) => t.startsWith('agent-') && !folded.has(t) && !alwaysVisible.has(t));
  assert.deepEqual(
    unclassified,
    [],
    `these agent events reach the chat panel and are silently dropped by it: ${unclassified.join(', ')}`,
  );
  for (const t of folded) {
    assert.ok(!alwaysVisible.has(t), `${t} cannot be both folded and always visible`);
  }
});
