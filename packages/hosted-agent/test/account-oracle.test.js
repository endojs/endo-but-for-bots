// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import { makeAccountOracle } from '../src/account-oracle.js';

const T0 = '2026-09-04T12:00:00.000Z';
const T1 = '2026-09-04T13:00:00.000Z';

const declaredProfile = harden({
  plan: { planId: 'max', title: 'Max', state: 'active', seats: 1n },
  rateLimits: {
    windows: [{ windowId: 'weekly', title: 'Weekly', limit: 1000n, used: 0n }],
  },
  rateCard: {
    rates: [
      {
        modelId: 'claude-sonnet-4-6',
        currency: 'USD',
        inputPerMillion: 3_000_000n,
        outputPerMillion: 15_000_000n,
      },
    ],
  },
});

/** An in-memory stand-in for the pet-store journal. */
const makeMemoryJournal = () => {
  /** @type {any} */
  let stored;
  return {
    journal: {
      read: async () => stored,
      write: async snapshot => {
        stored = snapshot;
      },
    },
    peek: () => stored,
    seed: snapshot => {
      stored = snapshot;
    },
  };
};

test('with no source at all every section is unavailable, not invented', async t => {
  const oracle = makeAccountOracle({ providerId: 'anthropic', now: () => T0 });
  const plan = await E(oracle).getPlan();
  t.is(plan.source, 'unavailable');
  t.is(plan.state, 'unknown');
  t.is(plan.observedAt, T0);
  t.deepEqual((await E(oracle).getRateLimits()).windows, []);
  t.deepEqual((await E(oracle).getRateCard()).rates, []);
});

test('a declared profile answers, marked as declared rather than measured', async t => {
  const oracle = makeAccountOracle({
    providerId: 'anthropic',
    provideDeclared: async () => declaredProfile,
    now: () => T0,
  });
  const plan = await E(oracle).getPlan();
  t.is(plan.source, 'declared');
  t.is(plan.title, 'Max');
  t.is(plan.providerId, 'anthropic');
  const limits = await E(oracle).getRateLimits();
  t.is(limits.windows[0].remaining, 1000n);
});

test('a live reading wins over the declared profile and is journalled', async t => {
  const { journal, peek } = makeMemoryJournal();
  const oracle = makeAccountOracle({
    providerId: 'anthropic',
    provideDeclared: async () => declaredProfile,
    provideObserved: async () => ({
      rateLimits: {
        windows: [{ windowId: 'weekly', limit: 1000n, used: 900n }],
      },
    }),
    journal,
    now: () => T0,
  });
  const limits = await E(oracle).getRateLimits();
  t.is(limits.source, 'observed');
  t.is(limits.windows[0].remaining, 100n);
  // The plan had no live reading, so it falls back to the declaration.
  t.is((await E(oracle).getPlan()).source, 'declared');
  t.truthy(peek(), 'a live reading is worth remembering');
  t.is(peek().rateLimits.windows[0].used, 900n);
});

test('a declared-only answer is not written back as if it were observed', async t => {
  const { journal, peek } = makeMemoryJournal();
  const oracle = makeAccountOracle({
    providerId: 'anthropic',
    provideDeclared: async () => declaredProfile,
    journal,
    now: () => T0,
  });
  await E(oracle).getPlan();
  t.is(peek(), undefined);
});

test('a failed live read falls back to the last reading, marked remembered', async t => {
  const { journal, seed } = makeMemoryJournal();
  const remembered = makeAccountOracle({
    providerId: 'anthropic',
    provideObserved: async () => ({
      rateLimits: {
        windows: [{ windowId: 'weekly', limit: 1000n, used: 400n }],
      },
    }),
    journal,
    now: () => T0,
  });
  await E(remembered).getRateLimits();

  const stored = await journal.read();
  seed(stored);
  const afterRestart = makeAccountOracle({
    providerId: 'anthropic',
    provideObserved: async () => {
      throw Error('provider unreachable');
    },
    journal,
    now: () => T1,
  });
  const limits = await E(afterRestart).getRateLimits();
  t.is(limits.source, 'remembered');
  t.is(limits.observedAt, T0, 'the age of the reading, not of the answer');
  t.is(limits.windows[0].used, 400n);
  // A section that was never known stays unavailable rather than becoming a
  // memory of nothing.
  t.is((await E(afterRestart).getPlan()).source, 'unavailable');
});

test('an unreadable declared profile does not take the whole answer down', async t => {
  const oracle = makeAccountOracle({
    providerId: 'anthropic',
    provideDeclared: async () => {
      throw Error('profile is corrupt');
    },
    provideObserved: async () => ({
      plan: { planId: 'pro', title: 'Pro', state: 'active' },
    }),
    now: () => T0,
  });
  t.is((await E(oracle).getPlan()).source, 'observed');
  t.is((await E(oracle).getRateCard()).source, 'unavailable');
});

test('estimateCost prices a session against the current card', async t => {
  const oracle = makeAccountOracle({
    providerId: 'anthropic',
    provideDeclared: async () => declaredProfile,
    now: () => T0,
  });
  const cost = await E(oracle).estimateCost(
    harden({
      modelId: 'claude-sonnet-4-6',
      inputTokens: 2_000_000n,
      outputTokens: 100_000n,
    }),
  );
  // 2M input at USD 3.00 plus 100k output at USD 15.00 = USD 7.50.
  t.is(cost.microUnits, 7_500_000n);
  t.is(cost.display, '7.500000 USD');
  t.is(cost.source, 'declared');

  const unknownModel = await E(oracle).estimateCost(
    harden({ modelId: 'gpt-mystery', inputTokens: 1_000_000n }),
  );
  t.is(unknownModel.microUnits, 0n);
  t.deepEqual(unknownModel.missing, ['rate']);

  await t.throwsAsync(E(oracle).estimateCost(harden({ modelId: '' })), {
    message: /requires a modelId/,
  });
});

test('concurrent first reads share one live read', async t => {
  let reads = 0;
  const oracle = makeAccountOracle({
    providerId: 'anthropic',
    provideObserved: async () => {
      reads += 1;
      return { plan: { planId: 'pro', title: 'Pro', state: 'active' } };
    },
    now: () => T0,
  });
  await Promise.all([
    E(oracle).getPlan(),
    E(oracle).getRateLimits(),
    E(oracle).getRateCard(),
  ]);
  t.is(reads, 1);
  // And a later read reuses the snapshot rather than hitting the provider.
  await E(oracle).getPlan();
  t.is(reads, 1);
  // refresh() is the way to ask again.
  await E(oracle).refresh();
  t.is(reads, 2);
});

test('the oracle exposes only read methods', async t => {
  const oracle = makeAccountOracle({ providerId: 'anthropic', now: () => T0 });
  // CapTP introspection is not on the exo's declared interface, so the guarded
  // type does not carry it; the cast is at the call, not on the oracle.
  // eslint-disable-next-line no-underscore-dangle
  const methods = await E(/** @type {any} */ (oracle)).__getMethodNames__();
  t.deepEqual([...methods].sort(), [
    '__getInterfaceGuard__',
    '__getMethodNames__',
    'estimateCost',
    'getPlan',
    'getRateCard',
    'getRateLimits',
    'help',
    'refresh',
  ]);
  t.true((await E(oracle).help()).includes('observed'));
  t.true((await E(oracle).help('getRateLimits')).includes('bigints'));
});

test('a provider id is required', t => {
  t.throws(() => makeAccountOracle({ providerId: '' }), {
    message: /requires a providerId/,
  });
});

test('a source that returns junk is rejected, not stored', async t => {
  const { journal, peek } = makeMemoryJournal();
  const oracle = makeAccountOracle({
    providerId: 'anthropic',
    provideObserved: async () => ({
      rateLimits: { windows: [{ windowId: 'w', limit: 5 }] },
    }),
    journal,
    now: () => T0,
  });
  // The float limit fails normalization, the live read is discarded with a
  // diagnostic, and nothing is written to the journal.
  t.is((await E(oracle).getRateLimits()).source, 'unavailable');
  t.is(peek(), undefined);
});

test('a source may be an eventual-send capability', async t => {
  const source = Far('AccountSource', {
    observe: async () =>
      harden({ plan: { planId: 'team', title: 'Team', state: 'active' } }),
  });
  const oracle = makeAccountOracle({
    providerId: 'anthropic',
    provideObserved: () => E(source).observe(),
    now: () => T0,
  });
  const plan = await E(oracle).getPlan();
  t.is(plan.title, 'Team');
  t.is(plan.source, 'observed');
});

test('a declared section is never journalled beside an observed one', async t => {
  const memory = makeMemoryJournal();
  const oracle = makeAccountOracle({
    providerId: 'anthropic',
    provideDeclared: async () => declaredProfile,
    // The provider publishes rate limits but neither a plan nor a price list —
    // the usual case.
    provideObserved: async () =>
      harden({
        rateLimits: {
          windows: [{ windowId: 'weekly', limit: 1000n, used: 400n }],
        },
      }),
    journal: memory.journal,
    now: () => T0,
  });
  t.is((await E(oracle).getRateLimits()).source, 'observed');
  t.is((await E(oracle).getPlan()).source, 'declared');

  // Journalling the *merged* answer would store the declared plan and the
  // unavailable rate card, and the next incarnation would replay the operator's
  // assertion as a past measurement.
  const stored = memory.peek();
  t.deepEqual(Object.keys(stored).sort(), ['rateLimits']);

  // Revived without the declared profile — an operator who removed it — the
  // plan must read as unavailable. Journalling the merged answer would have
  // replayed their old assertion as a measurement nobody ever took.
  const revived = makeAccountOracle({
    providerId: 'anthropic',
    journal: memory.journal,
    now: () => T1,
  });
  t.is((await E(revived).getRateLimits()).source, 'remembered');
  t.is((await E(revived).getPlan()).source, 'unavailable');
  t.is((await E(revived).getRateCard()).source, 'unavailable');
});

test('a partial live read does not erase an earlier reading of another section', async t => {
  const memory = makeMemoryJournal();
  let payload = harden({
    plan: { planId: 'max', title: 'Max', state: 'active', seats: 1n },
    rateLimits: {
      windows: [{ windowId: 'weekly', limit: 1000n, used: 100n }],
    },
  });
  const oracle = makeAccountOracle({
    providerId: 'anthropic',
    provideObserved: async () => payload,
    journal: memory.journal,
    now: () => T0,
  });
  await E(oracle).getPlan();
  t.deepEqual(Object.keys(memory.peek()).sort(), ['plan', 'rateLimits']);

  // The next reading answers only the plan. The stored rate-limit reading is
  // still the last real one, so it must survive rather than be replaced by
  // "unavailable".
  payload = harden({
    plan: { planId: 'max', title: 'Max', state: 'active', seats: 2n },
  });
  await E(oracle).refresh();
  const stored = memory.peek();
  t.deepEqual(Object.keys(stored).sort(), ['plan', 'rateLimits']);
  t.is(stored.plan.seats, 2n);
  t.is(stored.rateLimits.windows[0].used, 100n);
});

test('an unreadable journal is not overwritten from a partial view', async t => {
  const memory = makeMemoryJournal();
  memory.seed(
    harden({
      rateLimits: {
        windows: [
          {
            windowId: 'weekly',
            title: '',
            limit: 1000n,
            used: 100n,
            remaining: 900n,
            usedFraction: 0.1,
            resetsAt: '',
          },
        ],
        observedAt: T0,
        source: 'observed',
      },
    }),
  );
  let failReads = true;
  const oracle = makeAccountOracle({
    providerId: 'anthropic',
    provideObserved: async () =>
      harden({
        plan: { planId: 'max', title: 'Max', state: 'active', seats: 1n },
      }),
    journal: {
      read: async () => {
        if (failReads) throw Error('journal briefly unavailable');
        return memory.peek();
      },
      write: memory.journal.write,
    },
    now: () => T1,
  });
  await E(oracle).getPlan();
  // With no idea what is already stored, writing would have replaced a real
  // rate-limit reading with nothing.
  t.deepEqual(Object.keys(memory.peek()).sort(), ['rateLimits']);
  failReads = false;
});

test('a source cannot stamp its own provenance', async t => {
  const oracle = makeAccountOracle({
    providerId: 'anthropic',
    // A declared profile claiming to be a live reading, from a provider it
    // does not describe, taken at a time it chose.
    provideDeclared: async () =>
      harden({
        plan: {
          planId: 'max',
          title: 'Max',
          state: 'active',
          seats: 1n,
          source: 'observed',
          providerId: 'somebody-else',
          observedAt: T1,
        },
      }),
    now: () => T0,
  });
  const plan = await E(oracle).getPlan();
  t.is(plan.source, 'declared');
  t.is(plan.providerId, 'anthropic');
  t.is(plan.observedAt, T0);
});
