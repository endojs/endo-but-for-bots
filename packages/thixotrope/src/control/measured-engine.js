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
 * @returns {{ engine: WorkerEngine, timings: () => Record<'delivery' | 'snapshot' | 'wake', { count: number, milliseconds: number }> }}
 */
export const makeMeasuredEngine = (rawEngine, timers) => {
  const metrics = {
    delivery: { count: 0n, milliseconds: 0 },
    snapshot: { count: 0n, milliseconds: 0 },
    wake: { count: 0n, milliseconds: 0 },
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
      metrics[name].count += 1n;
      metrics[name].milliseconds += timers.monotonicNow() - start;
    }
  };
  const engine = harden({
    ...rawEngine,
    start: async options => {
      const worker = await timed('wake', () => rawEngine.start(options));
      return harden({
        ...worker,
        deliver: bytes => timed('delivery', () => worker.deliver(bytes)),
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
  return harden({ engine, timings });
};
harden(makeMeasuredEngine);
