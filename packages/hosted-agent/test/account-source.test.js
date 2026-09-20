// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import { makeAccountReadingSource } from '../src/account-source.js';

const headerReading = usedPercent =>
  harden({
    rateLimits: {
      windows: [{ windowId: 'secondary', title: 'Weekly window', usedPercent }],
      limitReached: false,
      credits: { balance: '5.00', hasCredits: true, unlimited: false },
    },
    status: 200,
    exhausted: false,
  });

test('observe answers from memory and never reads the provider', async t => {
  let reads = 0;
  const account = makeAccountReadingSource({
    now: () => '2026-09-20T00:00:00.000Z',
    activeRead: async () => {
      reads += 1;
      return undefined;
    },
  });
  t.deepEqual(await E(account.source).observe(), {});
  account.accept(headerReading(40));
  const observed = await E(account.source).observe();
  t.is(observed.rateLimits.windows[0].usedPercent, 40);
  t.is(observed.rateLimits.observedAt, '2026-09-20T00:00:00.000Z');
  t.is(reads, 0);
});

test('an active read adds the plan and banked resets, and headers do not erase them', async t => {
  const account = makeAccountReadingSource({
    now: () => '2026-09-20T00:00:00.000Z',
    activeRead: async () =>
      harden({
        plan: { planId: 'pro', title: 'Pro', state: 'active' },
        rateLimits: {
          windows: [
            { windowId: 'secondary', title: 'Weekly window', usedPercent: 41 },
          ],
          limitReached: false,
          resetCredits: { availableCount: 2, credits: null },
        },
      }),
  });
  await E(account.source).refresh();
  account.accept(headerReading(43));
  const observed = await E(account.source).observe();
  t.is(observed.plan.planId, 'pro');
  t.is(observed.rateLimits.windows[0].usedPercent, 43);
  // The header reading has no banked resets; the active read's stand.
  t.deepEqual(observed.rateLimits.resetCredits, {
    availableCount: 2,
    credits: null,
    observedAt: '2026-09-20T00:00:00.000Z',
  });
  t.is(observed.rateLimits.credits.balance, '5.00');
});

test('a failed or absent active read leaves the last reading standing', async t => {
  const errors = [];
  const failing = makeAccountReadingSource({
    activeRead: async () => {
      throw Error('provider unreachable');
    },
    reportError: error => errors.push(error),
  });
  failing.accept(headerReading(10));
  await E(failing.source).refresh();
  t.is(errors.length, 1);
  t.is(
    (await E(failing.source).observe()).rateLimits.windows[0].usedPercent,
    10,
  );
  // Without an active read, refresh does nothing at all.
  const passive = makeAccountReadingSource();
  await E(passive.source).refresh();
  t.deepEqual(await E(passive.source).observe(), {});
});

test('watch delivers the reading now and each later one', async t => {
  const account = makeAccountReadingSource();
  account.accept(headerReading(10));
  const reader = iterateReader(E(account.source).watch());
  t.is((await reader.next()).value.rateLimits.windows[0].usedPercent, 10);
  account.accept(headerReading(11));
  account.accept(headerReading(12));
  t.is((await reader.next()).value.rateLimits.windows[0].usedPercent, 12);
  account.close();
  t.true((await reader.next()).done);
});

test('a reading that names one window, or none, does not erase the others', async t => {
  const account = makeAccountReadingSource();
  account.accept(
    harden({
      rateLimits: {
        windows: [
          { windowId: 'primary', title: '5-hour window', usedPercent: 10 },
          {
            windowId: 'secondary',
            title: 'Weekly window',
            usedPercent: 60,
            resetsAt: '2030-01-01T00:00:00.000Z',
          },
        ],
        limitReached: false,
      },
    }),
  );
  // A refusal that carries only the word that the limit is reached.
  account.accept(harden({ rateLimits: { windows: [], limitReached: true } }));
  const refused = (await E(account.source).observe()).rateLimits;
  t.true(refused.limitReached);
  t.is(refused.windows.length, 2);
  t.is(refused.windows[1].resetsAt, '2030-01-01T00:00:00.000Z');
  // A response that names only the short window updates that one.
  account.accept(
    harden({
      rateLimits: {
        windows: [
          { windowId: 'primary', title: '5-hour window', usedPercent: 11 },
        ],
        limitReached: false,
      },
    }),
  );
  const next = (await E(account.source).observe()).rateLimits;
  t.deepEqual(
    next.windows.map(window => [window.windowId, window.usedPercent]),
    [
      ['primary', 11],
      ['secondary', 60],
    ],
  );
});

test('credits keep the time they were read under newer window readings', async t => {
  let clock = '2026-09-01T00:00:00.000Z';
  const account = makeAccountReadingSource({
    now: () => clock,
    activeRead: async () =>
      harden({
        rateLimits: {
          windows: [],
          limitReached: false,
          resetCredits: { availableCount: 1, credits: null },
        },
      }),
  });
  await E(account.source).refresh();
  clock = '2026-09-20T00:00:00.000Z';
  account.accept(headerReading(20));
  const limits = (await E(account.source).observe()).rateLimits;
  t.is(limits.observedAt, '2026-09-20T00:00:00.000Z');
  // The banked resets were counted three weeks ago, and say so.
  t.is(limits.resetCredits.observedAt, '2026-09-01T00:00:00.000Z');
  // The header reading's own credits are fresh.
  t.is(limits.credits.observedAt, '2026-09-20T00:00:00.000Z');
});
