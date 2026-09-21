/**
 * Terminal rendering helpers (no colors library, no dependencies).
 * @module cli/render
 */

import { pad } from '../protocol/util.js';
import { EventType } from '../protocol/events.js';

const useColor = (() => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
})();

/**
 * @param {number} code
 * @param {string} s
 * @returns {string}
 */
const c = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);

export const color = {
  dim: (/** @type {string} */ s) => c('2', s),
  bold: (/** @type {string} */ s) => c('1', s),
  red: (/** @type {string} */ s) => c('31', s),
  green: (/** @type {string} */ s) => c('32', s),
  yellow: (/** @type {string} */ s) => c('33', s),
  blue: (/** @type {string} */ s) => c('34', s),
  magenta: (/** @type {string} */ s) => c('35', s),
  cyan: (/** @type {string} */ s) => c('36', s),
};

/** @type {Record<string, (s:string)=>string>} */
const STATE_COLORS = {
  queued: color.dim,
  submitted: color.blue,
  working: color.cyan,
  'input-required': color.yellow,
  'auth-required': color.yellow,
  completed: color.green,
  failed: color.red,
  canceled: color.dim,
  rejected: color.magenta,
};

/**
 * @param {string} state
 * @returns {string}
 */
export function stateBadge(state) {
  const fn = STATE_COLORS[state] || ((s) => s);
  return fn(state);
}

/**
 * Render one event as a line for a human terminal.
 * Returns null when the event should not be printed.
 * @param {any} ev
 * @param {{showLog?:boolean}} [opts]
 * @returns {string|null}
 */
export function renderEvent(ev, opts = {}) {
  switch (ev.type) {
    case EventType.CHUNK:
      return ev.text || null;
    case EventType.THOUGHT:
      return ev.text ? color.dim(`💭 ${ev.text}`) : null;
    case EventType.TOOL_CALL:
      return color.yellow(`🔧 ${ev.text}`);
    case EventType.TOOL_UPDATE:
      return color.dim(`   ${ev.text}`);
    case EventType.PLAN:
      return color.blue(ev.text);
    case EventType.USAGE:
      // summarizeUpdate() already prefixes the emoji; don't double it here.
      return color.dim(ev.text || '');
    case EventType.APPROVAL_REQUESTED: {
      const d = ev.data || {};
      const options = (d.options || []).map((/** @type {any} */ o) => `${o.kind}=${o.optionId}`).join(', ');
      return [color.yellow(`⚠️  APPROVAL REQUIRED — ${d.title}`), options ? color.dim(`   options: ${options}`) : '', color.dim(`   approval id: ${d.id}`)].filter(Boolean).join('\n');
    }
    case EventType.APPROVAL_RESOLVED:
      return color.dim(`✓ approval ${ev.text}`);
    case EventType.ERROR:
      return color.red(`✖ ${ev.text}`);
    case EventType.DONE:
      break;
    case EventType.LOG:
      if (!opts.showLog) return null;
      return color.dim(`· ${ev.text}`);
    default:
      if (!opts.showLog) return null;
      return color.dim(`${ev.type}: ${ev.text}`);
  }
  return null;
}

/**
 * A two-column table.
 * @param {string[]} headers
 * @param {string[][]} rows
 * @param {{widths?:number[]}} [opts]
 * @returns {string}
 */
export function table(headers, rows, opts = {}) {
  const widths = opts.widths || headers.map((h, i) => Math.max(String(h).length, ...rows.map((r) => String(r[i] ?? '').length)));
  const lines = [headers.map((h, i) => color.bold(pad(h, widths[i]))).join('  ')];
  lines.push(widths.map((w) => '─'.repeat(w)).join('  '));
  for (const r of rows) lines.push(widths.map((w, i) => pad(r[i] ?? '', w)).join('  '));
  return lines.join('\n');
}

/**
 * Print an error and exit non-zero.
 * @param {unknown} err
 * @param {number} [code]
 * @returns {never}
 */
export function die(err, code = 1) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${color.red('error:')} ${msg}\n`);
  if (process.env.AGENTMESH_DEBUG && err instanceof Error && err.stack) process.stderr.write(`${color.dim(err.stack)}\n`);
  process.exit(code);
}

/**
 * @param {string} s
 */
export function info(s) {
  process.stderr.write(`${color.dim(s)}\n`);
}

/**
 * @param {string} s
 */
export function ok(s) {
  process.stderr.write(`${color.green('✓')} ${s}\n`);
}
