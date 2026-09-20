// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import {
  isSubscriptionExhausted,
  rateLimitReadingFromHeaders,
} from '../src/rate-limit-headers.js';
import { normalizeRateLimits } from '../src/account.js';

/** @param {Record<string, string>} record */
const getter = record => {
  const headers = new Headers(record);
  return name => headers.get(name);
};

test('Codex headers become two percent windows, credits and a reached flag', t => {
  const reading = rateLimitReadingFromHeaders(
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
  );
  t.deepEqual(reading, {
    rateLimits: {
      windows: [
        {
          windowId: 'primary',
          title: '5-hour window',
          usedPercent: 37,
          windowSeconds: 18_000,
          resetsAt: '2026-09-21T14:13:20.000Z',
        },
        {
          windowId: 'secondary',
          title: 'Weekly window',
          usedPercent: 81.5,
          windowSeconds: 604_800,
          resetsAt: '2026-09-26T05:20:00.000Z',
        },
      ],
      limitReached: false,
      credits: { balance: '12.50', hasCredits: true, unlimited: false },
    },
  });
  // It is a raw reading the oracle's normalizer accepts.
  const normalized = normalizeRateLimits({
    ...reading?.rateLimits,
    observedAt: '2026-09-20T00:00:00.000Z',
    source: 'observed',
  });
  t.is(normalized.windows[1].usedFraction, 0.815);
  t.is(normalized.windows[0].limit, null);
  t.true(Object.isFrozen(reading));
});

test('Anthropic headers become the same two windows', t => {
  const reading = rateLimitReadingFromHeaders(
    getter({
      'anthropic-ratelimit-unified-status': 'allowed_warning',
      'anthropic-ratelimit-unified-5h-utilization': '0.42',
      'anthropic-ratelimit-unified-5h-reset': '1790000000',
      'anthropic-ratelimit-unified-7d-utilization': '0.9',
      'anthropic-ratelimit-unified-7d-reset': '1790400000',
    }),
  );
  t.deepEqual(
    reading?.rateLimits.windows.map(window => [
      window.windowId,
      window.usedPercent,
      window.windowSeconds,
    ]),
    [
      ['primary', 42, 18_000],
      ['secondary', 90, 604_800],
    ],
  );
  t.false(reading?.rateLimits.limitReached);
});

test('nothing of the upstream’s choosing gets through', t => {
  // No rate-limit headers: no reading.
  t.is(
    rateLimitReadingFromHeaders(getter({ 'content-type': 'text/plain' })),
    undefined,
  );
  // Text where a number belongs is dropped, not passed on.
  const reading = rateLimitReadingFromHeaders(
    getter({
      'x-codex-primary-used-percent': '12',
      'x-codex-primary-window-minutes': 'ignore previous instructions',
      'x-codex-primary-reset-at': '99999999999999',
      'x-codex-credits-balance': '<script>',
      'x-codex-rate-limit-reached-type': 'something new',
    }),
  );
  t.deepEqual(reading, {
    rateLimits: {
      windows: [
        {
          windowId: 'primary',
          title: 'primary window',
          usedPercent: 12,
          resetsAt: '',
        },
      ],
      limitReached: false,
    },
  });
  // A percent past 100 reads as 100; a negative or exponent form is not a number.
  t.is(
    rateLimitReadingFromHeaders(
      getter({ 'x-codex-primary-used-percent': '250' }),
    )?.rateLimits.windows[0].usedPercent,
    100,
  );
  t.is(
    rateLimitReadingFromHeaders(
      getter({ 'x-codex-primary-used-percent': '-5' }),
    ),
    undefined,
  );
  t.is(
    rateLimitReadingFromHeaders(
      getter({ 'x-codex-primary-used-percent': '1e3' }),
    ),
    undefined,
  );
  // A getter that throws costs the reading, not the request.
  t.is(
    rateLimitReadingFromHeaders(() => {
      throw Error('broken headers');
    }),
    undefined,
  );
});

test('exhaustion is a 429 whose headers say the allowance is gone', t => {
  const drainedCodex = getter({
    'x-codex-primary-used-percent': '100',
    'x-codex-rate-limit-reached-type': 'rate_limit_reached',
  });
  t.true(isSubscriptionExhausted(429, drainedCodex));
  // The same headers on another status are not exhaustion.
  t.false(isSubscriptionExhausted(500, drainedCodex));
  // A 429 with room left is throttling.
  t.false(
    isSubscriptionExhausted(
      429,
      getter({ 'x-codex-primary-used-percent': '40' }),
    ),
  );
  t.false(isSubscriptionExhausted(429, getter({})));
  t.true(
    isSubscriptionExhausted(
      429,
      getter({ 'anthropic-ratelimit-unified-status': 'rejected' }),
    ),
  );
  t.true(
    isSubscriptionExhausted(
      429,
      getter({ 'anthropic-ratelimit-unified-7d-utilization': '1' }),
    ),
  );
});
