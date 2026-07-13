// @ts-check

import './init.js';

/**
 * @typedef {object} ObservedToolCall
 * @property {string} tool
 * @property {string} rawArgs
 * @property {Record<string, unknown> | undefined} args
 * @property {string | undefined} result
 * @property {string | undefined} error
 */

/**
 * @typedef {object} ObservedTrace
 * @property {ObservedToolCall[]} toolCalls
 * @property {number} toolErrors
 * @property {number} adoptionReminderRetries
 * @property {number} emptyContentRetries
 * @property {number} llmRoundTrips
 */

/**
 * @typedef {object} ExpectedStep
 * @property {string} tool
 * @property {string[]} [rawArgsIncludes]
 * @property {string} [rawArgsMatches]
 * @property {string} [rawArgsIncludesFromTool]
 *   When set, the step matches only if the observed `rawArgs` contains a
 *   non-trivial substring of the previous result emitted by the named
 *   tool. Used to catch hallucinated reply values: a model that
 *   "adopts" `timestampTool` and then replies with a fabricated date
 *   without ever calling it will fail this constraint, because the named
 *   tool produced no result the reply could quote.
 */

/**
 * @typedef {object} TraceExample
 * @property {string} id
 * @property {ExpectedStep[][]} acceptableTraces
 * @property {number} minLength
 * @property {number} [minRoundTrips]
 * @property {number} [maxToolErrors]
 * @property {number} [maxAdoptionReminderRetries]
 * @property {number} [maxEmptyContentRetries]
 * @property {number} [maxRoundTrips]
 */

/**
 * Best-effort conversion for the small Justin records emitted in tool-call
 * log lines. Multi-line `exec` source remains available through `rawArgs`
 * even when this parser cannot turn it into JSON.
 *
 * @param {string} rawArgs
 * @returns {Record<string, unknown> | undefined}
 */
const parseArgs = rawArgs => {
  try {
    const jsonish = rawArgs.replace(
      /([{,])([A-Za-z_$][A-Za-z0-9_$]*):/g,
      '$1"$2":',
    );
    return /** @type {Record<string, unknown>} */ (JSON.parse(jsonish));
  } catch {
    return undefined;
  }
};

/**
 * The worker logger prints tool arguments with literal newlines when an arg
 * contains source code. Keep collecting until the next prefixed log record
 * begins so those continuations stay attached to the initiating tool call.
 *
 * @param {string[]} lines
 * @param {number} start
 */
const collectRawArgs = (lines, start) => {
  const first = lines[start];
  const match = first.match(/^\[tool\] ([A-Za-z0-9_-]+)\(([\s\S]*)$/);
  if (!match) {
    return undefined;
  }

  const parts = [match[2]];
  let end = start;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\[(?:tool|fae)\]/.test(lines[i])) {
      break;
    }
    parts.push(lines[i]);
    end = i;
  }

  const raw = parts.join('\n');
  return {
    tool: match[1],
    rawArgs: raw.endsWith(')') ? raw.slice(0, -1) : raw,
    end,
  };
};

/**
 * Parse the signals already present in `worker.log` into the trace unit used by
 * the optimizer metric.
 *
 * @param {string} workerLog
 * @returns {ObservedTrace}
 */
export const parseWorkerLogTrace = workerLog => {
  const lines = workerLog.split(/\r?\n/);
  /** @type {ObservedToolCall[]} */
  const toolCalls = [];
  let toolErrors = 0;
  let adoptionReminderRetries = 0;
  let emptyContentRetries = 0;
  let llmRoundTrips = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.includes('[fae] sent:')) {
      llmRoundTrips += 1;
    }
    if (line.includes('[fae] empty-content response')) {
      emptyContentRetries += 1;
    }
    if (line.includes('[fae] attached references were not adopted')) {
      adoptionReminderRetries += 1;
    }

    const call = collectRawArgs(lines, i);
    if (call) {
      toolCalls.push({
        tool: call.tool,
        rawArgs: call.rawArgs,
        args: parseArgs(call.rawArgs),
        result: undefined,
        error: undefined,
      });
      i = call.end;
    } else {
      const resultMatch = line.match(
        /^\[tool\] ([A-Za-z0-9_-]+) -> ([\s\S]*)$/,
      );
      if (resultMatch) {
        const pending = [...toolCalls]
          .reverse()
          .find(
            item => item.tool === resultMatch[1] && item.result === undefined,
          );
        if (pending) {
          pending.result = resultMatch[2];
        }
      } else {
        const errorMatch = line.match(
          /^\[tool\] ([A-Za-z0-9_-]+) error: ([\s\S]*)$/,
        );
        if (errorMatch) {
          toolErrors += 1;
          const pending = [...toolCalls]
            .reverse()
            .find(
              item => item.tool === errorMatch[1] && item.error === undefined,
            );
          if (pending) {
            pending.error = errorMatch[2];
          }
        }
      }
    }
  }

  return harden({
    toolCalls,
    toolErrors,
    adoptionReminderRetries,
    emptyContentRetries,
    llmRoundTrips,
  });
};
harden(parseWorkerLogTrace);

/**
 * The minimum substring length the `rawArgsIncludesFromTool` check must
 * find in the reply before declaring a match. A two-character overlap
 * (e.g., a year fragment, a single digit and a unit) is too easy to hit
 * by accident; six characters of contiguous output excludes incidental
 * collisions while still tolerating partial paraphrase.
 */
const MIN_TOOL_EVIDENCE_FRAGMENT = 6;

/**
 * Walk a previous tool's recorded result and check whether `rawArgs`
 * quotes any contiguous slice of it at least
 * `MIN_TOOL_EVIDENCE_FRAGMENT` characters long. Returns `true` when a
 * matching fragment exists. The result is stripped of surrounding
 * quotes so an OpenAI-style `"2026-05-15T12:00:00.000Z"` result still
 * matches when the model embeds the bare ISO date in its reply.
 *
 * @param {string} rawArgs
 * @param {string | undefined} result
 */
const rawArgsIncludesFragment = (rawArgs, result) => {
  if (!result) {
    return false;
  }
  const stripped = result.trim().replace(/^"|"$/g, '').replace(/\\"/g, '"');
  if (stripped.length < MIN_TOOL_EVIDENCE_FRAGMENT) {
    return false;
  }
  for (
    let start = 0;
    start + MIN_TOOL_EVIDENCE_FRAGMENT <= stripped.length;
    start += 1
  ) {
    const fragment = stripped.slice(start, start + MIN_TOOL_EVIDENCE_FRAGMENT);
    if (rawArgs.includes(fragment)) {
      return true;
    }
  }
  return false;
};

/**
 * @param {ObservedToolCall} observed
 * @param {ExpectedStep} expected
 * @param {ObservedToolCall[]} [priorCalls]
 *   Calls observed strictly before `observed`. Used by the
 *   `rawArgsIncludesFromTool` constraint to verify that the named tool
 *   produced a result the current step can quote.
 */
export const matchesExpectedStep = (observed, expected, priorCalls = []) => {
  if (observed.tool !== expected.tool) {
    return false;
  }
  if (
    expected.rawArgsIncludes &&
    expected.rawArgsIncludes.some(
      fragment => !observed.rawArgs.includes(fragment),
    )
  ) {
    return false;
  }
  if (
    expected.rawArgsMatches &&
    !new RegExp(expected.rawArgsMatches).test(observed.rawArgs)
  ) {
    return false;
  }
  if (expected.rawArgsIncludesFromTool) {
    const source = [...priorCalls]
      .reverse()
      .find(call => call.tool === expected.rawArgsIncludesFromTool);
    if (!source || !rawArgsIncludesFragment(observed.rawArgs, source.result)) {
      return false;
    }
  }
  return true;
};
harden(matchesExpectedStep);

/**
 * @param {ObservedToolCall[]} observed
 * @param {ExpectedStep[]} expected
 */
export const traceEditDistance = (observed, expected) => {
  const rows = observed.length + 1;
  const cols = expected.length + 1;
  const matrix = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => 0),
  );

  for (let i = 0; i < rows; i += 1) {
    matrix[i][0] = i;
  }
  for (let j = 0; j < cols; j += 1) {
    matrix[0][j] = j;
  }

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const substitutionCost = matchesExpectedStep(
        observed[i - 1],
        expected[j - 1],
        observed.slice(0, i - 1),
      )
        ? 0
        : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + substitutionCost,
      );
    }
  }

  return matrix[rows - 1][cols - 1];
};
harden(traceEditDistance);

/**
 * @typedef {object} ScoreOptions
 * @property {boolean} [timedOut] Set when the trial harness aborted before
 *   the model produced a reply (e.g., `daemon-trial.js` hit
 *   `REPLY_TIMEOUT_MS`). A timed-out trial is treated as a hard fail
 *   regardless of how clean the partial trace looks.
 */

/**
 * Score a worker-log trace against the smoke-derived trace expectations.
 * The first acceptable trace is canonical; exact matches to alternate traces
 * still pass, but receive less credit so the search prefers direct calls.
 *
 * Hard-fail floor: when the trial timed out (`options.timedOut`) or the
 * observed trace contains no `reply` tool call, the resulting score is
 * clamped to be non-positive and `withinLimits` is forced to `false`. A
 * clean-looking partial trace that never produced a reply is task failure,
 * not a partial credit case.
 *
 * @param {ObservedTrace} observed
 * @param {TraceExample} example
 * @param {ScoreOptions} [options]
 */
export const scoreObservedTrace = (observed, example, options = {}) => {
  if (example.acceptableTraces.length === 0) {
    throw new Error(`example "${example.id}" has no acceptable traces`);
  }

  const distances = example.acceptableTraces.map(trace =>
    traceEditDistance(observed.toolCalls, trace),
  );
  const bestDistance = Math.min(...distances);
  const bestIndex = distances.indexOf(bestDistance);
  const bestTrace = example.acceptableTraces[bestIndex];
  const canonicalExact = distances[0] === 0;
  const alternateExact = bestDistance === 0 && !canonicalExact;
  const denominator = Math.max(bestTrace.length, observed.toolCalls.length, 1);
  const partial = 1 - bestDistance / denominator;
  const extraCalls = Math.max(0, observed.toolCalls.length - example.minLength);
  const extraRoundTrips = Math.max(
    0,
    observed.llmRoundTrips - (example.minRoundTrips || 0),
  );
  const toolErrorOverage = Math.max(
    0,
    observed.toolErrors - (example.maxToolErrors || 0),
  );
  const adoptionReminderOverage = Math.max(
    0,
    observed.adoptionReminderRetries -
      (example.maxAdoptionReminderRetries || 0),
  );
  const emptyContentOverage = Math.max(
    0,
    observed.emptyContentRetries - (example.maxEmptyContentRetries || 0),
  );
  const maxRoundTrips = example.maxRoundTrips || example.minRoundTrips || 0;
  const roundTripOverage = Math.max(0, observed.llmRoundTrips - maxRoundTrips);
  const overBudgetTotal =
    toolErrorOverage +
    adoptionReminderOverage +
    emptyContentOverage +
    roundTripOverage;
  const rawScore =
    (canonicalExact ? 10 : 0) +
    (alternateExact ? 3 : 0) +
    5 * partial -
    observed.toolErrors -
    observed.adoptionReminderRetries -
    observed.emptyContentRetries -
    0.5 * extraCalls -
    0.25 * extraRoundTrips -
    2 * overBudgetTotal;

  const hasReply = observed.toolCalls.some(call => call.tool === 'reply');
  const timedOut = options.timedOut === true;
  const hardFail = timedOut || !hasReply;
  // Hard-fail floor: clamp to <= 0 so a clean-but-empty trace (model
  // adopted the tool, then stalled or never replied) cannot score above
  // a noisy-but-completed trace. Subtract a fixed penalty for each
  // failure flag so the optimizer still distinguishes "timed out" from
  // "no reply" from both.
  const hardFailPenalty =
    (timedOut ? 5 : 0) + (!hasReply ? 5 : 0) + Math.max(0, rawScore);
  const score = hardFail ? rawScore - hardFailPenalty : rawScore;

  return harden({
    score,
    bestDistance,
    bestIndex,
    canonicalExact,
    alternateExact,
    partial,
    withinLimits: overBudgetTotal === 0 && !hardFail,
    hardFail,
    timedOut,
    hasReply,
    penalties: {
      toolErrors: observed.toolErrors,
      adoptionReminderRetries: observed.adoptionReminderRetries,
      emptyContentRetries: observed.emptyContentRetries,
      extraCalls,
      extraRoundTrips,
      overBudget: {
        toolErrors: toolErrorOverage,
        adoptionReminderRetries: adoptionReminderOverage,
        emptyContentRetries: emptyContentOverage,
        roundTrips: roundTripOverage,
      },
    },
  });
};
harden(scoreObservedTrace);
