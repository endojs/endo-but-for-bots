// @ts-check
// spell-out-exempt: `num_turns` is a field of claude's stream-json output.

import test from '@endo/ses-ava/prepare-endo.js';

import { parseClaudeStreamJson } from '../src/claude-stream.js';

/** @param {object[]} events */
const stream = events => events.map(e => `${JSON.stringify(e)}\n`).join('');

const init = { type: 'system', subtype: 'init', session_id: 's' };
const assistant = { type: 'assistant', message: { content: [] } };
const rateLimit = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed_warning',
    rateLimitType: 'five_hour',
    resetsAt: 1_790_000_000,
    overageStatus: 'rejected',
    unifiedWindows: {
      five_hour: { utilization: 0.81, resetsAt: 1_790_000_000 },
      seven_day: { utilization: 0.4, resetsAt: 1_790_500_000 },
    },
  },
};
const result = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'done',
  stop_reason: 'end_turn',
  num_turns: 2,
  duration_ms: 1200,
  duration_api_ms: 1000,
  ttft_ms: 300,
  total_cost_usd: 0.01,
  permission_denials: [],
  usage: { input_tokens: 10, output_tokens: 5, server_tool_use: {} },
};

test('a complete stream yields ok, usage, and the quota record', t => {
  const parsed = parseClaudeStreamJson(
    stream([init, assistant, rateLimit, result]),
  );
  t.deepEqual(parsed.outcome, { type: 'ok' });
  t.is(parsed.text, 'done');
  t.deepEqual(parsed.usage, { input_tokens: 10, output_tokens: 5 });
  t.is(parsed.fields?.num_turns, 2);
  t.is(parsed.fields?.permission_denials, 0);
  t.deepEqual(parsed.quota, {
    status: 'allowed_warning',
    rateLimitType: 'five_hour',
    resetsAt: 1_790_000_000,
    overageStatus: 'rejected',
    fiveHour: { utilization: 0.81, resetsAt: 1_790_000_000 },
    sevenDay: { utilization: 0.4, resetsAt: 1_790_500_000 },
  });
});

test('absent rate-limit telemetry is unknown, not zero', t => {
  t.is(parseClaudeStreamJson(stream([init, result])).quota, undefined);
});

test('a task-notification result does not count as the terminal result', t => {
  const notification = {
    ...result,
    result: 'background',
    origin: { kind: 'task-notification' },
  };
  const parsed = parseClaudeStreamJson(stream([init, notification, result]));
  t.is(parsed.outcome.type, 'ok');
  t.is(parsed.text, 'done');
});

test('truncated, missing-result, multiple-result, and malformed streams fail closed', t => {
  const full = stream([init, result]);
  for (const text of [
    full.slice(0, -10),
    stream([init, assistant]),
    stream([init, result, result]),
    `${stream([init])}not json\n${stream([result])}`,
    '',
  ]) {
    t.is(parseClaudeStreamJson(text).outcome.type, 'parse-error');
  }
});

test('terminal errors classify by structured fields', t => {
  /** @type {Array<[object, string]>} */
  const cases = [
    [{ api_error_status: 429 }, 'rate-limited'],
    [{ terminal_reason: 'usage_limit_reached' }, 'rate-limited'],
    [{ permission_denials: [{ tool_name: 'Bash' }] }, 'policy-refusal'],
    [{ api_error_status: 500 }, 'api-error'],
    [{ terminal_reason: 'overloaded' }, 'unavailable'],
    [{ subtype: 'error_max_turns' }, 'error'],
  ];
  for (const [fields, type] of cases) {
    const parsed = parseClaudeStreamJson(
      stream([{ ...result, is_error: true, subtype: 'error', ...fields }]),
    );
    t.is(parsed.outcome.type, type, JSON.stringify(fields));
  }
});
