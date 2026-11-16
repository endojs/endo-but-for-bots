// @ts-check
/**
 * Spike S3 (milestones.md M0, W0.5): evaluate a 150 k and a 400 k character
 * program source in a fresh vat at the settings in config/defaults.js, once
 * as one message and once staged in `frameBytes` chunks; the result sets
 * `execSourceBytes`.
 *
 *   THIX_HARNESS_SPIKES=1 node scripts/run-lock.mjs -- \
 *     corepack yarn test test/spikes/s3.test.js
 *
 * S3_BUDGET overrides the crank budget (default limits.crankBudget).
 */
import { performance } from 'node:perf_hooks';

import test from 'ava';

import { limits } from '../../config/defaults.js';
import {
  E,
  attempt,
  emit,
  makeProgram,
  round1,
  spikesEnabled,
  startHost,
  takeRunLock,
} from './_spike.js';

const crankBudget = BigInt(process.env.S3_BUDGET ?? limits.crankBudget);

/** @type {Awaited<ReturnType<typeof takeRunLock>> | undefined} */
let lock;
test.before(async () => {
  if (spikesEnabled) lock = await takeRunLock('spike s3');
});
test.after.always(async () => {
  await lock?.release();
});

const run = spikesEnabled ? test.serial : test.skip;

run('S3 program source into a fresh vat', async t => {
  t.timeout(60 * 60_000);
  const host = await startHost({ crankBudget, tag: 's3' });
  const { frameBytes } = limits;
  /** @type {Record<string, any>} */
  const found = {};
  try {
    const probe = await host.fresh();
    t.is(await E(probe.vat).hasCompartment(), 'function');
    await host.retire(probe.name);
    for (const bytes of [150_000, limits.execSourceBytes, 400_000]) {
      const { source, functions } = makeProgram(bytes);
      // One message.
      // eslint-disable-next-line no-await-in-loop
      const one = await host.fresh();
      // eslint-disable-next-line no-await-in-loop
      const floorMs = await host.floor(one.vat);
      // eslint-disable-next-line no-await-in-loop
      const single = await attempt(() => E(one.vat).evalProgram(source));
      // eslint-disable-next-line no-await-in-loop
      const singleDiag = single.ok ? {} : await host.diagnose(one);
      // eslint-disable-next-line no-await-in-loop
      await emit({
        spike: 'S3',
        metric: 'vat.evaluateProgram.oneMessage',
        crankBudget: String(crankBudget),
        frameBytes,
        sourceChars: source.length,
        functions,
        ok: single.ok && single.value === functions,
        ms: single.ms,
        floorMs,
        ...(single.ok ? { result: single.value } : { error: single.error }),
        ...singleDiag,
      });
      // eslint-disable-next-line no-await-in-loop
      await host.retire(one.name);

      // Staged: frameBytes characters per message, then one evaluating crank.
      // eslint-disable-next-line no-await-in-loop
      const staged = await host.fresh();
      const t0 = performance.now();
      let chunks = 0;
      let stageError;
      for (let offset = 0; offset < source.length; offset += frameBytes) {
        // eslint-disable-next-line no-await-in-loop
        const r = await attempt(() =>
          E(staged.vat).stage(source.slice(offset, offset + frameBytes)),
        );
        if (!r.ok) {
          stageError = r.error;
          break;
        }
        chunks += 1;
      }
      const stageMs = round1(performance.now() - t0);
      const evaluated = stageError
        ? { ok: false, ms: 0, error: `staging: ${stageError}` }
        : // eslint-disable-next-line no-await-in-loop
          await attempt(() => E(staged.vat).evalStaged());
      // eslint-disable-next-line no-await-in-loop
      const stagedDiag = evaluated.ok ? {} : await host.diagnose(staged);
      const ok = evaluated.ok && evaluated.value === functions;
      // eslint-disable-next-line no-await-in-loop
      await emit({
        spike: 'S3',
        metric: 'vat.evaluateProgram.staged',
        crankBudget: String(crankBudget),
        frameBytes,
        sourceChars: source.length,
        functions,
        chunks,
        stageMs,
        evalMs: evaluated.ms,
        totalMs: round1(stageMs + evaluated.ms),
        ok,
        ...(evaluated.ok
          ? { result: evaluated.value }
          : { error: evaluated.error }),
        ...stagedDiag,
      });
      // eslint-disable-next-line no-await-in-loop
      await host.retire(staged.name);
      found[bytes] = { single: single.ok, staged: ok };
    }
  } finally {
    await host.close();
  }
  // One-message results are recorded, not asserted: before d0fd6b1138
  // every inbound byte interned a key and both halted (J-0146, J-0190).
  // Staging is what the harness uses (CORE-1b), so every size up to
  // execSourceBytes, and 400 k, must evaluate staged.
  t.true(found[150_000].staged, '150 k staged evaluates in one crank');
  t.true(
    found[limits.execSourceBytes].staged,
    'execSourceBytes staged evaluates in one crank',
  );
  t.true(found[400_000].staged, '400 k staged evaluates in one crank');
});

if (!spikesEnabled) {
  test('S3 runs only with THIX_HARNESS_SPIKES=1', t => t.pass());
}
