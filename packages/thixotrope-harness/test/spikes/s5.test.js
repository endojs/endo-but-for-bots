// @ts-check
/**
 * Spike S5 (milestones.md M0, W0.5): does a suspended async generator, and
 * an `Array.fromAsync` accumulation waiting on a promise, survive (a) the end
 * of a delivery and (b) a clean supervisor restart, in the shipped worker?
 * (pkg/README.md says async generators and `Array.fromAsync` suspensions are
 * refused; rust/engine/ironhorse-snapshot/tests/persist_gates.rs says they
 * persist.)
 *
 *   THIX_HARNESS_SPIKES=1 node scripts/run-lock.mjs -- \
 *     corepack yarn test test/spikes/s5.test.js
 */
import test from 'ava';

import { limits } from '../../config/defaults.js';
import {
  E,
  attempt,
  emit,
  spikesEnabled,
  startHost,
  takeRunLock,
} from './_spike.js';

const crankBudget = BigInt(process.env.S5_BUDGET ?? limits.crankBudget);

/** @type {Awaited<ReturnType<typeof takeRunLock>> | undefined} */
let lock;
test.before(async () => {
  if (spikesEnabled) lock = await takeRunLock('spike s5');
});
test.after.always(async () => {
  await lock?.release();
});

const run = spikesEnabled ? test.serial : test.skip;

run(
  'S5 async generator and Array.fromAsync across delivery and restart',
  async t => {
    t.timeout(30 * 60_000);
    const host = await startHost({ crankBudget, tag: 's5' });
    /** @type {Record<string, any>} */
    const seen = {};
    const step = async (
      /** @type {string} */ name,
      /** @type {() => Promise<any>} */ fn,
    ) => {
      const r = await attempt(fn, { timeoutMs: 60_000 });
      seen[name] = r.ok ? r.value : `error: ${r.error}`;
      await emit({
        spike: 'S5',
        metric: `s5.${name}`,
        crankBudget: String(crankBudget),
        ok: r.ok,
        ms: r.ms,
        ...(r.ok ? { value: r.value } : { error: r.error }),
      });
      return r;
    };
    try {
      // (a) Across deliveries, in one incarnation.
      const a = await host.fresh();
      await step('acrossDelivery.genStart', () => E(a.vat).genStart());
      await step('acrossDelivery.genNext5', () => E(a.vat).genNext(5));
      await step('acrossDelivery.fromAsyncStart', () =>
        E(a.vat).fromAsyncStart(),
      );
      await step('acrossDelivery.fromAsyncRelease', () =>
        E(a.vat).fromAsyncRelease(2),
      );
      await step('acrossDelivery.fromAsyncResult', () =>
        E(a.vat).fromAsyncResult(),
      );

      // (b) Suspended across a clean restart (the vat checkpoints at shutdown).
      const b = await host.fresh();
      await step('acrossRestart.genStart', () => E(b.vat).genStart());
      await step('acrossRestart.genNext5', () => E(b.vat).genNext(5));
      await step('acrossRestart.fromAsyncStart', () =>
        E(b.vat).fromAsyncStart(),
      );
      const restarted = await host.restart();
      await emit({
        spike: 'S5',
        metric: 's5.restart',
        crankBudget: String(crankBudget),
        ...restarted,
      });
      const again = await host.client.call('lookup', b.name);
      await step('acrossRestart.genNext1', () => E(again).genNext(1));
      await step('acrossRestart.fromAsyncRelease', () =>
        E(again).fromAsyncRelease(2),
      );
      await step('acrossRestart.fromAsyncResult', () =>
        E(again).fromAsyncResult(),
      );
      const diag = await host.diagnose({ vat: again, workerId: b.workerId });
      await emit({
        spike: 'S5',
        metric: 's5.afterRestart.vat',
        crankBudget: String(crankBudget),
        ...diag,
      });
    } finally {
      await host.close();
    }
    t.is(seen['acrossDelivery.genStart'], 0);
    t.is(
      seen['acrossDelivery.genNext5'],
      5,
      'generator resumes in a later delivery',
    );
    t.is(
      seen['acrossDelivery.fromAsyncResult'],
      '1,2,3',
      'fromAsync completes in a later delivery',
    );
    t.is(
      seen['acrossRestart.genNext1'],
      6,
      'generator resumes after a restart',
    );
    t.is(
      seen['acrossRestart.fromAsyncResult'],
      '1,2,3',
      'fromAsync completes after a restart',
    );
  },
);

if (!spikesEnabled) {
  test('S5 runs only with THIX_HARNESS_SPIKES=1', t => t.pass());
}
