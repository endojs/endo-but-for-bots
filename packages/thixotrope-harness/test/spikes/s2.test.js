// @ts-check
/**
 * Spike S2 (milestones.md M0, W0.6; decides architecture.md D-7, the attach
 * pattern): with the throwaway native resource in fixtures/attach,
 *
 *   (a) a durable vat holds and calls an object exported by the transient
 *       adapter process, across deliveries;
 *   (b) after SIGKILL of the supervisor and a restart, the call that was
 *       pending into the adapter breaks with the "target session has been
 *       retired" text, and that break is delivered to the vat (it wakes it:
 *       the vat's journal grows with no other caller);
 *   (c) the manager's restore re-attaches a fresh adapter object and the vat
 *       reopens through it;
 *   (d) within one incarnation the adapter sees one stable presence for one
 *       vat object, whichever route it came by.
 *
 * Also measures the round trip vat -> adapter -> vat.
 *
 *   THIX_HARNESS_SPIKES=1 node scripts/run-lock.mjs -- \
 *     corepack yarn test test/spikes/s2.test.js
 */
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import test from 'ava';

import { limits } from '../../config/defaults.js';
import {
  ATTACH_FIXTURE,
  SPIKE_PROGRAM,
  adapterProcesses,
  startCrashHost,
  summarize,
} from './_crash.js';
import {
  E,
  RETIRED,
  attempt,
  emit,
  round1,
  spikesEnabled,
  takeRunLock,
} from './_spike.js';

const crankBudget = BigInt(process.env.S2_BUDGET ?? limits.crankBudget);
const N_FLOOR = Number(process.env.S2_N_FLOOR ?? 30);
const N_CHAIN = Number(process.env.S2_N_CHAIN ?? 20);
const CHAIN = 10;
const N_PINGVAT = Number(process.env.S2_N_PINGVAT ?? 200);

/** @type {Awaited<ReturnType<typeof takeRunLock>> | undefined} */
let lock;
test.before(async () => {
  if (spikesEnabled) lock = await takeRunLock('spike s2');
});
test.after.always(async () => {
  await lock?.release();
});

const run = spikesEnabled ? test.serial : test.skip;

/**
 * @param {() => Promise<boolean>} predicate
 * @param {number} ms
 */
const waitUntil = async (predicate, ms) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    // eslint-disable-next-line no-await-in-loop
    if (await predicate()) return round1(performance.now() - t0);
    // eslint-disable-next-line no-await-in-loop
    await delay(100);
  }
  return null;
};

run('S2 attach pattern across SIGKILL', async t => {
  t.timeout(40 * 60_000);
  const base = { spike: 'S2', crankBudget: String(crankBudget) };
  const host = await startCrashHost({ crankBudget, tag: 's2' });
  /** @type {Record<string, any>} */
  const found = {};
  try {
    await emit({ ...base, metric: 's2.serve.fresh', ...host.first });

    let t0 = performance.now();
    await host.client.call('installNative', 'spk', ATTACH_FIXTURE);
    const installNativeMs = round1(performance.now() - t0);
    const before = new Set((await host.workers()).map(w => w.workerId));
    t0 = performance.now();
    await host.client.call('install', 'v', SPIKE_PROGRAM, [['spk', 'spk']]);
    const installMs = round1(performance.now() - t0);
    const vatWorker = (await host.workers())
      .map(w => w.workerId)
      .find(id => !before.has(id));
    await emit({
      ...base,
      metric: 's2.install',
      installNativeMs,
      installMs,
    });
    let vat = await host.client.call('lookup', 'v');

    // (a) The vat opens an adapter endpoint (one manager crank, which builds
    // the adapter and attaches), then calls it in later deliveries.
    t0 = performance.now();
    const inc1 = await E(vat).open();
    const firstOpenMs = round1(performance.now() - t0);
    const a1 = await attempt(() => E(vat).callAdapter(1));
    const a2 = await attempt(() => E(vat).callAdapter(3));
    found.a = a1.ok && a2.ok && a1.value === 1 && a2.value === 3;
    await emit({
      ...base,
      metric: 's2.a.holdAndCall',
      incarnation: inc1,
      firstOpenMs,
      call1: a1,
      call3: a2,
      ok: found.a,
    });

    // Round trip costs.
    const floorSamples = [];
    for (let i = 0; i < N_FLOOR; i += 1) {
      const t1 = performance.now();
      // eslint-disable-next-line no-await-in-loop
      await E(vat).ping();
      floorSamples.push(performance.now() - t1);
    }
    const floor = summarize(floorSamples);
    const chainSamples = [];
    for (let i = 0; i < N_CHAIN; i += 1) {
      const t1 = performance.now();
      // eslint-disable-next-line no-await-in-loop
      await E(vat).callAdapter(CHAIN);
      chainSamples.push(performance.now() - t1);
    }
    const chain = summarize(chainSamples);
    const perHop =
      chain.median === null || floor.median === null
        ? null
        : round1((chain.median - floor.median) / CHAIN);
    await emit({
      ...base,
      metric: 's2.rtt.vatAdapterVat.hostTimed',
      unit: 'ms',
      floor,
      chainOf: CHAIN,
      chain,
      perRoundTripMedian: perHop,
      note: 'host->vat call doing CHAIN sequential E(endpoint).echo; per round trip = (chain - ping floor)/CHAIN',
    });
    const ep = await E(vat).endpoint();
    const me = await E(vat).me();
    const pingVat = await E(ep).pingVat(me, N_PINGVAT);
    await emit({
      ...base,
      metric: 's2.rtt.adapterVatAdapter.adapterTimed',
      unit: 'ms',
      ...pingVat,
      note: 'adapter E(vatObject).ping() timed in the adapter: one vat delivery + answer',
    });
    const hostEcho = [];
    for (let i = 0; i < N_FLOOR; i += 1) {
      const t1 = performance.now();
      // eslint-disable-next-line no-await-in-loop
      await E(ep).echo(i);
      hostEcho.push(performance.now() - t1);
    }
    await emit({
      ...base,
      metric: 's2.rtt.hostAdapterHost',
      unit: 'ms',
      ...summarize(hostEcho),
      note: 'control client -> adapter endpoint echo (no vat)',
    });

    // (d) One presence per vat object within this incarnation.
    const ids = {
      me1: await E(vat).see('me'),
      me2: await E(vat).see('me'),
      meRecord: await E(vat).seeRecord(),
      meRelayedByManager: await E(vat).relay(),
      meFromHost: await E(ep).see(me),
      me3: await E(vat).see('me'),
      other: await E(vat).see('other'),
    };
    const stats1 = await E(vat).seenStats();
    const meIds = [
      ids.me1,
      ids.me2,
      ids.meRecord,
      ids.meRelayedByManager,
      ids.me3,
    ];
    found.d1 =
      meIds.every(id => id === ids.me1) &&
      ids.other !== ids.me1 &&
      stats1.distinct === (ids.meFromHost === ids.me1 ? 2 : 3);
    await emit({
      ...base,
      metric: 's2.d.stablePresence.incarnation1',
      ids,
      stats: stats1,
      hostRouteSame: ids.meFromHost === ids.me1,
      ok: found.d1,
    });

    // (b) A call pending into the adapter, then SIGKILL of the supervisor.
    await E(vat).startPending();
    const pendingBefore = await E(vat).pendingState();
    await delay(1000);
    const supervisorPid = host.pid;
    t0 = performance.now();
    await host.kill();
    const killMs = round1(performance.now() - t0);
    await delay(1000);
    const orphans = await adapterProcesses();
    const restarted = await host.serve();
    const journalAt = async () =>
      (await host.workers()).find(w => w.workerId === vatWorker)
        ?.journalLength ?? null;
    const j0 = await journalAt();
    // Do not call the vat: wait for the break to arrive on its own.
    const grewMs = await waitUntil(
      async () => Number(await journalAt()) > Number(j0),
      30_000,
    );
    const j1 = await journalAt();
    vat = await host.client.call('lookup', 'v');
    const pendingAfter = await E(vat).pendingState();
    found.b =
      pendingAfter.state === 'broken' &&
      String(pendingAfter.message).includes(RETIRED);
    await emit({
      ...base,
      metric: 's2.b.pendingBreaksAfterSigkill',
      supervisorPid,
      killMs,
      orphanAdapterProcessesAfterKill: orphans.length,
      restart: restarted,
      pendingBefore,
      pendingAfter,
      vatJournalAtServe: j0,
      vatJournalAfterWait: j1,
      journalGrewWithoutCallerMs: grewMs,
      ok: found.b,
    });

    // (c) Restore re-attached a fresh adapter object; the old endpoint is a
    // tombstone; reopening reaches the new incarnation.
    const spk = await host.client.call('lookup', 'spk');
    let info = await E(spk).attachInfo();
    const reattachMs = await waitUntil(async () => {
      info = await E(spk).attachInfo();
      return Number(info.attaches) >= 2;
    }, 30_000);
    const stale = await attempt(() => E(vat).callAdapter(1), {
      timeoutMs: 60_000,
    });
    t0 = performance.now();
    const inc2 = await E(vat).open();
    const reopenMs = round1(performance.now() - t0);
    const c1 = await attempt(() => E(vat).callAdapter(2));
    const infoAfter = await E(spk).attachInfo();
    found.c =
      Number(info.attaches) >= 2 &&
      inc2 !== inc1 &&
      infoAfter.incarnation === inc2 &&
      c1.ok &&
      !stale.ok &&
      String(stale.error).includes(RETIRED);
    await emit({
      ...base,
      metric: 's2.c.restoreReattaches',
      inc1,
      inc2,
      attachInfoBeforeReopen: info,
      reattachObservedMs: reattachMs,
      staleEndpointCall: stale,
      reopenMs,
      callAfterReopen: c1,
      attachInfoAfter: infoAfter,
      ok: found.c,
    });

    // (d) again, in the second incarnation.
    const ep2 = await E(vat).endpoint();
    const ids2 = {
      me1: await E(vat).see('me'),
      meRelayedByManager: await E(vat).relay(),
      me2: await E(vat).see('me'),
      other: await E(vat).see('other'),
    };
    const stats2 = await E(ep2).seenStats();
    found.d2 =
      ids2.me1 === ids2.me2 &&
      ids2.me1 === ids2.meRelayedByManager &&
      ids2.other !== ids2.me1 &&
      stats2.distinct === 2;
    await emit({
      ...base,
      metric: 's2.d.stablePresence.incarnation2',
      ids: ids2,
      stats: stats2,
      ok: found.d2,
    });
    const chain2 = [];
    for (let i = 0; i < 10; i += 1) {
      const t1 = performance.now();
      // eslint-disable-next-line no-await-in-loop
      await E(vat).callAdapter(CHAIN);
      chain2.push(performance.now() - t1);
    }
    await emit({
      ...base,
      metric: 's2.rtt.vatAdapterVat.afterRestart',
      unit: 'ms',
      chainOf: CHAIN,
      chain: summarize(chain2),
    });
  } catch (error) {
    await emit({
      ...base,
      metric: 's2.error',
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
  t.true(found.a, '(a) a durable vat holds and calls an adapter object');
  t.true(found.b, '(b) the pending call breaks with the retired text');
  t.true(found.c, '(c) restore re-attaches a fresh adapter object');
  t.true(found.d1 && found.d2, '(d) one stable presence per vat object');
});

if (!spikesEnabled) {
  test('S2 runs only with THIX_HARNESS_SPIKES=1', t => t.pass());
}
