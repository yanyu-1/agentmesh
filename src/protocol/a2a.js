/**
 * A2A (Agent2Agent) v1.0 — wire helpers.
 *
 * Authoritative sources:
 *   - `research/schemas/a2aproject__A2A__specification_a2a.proto` (proto3 + ProtoJSON)
 *   - the reference implementation AgentMesh must interoperate with:
 *     `%LOCALAPPDATA%\hermes\hermes-agent\plugins\platforms\a2a\protocol.py`
 *
 * Two details that bite if you guess:
 *   1. `Part` is discriminated by **member presence** — there is NO `kind` field in
 *      v1.0 (`{"text":"hi","mediaType":"text/plain"}`). Older 0.3 peers send
 *      `{"kind":"text","text":"hi"}`; our reader accepts both, our writer emits v1.
 *   2. `contextId` lives **inside the Message**, not at the top of `params`
 *      (legacy peers put it at both levels).
 *
 * @module protocol/a2a
 */

import { newId, nowIso } from './util.js';
import { fromA2A } from './states.js';

/** Version string sent in the `A2A-Version` header. */
export const A2A_VERSION = '1.0';

export const ROLES = /** @type {const} */ ({ USER: 'ROLE_USER', AGENT: 'ROLE_AGENT' });

export const METHODS = /** @type {const} */ ({
  SEND_MESSAGE: 'SendMessage',
  SEND_STREAMING_MESSAGE: 'SendStreamingMessage',
  GET_TASK: 'GetTask',
  LIST_TASKS: 'ListTasks',
  CANCEL_TASK: 'CancelTask',
  SUBSCRIBE_TO_TASK: 'SubscribeToTask',
  GET_EXTENDED_AGENT_CARD: 'GetExtendedAgentCard',
});

/** Legacy (0.3-era) method names, still accepted by many servers. */
export const LEGACY_METHODS = /** @type {const} */ ({
  SEND_MESSAGE: 'message/send',
  SEND_STREAMING_MESSAGE: 'message/stream',
  GET_TASK: 'tasks/get',
  CANCEL_TASK: 'tasks/cancel',
});

export const AGENT_CARD_PATHS = /** @type {const} */ (['/.well-known/agent-card.json', '/.well-known/agent.json']);

/**
 * Candidate Agent Card URLs for a base URL, in preference order (v1.0 first).
 * @param {string} baseUrl
 * @returns {string[]}
 */
export function agentCardUrls(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return AGENT_CARD_PATHS.map((p) => base + p);
}

/**
 * @param {string} text
 * @returns {{text:string, mediaType:string}}
 */
export function textPart(text) {
  return { text, mediaType: 'text/plain' };
}

/**
 * @param {{role?:string, text:string, contextId?:string, messageId?:string}} opts
 * @returns {any} an A2A v1.0 Message
 */
export function textMessage({ role = ROLES.USER, text, contextId, messageId }) {
  /** @type {any} */
  const msg = { role, parts: [textPart(text)], messageId: messageId || newId('msg').replace('msg_', '') };
  if (contextId) msg.contextId = contextId;
  return msg;
}

/**
 * Build the `params` member of a `SendMessage` JSON-RPC request.
 * @param {{text:string, contextId?:string, tenant?:string, taskId?:string, configuration?:object, metadata?:object}} opts
 * @returns {any}
 */
export function buildSendMessageParams({ text, contextId, tenant, taskId, configuration, metadata }) {
  /** @type {any} */
  const params = { message: textMessage({ text, contextId }) };
  if (tenant) params.tenant = tenant;
  if (taskId) params.message.taskId = taskId;
  if (configuration) params.configuration = configuration;
  if (metadata) params.metadata = metadata;
  return params;
}

/**
 * Extract concatenated text from an A2A Message / Task / params payload.
 * Mirrors Hermes' `extract_text` so both ends agree on what "the answer" is.
 *
 * `trim: false` is used for streamed artifact *fragments*: trimming each fragment
 * would eat the significant trailing space of `"streamed "` and glue the next
 * fragment onto it.
 *
 * @param {any} payload
 * @param {{trim?:boolean}} [opts]
 * @returns {string}
 */
export function extractText(payload, opts = {}) {
  const { trim = true } = opts;
  if (!payload || typeof payload !== 'object') return typeof payload === 'string' ? payload : '';
  const msg = payload.message && typeof payload.message === 'object' ? payload.message : payload;
  const parts = Array.isArray(msg.parts) ? msg.parts : [];
  const chunks = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    if (typeof part.text === 'string') {
      chunks.push(part.text);
    } else if (typeof part.url === 'string' && part.url) {
      chunks.push(`[file${part.filename ? `: ${part.filename}` : ''}] ${part.url}${part.mediaType ? ` (${part.mediaType})` : ''}`);
    } else if (part.file && typeof part.file.fileWithUri === 'string') {
      // v0.3 shape
      chunks.push(`[file${part.file.name ? `: ${part.file.name}` : ''}] ${part.file.fileWithUri}`);
    } else if (typeof part.raw === 'string') {
      chunks.push(`[file${part.filename ? `: ${part.filename}` : ''}] ${part.raw.length} bytes base64`);
    } else if (part.data !== undefined && part.data !== null) {
      chunks.push(`[data] ${JSON.stringify(part.data)}`);
    }
  }
  return trim ? chunks.join('\n').trim() : chunks.join('\n');
}

/**
 * v1.0 `SendMessageResponse` is a oneof of `task` | `message`; legacy servers
 * return the payload bare. Unwrap to whichever member is present.
 * @param {any} result
 * @returns {any}
 */
export function unwrapSendMessageResponse(result) {
  if (result && typeof result === 'object') {
    if (result.task && typeof result.task === 'object') return result.task;
    if (result.message && typeof result.message === 'object') return result.message;
  }
  return result;
}

/**
 * Interpret a `SendMessage` result into a normalized record.
 * @param {any} result  the JSON-RPC `result`
 * @returns {{shape:'task'|'message'|'unknown', state:string, text:string, contextId:string|null, taskId:string|null, raw:any}}
 */
export function normalizeSendResult(result) {
  const payload = unwrapSendMessageResponse(result);
  if (payload && typeof payload === 'object' && payload.status && payload.id) {
    const state = fromA2A(payload.status.state);
    const artifactText = Array.isArray(payload.artifacts)
      ? payload.artifacts.map((/** @type {any} */ a) => extractText(a)).filter(Boolean).join('\n')
      : '';
    const statusText = extractText(payload.status.message || {});
    return {
      shape: 'task',
      state,
      text: artifactText || statusText,
      contextId: payload.contextId ?? null,
      taskId: payload.id ?? null,
      raw: payload,
    };
  }
  if (payload && typeof payload === 'object' && Array.isArray(payload.parts)) {
    return {
      shape: 'message',
      state: 'completed',
      text: extractText(payload),
      contextId: payload.contextId ?? null,
      taskId: payload.taskId ?? null,
      raw: payload,
    };
  }
  return { shape: 'unknown', state: 'completed', text: typeof payload === 'string' ? payload : JSON.stringify(payload), contextId: null, taskId: null, raw: payload };
}

/**
 * Is this hostname reachable only from inside a private network?
 *
 * Needed because an Agent Card very commonly advertises an RPC URL on the agent's own
 * LAN/VPC address (`http://172.24.225.207:9900/`), even when the operator reached the
 * card over a public address. Following that literally sends the task to an unroutable
 * address, which looks exactly like a firewall problem but is really a server-side
 * misconfiguration we can work around.
 *
 * Covers RFC1918, loopback, link-local, CGNAT, multicast IPv4, and the IPv6
 * loopback / ULA / link-local ranges, plus the usual internal-looking hostnames.
 *
 * @param {string} host  a hostname or IP literal (no port)
 * @returns {boolean}
 */
export function isPrivateHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;

  // IPv6
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // fc00::/7 unique-local
    if (/^fe[89ab][0-9a-f]:/.test(h)) return true; // fe80::/10 link-local
    // IPv4-mapped (::ffff:172.24.1.1)
    const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateHost(mapped[1]);
    return false;
  }

  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false; // a real DNS name: assume routable
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

/**
 * Fold prior conversation turns into the message about to be sent.
 *
 * A2A carries continuity in `contextId`, and a peer that keeps server-side context
 * needs nothing more. A peer that does not — one that accepts and echoes the
 * `contextId` but builds each prompt from the latest message alone — will otherwise
 * answer every turn in isolation, which reads like a conversation while being a series
 * of unrelated exchanges. Replaying the turns locally is the only way to give such a
 * peer the conversation.
 *
 * The transcript format is deliberately the plain `role: text` shape every chat model
 * was trained on, rather than prose the peer might summarise away.
 *
 * @param {string} text
 * @param {{role:'user'|'assistant', text:string}[]|undefined|null} history
 * @returns {string}
 */
export function withConversationHistory(text, history) {
  if (!Array.isArray(history) || history.length === 0) return text;
  const lines = history
    .filter((t) => t && typeof t.text === 'string' && t.text.trim())
    .map((t) => `${t.role === 'assistant' ? 'assistant' : 'user'}: ${t.text.trim()}`);
  if (lines.length === 0) return text;
  // A bare transcript with no framing invites the peer to reply to the LAST history
  // line instead of to the new message, so the new message is labelled explicitly.
  return `<earlier conversation>\n${lines.join('\n')}\n</earlier conversation>\n\nuser: ${text}`;
}

/**
 * Does this peer want the v0.3 method names (`message/send`) rather than the v1.0
 * ones (`SendMessage`)?
 *
 * A v1.0 card advertises `supportedInterfaces` containing a JSONRPC binding, and its
 * `protocolVersion` says which revision it speaks. A legacy card has neither — and a
 * real server in that state answers `SendMessage` with `-32601 Method not found`,
 * which is exactly what a live Hermes v0.14 A2A bridge did on first contact.
 *
 * @param {any} card
 * @param {{protocolVersion?:string|null}} [target]
 * @returns {boolean}
 */
export function prefersLegacyMethods(card, target) {
  const ifaces = Array.isArray(card?.supportedInterfaces) ? card.supportedInterfaces : [];
  const jsonrpc = ifaces.find(
    (/** @type {any} */ i) => i && typeof i === 'object' && String(i.protocolBinding || '').toUpperCase() === 'JSONRPC',
  );
  // An explicit revision wins; otherwise trust the one the card's JSONRPC interface
  // declares. Reading it from the interface matters: a v0.3 card carries `0.3` there,
  // so looking only at `target` would wrongly pick the v1.0 method names.
  const version = target?.protocolVersion ?? jsonrpc?.protocolVersion ?? null;
  if (version) return !String(version).startsWith('1.');
  return !jsonrpc; // no declared revision: legacy unless the card is v1.0-shaped
}

/**
 * Is this JSON-RPC error the peer saying "I do not know that method"?
 *
 * Used to retry once with the other protocol revision's naming, because a card can be
 * wrong about which revision its server actually implements.
 *
 * @param {any} error  the `error` member of a JSON-RPC response
 * @returns {boolean}
 */
export function isMethodNotFound(error) {
  if (!error || typeof error !== 'object') return false;
  if (Number(error.code) === -32601) return true;
  return /method\s+not\s+found/i.test(String(error.message ?? ''));
}

/**
 * Pick the JSON-RPC endpoint out of an Agent Card.
 * v1.0: `supportedInterfaces[].url` where `protocolBinding === 'JSONRPC'`.
 * Fallbacks: card.url (legacy), then the base URL we discovered from.
 * @param {any} card
 * @param {string} baseUrl
 * @returns {{url:string, tenant:string, protocolVersion:string|null}}
 */
export function cardRpcTarget(card, baseUrl) {
  const fallback = { url: String(baseUrl || '').replace(/\/+$/, ''), tenant: '', protocolVersion: null };
  if (!card || typeof card !== 'object') return fallback;
  const ifaces = Array.isArray(card.supportedInterfaces) ? card.supportedInterfaces : [];
  const jsonrpc = ifaces.find((/** @type {any} */ i) => i && typeof i === 'object' && String(i.protocolBinding || '').toUpperCase() === 'JSONRPC' && i.url);
  if (jsonrpc) {
    return { url: String(jsonrpc.url), tenant: jsonrpc.tenant ? String(jsonrpc.tenant) : '', protocolVersion: jsonrpc.protocolVersion ?? null };
  }
  if (typeof card.url === 'string' && card.url) return { ...fallback, url: card.url };
  return fallback;
}

/**
 * Summarize an Agent Card for humans (CLI `mesh probe`, Web node detail).
 * @param {any} card
 * @returns {{name:string, description:string, version:string, provider:string, streaming:boolean,
 *            pushNotifications:boolean, authRequired:boolean, interface:string, skills:Array<{id:string,name:string,description:string,tags:string[]}>}}
 */
export function summarizeCard(card) {
  const c = card && typeof card === 'object' ? card : {};
  const ifaces = Array.isArray(c.supportedInterfaces) ? c.supportedInterfaces : [];
  const iface = ifaces
    .filter((/** @type {any} */ i) => i && typeof i === 'object')
    .map((/** @type {any} */ i) => `${i.protocolBinding || '?'} v${i.protocolVersion || '?'}`)
    .join(', ');
  return {
    name: String(c.name ?? '?'),
    description: String(c.description ?? ''),
    version: String(c.version ?? '?'),
    provider: String(c.provider?.organization ?? ''),
    streaming: Boolean(c.capabilities?.streaming),
    pushNotifications: Boolean(c.capabilities?.pushNotifications),
    authRequired: Boolean(
      (Array.isArray(c.security) && c.security.length > 0) ||
        (Array.isArray(c.securityRequirements) && c.securityRequirements.length > 0) ||
        (c.securitySchemes && Object.keys(c.securitySchemes).length > 0),
    ),
    interface: iface || 'legacy',
    skills: (Array.isArray(c.skills) ? c.skills : []).map((/** @type {any} */ s) => ({
      id: String(s?.id ?? ''),
      name: String(s?.name ?? ''),
      description: String(s?.description ?? ''),
      tags: Array.isArray(s?.tags) ? s.tags.map(String) : [],
    })),
  };
}

/**
 * Incremental SSE parser for A2A streaming (`SendStreamingMessage`) and the
 * opencode `/event` endpoint, which use the same framing.
 *
 * Handles: `data:` accumulation across lines, `event:` names, `id:`, comments,
 * and multi-line data joined with `\n` (per the SSE spec).
 *
 * @returns {{push:(chunk:string|Buffer)=>Array<{event:string|null,data:string,id:string|null,retry:number|null}>, flush:()=>Array<any>}}
 */
export function createSseParser() {
  let buf = '';
  /** @type {{event:string|null,data:string[],id:string|null,retry:number|null}|null} */
  let cur = null;

  const finish = (/** @type {any} */ frame) => ({
    event: frame.event,
    data: frame.data.join('\n'),
    id: frame.id,
    retry: frame.retry,
  });

  return {
    push(chunk) {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      /** @type {any[]} */
      const out = [];
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);

        if (line === '') {
          // blank line dispatches the frame
          if (cur && cur.data.length) out.push(finish(cur));
          cur = null;
          continue;
        }
        if (line.startsWith(':')) continue; // comment / keep-alive
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (!cur) cur = { event: null, data: [], id: null, retry: null };
        if (field === 'data') cur.data.push(value);
        else if (field === 'event') cur.event = value;
        else if (field === 'id') cur.id = value;
        else if (field === 'retry') cur.retry = Number(value);
      }
      return out;
    },
    flush() {
      const out = [];
      if (cur && cur.data.length) out.push(finish(cur));
      cur = null;
      buf = '';
      return out;
    },
  };
}

/**
 * Parse one SSE `data:` payload into a normalized A2A stream event.
 * A2A requires a full JSON-RPC envelope on the stream (§9.4); bare
 * `StreamResponse` payloads are tolerated for older servers.
 *
 * @param {string} data
 * @returns {{type:'status'|'artifact'|'task'|'message'|'done'|'other', state:string|null,
 *            text:string, contextId:string|null, taskId:string|null, raw:any}|null}
 */
export function parseStreamPayload(data) {
  const trimmed = String(data ?? '').trim();
  if (!trimmed) return null;
  if (trimmed === '[DONE]') return { type: 'done', state: null, text: '', contextId: null, taskId: null, raw: trimmed };
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { type: 'other', state: null, text: trimmed, contextId: null, taskId: null, raw: trimmed };
  }
  if (parsed && parsed.error) {
    return { type: 'other', state: 'failed', text: String(parsed.error.message ?? 'stream error'), contextId: null, taskId: null, raw: parsed };
  }
  const result = parsed && parsed.result !== undefined ? parsed.result : parsed;

  if (result?.statusUpdate) {
    const su = result.statusUpdate;
    return {
      type: 'status',
      state: fromA2A(su.status?.state),
      text: extractText(su.status?.message || {}),
      contextId: su.contextId ?? null,
      taskId: su.taskId ?? null,
      raw: result,
    };
  }
  if (result?.artifactUpdate) {
    const au = result.artifactUpdate;
    return {
      type: 'artifact',
      state: 'working',
      text: extractText(au.artifact || {}, { trim: false }),
      contextId: au.contextId ?? null,
      taskId: au.taskId ?? null,
      // A2A TaskArtifactUpdateEvent: `append` false/absent means "replace".
      artifactId: au.artifact?.artifactId ?? null,
      append: au.append === true,
      raw: result,
    };
  }
  if (result?.task) {
    const t = result.task;
    return {
      type: 'task',
      state: fromA2A(t.status?.state),
      text: extractText(t.status?.message || {}) || (Array.isArray(t.artifacts) ? t.artifacts.map((/** @type {any} */ a) => extractText(a)).filter(Boolean).join('\n') : ''),
      contextId: t.contextId ?? null,
      taskId: t.id ?? null,
      raw: result,
    };
  }
  if (result?.message) {
    return { type: 'message', state: 'working', text: extractText(result.message), contextId: result.message.contextId ?? null, taskId: null, raw: result };
  }
  const normalized = normalizeSendResult(result);
  return { type: 'other', state: normalized.state, text: normalized.text, contextId: normalized.contextId, taskId: normalized.taskId, raw: result };
}

/**
 * Build a `SendMessage` JSON-RPC request body.
 * @param {{text:string, contextId?:string, tenant?:string, taskId?:string, id?:string|number, method?:string}} opts
 * @returns {any}
 */
export function buildSendMessageRequest({ text, contextId, tenant, taskId, id, method = METHODS.SEND_MESSAGE }) {
  return {
    jsonrpc: '2.0',
    id: id ?? newId('rpc'),
    method,
    params: buildSendMessageParams({ text, contextId, tenant, taskId }),
  };
}

/**
 * Build a `GetTask` request body (legacy name accepted by most v0.3 servers).
 * @param {{taskId:string, historyLength?:number, id?:string|number, legacy?:boolean}} opts
 * @returns {any}
 */
export function buildGetTaskRequest({ taskId, historyLength, id, legacy = false }) {
  /** @type {any} */
  const params = { id: taskId };
  if (typeof historyLength === 'number') params.historyLength = historyLength;
  return { jsonrpc: '2.0', id: id ?? newId('rpc'), method: legacy ? LEGACY_METHODS.GET_TASK : METHODS.GET_TASK, params };
}

/**
 * Build a `CancelTask` request body.
 * @param {{taskId:string, id?:string|number, legacy?:boolean}} opts
 * @returns {any}
 */
export function buildCancelTaskRequest({ taskId, id, legacy = false }) {
  return { jsonrpc: '2.0', id: id ?? newId('rpc'), method: legacy ? LEGACY_METHODS.CANCEL_TASK : METHODS.CANCEL_TASK, params: { id: taskId } };
}

/**
 * A stable, human-readable summary of an Agent Card's skills for the CLI.
 * @param {any} card
 * @returns {string}
 */
export function cardSkillLines(card) {
  const s = summarizeCard(card);
  if (!s.skills.length) return '  (no skills advertised)';
  return s.skills.map((sk) => `  - ${sk.name || sk.id}: ${sk.description}${sk.tags.length ? `  [${sk.tags.join(', ')}]` : ''}`).join('\n');
}

export { nowIso };
