// @ts-check
// spell-out-exempt: `num_turns` is a field of Claude Code's result event.
//
// Reduces one turn's Claude Code event stream to a `StreamReduction`. The CLI
// backend feeds raw `--output-format stream-json` stdout; the Agent SDK
// backend feeds the SDK's message objects, which have the same shapes.
//
// A turn has exactly one terminal `result` event. A `result` from a
// background task (`origin.kind === 'task-notification'`) is not the turn's.
// An unparseable line or a second terminal result makes the stream
// `malformed`, which the backend reports as `unavailable`, never as success.

/** @import { InferUsage } from '@endo/inference/types.js' */
/** @import { ClaudeStreamReducer, StreamReduction } from './backends.types.js' */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = value =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
const nonNegative = value =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

const USAGE_FIELDS = harden(
  /** @type {const} */ ([
    ['inputTokens', 'input_tokens'],
    ['outputTokens', 'output_tokens'],
    ['cacheReadTokens', 'cache_read_input_tokens'],
    ['cacheWriteTokens', 'cache_creation_input_tokens'],
  ]),
);

/**
 * Reads the seam's `InferUsage` from a terminal `result` event.
 *
 * @param {Record<string, unknown>} resultEvent
 * @returns {InferUsage | undefined}
 */
export const usageFromResult = resultEvent => {
  /** @type {Record<string, number>} */
  const usage = {};
  const tokens = isRecord(resultEvent.usage) ? resultEvent.usage : {};
  for (const [field, wireField] of USAGE_FIELDS) {
    const value = nonNegative(tokens[wireField]);
    if (value !== undefined) usage[field] = value;
  }
  const turns = nonNegative(resultEvent.num_turns);
  if (turns !== undefined) usage.turns = turns;
  const durationMs = nonNegative(resultEvent.duration_ms);
  if (durationMs !== undefined) usage.durationMs = durationMs;
  return Object.keys(usage).length === 0 ? undefined : harden(usage);
};
harden(usageFromResult);

/**
 * @param {Record<string, unknown>} event
 * @returns {string}
 */
const assistantText = event => {
  const message = isRecord(event.message) ? event.message : {};
  const { content } = message;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      block =>
        isRecord(block) &&
        block.type === 'text' &&
        typeof block.text === 'string',
    )
    .map(block => block.text)
    .join('');
};

/**
 * @returns {ClaudeStreamReducer}
 */
export const makeClaudeStreamReducer = () => {
  let pending = '';
  let lineNumber = 0;
  let accumulatedText = '';
  /** @type {Set<unknown>} */
  const messageIds = new Set();
  let anonymousTurns = 0;
  /** @type {Record<string, unknown>[]} */
  const results = [];
  /** @type {string | undefined} */
  let malformed;

  /**
   * @param {unknown} event
   * @returns {boolean} whether the event began a new model turn
   */
  const pushEvent = event => {
    if (!isRecord(event) || typeof event.type !== 'string') {
      malformed ??= 'an event is not a typed record';
      return false;
    }
    if (event.type === 'assistant') {
      accumulatedText += assistantText(event);
      // One model turn may arrive as several events sharing a message id.
      const id = isRecord(event.message) ? event.message.id : undefined;
      if (id === undefined) {
        anonymousTurns += 1;
        return true;
      }
      if (messageIds.has(id)) return false;
      messageIds.add(id);
      return true;
    }
    if (event.type === 'result') {
      const origin = isRecord(event.origin) ? event.origin : {};
      if (origin.kind !== 'task-notification') results.push(event);
    }
    return false;
  };

  /**
   * @param {string} line
   * @returns {number}
   */
  const pushLine = line => {
    lineNumber += 1;
    if (line.trim() === '') return 0;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      malformed ??= `line ${lineNumber} is not JSON`;
      return 0;
    }
    return pushEvent(event) ? 1 : 0;
  };

  /**
   * @param {string} chunk
   * @returns {number} model turns begun by the complete lines in `chunk`
   */
  const pushText = chunk => {
    const lines = `${pending}${chunk}`.split('\n');
    pending = lines.pop() ?? '';
    let began = 0;
    for (const line of lines) began += pushLine(line);
    return began;
  };

  /** @returns {StreamReduction} */
  const finish = () => {
    if (pending !== '') {
      pushLine(pending);
      pending = '';
    }
    const turns = messageIds.size + anonymousTurns;
    if (malformed === undefined && results.length > 1) {
      malformed = `${results.length} terminal result events`;
    }
    if (malformed !== undefined) {
      return harden({
        terminal: 'malformed',
        text: accumulatedText,
        turns,
        detail: malformed,
      });
    }
    if (results.length === 0) {
      return harden({ terminal: 'missing', text: accumulatedText, turns });
    }
    const [resultEvent] = results;
    const text =
      typeof resultEvent.result === 'string'
        ? resultEvent.result
        : accumulatedText;
    const usage = usageFromResult(resultEvent);
    const subtype = resultEvent.subtype;
    /** @type {StreamReduction['terminal']} */
    let terminal = 'error';
    if (subtype === 'success' && resultEvent.is_error !== true) {
      terminal = 'success';
    } else if (subtype === 'error_max_turns') {
      terminal = 'max-turns';
    }
    return harden({
      terminal,
      text,
      turns,
      resultEvent,
      ...(usage === undefined ? {} : { usage }),
    });
  };

  return harden({ pushText, pushEvent, finish });
};
harden(makeClaudeStreamReducer);
