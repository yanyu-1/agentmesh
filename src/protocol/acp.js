/**
 * ACP (Agent Client Protocol) v1 — wire helpers.
 *
 * Authoritative sources (vendored in `research/schemas/`):
 *   - `schema/v1/schema.json`  (170 definitions, `x-method` annotated)
 *   - `schema/v1/meta.json`    (agentMethods / clientMethods tables)
 *   - `docs/protocol/v1/transports.mdx`  (stdio = nd-JSON, no embedded newlines)
 *
 * Stable ACP transport is stdio ONLY, which is why AgentMesh tunnels it over SSH
 * instead of inventing an HTTP variant. See PLAN.md §2.
 *
 * @module protocol/acp
 */

import { TaskState, fromAcpStopReason } from './states.js';

/** Major protocol version negotiated in `initialize`. */
export const ACP_PROTOCOL_VERSION = 1;

/** Methods the CLIENT (AgentMesh) calls on the AGENT. */
export const AGENT_METHODS = /** @type {const} */ ({
  INITIALIZE: 'initialize',
  AUTHENTICATE: 'authenticate',
  SESSION_NEW: 'session/new',
  SESSION_LOAD: 'session/load',
  SESSION_SET_MODE: 'session/set_mode',
  SESSION_SET_CONFIG_OPTION: 'session/set_config_option',
  SESSION_PROMPT: 'session/prompt',
  SESSION_CANCEL: 'session/cancel',
  SESSION_LIST: 'session/list',
  SESSION_DELETE: 'session/delete',
  SESSION_RESUME: 'session/resume',
  SESSION_CLOSE: 'session/close',
  LOGOUT: 'logout',
});

/** Methods the AGENT calls on the CLIENT (us). Bidirectional by design. */
export const CLIENT_METHODS = /** @type {const} */ ({
  SESSION_REQUEST_PERMISSION: 'session/request_permission',
  SESSION_UPDATE: 'session/update',
  FS_WRITE_TEXT_FILE: 'fs/write_text_file',
  FS_READ_TEXT_FILE: 'fs/read_text_file',
  TERMINAL_CREATE: 'terminal/create',
  TERMINAL_OUTPUT: 'terminal/output',
  TERMINAL_RELEASE: 'terminal/release',
  TERMINAL_WAIT_FOR_EXIT: 'terminal/wait_for_exit',
  TERMINAL_KILL: 'terminal/kill',
  ELICITATION_CREATE: 'elicitation/create',
  ELICITATION_COMPLETE: 'elicitation/complete',
});

/** `$`-prefixed reserved methods. */
export const PROTOCOL_METHODS = /** @type {const} */ ({ CANCEL_REQUEST: '$/cancel_request' });

/** Terminal `StopReason` values returned by `session/prompt`. */
export const STOP_REASONS = /** @type {const} */ ([
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
]);

/** `sessionUpdate` discriminators we know how to render. */
export const SESSION_UPDATE_KINDS = /** @type {const} */ ([
  'user_message_chunk',
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'available_commands_update',
  'current_mode_update',
  'config_option_update',
  'session_info_update',
  'usage_update',
]);

/** Permission option kinds (schema `PermissionOptionKind`). */
export const PERMISSION_KINDS = /** @type {const} */ ([
  'allow_once',
  'allow_always',
  'reject_once',
  'reject_always',
]);

/**
 * How the client answers `session/request_permission`.
 * @typedef {'deny'|'allow-once'|'allow-always'|'ask'} PermissionPolicy
 */
export const PermissionPolicy = /** @type {const} */ ({
  DENY: 'deny',
  ALLOW_ONCE: 'allow-once',
  ALLOW_ALWAYS: 'allow-always',
  ASK: 'ask',
});

/**
 * Decide how to answer a permission request.
 * Returns an `optionId` to answer immediately, or `null` meaning "park the task
 * and let the operator answer later" (see PLAN.md design principle 2).
 *
 * @param {Array<{optionId:string,name?:string,kind:string}>} options
 * @param {PermissionPolicy} policy
 * @returns {{optionId: string|null, kind: string|null}}
 */
export function pickPermissionOption(options, policy) {
  const list = Array.isArray(options) ? options.filter((o) => o && typeof o.optionId === 'string') : [];
  const byKind = (/** @type {string} */ kind) => list.find((o) => o.kind === kind);
  if (policy === PermissionPolicy.ASK) return { optionId: null, kind: null };
  if (policy === PermissionPolicy.ALLOW_ALWAYS) {
    const o = byKind('allow_always') || byKind('allow_once');
    return o ? { optionId: o.optionId, kind: o.kind } : { optionId: null, kind: null };
  }
  if (policy === PermissionPolicy.ALLOW_ONCE) {
    const o = byKind('allow_once') || byKind('allow_always');
    return o ? { optionId: o.optionId, kind: o.kind } : { optionId: null, kind: null };
  }
  // deny
  const o = byKind('reject_once') || byKind('reject_always');
  return o ? { optionId: o.optionId, kind: o.kind } : { optionId: null, kind: null };
}

/**
 * Build the JSON-RPC result for `session/request_permission`.
 *
 * The nesting is mandatory and easy to get wrong: the response is
 * `{ outcome: RequestPermissionOutcome }`, and `RequestPermissionOutcome` is
 * itself a tagged object (`{outcome:'selected', optionId}` or `{outcome:'cancelled'}`).
 * Returning the inner object directly makes every approval read as a denial —
 * agents duck-type `response.outcome.outcome == "selected"`.
 *
 * @see research/schemas/agentclientprotocol__agent-client-protocol__schema_v1_schema.json
 *      → `RequestPermissionResponse.properties.outcome` (required) and `RequestPermissionOutcome`.
 * @param {string|null} optionId
 * @returns {{outcome:{outcome:'selected',optionId:string}|{outcome:'cancelled'}}}
 */
export function permissionOutcome(optionId) {
  return { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } };
}

/**
 * Serialize one ACP message for the stdio transport.
 * §transports: messages are newline-delimited and MUST NOT contain embedded newlines.
 * @param {object} msg
 * @returns {string}
 */
export function encodeMessage(msg) {
  return `${JSON.stringify(msg)}\n`;
}

/**
 * Incremental nd-JSON decoder.
 * Feed it raw chunks; it calls `onMessage` per complete JSON object.
 *
 * @param {(msg:any)=>void} onMessage
 * @param {(err:Error, line:string)=>void} [onError]
 * @returns {{push:(chunk:string|Buffer)=>void, flush:()=>void}}
 */
export function createNdJsonDecoder(onMessage, onError) {
  let buf = '';
  return {
    push(chunk) {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch (err) {
          // ACP requires stdout to carry only valid messages; surface, don't crash.
          onError?.(err instanceof Error ? err : new Error(String(err)), line);
          continue;
        }
        onMessage(parsed);
      }
    },
    flush() {
      const line = buf.trim();
      buf = '';
      if (!line) return;
      try {
        onMessage(JSON.parse(line));
      } catch (err) {
        onError?.(err instanceof Error ? err : new Error(String(err)), line);
      }
    },
  };
}

/**
 * Build a `ContentBlock` for a plain text prompt.
 * @param {string} text
 * @returns {{type:'text',text:string}}
 */
export function textBlock(text) {
  return { type: 'text', text };
}

/**
 * Extract human-readable text from an ACP `ContentBlock` (or a tool-call content
 * wrapper). Handles `text`, `resource` (text or blob), and `content` nesting.
 * @param {any} block
 * @returns {string}
 */
export function blockText(block) {
  if (!block) return '';
  if (typeof block === 'string') return block;
  if (typeof block.text === 'string') return block.text;
  if (block.type === 'resource' && block.resource) {
    const r = block.resource;
    if (typeof r.text === 'string') return r.text;
    if (typeof r.uri === 'string') return `[resource ${r.uri}]`;
  }
  if (block.type === 'image') return '[image]';
  if (block.type === 'audio') return '[audio]';
  if (block.type === 'content' && block.content) return blockText(block.content);
  return '';
}

/**
 * Normalize a `session/update` payload into a flat, render-agnostic record.
 *
 * @param {any} update the `update` member of a `session/update` notification
 * @returns {{kind:string, text:string, messageId:string|null, toolCallId:string|null,
 *            title:string|null, status:string|null, toolKind:string|null, raw:any}}
 */
export function classifyUpdate(update) {
  const kind = String(update?.sessionUpdate ?? 'unknown');
  /** @type {{kind:string, text:string, messageId:string|null, toolCallId:string|null, title:string|null, status:string|null, toolKind:string|null, raw:any}} */
  const out = {
    kind,
    text: '',
    messageId: update?.messageId ?? null,
    toolCallId: update?.toolCallId ?? null,
    title: update?.title ?? null,
    status: update?.status ?? null,
    toolKind: update?.kind ?? null,
    raw: update,
  };
  switch (kind) {
    case 'agent_message_chunk':
    case 'user_message_chunk':
    case 'agent_thought_chunk':
      out.text = blockText(update?.content);
      break;
    case 'tool_call_update':
      out.text = Array.isArray(update?.content) ? update.content.map(blockText).filter(Boolean).join('\n') : '';
      break;
    case 'plan':
      out.text = Array.isArray(update?.entries)
        ? update.entries.map((/** @type {any} */ e) => `- [${e?.status ?? '?'}] ${e?.content ?? ''}`).join('\n')
        : '';
      break;
    case 'usage_update':
      out.text = `used=${update?.used ?? '?'} size=${update?.size ?? '?'}` + (update?.cost ? ` cost=${update.cost.amount}${update.cost.currency}` : '');
      break;
    case 'current_mode_update':
      out.text = `mode=${update?.currentModeId ?? '?'}`;
      break;
    default:
      out.text = '';
  }
  return out;
}

/**
 * One-line, human-friendly rendering of a session update — used by both the CLI
 * event stream and the Web console.
 * @param {any} update
 * @returns {string|null} null when the update carries nothing worth printing
 */
export function summarizeUpdate(update) {
  const c = classifyUpdate(update);
  switch (c.kind) {
    case 'agent_message_chunk':
      return c.text || null;
    case 'agent_thought_chunk':
      return c.text ? `💭 ${c.text}` : null;
    case 'user_message_chunk':
      return null; // we already echoed it
    case 'tool_call':
      return `🔧 ${c.title || c.toolCallId} (${c.status || 'pending'})`;
    case 'tool_call_update':
      return c.text ? `🔧 ${c.toolCallId} ${c.status || ''}: ${c.text}` : `🔧 ${c.toolCallId} ${c.status || ''}`.trim();
    case 'plan':
      return c.text ? `📋 plan\n${c.text}` : null;
    case 'usage_update':
      return `📊 ${c.text}`;
    case 'current_mode_update':
      return `⚙️  ${c.text}`;
    case 'available_commands_update':
      return `⚙️  commands updated (${(update?.availableCommands || []).length})`;
    case 'session_info_update':
      return update?.title ? `📝 ${update.title}` : null;
    default:
      return null;
  }
}

/**
 * @param {string} stopReason
 * @returns {import('./states.js').TaskState}
 */
export function stateFromStopReason(stopReason) {
  return fromAcpStopReason(stopReason);
}

/**
 * Describe the client capabilities AgentMesh advertises.
 *
 * Default is deliberately conservative: we do NOT advertise `fs` or `terminal`, so
 * the agent uses its own tools inside its own machine (which is exactly what we
 * want for a remote node). Turning them on makes the agent operate on the
 * *client's* filesystem — only meaningful for a local node.
 *
 * @param {{fs?:boolean, terminal?:boolean, terminalAuth?:boolean}} [opts]
 * @returns {object}
 */
export function clientCapabilities(opts = {}) {
  /** @type {any} */
  const caps = {};
  if (opts.fs) caps.fs = { readTextFile: true, writeTextFile: true };
  if (opts.terminal) caps.terminal = true;
  if (opts.terminalAuth) caps.auth = { terminal: true };
  return caps;
}

export { TaskState };
