// @ts-check
/**
 * The supervisor's measured engine: cumulative delivery, snapshot and wake
 * timings, and the delivery (crank) histogram `status().deliveryHistogram`
 * reports (harness perf `concurrency.10`: crank p95 under load).
 */
import test from '@endo/ses-ava/test.js';

import { makeMeasuredEngine } from '../src/control/measured-engine.js';

test('deliveries are counted, timed and bucketed by wall time', async t => {
  let now = 0;
  /** @type {number[]} */
  const durations = [3, 5, 6, 199, 200, 201, 9000];
  const rawEngine = /** @type {any} */ ({
    start: async () => ({
      deliver: async () => {
        now += /** @type {number} */ (durations.shift());
      },
      snapshot: async () => {
        now += 1;
      },
    }),
  });
  const timers = /** @type {any} */ ({ monotonicNow: () => now });
  const { engine, timings, deliveryHistogram } = makeMeasuredEngine(
    rawEngine,
    timers,
  );
  const worker = await engine.start(/** @type {any} */ ({}));
  for (let i = 0; i < 7; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await worker.deliver(/** @type {any} */ ({}));
  }
  await worker.snapshot();
  t.is(timings().delivery.count, 7);
  t.is(timings().delivery.milliseconds, 3 + 5 + 6 + 199 + 200 + 201 + 9000);
  t.is(timings().snapshot.count, 1);
  const h = deliveryHistogram();
  t.is(h.counts.length, h.bounds.length + 1);
  const at = (/** @type {number} */ bound) => h.counts[h.bounds.indexOf(bound)];
  t.is(at(5), 2, '3 and 5 ms: a bound is inclusive');
  t.is(at(10), 1);
  t.is(at(200), 2, '199 and 200 ms');
  t.is(at(300), 1, '201 ms');
  t.is(h.counts[h.counts.length - 1], 1, '9 s: the open bucket');
  t.is(h.maxMs, 9000);
  t.is(
    h.counts.reduce((a, b) => a + b, 0),
    7,
  );
});
