// @ts-check
/**
 * Trace metric for the lal prompt optimizer.
 *
 * lal's hooks API (`hooks/index.js`) lets the trial runner observe the
 * agent's per-event stream directly, without parsing console output. The
 * trial runner therefore emits a structured trace array (each element
 * is a `TraceEvent`):
 *
 *   [
 *     { kind: 'tool-call', name: 'reply', args: {messageNumber: '+1', strings:['hi'], ...},
 *       rawArgs: '{"messageNumber":"+1",...}', ok: true,  result: <serialized> },
 *     { kind: 'tool-call', name: 'dismiss', args: {messageNumber:'+1'},
 *       rawArgs: '{"messageNumber":"+1"}',     ok: false, error: 'unknown'  },
 *     { kind: 'message',   role: 'assistant', content: 'Done.' },
 *     { kind: 'error',     message: 'LLM rate limit' },
 *     { kind: 'round',     round: 1 },
 *   ]
 *
 * The four kinds are exactly what `runRound` in `round-runner.js`
 * already observes; the metric only cares about `tool-call`, `round`,
 * and `error`. `rawArgs` is the JSON-encoded args record (the LLM's
 * literal call shape) so example specs can pin specific substrings
 * (`rawArgsIncludes`) or regexes (`rawArgsMatches`).
 *
 * Scoring rubric (mirrors fae):
 *
 *   +10  perfect match to the canonical (first acceptable) trace
 *   + 3  perfect match to an alternate acceptable trace
 *   + 5 * (1 - editDistance / max(canonical.length, observed.length, 1))
 *        partial credit by Levenshtein edit distance
 *   - 1   per tool error
 *   - 0.5 per extra tool call beyond example.minLength
 *   - 0.25 per extra round beyond example.minRoundTrips
 *   - 2   per budget violation (tool errors, round trips over max)
 */

import './init.js';

/**
 * @typedef {{
 *   kind: 'tool-call',
 *   name: string,
 *   args: Record<string, unknown> | undefined,
 *   rawArgs: string,
 *   ok: boolean,
 *   result?: unknown,
 *   error?: string,
 * }} ToolCallEvent
 *
 * @typedef {{ kind: 'message', role: string, content?: string }} MessageEvent
 * @typedef {{ kind: 'error',   message: string }} ErrorEvent
 * @typedef {{ kind: 'round',   round: number }} RoundEvent
 * @typedef {ToolCallEvent | MessageEvent | ErrorEvent | RoundEvent} TraceEvent
 *
 * @typedef {object} ExpectedStep
 * @property {string} tool
 * @property {string[]} [rawArgsIncludes]
 * @property {string} [rawArgsMatches]
 *
 * @typedef {object} TraceExample
 * @property {string} id
 * @property {ExpectedStep[][]} acceptableTraces
 * @property {number} minLength
 * @property {number} [minRoundTrips]
 * @property {number} [maxToolErrors]
 * @property {number} [maxRoundTrips]
 *
 * @typedef {object} ObservedTrace
 * @property {ToolCallEvent[]} toolCalls
 * @property {number} toolErrors
 * @property {number} llmRoundTrips
 */

/**
 * Reduce a raw `TraceEvent[]` into the compact form the scorer reads.
 *
 * @param {TraceEvent[]} events
 * @returns {ObservedTrace}
 */
export const summarizeTrace = events => {
  /** @type {ToolCallEvent[]} */
  const toolCalls = [];
  let toolErrors = 0;
  let llmRoundTrips = 0;
  for (const event of events) {
    if (event.kind === 'tool-call') {
      toolCalls.push(event);
      if (!event.ok) {
        toolErrors += 1;
      }
    } else if (event.kind === 'round') {
      llmRoundTrips += 1;
    }
  }
  return harden({ toolCalls, toolErrors, llmRoundTrips });
};
harden(summarizeTrace);

/**
 * Step-level match: tool name plus optional rawArgs substring / regex
 * constraints. The substring form is preferred for readability; the
 * regex form is escape hatch for "any digit" or "ISO date" assertions.
 *
 * @param {ToolCallEvent} observed
 * @param {ExpectedStep} expected
 */
export const matchesExpectedStep = (observed, expected) => {
  if (observed.name !== expected.tool) {
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
 * Standard Levenshtein over tool-call sequences with `matchesExpectedStep`
 * as the substitution oracle. Equal weight for insert / delete / sub.
 *
 * @param {ToolCallEvent[]} observed
 * @param {ExpectedStep[]} expected
 */
export const traceEditDistance = (observed, expected) => {
  const rows = observed.length + 1;
  const cols = expected.length + 1;
  /** @type {number[][]} */
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
 * Score an observed trace (raw event array OR pre-summarized) against
 * the example's `acceptableTraces`. The first acceptable trace is
 * canonical; alternates pass with reduced credit so the optimizer
 * prefers direct tool calls.
 *
 * @param {TraceEvent[] | ObservedTrace} observedInput
 * @param {TraceExample} example
 */
export const scoreObservedTrace = (observedInput, example) => {
  if (example.acceptableTraces.length === 0) {
    throw new Error(`example "${example.id}" has no acceptable traces`);
  }
  const observed = Array.isArray(observedInput)
    ? summarizeTrace(observedInput)
    : observedInput;

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
  const maxRoundTrips = example.maxRoundTrips || example.minRoundTrips || 0;
  const roundTripOverage = Math.max(0, observed.llmRoundTrips - maxRoundTrips);
  const overBudgetTotal = toolErrorOverage + roundTripOverage;
  const score =
    (canonicalExact ? 10 : 0) +
    (alternateExact ? 3 : 0) +
    5 * partial -
    observed.toolErrors -
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
      extraCalls,
      extraRoundTrips,
      overBudget: {
        toolErrors: toolErrorOverage,
        roundTrips: roundTripOverage,
      },
    },
  });
};
harden(scoreObservedTrace);
