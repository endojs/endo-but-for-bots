// @ts-check
/**
 * Spike S9 (milestones.md M0, W0.6; architecture.md section 4.3, coverage
 * 17, intent before effect): a vat crank records an intent in its heap and,
 * in the same crank, sends a call to an adapter object, whose effect is an
 * fsynced line in a log file. The supervisor is SIGKILLed at varied delays
 * after the host sends the triggering message, or as soon as the effect
 * line appears. After each restart:
 *
 *   - if the effect ran, the intent record must exist;
 *   - the effect ran at most once (no replay re-sends it).
 *
 * The distribution over iterations (ran 0 / ran once / record missing) is
 * the finding.
 *
 *   THIX_HARNESS_SPIKES=1 node scripts/run-lock.mjs -- \
 *     corepack yarn test test/spikes/s9.test.js
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import test from 'ava';

import { limits } from '../../config/defaults.js';
import {
  ATTACH_FIXTURE,
  SPIKE_PROGRAM,
  readEffects,
  startCrashHost,
  summarize,
} from './_crash.js';
import {
  E,
  RETIRED,
  emit,
  round1,
  spikesEnabled,
  takeRunLock,
} from './_spike.js';

const crankBudget = BigInt(process.env.S9_BUDGET ?? limits.crankBudget);
/** Kill delays (ms after the host's send); 'effect' = as soon as it ran. */
const PLAN = (
  process.env.S9_PLAN ??
  '0,10,20,30,40,50,60,70,80,90,100,120,140,160,180,200,250,300,400,600,effect,effect,effect,effect'
).split(',');

/** @type {Awaited<ReturnType<typeof takeRunLock>> | undefined} */
let lock;
test.before(async () => {
  if (spikesEnabled) lock = await takeRunLock('spike s9');
});
test.after.always(async () => {
  await lock?.release();
});

const run = spikesEnabled ? test.serial : test.skip;

/**
 * Poll the effect log until `id` appears.
 * @param {string} file
 * @param {string} id
 * @param {number} ms
 */
const waitForEffect = async (file, id, ms) => {
  const needle = `"id":"${id}"`;
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    // eslint-disable-next-line no-await-in-loop
    const text = await readFile(file, 'utf8').catch(() => '');
    if (text.includes(needle)) return round1(performance.now() - t0);
    // eslint-disable-next-line no-await-in-loop
    await delay(1);
  }
  return null;
};

run('S9 intent before effect across SIGKILL', async t => {
  t.timeout(90 * 60_000);
  const base = { spike: 'S9', crankBudget: String(crankBudget) };
  const host = await startCrashHost({ crankBudget, tag: 's9' });
  const logPath = path.join(host.root, 'effects.jsonl');
  /** @type {Array<Record<string, any>>} */
  const rows = [];
  try {
    await host.client.call('installNative', 'spk', ATTACH_FIXTURE);
    await host.client.call('install', 'v', SPIKE_PROGRAM, [['spk', 'spk']]);
    let vat = await host.client.call('lookup', 'v');
    await E(vat).open();

    // Calibration without a kill: send -> effect line, send -> answer seen.
    const toEffect = [];
    for (let i = 0; i < 5; i += 1) {
      const id = `cal${i}`;
      const t0 = performance.now();
      E.sendOnly(vat).act(id, logPath);
      // eslint-disable-next-line no-await-in-loop
      const ms = await waitForEffect(logPath, id, 30_000);
      if (ms !== null) toEffect.push(performance.now() - t0);
      // eslint-disable-next-line no-await-in-loop
      await delay(500);
    }
    const calibration = summarize(toEffect);
    await emit({
      ...base,
      metric: 's9.calibration.sendToEffect',
      unit: 'ms',
      ...calibration,
    });

    for (let i = 0; i < PLAN.length; i += 1) {
      const mode = PLAN[i];
      const id = `k${i}`;
      // A fresh endpoint in this incarnation (the old one is a tombstone).
      const t0 = performance.now();
      // eslint-disable-next-line no-await-in-loop
      const incarnation = await E(vat).open();
      const openMs = round1(performance.now() - t0);
      const t1 = performance.now();
      E.sendOnly(vat).act(id, logPath);
      /** @type {number | null} */
      let effectSeenMs = null;
      if (mode === 'effect') {
        // eslint-disable-next-line no-await-in-loop
        effectSeenMs = await waitForEffect(logPath, id, 30_000);
      } else {
        // eslint-disable-next-line no-await-in-loop
        await delay(Number(mode));
      }
      const killAtMs = round1(performance.now() - t1);
      // eslint-disable-next-line no-await-in-loop
      await host.kill();
      // eslint-disable-next-line no-await-in-loop
      const restart = await host.serve();
      // eslint-disable-next-line no-await-in-loop
      vat = await host.client.call('lookup', 'v');
      // eslint-disable-next-line no-await-in-loop
      const state = new Map(await E(vat).intentState());
      // eslint-disable-next-line no-await-in-loop
      const effects = await readEffects(logPath);
      const ran = effects.get(id)?.length ?? 0;
      const recorded = state.has(id);
      const row = {
        ...base,
        metric: 's9.iteration',
        i,
        id,
        mode,
        killAtMs,
        effectSeenMs,
        openMs,
        incarnation,
        restartServedMs: restart.servedMs,
        recorded,
        ran,
        outcomeAtRestart: state.get(id) ?? null,
        category: !recorded
          ? ran > 0
            ? 'VIOLATION: ran without record'
            : 'record missing, ran 0'
          : ran === 0
            ? 'recorded, ran 0'
            : ran === 1
              ? 'recorded, ran once'
              : 'VIOLATION: ran more than once',
      };
      rows.push(row);
      // eslint-disable-next-line no-await-in-loop
      await emit(row);
    }

    // Settle: outcomes the retired break delivered after the last restart,
    // and the effect counts over every incarnation.
    await delay(5000);
    const finalState = new Map(await E(vat).intentState());
    const effects = await readEffects(logPath);
    /** @type {Record<string, number>} */
    const distribution = {};
    /** @type {Record<string, number>} */
    const outcomes = {};
    for (const row of rows) {
      const ran = effects.get(row.id)?.length ?? 0;
      const recorded = finalState.has(row.id);
      row.final = {
        recorded,
        ran,
        outcome: finalState.get(row.id) ?? null,
      };
      const key = !recorded
        ? ran > 0
          ? 'VIOLATION ran without record'
          : 'record missing (ran 0)'
        : ran === 0
          ? 'recorded, ran 0'
          : ran === 1
            ? 'recorded, ran once'
            : 'VIOLATION ran more than once';
      distribution[key] = (distribution[key] ?? 0) + 1;
      const outcome = String(finalState.get(row.id) ?? 'none');
      const outcomeKey = outcome.includes(RETIRED) ? 'retired break' : outcome;
      outcomes[outcomeKey] = (outcomes[outcomeKey] ?? 0) + 1;
    }
    await emit({
      ...base,
      metric: 's9.distribution',
      iterations: rows.length,
      distribution,
      outcomesSeenByVat: outcomes,
      byMode: rows.map(r => [
        r.mode,
        r.killAtMs,
        r.final.recorded,
        r.final.ran,
        String(r.final.outcome).includes(RETIRED) ? 'retired' : r.final.outcome,
      ]),
      restartServedMs: summarize(rows.map(r => r.restartServedMs)),
      calibrationSendToEffectMedian: calibration.median,
    });
  } catch (error) {
    await emit({
      ...base,
      metric: 's9.error',
      error: String(/** @type {Error} */ (error)?.stack ?? error).slice(
        0,
        2000,
      ),
      stderr: host.stderrTail.slice(-2000),
    });
    throw error;
  } finally {
    await host.close();
  }
  t.true(rows.length >= 20, 'at least 20 kills');
  for (const row of rows) {
    t.true(
      Number(row.final.ran) <= 1,
      `${row.id}: the adapter ran the call at most once`,
    );
    t.true(
      row.final.ran === 0 || row.final.recorded,
      `${row.id}: an effect that ran has its intent recorded`,
    );
  }
});

if (!spikesEnabled) {
  test('S9 runs only with THIX_HARNESS_SPIKES=1', t => t.pass());
}
