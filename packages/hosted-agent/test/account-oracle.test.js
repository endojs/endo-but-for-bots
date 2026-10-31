// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import { makeAccountOracleKit } from '../src/account-oracle.js';
import { makeAccountReadingSource } from '../src/account-source.js';

const makeTestOracle = (t, options) => {
  const kit = makeAccountOracleKit(options);
  t.teardown(() => kit.close());
  return kit.account;
};

const T0 = '2026-09-04T12:00:00.000Z';
const T1 = '2026-09-04T13:00:00.000Z';
const TEARLIER = '2026-09-04T11:00:00.000Z';

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
  let writes = 0;
  return {
    journal: {
      read: async () => stored,
      write: async snapshot => {
        writes += 1;
        stored = snapshot;
      },
    },
    writes: () => writes,
    peek: () => stored,
    seed: snapshot => {
      stored = snapshot;
    },
  };
};

test('with no source at all every section is unavailable, not invented', async t => {
  const oracle = makeTestOracle(t, { providerId: 'anthropic', now: () => T0 });
  const plan = await E(oracle).getPlan();
  t.is(plan.source, 'unavailable');
  t.is(plan.state, 'unknown');
  t.is(plan.observedAt, T0);
  t.deepEqual((await E(oracle).getRateLimits()).windows, []);
  t.deepEqual((await E(oracle).getRateCard()).rates, []);
});

test('a declared profile answers, marked as declared rather than measured', async t => {
  const oracle = makeTestOracle(t, {
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
  const oracle = makeTestOracle(t, {
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
  const oracle = makeTestOracle(t, {
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
  const remembered = makeTestOracle(t, {
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
  const afterRestart = makeTestOracle(t, {
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
  const oracle = makeTestOracle(t, {
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
  const oracle = makeTestOracle(t, {
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
  const oracle = makeTestOracle(t, {
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
  const oracle = makeTestOracle(t, { providerId: 'anthropic', now: () => T0 });
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
    'watch',
  ]);
  t.true((await E(oracle).help()).includes('observed'));
  t.true((await E(oracle).help('getRateLimits')).includes('bigints'));
});

test('a provider id is required', t => {
  t.throws(() => makeTestOracle(t, { providerId: '' }), {
    message: /requires a providerId/,
  });
});

test('a source that returns junk is rejected, not stored', async t => {
  const { journal, peek } = makeMemoryJournal();
  const oracle = makeTestOracle(t, {
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
  const oracle = makeTestOracle(t, {
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
  const oracle = makeTestOracle(t, {
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
  const revived = makeTestOracle(t, {
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
  /** @type {any} */
  let payload = harden({
    plan: { planId: 'max', title: 'Max', state: 'active', seats: 1n },
    rateLimits: {
      windows: [{ windowId: 'weekly', limit: 1000n, used: 100n }],
    },
  });
  const oracle = makeTestOracle(t, {
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
  const oracle = makeTestOracle(t, {
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

  // Once the journal is readable again the oracle resumes writing, so the
  // outage is transient rather than terminal.
  failReads = false;
  await E(oracle).refresh();
  t.deepEqual(Object.keys(memory.peek()).sort(), ['plan', 'rateLimits']);
});

test('a source cannot stamp its own provenance', async t => {
  const oracle = makeTestOracle(t, {
    providerId: 'anthropic',
    // A declared profile claiming to be a live reading, of an account it does
    // not describe.
    provideDeclared: async () =>
      harden({
        plan: {
          planId: 'max',
          title: 'Max',
          state: 'active',
          seats: 1n,
          source: 'observed',
          providerId: 'somebody-else',
          observedAt: TEARLIER,
        },
      }),
    now: () => T0,
  });
  const plan = await E(oracle).getPlan();
  t.is(plan.source, 'declared');
  t.is(plan.providerId, 'anthropic');
  // `observedAt` is the source's to report, though: only it knows when the
  // figure was taken, and a backend that caches provider quota would otherwise
  // have hour-old numbers presented as measured just now.
  t.is(plan.observedAt, TEARLIER);
});

test('a stamp that would make a stale figure look fresh is refused', async t => {
  /** @param {any} reported */
  const planWith = reported =>
    makeTestOracle(t, {
      providerId: 'anthropic',
      provideObserved: async () =>
        harden({
          plan: {
            planId: 'max',
            title: 'Max',
            state: 'active',
            seats: 1n,
            observedAt: reported,
          },
        }),
      now: () => T0,
    });
  // A reading cannot have been taken after the moment it was read.
  t.is((await E(planWith(T1)).getPlan()).observedAt, T0);
  // Nor can it have been taken at a moment that is not one.
  t.is((await E(planWith('Dec 25 3000')).getPlan()).observedAt, T0);
  t.is((await E(planWith('')).getPlan()).observedAt, T0);
  // A source that reports no instant at all gets the oracle's clock.
  t.is((await E(planWith(undefined)).getPlan()).observedAt, T0);
  // A real past instant is honoured, canonicalized.
  t.is(
    (await E(planWith('2026-09-04T11:00:00Z')).getPlan()).observedAt,
    TEARLIER,
  );
});

test('one unusable section does not discard the reading beside it', async t => {
  const memory = makeMemoryJournal();
  const oracle = makeTestOracle(t, {
    providerId: 'anthropic',
    // `seats` must be a count; the plan cannot be projected. The rate limits
    // beside it are perfectly good, and all-or-nothing projection threw them
    // away — and with them the only thing worth journalling, so the journal
    // stayed empty on every refresh.
    provideObserved: async () =>
      harden({
        plan: { planId: 'max', state: 'active', seats: 'lots' },
        rateLimits: { windows: [{ windowId: 'weekly', limit: 9n, used: 1n }] },
      }),
    journal: memory.journal,
    now: () => T0,
  });
  const limits = await E(oracle).getRateLimits();
  t.is(limits.source, 'observed');
  t.is(limits.windows.length, 1);
  t.is((await E(oracle).getPlan()).source, 'unavailable');
  t.deepEqual(Object.keys(memory.peek()).sort(), ['rateLimits']);
});

test('the oracle clock supplies observedAt only when the source does not', async t => {
  const oracle = makeTestOracle(t, {
    providerId: 'anthropic',
    provideDeclared: async () =>
      harden({
        plan: { planId: 'max', title: 'Max', state: 'active', seats: 1n },
      }),
    now: () => T0,
  });
  t.is((await E(oracle).getPlan()).observedAt, T0);
});

test('a stored section no normalizer can read is replaced, not wedged', async t => {
  const memory = makeMemoryJournal();
  // A plan written before the normalizer required `state`: it passes the raw
  // `source === 'observed'` filter and then fails normalization.
  memory.seed(harden({ plan: { planId: 'max', source: 'observed' } }));
  const oracle = makeTestOracle(t, {
    providerId: 'anthropic',
    provideObserved: async () =>
      harden({
        rateLimits: { windows: [{ windowId: 'weekly', limit: 9n, used: 1n }] },
      }),
    journal: memory.journal,
    now: () => T0,
  });
  t.is((await E(oracle).getRateLimits()).source, 'observed');
  t.is((await E(oracle).getPlan()).source, 'unavailable');
  // Gating the write on the *read* would have made one bad entry terminal:
  // nothing prunes the journal, so the only way past a bad entry is to write a
  // newer one.
  t.deepEqual(Object.keys(memory.peek()).sort(), ['rateLimits']);
});

const weekly = (usedPercent, extra = {}) =>
  harden({
    rateLimits: {
      windows: [
        {
          windowId: 'secondary',
          title: 'Weekly window',
          usedPercent,
          resetsAt: '2026-09-11T00:00:00.000Z',
        },
      ],
      limitReached: false,
      ...extra,
    },
    status: 200,
    exhausted: false,
  });

/**
 * An oracle fed by a broker's account source, as the adapters wire it.
 * @param {any} t
 * @param {ReturnType<typeof makeMemoryJournal>} memory
 */
const pushedOracle = (t, memory) => {
  const account = makeAccountReadingSource({ now: () => T0 });
  let reads = 0;
  const oracle = makeTestOracle(t, {
    providerId: 'codex',
    now: () => T0,
    journal: memory.journal,
    provideObserved: () => E(account.source).observe(),
    watchObserved: async () => E(account.source).watch(),
    refreshObserved: async () => {
      reads += 1;
      await E(account.source).refresh();
    },
  });
  return { account, oracle, reads: () => reads };
};

test('a pushed reading reaches watchers without anyone asking again', async t => {
  const journal = makeMemoryJournal();
  const { account, oracle, reads } = pushedOracle(t, journal);
  const reader = iterateReader(E(oracle).watch());
  // Nothing served yet: the first answer is honest about knowing nothing.
  const first = (await reader.next()).value;
  t.is(first.rateLimits.source, 'unavailable');
  account.accept(weekly(37));
  const second = (await reader.next()).value;
  t.is(second.rateLimits.source, 'observed');
  t.is(second.rateLimits.windows[0].usedPercent, 37);
  t.is(second.rateLimits.windows[0].usedFraction, 0.37);
  // The plan was never observed and is not invented.
  t.is(second.plan.source, 'unavailable');
  // Watching is not refreshing: the provider was never asked.
  t.is(reads(), 0);
  await reader.return(undefined);
});

test('a reading is journalled when it changes materially, not on every response', async t => {
  const journal = makeMemoryJournal();
  const { account, oracle } = pushedOracle(t, journal);
  const reader = iterateReader(E(oracle).watch());
  await reader.next();
  const settle = async usedPercent => {
    account.accept(usedPercent);
    await reader.next();
    // The write follows the publication.
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  await settle(weekly(37));
  t.is(journal.writes(), 1);
  // Creeping within a five-point step writes nothing.
  await settle(weekly(38));
  await settle(weekly(39.9));
  t.is(journal.writes(), 1);
  // Crossing a step, reaching the limit, and a moved reset each write once.
  await settle(weekly(40));
  t.is(journal.writes(), 2);
  await settle(weekly(40, { limitReached: true }));
  t.is(journal.writes(), 3);
  await settle(
    harden({
      rateLimits: {
        windows: [
          {
            windowId: 'secondary',
            title: 'Weekly window',
            usedPercent: 0,
            resetsAt: '2026-09-18T00:00:00.000Z',
          },
        ],
        limitReached: false,
      },
    }),
  );
  t.is(journal.writes(), 4);
  await reader.return(undefined);
});

test('after a restart the last reading is remembered, with a blocked window still blocked', async t => {
  const journal = makeMemoryJournal();
  const before = pushedOracle(t, journal);
  const reader = iterateReader(E(before.oracle).watch());
  await reader.next();
  before.account.accept(weekly(100, { limitReached: true }));
  await reader.next();
  await new Promise(resolve => setTimeout(resolve, 0));
  await reader.return(undefined);

  // A new incarnation: a fresh source that has served nothing, same journal.
  const after = pushedOracle(t, journal);
  const limits = await E(after.oracle).getRateLimits();
  t.is(limits.source, 'remembered');
  t.true(limits.limitReached);
  t.is(limits.windows[0].usedPercent, 100);
  t.is(limits.windows[0].resetsAt, '2026-09-11T00:00:00.000Z');
  // Reading it asked the provider nothing.
  t.is(after.reads(), 0);
});

test('an explicit refresh asks the source to read its provider, once', async t => {
  const { oracle, reads } = pushedOracle(t, makeMemoryJournal());
  await E(oracle).getPlan();
  t.is(reads(), 0);
  await E(oracle).refresh();
  t.is(reads(), 1);
});

test('a reading pushed while the answer is being built is not overwritten by it', async t => {
  // The journal is slow to read, as a pet store under load is. A 429 arrives
  // in that window: the build saw the source before it, and must not put its
  // older view back over it, in the answer or in the journal.
  const account = makeAccountReadingSource({ now: () => T0 });
  account.accept(weekly(50));
  /** @type {any[]} */
  const written = [];
  let release = () => {};
  const held = new Promise(resolve => {
    release = () => resolve(undefined);
  });
  let observedOnce = () => {};
  const observed = new Promise(resolve => {
    observedOnce = () => resolve(undefined);
  });
  const oracle = makeTestOracle(t, {
    providerId: 'codex',
    now: () => T0,
    journal: {
      read: async () => {
        await held;
        return undefined;
      },
      write: async record => {
        written.push(record);
      },
    },
    provideObserved: async () => {
      const reading = await E(account.source).observe();
      observedOnce();
      return reading;
    },
    watchObserved: async () => E(account.source).watch(),
  });
  const reader = iterateReader(E(oracle).watch());
  const first = reader.next();
  await observed;
  // The build has read the source and is now waiting on the journal.
  account.accept(weekly(100, { limitReached: true }));
  release();
  let value = (await first).value;
  while (!value.rateLimits.limitReached) {
    // eslint-disable-next-line no-await-in-loop
    value = (await reader.next()).value;
  }
  await new Promise(resolve => setTimeout(resolve, 0));
  const limits = await E(oracle).getRateLimits();
  t.true(limits.limitReached);
  t.is(limits.windows[0].usedPercent, 100);
  t.true(written.at(-1).rateLimits.limitReached);
  await reader.return(undefined);
});
