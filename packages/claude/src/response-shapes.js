// @ts-check
//
// The Claude Code response-shape table and the classification of one turn
// (designs/endo-claude-inference-backends.md § The Inference Seam). Each tag
// has one writer: the limit enforcer's outcome wins; then the stream's own
// success or turn ceiling; then a row of the pinned table; and anything else
// is `unavailable`. `needs-auth` comes only from a row captured against the
// running binary's exact version, so a CLI upgrade that changes the error
// wire cannot start a false reauthentication storm.

import { makeShapeClassifier } from '@endo/inference/classify.js';

/** @import { ClassifiedResult, InferResult, ShapeTable } from '@endo/inference/types.js' */
/** @import { ClaudeCodeResponse, TurnOutcomeSpec } from './backends.types.js' */

/**
 * The rows captured so far, keyed by exact Claude Code version. None: the
 * failure shapes of verification gate 3 (an invalid credential, an exhausted
 * window, a rate limit) have not been captured against a pinned binary, so
 * every failure classifies as `unavailable` until they are. A deployment
 * passes its canary-recorded rows as the backend's `responseShapes`.
 *
 * Rows match a `ClaudeCodeResponse`, for example
 * `M.splitRecord({ source: 'result', api_error_status: 401 })`.
 *
 * @type {ShapeTable}
 */
export const CLAUDE_CODE_RESPONSE_SHAPES = harden({});

const STDERR_TAIL_CODE_UNITS = 4096;

/**
 * @param {unknown} value
 * @returns {value is string | number | boolean | null}
 */
const isJsonPrimitive = value =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value);

/**
 * The passable record a row matches for a terminal `result` event: its
 * JSON-primitive fields, so nested provider data never needs to be passable.
 *
 * @param {Record<string, unknown>} resultEvent
 * @returns {ClaudeCodeResponse}
 */
export const resultResponse = resultEvent => {
  /** @type {Record<string, string | number | boolean | null>} */
  const fields = {};
  for (const [key, value] of Object.entries(resultEvent)) {
    if (isJsonPrimitive(value)) fields[key] = value;
  }
  return harden({ ...fields, source: 'result' });
};
harden(resultResponse);

/**
 * The last `STDERR_TAIL_CODE_UNITS` code units of `stderr`, never beginning with
 * the low half of a surrogate pair the cut split.
 *
 * @param {string} stderr
 */
const stderrTail = stderr => {
  const tail = stderr.slice(-STDERR_TAIL_CODE_UNITS);
  const first = tail.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff && tail.length < stderr.length
    ? tail.slice(1)
    : tail;
};

/**
 * The record a row matches for a process that ended without a terminal
 * `result` event. Only the tail of stderr is kept.
 *
 * @param {object} exit
 * @param {number | null} exit.exitCode
 * @param {string | null} exit.signal
 * @param {string} exit.stderr
 * @returns {ClaudeCodeResponse}
 */
export const exitResponse = ({ exitCode, signal, stderr }) =>
  harden({
    source: 'exit',
    exitCode,
    signal,
    stderr: stderrTail(stderr),
  });
harden(exitResponse);

/**
 * @param {ShapeTable} table
 * @param {string} version  the running binary's exact version
 * @returns {(response: ClaudeCodeResponse) => ClassifiedResult | undefined}
 */
export const makeClaudeCodeClassifier = (table, version) => {
  const { classify } = makeShapeClassifier(table);
  return response => classify(version, response);
};
harden(makeClaudeCodeClassifier);

/**
 * @param {string} detail
 * @returns {InferResult}
 */
export const unavailable = detail => harden({ type: 'unavailable', detail });
harden(unavailable);

/**
 * Classifies one finished turn.
 *
 * @param {TurnOutcomeSpec} spec
 * @returns {InferResult}
 */
export const turnOutcome = ({
  limitOutcome,
  reduction,
  classify,
  fallbackResponse,
  thrownCategory,
  exitCode,
}) => {
  if (limitOutcome !== undefined) return limitOutcome;
  const { terminal, text, usage, resultEvent, detail } = reduction;
  const exitedCleanly = exitCode === undefined || exitCode === 0;
  if (terminal === 'success' && exitedCleanly) {
    return harden(
      usage === undefined ? { type: 'ok', text } : { type: 'ok', text, usage },
    );
  }
  if (terminal === 'max-turns') {
    return harden({ type: 'limit-exceeded', which: 'max-turns' });
  }
  const response =
    resultEvent !== undefined && terminal !== 'success'
      ? resultResponse(resultEvent)
      : fallbackResponse;
  const classified = response === undefined ? undefined : classify(response);
  if (classified !== undefined) return classified;
  switch (terminal) {
    case 'malformed':
      return unavailable(`malformed stream: ${detail}`);
    case 'missing':
      if (fallbackResponse?.source === 'thrown') {
        // The message stays out of the detail: it may quote a credential.
        return unavailable(
          thrownCategory === undefined
            ? 'turn failed'
            : `turn failed: ${thrownCategory}`,
        );
      }
      return unavailable(
        exitCode === undefined
          ? 'no terminal result event'
          : `no terminal result event (exit ${exitCode})`,
      );
    case 'success':
      return unavailable(`exited ${exitCode} after a success result`);
    default: {
      const subtype = resultEvent?.subtype;
      return unavailable(
        `turn ended with ${typeof subtype === 'string' ? subtype : 'an error'}`,
      );
    }
  }
};
harden(turnOutcome);
