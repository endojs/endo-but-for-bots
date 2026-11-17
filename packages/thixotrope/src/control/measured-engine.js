// @ts-check
/** @import { WorkerEngine } from '../core/worker-engine.js' */
/** @import { TimerPowers } from '../platform/timers.js' */
import harden from '@endo/harden';

/**
 * An engine that counts and times its wakes, deliveries and snapshots:
 * cumulative process-local counts and milliseconds, coarse measurements
 * for `status`, not a benchmark.
 * @param {WorkerEngine} rawEngine
 * @param {TimerPowers} timers
 * @returns {{ engine: WorkerEngine, timings: () => Record<'delivery' | 'snapshot' | 'wake', { count: number, milliseconds: number }>, deliveryHistogram: () => { bounds: number[], counts: number[], maxMs: number } }}
 */
export const makeMeasuredEngine = (rawEngine, timers) => {
  const metrics = {
    delivery: { count: 0n, milliseconds: 0 },
    snapshot: { count: 0n, milliseconds: 0 },
    wake: { count: 0n, milliseconds: 0 },
  };
  /**
   * Deliveries (cranks) by wall time: cumulative counts per bucket, the
   * last bucket open; a reader takes the difference of two readings for
   * a window's distribution (perf: crank p95 under load).
   */
  const deliveryBounds = harden([
    5, 10, 20, 30, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 2000, 5000,
  ]);
  const deliveryCounts = deliveryBounds.map(() => 0).concat([0]);
  let deliveryMaxMs = 0;
  /** @param {number} ms */
  const countDelivery = ms => {
    let i = 0;
    while (i < deliveryBounds.length && ms > deliveryBounds[i]) i += 1;
    deliveryCounts[i] += 1;
    if (ms > deliveryMaxMs) deliveryMaxMs = ms;
  };
  /**
   * @template T
   * @param {keyof typeof metrics} name
   * @param {() => Promise<T>} operation
   */
  const timed = async (name, operation) => {
    const start = timers.monotonicNow();
    try {
      return await operation();
    } finally {
      const ms = timers.monotonicNow() - start;
      metrics[name].count += 1n;
      metrics[name].milliseconds += ms;
      if (name === 'delivery') countDelivery(ms);
    }
  };
  const engine = harden({
    ...rawEngine,
    start: async options => {
      const worker = await timed('wake', () => rawEngine.start(options));
      const { deliverBatch } = worker;
      return harden({
        ...worker,
        deliver: bytes => timed('delivery', () => worker.deliver(bytes)),
        // One crank, however many frames it carries: one delivery.
        ...(deliverBatch === undefined
          ? {}
          : {
              deliverBatch: (/** @type {any} */ messages) =>
                timed('delivery', () => deliverBatch(messages)),
            }),
        snapshot: () => timed('snapshot', () => worker.snapshot()),
      });
    },
  });
  /** @param {{ count: bigint, milliseconds: number }} metric */
  const report = ({ count, milliseconds }) =>
    harden({ count: Number(count), milliseconds });
  /** The measurements as the control socket reports them: counts as numbers. */
  const timings = () =>
    harden({
      delivery: report(metrics.delivery),
      snapshot: report(metrics.snapshot),
      wake: report(metrics.wake),
    });
  const deliveryHistogram = () =>
    harden({
      bounds: deliveryBounds,
      counts: [...deliveryCounts],
      maxMs: deliveryMaxMs,
    });
  return harden({ engine, timings, deliveryHistogram });
};
harden(makeMeasuredEngine);
