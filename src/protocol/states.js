/**
 * Unified task-state model.
 *
 * A2A's TaskState is the baseline (it is the only one of the two protocols that
 * has a real task lifecycle); ACP's StopReason and process outcomes are mapped
 * into it. See PLAN.md §3.2.
 *
 * @module protocol/states
 */

/** @typedef {'queued'|'submitted'|'working'|'input-required'|'auth-required'|'completed'|'failed'|'canceled'|'rejected'} TaskState */

export const TaskState = /** @type {const} */ ({
  QUEUED: 'queued',
  SUBMITTED: 'submitted',
  WORKING: 'working',
  INPUT_REQUIRED: 'input-required',
  AUTH_REQUIRED: 'auth-required',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELED: 'canceled',
  REJECTED: 'rejected',
});

/** States from which a task never moves again. */
export const TERMINAL_STATES = new Set([
  TaskState.COMPLETED,
  TaskState.FAILED,
  TaskState.CANCELED,
  TaskState.REJECTED,
]);

/** States where the remote agent is blocked on us. */
export const WAITING_STATES = new Set([TaskState.INPUT_REQUIRED, TaskState.AUTH_REQUIRED]);

/** Active (non-terminal, not waiting) states. */
export const ACTIVE_STATES = new Set([TaskState.QUEUED, TaskState.SUBMITTED, TaskState.WORKING]);

/**
 * @param {string} state
 * @returns {boolean}
 */
export function isTerminal(state) {
  return TERMINAL_STATES.has(/** @type {TaskState} */ (state));
}

/**
 * Map an A2A TaskState wire value to the unified model.
 * Accepts v1.0 (`TASK_STATE_WORKING`), v0.3 (`working`) and `-`/`_` spellings.
 * @param {string} wire
 * @returns {TaskState|string}
 */
export function fromA2A(wire) {
  if (!wire) return TaskState.WORKING;
  const raw = String(wire).trim();
  const key = raw
    .replace(/^TASK_STATE_/i, '')
    .replace(/^TASK_STATE/i, '')
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
  switch (key) {
    case 'submitted':
      return TaskState.SUBMITTED;
    case 'working':
      return TaskState.WORKING;
    case 'input-required':
      return TaskState.INPUT_REQUIRED;
    case 'auth-required':
      return TaskState.AUTH_REQUIRED;
    case 'completed':
      return TaskState.COMPLETED;
    case 'failed':
      return TaskState.FAILED;
    case 'canceled':
    case 'cancelled':
      return TaskState.CANCELED;
    case 'rejected':
      return TaskState.REJECTED;
    case 'unspecified':
    case '':
      return TaskState.WORKING;
    default:
      return key;
  }
}

/**
 * Map an ACP StopReason to the unified model.
 * @param {string} stopReason
 * @returns {TaskState}
 */
export function fromAcpStopReason(stopReason) {
  switch (String(stopReason || '').toLowerCase()) {
    case 'end_turn':
      return TaskState.COMPLETED;
    case 'cancelled':
    case 'canceled':
      return TaskState.CANCELED;
    case 'refusal':
    case 'max_tokens':
    case 'max_turn_requests':
      return TaskState.FAILED;
    default:
      return TaskState.COMPLETED;
  }
}

/**
 * Human label, stable across the codebase (CLI + Web).
 * @param {string} state
 * @returns {string}
 */
export function label(state) {
  return (
    {
      [TaskState.QUEUED]: 'queued',
      [TaskState.SUBMITTED]: 'submitted',
      [TaskState.WORKING]: 'working',
      [TaskState.INPUT_REQUIRED]: 'input-required',
      [TaskState.AUTH_REQUIRED]: 'auth-required',
      [TaskState.COMPLETED]: 'completed',
      [TaskState.FAILED]: 'failed',
      [TaskState.CANCELED]: 'canceled',
      [TaskState.REJECTED]: 'rejected',
    }[state] || String(state)
  );
}
