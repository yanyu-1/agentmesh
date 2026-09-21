/**
 * Small shared helpers. Deliberately dependency-free.
 * @module protocol/util
 */

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

/**
 * Generate a short, prefixed, collision-resistant id.
 * @param {string} prefix
 * @returns {string}
 */
export function newId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/** @returns {string} ISO-8601 UTC timestamp with millisecond precision. */
export function nowIso() {
  return new Date().toISOString();
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
export function truncate(value, max = 200) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (s == null) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Parse JSON without throwing.
 * @param {string} text
 * @returns {any|null}
 */
export function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Expand a leading `~` to the user's home directory.
 * @param {string} p
 * @returns {string}
 */
export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Root directory for AgentMesh state. Override with AGENTMESH_HOME.
 * @returns {string}
 */
export function meshHome() {
  const dir = process.env.AGENTMESH_HOME
    ? resolve(expandHome(process.env.AGENTMESH_HOME))
    : join(homedir(), '.agentmesh');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Render an error as a single short line (used in CLI output and event logs).
 * @param {unknown} err
 * @returns {string}
 */
export function errLine(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Format a duration in ms as a compact human string.
 * @param {number} ms
 * @returns {string}
 */
export function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${String(s).padStart(2, '0')}s`;
}

/**
 * Right-pad to a visible width (ASCII-safe enough for CLI tables).
 * @param {unknown} v
 * @param {number} w
 * @returns {string}
 */
export function pad(v, w) {
  const s = String(v ?? '');
  // CJK chars occupy two columns in a terminal; approximate for nicer tables.
  let width = 0;
  for (const ch of s) width += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  return s + ' '.repeat(Math.max(0, w - width));
}
