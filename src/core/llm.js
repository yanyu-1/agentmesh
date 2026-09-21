// Minimal OpenAI-compatible chat client.
//
// Deliberately hand-written rather than pulled from npm: the whole point of the
// local orchestrator is that its behaviour, permissions and wire format stay under
// our control, with no upstream release cadence to chase. `/chat/completions` with
// `tools` is a small, stable, well-documented shape, so a dependency would buy us
// nothing but a supply chain.

import { postJson, getJson, HttpError } from './transport/http.js';
import { meshHome } from '../protocol/util.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @typedef {object} LlmConfig
 * @property {string} baseUrl   e.g. http://10.0.0.5:8000/v1
 * @property {string} model
 * @property {string} [apiKey]
 * @property {number} [timeoutMs]
 * @property {number} [maxTokens]
 * @property {number} [temperature]
 */

/** @type {LlmConfig|null} */
let override = null;

/** Where the persisted (non-secret) provider settings live. */
export function llmConfigPath() {
  return join(meshHome(), 'llm.json');
}

/**
 * Read the persisted settings. Deliberately returns only non-secret fields: the file
 * names an environment variable to read the key from, it never holds the key itself.
 * A config file that contains a live credential is a credential in every backup, every
 * screen-share and every pasted bug report.
 * @returns {{baseUrl?:string, model?:string, apiKeyEnv?:string, ignoredApiKey?:boolean}}
 */
export function readLlmConfigFile() {
  try {
    const j = JSON.parse(readFileSync(llmConfigPath(), 'utf8'));
    return {
      baseUrl: typeof j.baseUrl === 'string' ? j.baseUrl : undefined,
      model: typeof j.model === 'string' ? j.model : undefined,
      apiKeyEnv: typeof j.apiKeyEnv === 'string' ? j.apiKeyEnv : undefined,
      ignoredApiKey: typeof j.apiKey === 'string' && j.apiKey.length > 0,
    };
  } catch {
    return {};
  }
}

/**
 * Persist provider settings. Refuses to write anything secret-looking, so a careless
 * `--save --api-key …` cannot quietly put a credential on disk.
 * @param {{baseUrl?:string, model?:string, apiKeyEnv?:string}} cfg
 */
export function saveLlmConfig(cfg) {
  if (cfg.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(cfg.apiKeyEnv)) {
    throw new Error(`--api-key-env must be an environment variable NAME, not the key itself (got ${cfg.apiKeyEnv.length} chars)`);
  }
  /** @type {Record<string,string>} */
  const out = {};
  if (cfg.baseUrl) out.baseUrl = cfg.baseUrl;
  if (cfg.model) out.model = cfg.model;
  if (cfg.apiKeyEnv) out.apiKeyEnv = cfg.apiKeyEnv;
  writeFileSync(llmConfigPath(), `${JSON.stringify(out, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return llmConfigPath();
}

/**
 * Provider settings, resolved in this order:
 *   1. an explicit override (tests, or `mesh agent --base-url …`)
 *   2. environment (`AGENTMESH_LLM_BASE_URL` / `_API_KEY` / `_MODEL`, or the generic
 *      `OPENAI_BASE_URL` / `OPENAI_API_KEY`)
 *   3. `.agentmesh/llm.json`, written by `mesh agent save`
 *
 * No default API key is ever baked in, and the key is never logged.
 *
 * @returns {LlmConfig}
 */
export function llmConfig() {
  if (override) return override;
  const file = readLlmConfigFile();
  const envKey = process.env.AGENTMESH_LLM_API_KEY || process.env.OPENAI_API_KEY || '';
  // Resolve the key through the named variable only if it is actually set, so a typo in
  // the name surfaces as "no credentials" rather than as an empty Bearer token.
  const fileKey = file.apiKeyEnv ? process.env[file.apiKeyEnv] ?? '' : '';
  return {
    baseUrl: process.env.AGENTMESH_LLM_BASE_URL || process.env.OPENAI_BASE_URL || file.baseUrl || '',
    apiKey: envKey || fileKey,
    model: process.env.AGENTMESH_LLM_MODEL || file.model || '',
    timeoutMs: Number(process.env.AGENTMESH_LLM_TIMEOUT_MS ?? 0) || undefined,
  };
}

/**
 * Replace the resolved config. Used by tests and by the CLI when flags are given.
 * @param {Partial<LlmConfig>|null} cfg
 */
export function setLlmConfig(cfg) {
  override = cfg ? { ...(override ?? {}), ...cfg } : null;
}

/**
 * Layer a change onto the CURRENTLY RESOLVED config and make that the live one.
 *
 * `setLlmConfig` merges into the override object, but `llmConfig()` returns the override
 * wholesale once it exists. So `setLlmConfig({apiKey})` — which is what the Web console
 * did when you typed a key — produced an override of `{apiKey}` with no `baseUrl` and no
 * `model`, silently blanking an endpoint that had been resolved from the file or the
 * environment. Typing a key made the console *less* configured than before.
 *
 * Resolving first and then layering avoids that, and keeps the precedence rules in
 * `llmConfig()` intact for everything the patch does not mention.
 *
 * @param {Partial<LlmConfig>} patch
 * @returns {LlmConfig}
 */
export function applyLlmRuntime(patch) {
  override = { ...llmConfig(), ...patch };
  return override;
}

/**
 * Is the configuration complete enough to make a call?
 * @param {Partial<LlmConfig>} [cfg]
 * @returns {{ok:boolean, missing:string[]}}
 */
export function llmReady(cfg = llmConfig()) {
  const missing = [];
  if (!cfg.baseUrl) missing.push('baseUrl');
  if (!cfg.model) missing.push('model');
  return { ok: missing.length === 0, missing };
}

/**
 * Join a base URL and a path without doubling or dropping the slash.
 * `http://host/v1` + `/chat/completions` -> `http://host/v1/chat/completions`
 * @param {string} baseUrl
 * @param {string} path
 */
export function joinUrl(baseUrl, path) {
  const b = String(baseUrl).replace(/\/+$/, '');
  // Collapse leading slashes on the path as well: `//models` survives into the
  // request line and some servers answer it with a 404.
  const p = String(path).replace(/^\/+/, '');
  return p ? `${b}/${p}` : b;
}

/**
 * Turn a chat-completions response into a normalised assistant turn.
 *
 * Providers differ in small ways here (some omit `tool_calls` entirely, some send
 * `arguments` as an object instead of a JSON string, some use a legacy
 * `function_call`), so normalise once instead of at every call site.
 *
 * @param {any} res
 * @returns {{content:string, toolCalls:{id:string, name:string, args:any, raw:string}[], finishReason:string, usage:any}}
 */
export function normalizeCompletion(res) {
  const choice = res?.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  /** @type {{id:string, name:string, args:any, raw:string}[]} */
  const toolCalls = [];
  const rawCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  for (const [i, c] of rawCalls.entries()) {
    const name = c?.function?.name ?? c?.name ?? '';
    let raw = c?.function?.arguments ?? c?.arguments ?? '';
    if (raw && typeof raw === 'object') raw = JSON.stringify(raw);
    raw = typeof raw === 'string' ? raw : String(raw ?? '');
    toolCalls.push({ id: c?.id || `call_${i}`, name, args: parseToolArgs(raw), raw });
  }
  // Legacy single-call shape, kept because small local servers still emit it.
  if (toolCalls.length === 0 && msg.function_call) {
    const raw = typeof msg.function_call.arguments === 'string' ? msg.function_call.arguments : JSON.stringify(msg.function_call.arguments ?? {});
    toolCalls.push({ id: 'call_0', name: msg.function_call.name ?? '', args: parseToolArgs(raw), raw });
  }
  const content = typeof msg.content === 'string' ? msg.content : msg.content == null ? '' : JSON.stringify(msg.content);
  return { content, toolCalls, finishReason: choice.finish_reason ?? '', usage: res?.usage ?? null };
}

/**
 * Parse tool arguments, tolerating the empty string and malformed JSON that local
 * servers produce. A model that emits broken JSON should get a chance to fix it, so
 * the parse failure is reported as data rather than thrown.
 * @param {string} raw
 * @returns {any}
 */
export function parseToolArgs(raw) {
  if (!raw || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __parseError: raw };
  }
}

/**
 * Raise a useful error for a failed LLM call.
 *
 * Routing on the HTTP status alone is not possible: the gateway in front of our
 * models answers **401 for four unrelated failures** — an unknown model name, a model
 * the plan excludes, a missing API key, and a bad key all come back 401. Diagnosing
 * from the status therefore mislabels them (it reported "your plan does not include
 * this model" for a plain typo). The response *body* distinguishes them cleanly, so
 * that is what we match on.
 *
 * @param {unknown} err
 * @param {string} model
 * @returns {never}
 */
export function rethrowLlmError(err, model) {
  if (!(err instanceof HttpError)) throw err;
  const body = String(err.body ?? '');
  const gw = gatewayMessage(body);

  if (/missing api key|api key.*(missing|invalid|required)|invalid.*api.?key|incorrect api key/i.test(body)) {
    throw new Error(
      `the gateway rejected our credentials (HTTP ${err.status})${gw ? `: ${gw}` : ''}. ` +
        `Set AGENTMESH_LLM_API_KEY (or pass --api-key-env).`,
    );
  }
  if (/MODEL_NOT_IN_PLAN|not in .{0,20}plan/i.test(body)) {
    throw new Error(`model '${model}' exists but this account's plan does not include it (HTTP ${err.status})${gw ? `: ${gw}` : ''}. Pick another --model.`);
  }
  if (/not recognized|model.{0,20}(not found|unknown)|no such model|unknown model/i.test(body)) {
    throw new Error(
      `the gateway does not recognise model '${model}' (HTTP ${err.status})${gw ? `: ${gw}` : ''}. ` +
        `Run 'mesh agent models' to see what it serves (a missing provider prefix is a common cause).`,
    );
  }
  if (err.status === 429) {
    throw new Error(`the gateway rate-limited model '${model}' (HTTP 429). Retry, or pick another --model.`);
  }
  if (err.status >= 500) {
    throw new Error(`the gateway failed on model '${model}' (HTTP ${err.status})${gw ? `: ${gw}` : ''}. This is server-side; retry.`);
  }
  throw new Error(`the gateway returned HTTP ${err.status} for model '${model}'${gw ? `: ${gw}` : `: ${body.slice(0, 200)}`}`);
}

/**
 * Pull the human-readable message out of an OpenAI-shaped error body, so the
 * gateway's own wording (which is usually the most specific thing available) reaches
 * the user instead of being truncated mid-JSON.
 * @param {string} body
 * @returns {string}
 */
export function gatewayMessage(body) {
  if (!body) return '';
  try {
    const j = JSON.parse(body);
    const msg = j?.error?.message ?? j?.message ?? j?.error;
    return typeof msg === 'string' ? msg.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  } catch {
    return body.replace(/\s+/g, ' ').trim().slice(0, 300);
  }
}

/**
 * One chat completion.
 *
 * @param {object} opts
 * @param {{role:string, content?:any, tool_calls?:any, tool_call_id?:string, name?:string}[]} opts.messages
 * @param {any[]} [opts.tools]        OpenAI tool schema array
 * @param {string} [opts.toolChoice]
 * @param {import('./llm.js').LlmConfig} [opts.config]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{content:string, toolCalls:{id:string,name:string,args:any,raw:string}[], finishReason:string, usage:any}>}
 */
export async function chat({ messages, tools, toolChoice, config, signal }) {
  const cfg = { ...llmConfig(), ...(config ?? {}) };
  const ready = llmReady(cfg);
  if (!ready.ok) {
    throw new Error(
      `LLM not configured (missing ${ready.missing.join(', ')}). Set AGENTMESH_LLM_BASE_URL / AGENTMESH_LLM_MODEL ` +
        `(and AGENTMESH_LLM_API_KEY if needed), or pass --base-url/--model.`,
    );
  }
  /** @type {Record<string,any>} */
  const body = {
    model: cfg.model,
    messages,
    stream: false,
  };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = toolChoice ?? 'auto';
  }
  if (cfg.maxTokens) body.max_tokens = cfg.maxTokens;
  if (typeof cfg.temperature === 'number') body.temperature = cfg.temperature;

  /** @type {Record<string,string>} */
  const headers = {};
  // Local gateways often run unauthenticated, so the header is only sent when a key
  // exists — sending `Bearer ` with an empty key breaks some of them.
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

  try {
    const res = await postJson({
      url: joinUrl(cfg.baseUrl, '/chat/completions'),
      body,
      headers,
      signal,
      timeoutMs: cfg.timeoutMs ?? 0,
    });
    return normalizeCompletion(res);
  } catch (err) {
    rethrowLlmError(err, cfg.model);
  }
}

/**
 * List model ids the gateway advertises. Used by `mesh agent models` and by the
 * "your model name is wrong" path, because guessing a model id wastes real time.
 * @param {Partial<LlmConfig>} [config]
 * @returns {Promise<string[]>}
 */
export async function listModels(config) {
  const cfg = { ...llmConfig(), ...(config ?? {}) };
  if (!cfg.baseUrl) {
    throw new Error(
      'LLM not configured: no API base URL. Set it in the console (编排 Agent → 模型设置 → API 地址) ' +
        'or pass --base-url / AGENTMESH_LLM_BASE_URL.',
    );
  }
  /** @type {Record<string,string>} */
  const headers = {};
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  try {
    const res = await getJson({ url: joinUrl(cfg.baseUrl, '/models'), headers, timeoutMs: cfg.timeoutMs ?? 20_000 });
    const list = res?.data ?? res?.models;
    // Returning [] here would report "this gateway serves no models" for what is
    // really "this endpoint is not OpenAI-compatible". Those need different fixes.
    if (!Array.isArray(list)) {
      throw new Error(
        `the endpoint at ${cfg.baseUrl} did not return a model list (expected {"data":[…]} or {"models":[…]}); ` +
          `is it an OpenAI-compatible /v1 endpoint?`,
      );
    }
    return list.map((m) => String(m?.id ?? m?.name ?? m)).filter(Boolean).sort();
  } catch (err) {
    rethrowLlmError(err, cfg.model ?? '(none)');
  }
}
