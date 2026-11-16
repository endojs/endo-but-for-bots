// @ts-check
/**
 * Spike S7 (milestones.md M0, W0.6): a native-resource registration spec
 * that carries a foreign remotable (a listener exported by an application
 * vat, not by the manager) survives a restart: the manager's restore hands
 * the same listener to the new adapter, which can call it, after a clean
 * restart and after SIGKILL of the supervisor.
 *
 * (pkg/src/native/contract.js says a spec must be "data and the manager's
 * own remotables"; pkg/resources/http/durable.js keeps a foreign handler.)
 *
 *   THIX_HARNESS_SPIKES=1 node scripts/run-lock.mjs -- \
 *     corepack yarn test test/spikes/s7.test.js
 */
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import test from 'ava';

import { limits } from '../../config/defaults.js';
import { ATTACH_FIXTURE, SPIKE_PROGRAM, startCrashHost } from './_crash.js';
import { E, emit, round1, spikesEnabled, takeRunLock } from './_spike.js';

const crankBudget = BigInt(process.env.S7_BUDGET ?? limits.crankBudget);

/** @type {Awaited<ReturnType<typeof takeRunLock>> | undefined} */
let lock;
test.before(async () => {
  if (spikesEnabled) lock = await takeRunLock('spike s7');
});
test.after.always(async () => {
  await lock?.release();
});

const run = spikesEnabled ? test.serial : test.skip;

run(
  'S7 registration spec with a foreign remotable survives restart',
  async t => {
    t.timeout(30 * 60_000);
    const base = { spike: 'S7', crankBudget: String(crankBudget) };
    const host = await startCrashHost({ crankBudget, tag: 's7' });
    /** @type {Record<string, boolean>} */
    const found = {};
    /** @type {any} */
    let vat;
    /** @returns {Promise<any[]>} */
    const log = () => E(vat).listenerLog();
    /**
     * Wait until the listener log has an entry matching `match`.
     * @param {(entry: any[]) => boolean} match
     */
    const waitFor = async match => {
      const t0 = performance.now();
      while (performance.now() - t0 < 60_000) {
        // eslint-disable-next-line no-await-in-loop
        const entry = (await log()).find(match);
        if (entry) return { entry, ms: round1(performance.now() - t0) };
        // eslint-disable-next-line no-await-in-loop
        await delay(200);
      }
      return { entry: undefined, ms: null };
    };
    /**
     * After a (re)start: the listener heard `bound` from a new incarnation, and
     * a broadcast through the new adapter reaches it.
     * @param {string} phase
     * @param {Set<string>} incarnationsSoFar
     */
    const check = async (phase, incarnationsSoFar) => {
      vat = await host.client.call('lookup', 'v');
      const spk = await host.client.call('lookup', 'spk');
      const bound = await waitFor(
        e =>
          e[0] === 'bound' &&
          e[1] === 'sub1' &&
          !incarnationsSoFar.has(String(e[2])),
      );
      const t0 = performance.now();
      const listeners = await E(spk).broadcast(phase);
      const heard = await waitFor(e => e[0] === 'hear' && e[2] === phase);
      const ok =
        bound.entry !== undefined &&
        heard.entry !== undefined &&
        heard.entry[1] === bound.entry[2] &&
        Number(listeners) >= 1;
      if (bound.entry) incarnationsSoFar.add(String(bound.entry[2]));
      await emit({
        ...base,
        metric: `s7.${phase}`,
        boundEntry: bound.entry,
        boundSeenMs: bound.ms,
        listenersInAdapter: listeners,
        heardEntry: heard.entry,
        broadcastToHeardMs: round1(performance.now() - t0),
        ok,
      });
      return ok;
    };
    try {
      await host.client.call('installNative', 'spk', ATTACH_FIXTURE);
      await host.client.call('install', 'v', SPIKE_PROGRAM, [['spk', 'spk']]);
      vat = await host.client.call('lookup', 'v');
      const sub = await E(vat).subscribe();
      await emit({ ...base, metric: 's7.subscribe', sub });
      /** @type {Set<string>} */
      const incarnations = new Set();
      found.fresh =
        sub.status === 'bound' && (await check('fresh', incarnations));

      await host.stop();
      const clean = await host.serve();
      await emit({ ...base, metric: 's7.restart.clean', ...clean });
      found.clean = await check('afterCleanRestart', incarnations);

      await host.kill();
      const killed = await host.serve();
      await emit({ ...base, metric: 's7.restart.sigkill', ...killed });
      found.kill = await check('afterSigkill', incarnations);

      // The full listener log, for the journal.
      await emit({ ...base, metric: 's7.listenerLog', log: await log() });
    } catch (error) {
      await emit({
        ...base,
        metric: 's7.error',
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
    t.true(found.fresh, 'the adapter calls the foreign listener from the spec');
    t.true(found.clean, 'the spec and its listener survive a clean restart');
    t.true(found.kill, 'the spec and its listener survive SIGKILL');
  },
);

if (!spikesEnabled) {
  test('S7 runs only with THIX_HARNESS_SPIKES=1', t => t.pass());
}
