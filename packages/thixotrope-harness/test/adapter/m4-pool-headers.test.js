// @ts-check
// M4 W4.2: rate-limit headers to readings and exhaustion
// (resources/agent-host/impl/subscriptions/rate-limit-headers.js;
// designs/m4-interfaces.md 5.1, 5.3; R4-25, R4-84). Ported from
// hosted-agent test/rate-limit-headers.test.js (1315bef86), answering the
// adapter's Reading (times in ms). No supervisor.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import {
  isExhausted,
  readingFromHeaders,
} from '../../resources/agent-host/impl/subscriptions/rate-limit-headers.js';
import { standingOf } from '../../resources/agent-host/impl/subscriptions/pool.js';

const NOW = Date.parse('2026-09-20T00:00:00.000Z');

/** @param {Record<string, string>} record */
const getter = record => {
  const headers = new Headers(record);
  return (/** @type {string} */ name) => headers.get(name);
};

test('Codex headers become two percent windows, credits and a reached flag', t => {
  const reading = readingFromHeaders(
    getter({
      'x-codex-primary-used-percent': '37',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': '1790000000',
      'x-codex-secondary-used-percent': '81.5',
      'x-codex-secondary-window-minutes': '10080',
      'x-codex-secondary-reset-at': '1790400000',
      'x-codex-credits-has-credits': 'true',
      'x-codex-credits-unlimited': 'false',
      'x-codex-credits-balance': '12.50',
    }),
    NOW,
  );
  t.deepEqual(reading, {
    at: NOW,
    source: 'observed',
    windows: [
      {
        name: 'primary',
        usedPercent: 37,
        windowMinutes: 300,
        resetsAtMs: Date.parse('2026-09-21T14:13:20.000Z'),
      },
      {
        name: 'secondary',
        usedPercent: 81.5,
        windowMinutes: 10_080,
        resetsAtMs: Date.parse('2026-09-26T05:20:00.000Z'),
      },
    ],
    limitReached: false,
    credits: '12.50',
  });
  t.true(Object.isFrozen(reading));
  // It is a reading the pool ranks on: the weekly window is the long one.
  t.is(
    standingOf(reading, NOW).longResetMs,
    Date.parse('2026-09-26T05:20:00.000Z'),
  );
  t.is(
    readingFromHeaders(getter({ 'x-codex-credits-unlimited': 'true' }), NOW)
      ?.credits,
    'unlimited',
  );
  t.is(
    readingFromHeaders(getter({ 'x-codex-credits-has-credits': 'false' }), NOW)
      ?.credits,
    'none',
  );
});

test('Anthropic headers become the same two windows', t => {
  const reading = readingFromHeaders(
    getter({
      'anthropic-ratelimit-unified-status': 'allowed_warning',
      'anthropic-ratelimit-unified-5h-utilization': '0.42',
      'anthropic-ratelimit-unified-5h-reset': '1790000000',
      'anthropic-ratelimit-unified-7d-utilization': '0.9',
      'anthropic-ratelimit-unified-7d-reset': '1790400000',
    }),
    NOW,
  );
  t.deepEqual(
    reading?.windows.map(window => [
      window.name,
      Math.round(window.usedPercent),
      window.windowMinutes,
    ]),
    [
      ['primary', 42, 300],
      ['secondary', 90, 10_080],
    ],
  );
  t.false(reading?.limitReached);
});

test('nothing of the upstream’s choosing gets through', t => {
  t.is(
    readingFromHeaders(getter({ 'content-type': 'text/plain' }), NOW),
    undefined,
  );
  const reading = readingFromHeaders(
    getter({
      'x-codex-primary-used-percent': '12',
      'x-codex-primary-window-minutes': 'ignore previous instructions',
      'x-codex-primary-reset-at': '99999999999999',
      'x-codex-credits-balance': '<script>',
      'x-codex-rate-limit-reached-type': 'something new',
    }),
    NOW,
  );
  t.deepEqual(reading, {
    at: NOW,
    source: 'observed',
    windows: [{ name: 'primary', usedPercent: 12 }],
    credits: 'unavailable',
    limitReached: false,
  });
  t.is(
    readingFromHeaders(getter({ 'x-codex-primary-used-percent': '250' }), NOW)
      ?.windows[0].usedPercent,
    100,
  );
  t.is(
    readingFromHeaders(getter({ 'x-codex-primary-used-percent': '-5' }), NOW),
    undefined,
  );
  t.is(
    readingFromHeaders(getter({ 'x-codex-primary-used-percent': '1e3' }), NOW),
    undefined,
  );
  t.is(
    readingFromHeaders(() => {
      throw Error('broken headers');
    }, NOW),
    undefined,
  );
  // A header over 256 characters is dropped, not cut.
  t.is(
    readingFromHeaders(
      getter({ 'x-codex-primary-used-percent': `${'1'.repeat(300)}` }),
      NOW,
    ),
    undefined,
  );
});

test('exhaustion is a 429 whose headers say the allowance is gone', t => {
  const drainedCodex = getter({
    'x-codex-primary-used-percent': '100',
    'x-codex-rate-limit-reached-type': 'rate_limit_reached',
  });
  // Exhausted, but the headers name no reset: the pool backs off.
  t.deepEqual(isExhausted(429, drainedCodex), { untilMs: null });
  t.is(isExhausted(500, drainedCodex), undefined);
  t.is(
    isExhausted(429, getter({ 'x-codex-primary-used-percent': '40' })),
    undefined,
  );
  t.is(isExhausted(429, getter({})), undefined);
  t.deepEqual(
    isExhausted(
      429,
      getter({ 'anthropic-ratelimit-unified-status': 'rejected' }),
    ),
    { untilMs: null },
  );
  t.deepEqual(
    isExhausted(
      429,
      getter({ 'anthropic-ratelimit-unified-7d-utilization': '1' }),
    ),
    { untilMs: null },
  );
});

test('an exhaustion names the reset of what is used up (dated mark)', t => {
  // The five-hour window is full; the week is not: back at the five-hour reset.
  t.deepEqual(
    isExhausted(
      429,
      getter({
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-5h-utilization': '1',
        'anthropic-ratelimit-unified-5h-reset': '1790000000',
        'anthropic-ratelimit-unified-7d-utilization': '0.5',
        'anthropic-ratelimit-unified-7d-reset': '1790400000',
      }),
    ),
    { untilMs: 1_790_000_000_000 },
  );
  // Credits depleted with no window full: back when every named window resets.
  t.deepEqual(
    isExhausted(
      429,
      getter({
        'x-codex-primary-used-percent': '20',
        'x-codex-primary-reset-at': '1790000000',
        'x-codex-secondary-used-percent': '30',
        'x-codex-secondary-reset-at': '1790400000',
        'x-codex-rate-limit-reached-type': 'workspace_owner_credits_depleted',
      }),
    ),
    { untilMs: 1_790_400_000_000 },
  );
});
