/**
 * Unified event vocabulary.
 *
 * Every adapter (ACP, A2A, opencode, CLI) emits the same event shapes, so the CLI
 * renderer, the Web console and the store never need to know which protocol a
 * node speaks.
 *
 * @module protocol/events
 */

export const EventType = /** @type {const} */ ({
  /** A task record was created locally. */
  TASK_CREATED: 'task-created',
  /** Unified TaskState transition. `data.state` holds the new state. */
  TASK_STATE: 'task-state',
  /** Session/context established (ACP sessionId or A2A contextId). */
  SESSION: 'session',
  /** Streamed assistant text. */
  CHUNK: 'chunk',
  /** Streamed model reasoning/thought (ACP only). */
  THOUGHT: 'thought',
  /** A tool call was announced. */
  TOOL_CALL: 'tool-call',
  /** A tool call produced output / changed status. */
  TOOL_UPDATE: 'tool-update',
  /** Agent plan update. */
  PLAN: 'plan',
  /** Token/cost usage report. */
  USAGE: 'usage',
  /** Remote agent is blocked waiting for our decision. */
  APPROVAL_REQUESTED: 'approval-requested',
  /** The decision was made and sent back. */
  APPROVAL_RESOLVED: 'approval-resolved',
  /**
   * The task stopped in a waiting state: nothing is running, and nothing will happen until the
   * operator replies. `data.question` is what the remote asked (empty when it did not say) and
   * `data.replyWith` is the command that answers it.
   *
   * This is distinct from `APPROVAL_REQUESTED` on purpose. An approval is a decision the console
   * can put on a button, because ACP and opencode ask with a fixed set of options. A2A's
   * `TASK_STATE_INPUT_REQUIRED` asks for **free text** — there is no option set to render, and the
   * peer's question is the only thing to show. Modelling it as an approval would put a button in
   * the panel that cannot carry the operator's words, so it is its own event instead: unmissable,
   * and honest about the fact that a human has to type something.
   */
  NEEDS_INPUT: 'needs-input',
  /** Free-form adapter log line (stderr, connectivity, protocol noise). */
  LOG: 'log',
  /** Something went wrong. `data.error` holds the message. */
  ERROR: 'error',
  /** Terminal event for the task; `data.state` holds the final state. */
  DONE: 'done',
});

/**
 * The event types that arrive as a **stream of fragments** rather than as one complete
 * statement: several events with the same `nodeId`/`taskId` together make up a single
 * logical message, and ACP fragments can be a single character (`agent_message_chunk` in
 * `src/core/adapters/acp.js`).
 *
 * A renderer must therefore append consecutive fragments to one line rather than giving each
 * its own: one line per fragment turned a paragraph into hundreds of single-letter lines.
 * Every other event type is a complete statement and starts a new line.
 *
 * Cross-checked against the console by `test/ui-events.test.js`, so adding a streaming type
 * here fails the suite until the log panel coalesces it.
 */
export const STREAMED_EVENTS = new Set([EventType.CHUNK, EventType.THOUGHT]);

/**
 * @typedef {object} MeshEvent
 * @property {string} ts        ISO timestamp
 * @property {string} nodeId
 * @property {string|null} taskId
 * @property {string} type      one of EventType
 * @property {string} [text]    human-facing text
 * @property {any} [data]       structured payload
 */

/**
 * @param {Partial<MeshEvent> & {nodeId:string, type:string}} ev
 * @returns {MeshEvent}
 */
export function makeEvent(ev) {
  return {
    ts: new Date().toISOString(),
    taskId: null,
    text: '',
    ...ev,
  };
}
