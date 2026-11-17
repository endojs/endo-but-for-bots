// @ts-check
/// <reference types="ses"/>

// The harness half of the structured-signal contract
// (designs/endo-guest-stdio-mcp.md § Structured signals from the `claude`
// child): parse the `--output-format stream-json --verbose` stdout of one
// `claude -p` invocation into a hardened, tagged outcome.
//
// The stream must contain exactly one terminal `result` event for the prompt.
// A `result` whose `origin.kind` is `task-notification` belongs to a background
// task and does not count. A malformed line, a truncated stream, a missing
// terminal result, or several terminal results is a `parse-error`, never a
// successful inference. Absent rate-limit telemetry is reported as unknown
// (`quota: undefined`), never as zero utilization.

/** @import { ClaudeStreamParse } from './types.js' */

const RESULT_FIELDS = harden([
  'is_error',
  'subtype',
  'api_error_status',
  'stop_reason',
  'terminal_reason',
  'num_turns',
  'duration_ms',
  'duration_api_ms',
  'ttft_ms',
  'total_cost_usd',
  'queued_turn_count',
  'fast_mode_state',
  'session_id',
]);

const RATE_LIMIT_FIELDS = harden([
  'status',
  'rateLimitType',
  'resetsAt',
  'overageStatus',
  'overageResetsAt',
  'isUsingOverage',
]);

/**
 * A JSON primitive: narrower than `@endo/pass-style`'s `isPrimitive`, which
 * also admits `undefined`, bigints, and symbols that JSON cannot carry.
 *
 * @param {unknown} value
 * @returns {value is string | number | boolean | null}
 */
const isJsonPrimitive = value =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value);

/**
 * Copy the primitive-valued own entries of a record, optionally restricted to
 * a field list, into a fresh hardened record.
 *
 * @param {unknown} source
 * @param {ReadonlyArray<string>} [fields]
 * @returns {Record<string, string | number | boolean | null> | undefined}
 */
const copyPrimitives = (source, fields) => {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    return undefined;
  }
  /** @type {Record<string, string | number | boolean | null>} */
  const copy = {};
  for (const key of fields ?? Object.keys(source)) {
    const value = /** @type {Record<string, unknown>} */ (source)[key];
    if (Object.hasOwn(source, key) && isJsonPrimitive(value)) {
      copy[key] = value;
    }
  }
  return harden(copy);
};

/**
 * @param {Record<string, unknown>} rateLimitInfo
 */
const toQuota = rateLimitInfo => {
  const windows = /** @type {Record<string, unknown> | undefined} */ (
    rateLimitInfo.unifiedWindows
  );
  return harden({
    ...copyPrimitives(rateLimitInfo, RATE_LIMIT_FIELDS),
    fiveHour: copyPrimitives(windows && windows.five_hour),
    sevenDay: copyPrimitives(windows && windows.seven_day),
  });
};

const RATE_LIMIT_RE = /rate.?limit|usage.?limit|quota/i;
const AVAILABILITY_RE = /overload|connection|timeout|timed.?out|unavailable/i;

/**
 * @param {Record<string, unknown>} result
 * @returns {{ type: string, status?: number, reason?: string }}
 */
const classify = result => {
  if (result.is_error !== true) {
    return { type: 'ok' };
  }
  const status =
    typeof result.api_error_status === 'number'
      ? result.api_error_status
      : undefined;
  const reasons = [result.terminal_reason, result.stop_reason, result.subtype]
    .filter(value => typeof value === 'string')
    .join(' ');
  if (status === 429 || RATE_LIMIT_RE.test(reasons)) {
    return { type: 'rate-limited', status, reason: reasons || undefined };
  }
  const denials = result.permission_denials;
  if (Array.isArray(denials) && denials.length > 0) {
    return { type: 'policy-refusal', reason: reasons || undefined };
  }
  if (status !== undefined) {
    return { type: 'api-error', status, reason: reasons || undefined };
  }
  if (AVAILABILITY_RE.test(reasons)) {
    return { type: 'unavailable', reason: reasons };
  }
  return { type: 'error', reason: reasons || undefined };
};

/**
 * @param {string} detail
 * @returns {ClaudeStreamParse}
 */
const parseError = detail =>
  harden({ outcome: { type: 'parse-error', detail } });

/**
 * Parse the complete stdout of one `claude -p --output-format stream-json
 * --verbose` run.
 *
 * @param {string} text
 * @returns {ClaudeStreamParse}
 */
export const parseClaudeStreamJson = text => {
  if (typeof text !== 'string') {
    return parseError('stream is not text');
  }
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  } else if (text !== '') {
    return parseError('stream is truncated (no trailing newline)');
  }

  /** @type {Record<string, unknown>[]} */
  const results = [];
  /** @type {Record<string, unknown> | undefined} */
  let rateLimitInfo;
  /**
   * @param {string} line
   * @param {number} index
   * @returns {ClaudeStreamParse | undefined} a parse error, if any.
   */
  const consider = (line, index) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return parseError(`line ${index + 1} is not JSON`);
    }
    if (
      event === null ||
      typeof event !== 'object' ||
      Array.isArray(event) ||
      typeof event.type !== 'string'
    ) {
      return parseError(`line ${index + 1} is not a stream event`);
    }
    if (event.type === 'result') {
      const origin = event.origin;
      if (!(origin && origin.kind === 'task-notification')) {
        results.push(event);
      }
    } else if (
      event.type === 'rate_limit_event' &&
      event.rate_limit_info !== null &&
      typeof event.rate_limit_info === 'object'
    ) {
      rateLimitInfo = event.rate_limit_info;
    }
    return undefined;
  };
  for (const [index, line] of lines.entries()) {
    if (line.trim() !== '') {
      const failure = consider(line, index);
      if (failure !== undefined) {
        return failure;
      }
    }
  }

  if (results.length === 0) {
    return parseError('no terminal result event');
  }
  if (results.length > 1) {
    return parseError(`${results.length} terminal result events`);
  }
  const [result] = results;
  const denials = Array.isArray(result.permission_denials)
    ? result.permission_denials.length
    : 0;

  return harden({
    outcome: harden(classify(result)),
    text: typeof result.result === 'string' ? result.result : undefined,
    fields: harden({
      ...copyPrimitives(result, RESULT_FIELDS),
      permission_denials: denials,
    }),
    usage: copyPrimitives(result.usage),
    subagentStats: copyPrimitives(result.subagent_stats),
    quota: rateLimitInfo === undefined ? undefined : toQuota(rateLimitInfo),
  });
};
harden(parseClaudeStreamJson);
