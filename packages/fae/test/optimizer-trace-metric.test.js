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
