// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import {
  coerceDeclaredProfile,
  estimateCostAtRate,
  formatMicroUnits,
  normalizeAccountPlan,
  normalizeModelRate,
  normalizeRateCard,
  normalizeRateLimits,
  normalizeRateLimitWindow,
} from '../src/account.js';

const AT = '2026-09-04T12:00:00.000Z';

test('a plan snapshot keeps its provenance and rejects an unknown state', t => {
  const plan = normalizeAccountPlan({
    providerId: 'anthropic',
    planId: 'max-20x',
    title: 'Max',
    state: 'active',
    renewsAt: '2026-10-01T00:00:00.000Z',
    seats: 3n,
    observedAt: AT,
    source: 'declared',
  });
  t.is(plan.source, 'declared');
  t.is(plan.seats, 3n);
  t.throws(
    () =>
      normalizeAccountPlan({
        providerId: 'anthropic',
        state: 'lapsed',
        observedAt: AT,
        source: 'declared',
      }),
    { message: /plan state must be one of/ },
  );
  t.throws(
    () =>
      normalizeAccountPlan({
        providerId: 'anthropic',
        state: 'active',
        observedAt: AT,
        source: 'guessed',
      }),
    { message: /plan source. must be one of/ },
  );
  t.throws(
    () =>
      normalizeAccountPlan({
        providerId: 'anthropic',
        state: 'active',
        observedAt: 'yesterday',
        source: 'declared',
      }),
    { message: /ISO 8601 instant/ },
  );
});

test('a rate-limit window derives remaining and usage only from published figures', t => {
  const derived = normalizeRateLimitWindow({
    windowId: 'tokens-per-minute',
    title: 'Tokens per minute',
    limit: 400_000n,
    used: 100_000n,
    resetsAt: AT,
  });
  t.is(derived.remaining, 300_000n);
  t.is(derived.usedFraction, 0.25);

  const partial = normalizeRateLimitWindow({
    windowId: 'requests-per-minute',
    limit: null,
    used: 12n,
  });
  t.is(partial.remaining, null);
  t.is(
    partial.usedFraction,
    null,
    'a limit nobody published cannot be a ratio',
  );

  // Over-consumption is clamped rather than reported as negative headroom.
  const over = normalizeRateLimitWindow({
    windowId: 'weekly',
    limit: 10n,
    used: 25n,
  });
  t.is(over.remaining, 0n);
  t.is(over.usedFraction, 1);
});

test('counts must be bigints, so a float quota cannot slip through', t => {
  t.throws(() => normalizeRateLimitWindow({ windowId: 'w', limit: 400_000 }), {
    message: /must be a bigint or null/,
  });
  t.throws(() => normalizeRateLimitWindow({ windowId: 'w', used: -1n }), {
    message: /must not be negative/,
  });
});

test('rate limits and rate cards reject duplicate ids', t => {
  t.throws(
    () =>
      normalizeRateLimits({
        windows: [{ windowId: 'w' }, { windowId: 'w' }],
        observedAt: AT,
        source: 'observed',
      }),
    { message: /distinct ids/ },
  );
  t.throws(
    () =>
      normalizeRateCard({
        rates: [
          { modelId: 'm', currency: 'USD' },
          { modelId: 'm', currency: 'USD' },
        ],
        observedAt: AT,
        source: 'declared',
      }),
    { message: /must not price a model twice/ },
  );
});

test('a model rate requires an ISO 4217 currency', t => {
  t.throws(() => normalizeModelRate({ modelId: 'm', currency: 'dollars' }), {
    message: /ISO 4217/,
  });
  const rate = normalizeModelRate({
    modelId: 'claude-sonnet-4-6',
    currency: 'USD',
    inputPerMillion: 3_000_000n,
    outputPerMillion: 15_000_000n,
    cachedInputPerMillion: null,
  });
  t.is(rate.cachedInputPerMillion, null);
});

test('cost is exact integer arithmetic and says what it could not price', t => {
  const rate = normalizeModelRate({
    modelId: 'claude-sonnet-4-6',
    currency: 'USD',
    inputPerMillion: 3_000_000n,
    outputPerMillion: 15_000_000n,
    cachedInputPerMillion: null,
  });
  const estimate = estimateCostAtRate(
    { inputTokens: 1_000_000n, outputTokens: 500_000n },
    rate,
  );
  // 1M input at USD 3.00 plus 500k output at USD 15.00 = USD 10.50.
  t.is(estimate.microUnits, 10_500_000n);
  t.is(formatMicroUnits(estimate.microUnits, 'USD'), '10.500000 USD');
  t.deepEqual(estimate.missing, []);

  const unpriced = estimateCostAtRate(
    { inputTokens: 10n, cachedInputTokens: 1_000_000n },
    rate,
  );
  t.deepEqual(unpriced.missing, ['cachedInput']);
  t.is(unpriced.microUnits, 30n, 'the priced part still counts');

  const noRate = estimateCostAtRate({ inputTokens: 1n }, undefined);
  t.is(noRate.microUnits, 0n);
  t.deepEqual(noRate.missing, ['rate']);
});

test('a zero token count is free, not unpriced', t => {
  const rate = normalizeModelRate({
    modelId: 'm',
    currency: 'USD',
    inputPerMillion: null,
    outputPerMillion: null,
    cachedInputPerMillion: null,
  });
  const estimate = estimateCostAtRate({ inputTokens: 0n }, rate);
  t.is(estimate.microUnits, 0n);
  t.deepEqual(estimate.missing, []);
});

test('cost rejects a negative or non-bigint token count', t => {
  const rate = normalizeModelRate({
    modelId: 'm',
    currency: 'USD',
    inputPerMillion: 1n,
  });
  t.throws(
    () => estimateCostAtRate({ inputTokens: /** @type {any} */ (1000) }, rate),
    { message: /must be a bigint/ },
  );
  t.throws(() => estimateCostAtRate({ inputTokens: -1n }, rate), {
    message: /must not be negative/,
  });
});

test('a declared profile widens JSON numbers and strings into counts', t => {
  const profile = coerceDeclaredProfile({
    plan: { planId: 'max', title: 'Max', state: 'active', seats: 5 },
    rateLimits: {
      windows: [{ windowId: 'weekly', limit: '90000000000', used: 12 }],
    },
    rateCard: {
      rates: [
        {
          modelId: 'claude-sonnet-4-6',
          currency: 'USD',
          inputPerMillion: 3_000_000,
          outputPerMillion: '15000000',
        },
      ],
    },
  });
  t.is(profile.plan.seats, 5n);
  t.is(profile.rateLimits.windows[0].limit, 90_000_000_000n);
  t.is(profile.rateCard.rates[0].outputPerMillion, 15_000_000n);
  // And the result validates.
  const card = normalizeRateCard({
    ...profile.rateCard,
    observedAt: AT,
    source: 'declared',
  });
  t.is(card.rates[0].inputPerMillion, 3_000_000n);
});

test('a declared profile refuses a quota that JSON cannot hold exactly', t => {
  t.throws(
    () =>
      coerceDeclaredProfile({
        rateLimits: { windows: [{ windowId: 'w', limit: 1.5 }] },
      }),
    { message: /written as a string/ },
  );
  t.throws(
    () =>
      coerceDeclaredProfile({
        rateLimits: { windows: [{ windowId: 'w', limit: '-4' }] },
      }),
    { message: /non-negative decimal integer/ },
  );
});

test('micro-units render with a fixed six-place fraction', t => {
  t.is(formatMicroUnits(0n, 'USD'), '0.000000 USD');
  t.is(formatMicroUnits(1n, 'USD'), '0.000001 USD');
  t.is(formatMicroUnits(1_234_567n, 'EUR'), '1.234567 EUR');
  t.is(formatMicroUnits(-2_000_000n, 'USD'), '-2.000000 USD');
  t.is(formatMicroUnits(5n, ''), '0.000005');
});
