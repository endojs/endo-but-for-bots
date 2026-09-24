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

test('account rendering preserves plan and quota provenance without billing claims', t => {
  const text = renderAccountStatus(snapshotWith([]));
  t.regex(text, /Plan: Max on anthropic/);
  t.regex(text, /read from the provider as of/);
  t.false(text.includes('cost'));
});
