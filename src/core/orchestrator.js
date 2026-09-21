// The local orchestrator agent.
//
// This is the piece that turns AgentMesh from "you dispatch each task yourself" into
// "you say one sentence to a local agent and it decides who should do the work".
//
// It is deliberately ours rather than an off-the-shelf agent framework: the tool set,
// the permission gate and the loop semantics are the whole product here, and we want
// to change them without reading anyone's docs or waiting on their release.
//
// Two properties are worth stating up front, because they are what make it a control
// plane rather than a chat toy:
//
//   1. Every dispatch goes through the ordinary `Fleet`, so it lands in the same store
//      and shows up in `mesh tasks` and the Web console exactly like a hand-typed run.
//      The agent has no private side channel.
//   2. The reasoning stream and the durable record are separate. Thinking is live and
//      ephemeral; *actions* are recorded. So the audit trail shows what was actually
//      done to which machine, which is the part that matters.

import { chat, llmConfig, llmReady } from './llm.js';

/** Tool names the orchestrator can offer. */
export const AGENT_TOOLS = /** @type {const} */ ([
  'list_nodes',
  'probe_node',
  'send_task',
  'broadcast',
  'list_tasks',
  'get_task',
]);

/**
 * Read-only tools, safe to allow always.
 */
export const READ_ONLY_TOOLS = ['list_nodes', 'probe_node', 'list_tasks', 'get_task'];

/**
 * Tools that cause work to happen on another machine.
 */
export const DISPATCH_TOOLS = ['send_task', 'broadcast'];

/**
 * A remote agent's answer can be arbitrarily large (a whole file, a build log). Feeding
 * all of it back would blow the context window and cost real money, so cap it and say
 * plainly that it was capped — a silently truncated tool result is how an agent ends up
 * confidently describing half an answer.
 */
export const DEFAULT_TOOL_RESULT_LIMIT = 20_000;

/**
 * @typedef {object} AgentPolicy
 * @property {string[]} [allow]          tool names permitted (default: all)
 * @property {boolean} [dryRun]          plan dispatches without performing them
 * @property {boolean} [shareContext]    let each dispatched agent see the others' recent turns
 * @property {number} [shareLimit]       how many of those turns (default 6)
 * @property {number} [maxSteps]         LLM turns before giving up
 * @property {number} [maxDispatches]    cap on tasks actually dispatched
 * @property {boolean} [confirm]         ask before each dispatch (callback below)
 * @property {(info:{node:string, prompt:string})=>Promise<boolean>} [onConfirm]
 */

/**
 * The JSON-schema tool definitions handed to the model. Kept in one place so the CLI,
 * the HTTP API and the tests all offer exactly the same surface.
 *
 * @param {string[]} [allow]
 * @returns {any[]}
 */
export function toolDefinitions(allow) {
  const want = (n) => !allow || allow.includes(n);
  /** @type {any[]} */
  const tools = [];
  if (want('list_nodes')) {
    tools.push({
      type: 'function',
      function: {
        name: 'list_nodes',
        description:
          'List the agent nodes this control plane can reach, with each one\'s name, transport, target and declared capabilities. ' +
          'Call this first: node names are exact strings and you must not invent them.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    });
  }
  if (want('probe_node')) {
    tools.push({
      type: 'function',
      function: {
        name: 'probe_node',
        description:
          'Ask one node live what it is and what it can do (agent name, version, advertised skills). Slower than list_nodes ' +
          'but authoritative — use it when you are unsure whether a node can handle the task.',
        parameters: {
          type: 'object',
          properties: { node: { type: 'string', description: 'Exact node name, as returned by list_nodes.' } },
          required: ['node'],
        },
      },
    });
  }
  if (want('send_task')) {
    tools.push({
      type: 'function',
      function: {
        name: 'send_task',
        description:
          'Dispatch ONE task to ONE node and wait for its final answer. The remote agent does the actual work. ' +
          'The remote agent cannot see this conversation, so the prompt must be fully self-contained: include every ' +
          'detail, path and constraint it needs. Prefer one clear instruction over several vague ones.',
        parameters: {
          type: 'object',
          properties: {
            node: { type: 'string', description: 'Exact node name from list_nodes.' },
            prompt: { type: 'string', description: 'The complete, self-contained instruction for the remote agent.' },
            continue_previous: {
              type: 'boolean',
              description: "Continue that node's previous session instead of starting a fresh one. Default false.",
            },
          },
          required: ['node', 'prompt'],
        },
      },
    });
  }
  if (want('broadcast')) {
    tools.push({
      type: 'function',
      function: {
        name: 'broadcast',
        description: 'Send the SAME task to several nodes at once and collect every answer. Use when the user wants a comparison or redundancy.',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'The complete, self-contained instruction.' },
            nodes: { type: 'array', items: { type: 'string' }, description: 'Exact node names. Omit to target every node.' },
          },
          required: ['prompt'],
        },
      },
    });
  }
  if (want('list_tasks')) {
    tools.push({
      type: 'function',
      function: {
        name: 'list_tasks',
        description: 'Recent tasks across the mesh, newest first. Use it to see what has already been done instead of redoing work.',
        parameters: {
          type: 'object',
          properties: {
            node: { type: 'string', description: 'Limit to one node.' },
            limit: { type: 'number', description: 'How many to return (default 10).' },
          },
          required: [],
        },
      },
    });
  }
  if (want('get_task')) {
    tools.push({
      type: 'function',
      function: {
        name: 'get_task',
        description: "Fetch one task's state and result by id.",
        parameters: {
          type: 'object',
          properties: { task_id: { type: 'string' } },
          required: ['task_id'],
        },
      },
    });
  }
  return tools;
}

/**
 * The system prompt. The node inventory is injected because a model asked to "route to
 * the NAS" needs to know that the NAS is called `nas-hermes` — guessing names is the
 * single most common failure of an orchestrator.
 *
 * @param {{nodes:any[], extra?:string}} opts
 * @returns {string}
 */
export function systemPrompt({ nodes, extra = '' }) {
  const inventory = nodes.length
    ? nodes
        .map((n) => {
          const caps = n.capabilities?.length ? ` capabilities=[${n.capabilities.join(', ')}]` : '';
          const desc = n.description ? ` — ${n.description}` : '';
          return `- ${n.name} (transport=${n.transport}, kind=${n.kind}, target=${n.target}${caps})${desc}`;
        })
        .join('\n')
    : '(no nodes are registered yet)';

  return [
    'You are the local orchestrator of AgentMesh, a control plane that dispatches work to AI agents running on other machines.',
    'The user talks to you in natural language. Your job is to decide what should happen, which node should do it, and then actually make it happen with the tools you have.',
    '',
    'Nodes you can reach right now:',
    inventory,
    '',
    'How to work:',
    '1. Before dispatching, make sure you know the exact node name. Call list_nodes if unsure. Never invent a node name.',
    '2. If it is unclear whether a node can do the job, call probe_node to see what it advertises.',
    '3. Write remote prompts that are fully self-contained. The remote agent cannot see this conversation, the user, or your reasoning — it only receives the prompt string. Include paths, language, format and constraints explicitly.',
    '4. Actually call the tools. Do not describe work you could have done, and never report a result you did not receive from a tool.',
    '5. When you have the results, answer the user directly. Relay the remote agent\'s output faithfully: if the user asked for code, include the code; if they asked for a file, say exactly where it is. Do not summarise away the substance.',
    '6. If a dispatch fails, say so plainly and include the error. Do not pretend it succeeded, and do not silently retry more than once.',
    '7. Answer in the same language the user used.',
    extra ? `\n${extra}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Run one orchestration.
 *
 * @param {object} opts
 * @param {import('./fleet.js').Fleet} opts.fleet
 * @param {string} opts.prompt
 * @param {AgentPolicy} [opts.policy]
 * @param {(ev:any)=>void} [opts.onEvent]
 * @param {AbortSignal} [opts.signal]
 * @param {Partial<import('./llm.js').LlmConfig>} [opts.llm]
 * @param {boolean} [opts.verbose]
 * @returns {Promise<{text:string, steps:number, dispatchCount:number, toolCalls:any[], tasks:any[], stopReason:string, usage:any}>}
 */
export async function runAgent({ fleet, prompt, policy = {}, onEvent, signal, llm, verbose = false }) {
  const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const maxSteps = policy.maxSteps ?? 8;
  const maxDispatches = policy.maxDispatches ?? 8;
  const allow = policy.allow ?? null;
  const dryRun = Boolean(policy.dryRun);

  const emit = (ev) => {
    try {
      onEvent?.({ runId, ...ev });
    } catch {
      /* a broken renderer must never abort the run */
    }
  };

  const ready = llmReady({ ...llmConfig(), ...(llm ?? {}) });
  if (!ready.ok) {
    throw new Error(
      `LLM not configured (missing ${ready.missing.join(', ')}). Set AGENTMESH_LLM_BASE_URL and AGENTMESH_LLM_MODEL, ` +
        `or pass --base-url/--model.`,
    );
  }

  const nodeList = fleet.registry.list().map((n) => ({
    name: n.name,
    kind: n.kind,
    transport: n.transport,
    target: n.transport === 'a2a' ? n.url : n.ssh ? `ssh://${n.ssh.user ? `${n.ssh.user}@` : ''}${n.ssh.host}` : n.command,
    caps: n.capabilities ?? [],
    description: n.description ?? '',
  }));

  emit({ type: 'agent-start', text: prompt, data: { nodes: nodeList.map((n) => n.name), dryRun, model: (llm?.model ?? llmConfig().model) } });

  /** @type {any[]} */
  const messages = [
    { role: 'system', content: systemPrompt({ nodes: nodeList, extra: dryRun ? 'NOTE: this run is a DRY RUN. Dispatches will not be performed; you will be told what would have been sent.' : '' }) },
    { role: 'user', content: prompt },
  ];
  const tools = toolDefinitions(allow ?? undefined);
  if (tools.length === 0) throw new Error('no tools are enabled; nothing can be orchestrated');

  /** @type {any[]} */
  const toolCalls = [];
  /** @type {any[]} */
  const dispatched = [];
  let dispatchCount = 0;
  let usage = null;
  let steps = 0;

  const ctx = {
    signal,
    policy,
    dryRun,
    llm,
    emit,
    toolCalls,
    dispatched,
    countDispatch: () => {
      // Check BEFORE incrementing. Counting first and rejecting afterwards reports
      // dispatches that never happened: the loop catches the throw and carries on, so the
      // counter climbs once per refused attempt and the run's own summary lies about how
      // much work it did.
      if (dispatchCount + 1 > maxDispatches) {
        throw new Error(`dispatch limit reached (${maxDispatches}); refusing to dispatch more. Split the request into smaller runs.`);
      }
      dispatchCount += 1;
    },
  };

  for (let step = 1; step <= maxSteps; step += 1) {
    steps = step;
    const res = await chat({ messages, tools, config: llm, signal });
    if (res.usage) usage = res.usage;
    if (res.content) emit({ type: 'agent-thought', text: res.content });

    if (res.toolCalls.length === 0) {
      emit({ type: 'agent-final', text: res.content, data: { steps: step, dispatches: dispatchCount } });
      return { text: res.content, steps: step, dispatchCount, toolCalls, tasks: dispatched, stopReason: res.finishReason || 'stop', usage };
    }

    messages.push({
      role: 'assistant',
      content: res.content || null,
      tool_calls: res.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.raw || '{}' } })),
    });

    for (const call of res.toolCalls) {
      emit({ type: 'agent-tool-call', text: call.name, data: { id: call.id, args: call.args } });
      let result;
      try {
        result = await executeTool(call.name, call.args, fleet, ctx);
      } catch (err) {
        // Tool failures go BACK TO THE MODEL rather than aborting the run: a wrong node
        // name or an unreachable host is exactly the situation where the model can
        // correct itself, and failing the whole run would waste the work already done.
        result = { error: err instanceof Error ? err.message : String(err) };
      }
      const payload = JSON.stringify(result);
      const limited =
        payload.length > DEFAULT_TOOL_RESULT_LIMIT
          ? `${payload.slice(0, DEFAULT_TOOL_RESULT_LIMIT)}\n…[truncated: full result was ${payload.length} chars]`
          : payload;
      emit({ type: 'agent-tool-result', text: call.name, data: { id: call.id, result: limited } });
      messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: limited });
    }
  }

  // Out of steps. This is a real outcome the caller must be able to tell apart from a
  // completed run, so it is reported as such instead of looking like an empty answer.
  emit({ type: 'agent-final', text: '', data: { steps: maxSteps, dispatches: dispatchCount, stepLimitReached: true } });
  return {
    text: '',
    steps: maxSteps,
    dispatchCount,
    toolCalls,
    tasks: dispatched,
    stopReason: 'step-limit',
    usage,
  };
}

/**
 * Execute one tool call. Kept separate from the loop so tests can drive it directly and
 * so the permission gate lives in exactly one place.
 *
 * @param {string} name
 * @param {any} args
 * @param {import('./fleet.js').Fleet} fleet
 * @param {any} ctx
 * @returns {Promise<any>}
 */
export async function executeTool(name, args, fleet, ctx) {
  const { policy, dryRun, signal, emit, toolCalls, dispatched, countDispatch } = ctx;
  const a = args && typeof args === 'object' ? args : {};

  if (a.__parseError !== undefined) {
    return { error: `your arguments were not valid JSON: ${String(a.__parseError).slice(0, 200)}. Re-issue the call with valid JSON.` };
  }

  toolCalls.push({ name, args: a });

  switch (name) {
    case 'list_nodes': {
      return {
        nodes: fleet.registry.list().map((n) => ({
          name: n.name,
          kind: n.kind,
          transport: n.transport,
          target: n.transport === 'a2a' ? n.url : n.ssh ? `ssh://${n.ssh.user ? `${n.ssh.user}@` : ''}${n.ssh.host}` : n.command,
          capabilities: n.capabilities ?? [],
          approval: n.approvalPolicy ?? n.approval ?? 'deny',
        })),
      };
    }

    case 'probe_node': {
      if (!a.node) return { error: 'node is required' };
      try {
        const res = await fleet.probe(String(a.node));
        return {
          node: a.node,
          reachable: true,
          agent: res?.agentName ?? res?.name ?? null,
          version: res?.agentVersion ?? res?.version ?? null,
          interface: res?.interface ?? res?.protocolVersion ?? null,
          streaming: res?.streaming ?? null,
          skills: res?.skills ?? [],
        };
      } catch (err) {
        return { node: a.node, reachable: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    case 'send_task': {
      if (!a.node) return { error: 'node is required' };
      if (!a.prompt) return { error: 'prompt is required' };
      if (typeof a.prompt !== 'string') return { error: 'prompt must be a string', got: typeof a.prompt };
      // Validate the node BEFORE the confirmation prompt and before any dry-run
      // reporting: a plan that names a node we cannot reach is worse than no plan.
      try {
        fleet.registry.mustGet(String(a.node));
      } catch {
        const names = fleet.registry.list().map((n) => n.name);
        return { error: `unknown node '${a.node}'. Known nodes: ${names.length ? names.join(', ') : '(none registered)'}` };
      }

      if (dryRun) {
        return { dryRun: true, wouldSend: { node: a.node, prompt: a.prompt }, note: 'no task was dispatched' };
      }
      if (policy.onConfirm) {
        const ok = await policy.onConfirm({ node: String(a.node), prompt: String(a.prompt) });
        if (!ok) return { refused: true, note: 'the user declined this dispatch' };
      }
      countDispatch();

      const task = await fleet.send({
        nodeRef: String(a.node),
        prompt: String(a.prompt),
        continueSession: Boolean(a.continue_previous),
        // A run-level choice, not a per-dispatch tool argument: whether the agents this run
        // talks to may see each other is a property of the job, and leaving it to the model
        // would make the same request behave differently on different days.
        shareContext: Boolean(policy.shareContext),
        shareLimit: Number.isFinite(Number(policy.shareLimit)) ? Number(policy.shareLimit) : undefined,
        signal,
      });
      dispatched.push({ node: String(a.node), taskId: task.id, state: task.state, result: task.result, error: task.error });
      emit({ type: 'agent-dispatch', text: `${a.node} ${task.state}`, data: { node: a.node, taskId: task.id, state: task.state } });

      return {
        node: a.node,
        task_id: task.id,
        state: task.state,
        answer: task.result ?? '',
        ...(task.error ? { error: task.error } : {}),
      };
    }

    case 'broadcast': {
      if (!a.prompt) return { error: 'prompt is required' };
      const refs = Array.isArray(a.nodes) && a.nodes.length ? a.nodes.map(String) : null;
      const targets = refs ?? fleet.registry.list().map((n) => n.name);
      if (targets.length === 0) return { error: 'no nodes to broadcast to' };
      if (dryRun) return { dryRun: true, wouldSend: { nodes: targets, prompt: a.prompt }, note: 'no task was dispatched' };
      if (policy.onConfirm) {
        const ok = await policy.onConfirm({ node: targets.join(','), prompt: String(a.prompt) });
        if (!ok) return { refused: true, note: 'the user declined this broadcast' };
      }
      countDispatch();

      const results = await fleet.broadcast({ prompt: String(a.prompt), refs: refs ?? undefined, shareContext: Boolean(policy.shareContext), shareLimit: policy.shareLimit, signal, onEvent: undefined });
      const out = results.map((r) => ({
        node: r.node?.name ?? '?',
        task_id: r.task?.id ?? null,
        state: r.task?.state ?? 'unknown',
        answer: r.task?.result ?? '',
        ...(r.task?.error ? { error: r.task.error } : {}),
      }));
      for (const r of out) dispatched.push({ node: r.node, taskId: r.task_id, state: r.state, result: r.answer, error: r.error });
      return { results: out };
    }

    case 'list_tasks': {
      const limit = Number.isFinite(Number(a.limit)) ? Math.max(1, Math.min(50, Number(a.limit))) : 10;
      let rows;
      if (a.node) {
        try {
          const node = fleet.registry.mustGet(String(a.node));
          rows = fleet.store.listTasks({ nodeId: node.id, limit });
        } catch {
          return { error: `unknown node '${a.node}'` };
        }
      } else {
        rows = fleet.store.listTasks({ limit });
      }
      return {
        tasks: rows.map((t) => ({
          task_id: t.id,
          node: fleet.registry.list().find((n) => n.id === t.nodeId)?.name ?? t.nodeId,
          state: t.state,
          prompt: String(t.prompt ?? '').slice(0, 300),
          result: String(t.result ?? '').slice(0, 300),
          created_at: t.createdAt,
        })),
      };
    }

    case 'get_task': {
      if (!a.task_id) return { error: 'task_id is required' };
      // `Store.getTask` throws on a missing id. A tool must never throw for ordinary bad
      // input: the model needs the miss as data so it can correct the id, and an
      // exception here would surface as an opaque tool failure.
      let t = null;
      try {
        t = typeof fleet.store.findTask === 'function' ? fleet.store.findTask(String(a.task_id)) : null;
        if (!t) t = fleet.store.getTask(String(a.task_id));
      } catch {
        return { error: `no task '${a.task_id}'` };
      }
      if (!t) return { error: `no task '${a.task_id}'` };
      return { task_id: t.id, state: t.state, prompt: t.prompt, answer: t.result ?? '', error: t.error ?? null };
    }

    default:
      return { error: `unknown tool '${name}'. Available: ${AGENT_TOOLS.join(', ')}` };
  }
}
