// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { makeShareMeter, weightedTokens } from '../src/share-meter.js';

const ANCHOR = Date.parse('2026-09-20T00:00:00Z');

/**
 * @param {object} [options]
 * @param options.tokens
 * @param options.periodSeconds
 * @param options.initial
 */
const makeHarness = ({ tokens = 1000, periodSeconds = 3600, initial } = {}) => {
  /** @type {any[]} */
  const kept = [];
  const state = {
    now: ANCHOR + 1000,
    failing: false,
    budget: { tokens, periodSeconds },
  };
  const meter = makeShareMeter({
    budget: () => state.budget,
    anchorMs: ANCHOR,
    now: () => state.now,
    initial,
    keep: async record => {
      if (state.failing) throw Error('store is down');
      kept.push(record);
    },
  });
  return { meter, kept, state };
};

const usage = (inputTokens, outputTokens, cachedInputTokens = 0) => ({
  complete: true,
  usage: {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: 0,
  },
  began: true,
});

test('cached input weighs a tenth; everything else at par', t => {
  t.is(
    weightedTokens({
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 1005,
      cacheWriteInputTokens: 20,
      reasoningOutputTokens: 30,
    }),
    301,
  );
  t.is(weightedTokens(null), 0);
  t.is(weightedTokens({ inputTokens: 'many' }), 0);
});

test('a reservation is replaced by the charge, and what does not fit is refused', async t => {
  const { meter } = makeHarness();
  const first = await meter.reserve(600);
  t.like(meter.read(), { spent: 0, reserved: 600, remaining: 400 });
  // Room for one, not two: the second is refused while the first is open.
  await t.throwsAsync(() => meter.reserve(600), {
    message: 'Provider share exhausted',
  });
  first.settle(usage(100, 50));
  t.like(meter.read(), { spent: 150, reserved: 0, remaining: 850 });
  // Settling twice charges once.
  first.settle(usage(100, 50));
  t.is(meter.read()?.spent, 150);
});

test('refused before a response is free; begun without a usage event keeps the reservation', async t => {
  const { meter } = makeHarness();
  (await meter.reserve(300)).settle({ usage: null, began: false });
  t.is(meter.read()?.spent, 0);
  (await meter.reserve(300)).settle({ usage: null, began: true });
  t.is(meter.read()?.spent, 300);
  // No settlement at all (an endpoint that has none) reads the same way.
  (await meter.reserve(100)).settle(undefined);
  t.is(meter.read()?.spent, 400);
});

test('the ceiling is in the store before a request is admitted, and a restart starts from it', async t => {
  const { meter, kept } = makeHarness();
  const open = await meter.reserve(100);
  // Written ahead, by a step (a fiftieth of the budget).
  t.deepEqual(kept, [{ period: 0, ceiling: 120 }]);
  open.settle(usage(10, 5));
  await meter.flushed();
  // It settled far below its reservation: the store is brought back down to
  // a step above what is spent, so a restart would not charge the rest.
  t.deepEqual(kept[kept.length - 1], { period: 0, ceiling: 35 });
  // Under the ceiling still: no write for this one.
  const writes = kept.length;
  (await meter.reserve(10)).settle(usage(2, 1));
  await meter.flushed();
  t.is(kept.length, writes);
  const inFlight = await meter.reserve(200);
  t.is(kept.length, writes + 1);
  t.truthy(inFlight);

  // The daemon dies with that one open. The revived meter takes the whole
  // ceiling as spent: the open reservation and the unused step with it.
  const revived = makeHarness({ initial: kept[kept.length - 1] });
  t.is(revived.meter.read()?.spent, kept[kept.length - 1].ceiling);
  t.true(Number(revived.meter.read()?.spent) >= 18 + 200);
});

test('a store that cannot be written admits nothing', async t => {
  const { meter, state } = makeHarness();
  state.failing = true;
  await t.throwsAsync(() => meter.reserve(100), { message: /store is down/ });
  t.like(meter.read(), { reserved: 0, spent: 0 });
  state.failing = false;
  t.truthy(await meter.reserve(100));
});

test('a new period starts empty, and a kept ceiling from an older one is not carried', async t => {
  const { meter, state } = makeHarness();
  (await meter.reserve(900)).settle(usage(800, 100));
  await t.throwsAsync(() => meter.reserve(200));
  t.is(meter.read()?.periodEndsAt, '2026-09-20T01:00:00.000Z');
  state.now = ANCHOR + 3_600_000 + 1;
  t.like(meter.read(), { spent: 0, remaining: 1000 });
  t.truthy(await meter.reserve(200));
  const later = makeHarness({ initial: { period: 0, ceiling: 1000 } });
  later.state.now = ANCHOR + 2 * 3_600_000 + 5;
  t.is(later.meter.read()?.spent, 0);
});

test('a response that cost more than it reserved is spent, and the store is told', async t => {
  const { meter, kept } = makeHarness();
  (await meter.reserve(100)).settle(usage(400, 100));
  await meter.flushed();
  t.is(meter.read()?.spent, 500);
  t.true(Number(kept[kept.length - 1].ceiling) >= 500);
});

test('a share with no budget is not metered', async t => {
  const { meter, state, kept } = makeHarness();
  state.budget = undefined;
  (await meter.reserve(10_000_000)).settle(usage(1, 1));
  t.is(meter.read(), undefined);
  t.deepEqual(kept, []);
});

test('a response cut short is never cheaper than its reservation, and dearer where more is known', async t => {
  const { meter } = makeHarness({ tokens: 100_000 });
  // Cancelled after the first event, which already named a little usage.
  (await meter.reserve(5000)).settle({
    began: true,
    complete: false,
    usage: { inputTokens: 12, outputTokens: 1 },
  });
  t.is(meter.read()?.spent, 5000);
  // It had already said more than was reserved.
  (await meter.reserve(100)).settle({
    began: true,
    complete: false,
    usage: { inputTokens: 900, outputTokens: 100 },
  });
  t.is(meter.read()?.spent, 6000);
  // Silent about its cost, but its size says more than the reservation.
  (await meter.reserve(100)).settle({ began: true, usage: null }, 750.2);
  t.is(meter.read()?.spent, 6751);
  // What is not a settlement at all keeps the reservation; nothing throws.
  for (const junk of [null, 'done', { began: 'yes' }, { usage: {} }]) {
    // eslint-disable-next-line no-await-in-loop
    (await meter.reserve(10)).settle(/** @type {any} */ (junk));
  }
  t.is(meter.read()?.spent, 6791);
  // Complete, but it never said: the reservation.
  (await meter.reserve(9)).settle({ began: true, complete: true, usage: null });
  t.is(meter.read()?.spent, 6800);
});

test('a large reservation that settles small does not cost its size at the next restart', async t => {
  const { meter, kept } = makeHarness({ tokens: 1_000_000 });
  (await meter.reserve(120_000)).settle(usage(2000, 500));
  await meter.flushed();
  const last = kept[kept.length - 1];
  // One step (a fiftieth) above what is spent, not the reservation's height.
  t.is(last.ceiling, 2500 + 20_000);
  const revived = makeHarness({ tokens: 1_000_000, initial: last });
  t.is(revived.meter.read()?.spent, 22_500);
  // And with one still open, the store covers it.
  const open = await meter.reserve(300_000);
  await meter.flushed();
  t.true(Number(kept[kept.length - 1].ceiling) >= 302_500);
  open.settle(usage(1, 1));
});

test('a budget lowered under what was spent does not let a restart forget the difference', async t => {
  const { meter, kept, state } = makeHarness({ tokens: 100_000 });
  (await meter.reserve(100)).settle(usage(40_000, 10_000));
  await meter.flushed();
  // One is open when the grantor lowers the budget under what is spent; it
  // then settles free. The store must not be written down to the budget.
  const open = await meter.reserve(30_000);
  state.budget = { tokens: 10_000, periodSeconds: 3600 };
  open.settle({ began: false, usage: null });
  await meter.flushed();
  t.true(Number(kept[kept.length - 1].ceiling) >= 50_000);
  const revived = makeHarness({
    tokens: 100_000,
    initial: kept[kept.length - 1],
  });
  t.true(Number(revived.meter.read()?.spent) >= 50_000);
});

test('a response that claims to be complete and free is one that did not say', async t => {
  const { meter } = makeHarness({ tokens: 100_000 });
  (await meter.reserve(500)).settle(
    { began: true, complete: true, usage: {} },
    1000,
  );
  t.is(meter.read()?.spent, 1000);
});
