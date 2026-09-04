// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { renderAccountStatus } from '../src/account-tool.js';

const T0 = '2026-09-04T12:00:00.000Z';

const snapshotWith = rates =>
  harden({
    plan: {
      providerId: 'anthropic',
      planId: 'max',
      title: 'Max',
      state: 'active',
      renewsAt: '',
      seats: 1n,
      observedAt: T0,
      source: 'observed',
    },
    rateLimits: harden({
      windows: harden([]),
      observedAt: T0,
      source: 'observed',
    }),
    rateCard: harden({
      rates: harden(rates),
      observedAt: T0,
      source: 'declared',
    }),
  });

const usage = harden({ inputTokens: 1000n, outputTokens: 500n });

test('a session with no model id says why it cannot be priced', t => {
  const text = renderAccountStatus(
    snapshotWith([
      {
        modelId: 'claude-sonnet-4-6',
        currency: 'USD',
        inputPerMillion: 3_000_000n,
        outputPerMillion: 15_000_000n,
        cachedInputPerMillion: null,
      },
    ]),
    usage,
    undefined,
    '',
  );
  // Silently omitting the cost line reads as "this session is free".
  t.true(text.includes('not identified'));
});

test('a model the rate card does not price is named', t => {
  const text = renderAccountStatus(
    snapshotWith([
      {
        modelId: 'claude-sonnet-4-6',
        currency: 'USD',
        inputPerMillion: 3_000_000n,
        outputPerMillion: 15_000_000n,
        cachedInputPerMillion: null,
      },
    ]),
    usage,
    undefined,
    'some-other-model',
  );
  t.true(text.includes('does not price "some-other-model"'));
});

test('an empty rate card still reports that no price is configured', t => {
  const text = renderAccountStatus(snapshotWith([]), usage, undefined, 'any');
  t.true(text.includes('No list price is configured'));
});
