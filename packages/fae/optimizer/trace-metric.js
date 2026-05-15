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
 * @param {ObservedToolCall} observed
 * @param {ExpectedStep} expected
 */
export const matchesExpectedStep = (observed, expected) => {
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
 * Score a worker-log trace against the smoke-derived trace expectations.
 * The first acceptable trace is canonical; exact matches to alternate traces
 * still pass, but receive less credit so the search prefers direct calls.
 *
 * @param {ObservedTrace} observed
 * @param {TraceExample} example
 */
export const scoreObservedTrace = (observed, example) => {
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
  const score =
    (canonicalExact ? 10 : 0) +
    (alternateExact ? 3 : 0) +
    5 * partial -
    observed.toolErrors -
    observed.adoptionReminderRetries -
    observed.emptyContentRetries -
    0.5 * extraCalls -
    0.25 * extraRoundTrips -
    2 * overBudgetTotal;

  return harden({
    score,
    bestDistance,
    bestIndex,
    canonicalExact,
    alternateExact,
    partial,
    withinLimits: overBudgetTotal === 0,
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
