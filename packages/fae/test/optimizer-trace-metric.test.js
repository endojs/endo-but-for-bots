// @ts-check

import '@endo/init/debug.js';

import test from 'ava';

import {
  parseWorkerLogTrace,
  scoreObservedTrace,
  traceEditDistance,
} from '../optimizer/trace-metric.js';

const timestampExample = harden({
  id: 'timestamp',
  acceptableTraces: [
    [
      { tool: 'adoptTool', rawArgsIncludes: ['edgeName:"timestamp-tool"'] },
      { tool: 'timestampTool' },
      { tool: 'reply', rawArgsMatches: '\\d{4}-\\d{2}-\\d{2}' },
    ],
    [
      { tool: 'adoptTool', rawArgsIncludes: ['edgeName:"timestamp-tool"'] },
      { tool: 'exec', rawArgsIncludes: ['timestamp-tool'] },
      { tool: 'reply', rawArgsMatches: '\\d{4}-\\d{2}-\\d{2}' },
    ],
  ],
  minLength: 3,
  minRoundTrips: 2,
});

test('parseWorkerLogTrace captures tool calls and retry signals', t => {
  const trace = parseWorkerLogTrace(`
[fae] sent:
[tool] adoptTool({edgeName:"timestamp-tool",toolName:"timestamp-tool"})
[tool] adoptTool -> "ok"
[fae] sent:
[fae] attached references were not adopted; asking model to retry once
[fae] empty-content response; asking model to continue (1/2)
[tool] timestampTool({})
[tool] timestampTool -> "2026-05-15T12:00:00.000Z"
[tool] reply({strings:["2026-05-15T12:00:00.000Z"]})
[tool] reply -> "sent"
`);

  t.deepEqual(
    trace.toolCalls.map(call => call.tool),
    ['adoptTool', 'timestampTool', 'reply'],
  );
  t.is(trace.toolCalls[0].args?.edgeName, 'timestamp-tool');
  t.is(trace.adoptionReminderRetries, 1);
  t.is(trace.emptyContentRetries, 1);
  t.is(trace.llmRoundTrips, 2);
  t.is(trace.toolErrors, 0);
});

test('traceEditDistance treats alternate tool paths as one substitution apart', t => {
  const observed = parseWorkerLogTrace(`
[tool] adoptTool({edgeName:"timestamp-tool"})
[tool] exec({code:"lookup timestamp-tool"})
[tool] reply({strings:["2026-05-15"]})
`);
  t.is(
    traceEditDistance(observed.toolCalls, timestampExample.acceptableTraces[0]),
    1,
  );
  t.is(
    traceEditDistance(observed.toolCalls, timestampExample.acceptableTraces[1]),
    0,
  );
});

test('scoreObservedTrace prefers canonical direct dispatch over exec fallback', t => {
  const direct = parseWorkerLogTrace(`
[fae] sent:
[tool] adoptTool({edgeName:"timestamp-tool"})
[fae] sent:
[tool] timestampTool({})
[tool] reply({strings:["2026-05-15"]})
`);
  const fallback = parseWorkerLogTrace(`
[fae] sent:
[tool] adoptTool({edgeName:"timestamp-tool"})
[fae] sent:
[tool] exec({code:"lookup timestamp-tool"})
[tool] reply({strings:["2026-05-15"]})
`);

  const directScore = scoreObservedTrace(direct, timestampExample);
  const fallbackScore = scoreObservedTrace(fallback, timestampExample);
  t.is(directScore.score, 15);
  t.is(fallbackScore.score, 8);
  t.true(directScore.score > fallbackScore.score);
});

test('scoreObservedTrace marks traces over budget for errors, repair hints, and turns', t => {
  const overBudget = parseWorkerLogTrace(`
[fae] sent:
[tool] adoptTool({edgeName:"timestamp-tool"})
[fae] attached references were not adopted; asking model to retry once
[fae] sent:
[fae] empty-content response; asking model to continue (1/2)
[fae] sent:
[tool] timestampTool({})
[tool] timestampTool error: failed once
[fae] sent:
[tool] timestampTool({})
[tool] reply({strings:["2026-05-15"]})
`);

  const score = scoreObservedTrace(overBudget, timestampExample);
  t.false(score.withinLimits);
  t.deepEqual(score.penalties.overBudget, {
    toolErrors: 1,
    adoptionReminderRetries: 1,
    emptyContentRetries: 1,
    roundTrips: 2,
  });
});

test('scoreObservedTrace hard-fails when the trial timed out', t => {
  // Clean trace shape (adopt then call), but the trial harness aborted
  // before any reply — score must be non-positive and withinLimits false.
  const stalled = parseWorkerLogTrace(`
[fae] sent:
[tool] adoptTool({edgeName:"timestamp-tool"})
[fae] sent:
[tool] timestampTool({})
[tool] timestampTool -> "2026-05-15T12:00:00.000Z"
`);

  const score = scoreObservedTrace(stalled, timestampExample, {
    timedOut: true,
  });
  t.true(score.hardFail);
  t.true(score.timedOut);
  t.false(score.hasReply);
  t.false(score.withinLimits);
  t.true(score.score <= 0);
});

test('scoreObservedTrace hard-fails when the trace has no reply call', t => {
  // No reply tool call ever made — even without an explicit timedOut
  // flag the score floor applies, because the task was not completed.
  const noReply = parseWorkerLogTrace(`
[fae] sent:
[tool] adoptTool({edgeName:"timestamp-tool"})
[fae] sent:
[tool] timestampTool({})
[tool] timestampTool -> "2026-05-15T12:00:00.000Z"
`);

  const score = scoreObservedTrace(noReply, timestampExample);
  t.true(score.hardFail);
  t.false(score.timedOut);
  t.false(score.hasReply);
  t.false(score.withinLimits);
  t.true(score.score <= 0);
});

test('rawArgsIncludesFromTool rejects a reply that quotes nothing from the named tool', t => {
  // Model adopted timestampTool but never invoked it; the reply contains
  // a plausible-looking ISO date that the model fabricated. The
  // hallucination assertion fails because no prior timestampTool call
  // produced any result the reply could quote.
  const hallucinated = harden({
    id: 'timestamp-evidence',
    acceptableTraces: [
      [
        { tool: 'adoptTool' },
        { tool: 'timestampTool' },
        {
          tool: 'reply',
          rawArgsIncludesFromTool: 'timestampTool',
        },
      ],
    ],
    minLength: 3,
    minRoundTrips: 2,
  });

  const noToolCall = parseWorkerLogTrace(`
[fae] sent:
[tool] adoptTool({edgeName:"timestamp-tool"})
[tool] adoptTool -> "ok"
[fae] sent:
[tool] reply({strings:["Wed May 20 2026 14:47:49 GMT-0400"]})
`);

  const scoreNoCall = scoreObservedTrace(noToolCall, hallucinated);
  // Distance is 1 (missing timestampTool step), not 0 — the canonical
  // trace is not an exact match.
  t.false(scoreNoCall.canonicalExact);

  const withToolEvidence = parseWorkerLogTrace(`
[fae] sent:
[tool] adoptTool({edgeName:"timestamp-tool"})
[tool] adoptTool -> "ok"
[fae] sent:
[tool] timestampTool({})
[tool] timestampTool -> "2026-05-15T12:00:00.000Z"
[tool] reply({strings:["The time is 2026-05-15T12:00:00.000Z"]})
`);

  const scoreWithEvidence = scoreObservedTrace(withToolEvidence, hallucinated);
  t.true(scoreWithEvidence.canonicalExact);

  // Same shape as withToolEvidence but the reply substitutes a different
  // ISO date that the tool did not produce — the constraint catches it.
  const fabricated = parseWorkerLogTrace(`
[fae] sent:
[tool] adoptTool({edgeName:"timestamp-tool"})
[tool] adoptTool -> "ok"
[fae] sent:
[tool] timestampTool({})
[tool] timestampTool -> "2026-05-15T12:00:00.000Z"
[tool] reply({strings:["The time is 1999-12-31T23:59:59.000Z"]})
`);

  const scoreFabricated = scoreObservedTrace(fabricated, hallucinated);
  // The reply step does not match (the fragment is missing), so the
  // canonical trace edit distance is 1.
  t.false(scoreFabricated.canonicalExact);
  t.true(scoreFabricated.bestDistance >= 1);
});

test('scoreObservedTrace leaves successful traces unchanged when timedOut is omitted', t => {
  // Regression guard: the canonical direct-dispatch trace must still
  // score 15 with the hard-fail floor in place.
  const direct = parseWorkerLogTrace(`
[fae] sent:
[tool] adoptTool({edgeName:"timestamp-tool"})
[fae] sent:
[tool] timestampTool({})
[tool] reply({strings:["2026-05-15"]})
`);

  const score = scoreObservedTrace(direct, timestampExample);
  t.is(score.score, 15);
  t.false(score.hardFail);
  t.true(score.hasReply);
  t.true(score.withinLimits);
});
