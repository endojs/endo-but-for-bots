// @ts-check
/**
 * Perf check "gc" (core candidate C-17, journal J-0272..J-0277, J-0293):
 * where OCapN garbage-collection frames come from, what they cost the
 * session vat, and whether they wake sleeping vats after a restart.
 *
 *   cd packages/thixotrope-harness && node perf/gc.perf.mjs
 *
 * Phase 1, the burst (one served copy of the m1a template, idle sleep 1 h):
 * one session of the real program on the scripted backend, followed by a
 * Live subscriber in this process (a control client, as J-0272 had it), 3
 * warm-up turns, then one-chunk turns back to back for GC_WINDOW_MS
 * (default 60 s; it was GC_TURNS = 150 turns), each submitted
 * through the Composer and awaited on the subscription. Per turn: the time
 * from the Composer stamp to the provider's `request` line (as
 * `turn.start`), the frames journaled into the session vat (decoded: deliver
 * or `op:gc-*`), the session vat's cranks (worker row `cranks` where the
 * daemon reports it, else one per frame) and the daemon's engine deliveries.
 * Rows:
 * - `gc.burst.turnStart`: start latency; budget median 350 ms as turn.start.
 * - `gc.burst.frames`: GC frames into the session per turn (histogram,
 *   largest windows with their latencies), frames and cranks per turn.
 * - `gc.burst.hub`: the hub's own counts (`status().gc`, process-local):
 *   GC frames and positions received from each session and sent to each
 *   destination, with the session whose frame let the last holder go.
 *   Sessions are named by vat label, `endpoint`, `adapter <id>` (a native
 *   adapter's transient session), `transient <id>`, or `peer <key>`.
 *
 * Phase 2, the restart wake (a second copy, idle sleep 2 s, crash bound 5):
 * GC_SESSIONS (default 10) sessions each run one turn, so the dying control
 * client and adapter hold their exports; then SIGKILL restarts with every
 * session asleep and checkpointed, back to back for GC_RESTART_WINDOW_MS
 * (default 90 s, at least 2 runs; it was GC_RESTARTS = 5 runs). Run 1 is the
 * first restart after the setup. A vat counts as woken when its worker row
 * reports `wakes` > 0 since the restart; where the daemon does not report
 * `wakes`, when its journal grew (every journaled frame was then a
 * delivery). Gate: no idle session vat woken, in every run. After the last
 * run one idle session runs a turn (its held GC frames go with it) and must
 * complete.
 * - `gc.restart.run`: woken session vats, GC frames journaled per vat (by
 *   kind), held frames, hub GC counts since the restart, serving time.
 * - `gc.restart`: the gate over all runs.
 */
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import {
  crankBudget,
  emit,
  loadAvg,
  runIdentity,
  runPerf,
  single,
  stats,
} from './_harness.mjs';
import { runWindow, windowFields, windowMs } from './_window.mjs';

// After the harness module (it locks down first).
const { installGuestPrelude } = await import('../scripts/guest-prelude.js');
installGuestPrelude();
const { E } = await import('@endo/far');
const { inputs, perfInputs, perfScript } =
  await import('../test/fixtures/scripts/m1a-slice.js');
const { killStrays, startFromTemplate } =
  await import('../test/template/index.js');
const { journalTail, makeSlice, round1, sliceTemplate, untilAsleep } =
  await import('../test/integration/_m1a-slice.js');

/** The burst: turns back to back for this window (it was GC_TURNS = 150). */
const GC_WINDOW_MS = windowMs('GC_WINDOW_MS', 60_000);
const GC_SESSIONS = Number(process.env.GC_SESSIONS ?? 10);
/** SIGKILL restarts for this window, at least 2 (it was GC_RESTARTS = 5). */
const GC_RESTART_WINDOW_MS = windowMs('GC_RESTART_WINDOW_MS', 90_000);

/** @param {number[]} values */
/**
 * Entries in a worker's journal file past its truncation point: the
 * delivery frontier (`journalLength`) plus the GC frames held after it
 * (`heldFrames`, where the daemon reports it).
 * @param {any} row a worker status row
 */
const journaled = row =>
  Number(row?.journalLength ?? 0) + Number(row?.heldFrames ?? 0);

const median = values => {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * Names for hub session keys: a vat's debug label, or a key prefix.
 * @param {any[]} workers
 */
const namer = workers => {
  const labels = new Map(workers.map(w => [w.workerId, w.debugLabel]));
  /** @param {string} key */
  return key => {
    if (labels.has(key)) return labels.get(key) ?? `vat ${key.slice(0, 8)}`;
    if (key === 'endpoint' || key === 'other') return key;
    if (key.startsWith('retired '))
      return `retired ${namer(workers)(key.slice(8))}`;
    // Native adapters (the agent host) connect as `transient:native:<id>`;
    // other transient peers (host clients) as `transient:<id>`.
    if (key.startsWith('transient:native:'))
      return `adapter ${key.slice(17, 23)}`;
    if (key.startsWith('transient:')) return `transient ${key.slice(10, 16)}`;
    return `peer ${key.slice(0, 24)}`;
  };
};

/**
 * Hub GC counts from `status().gc`, minus an earlier reading, named.
 * @param {any[] | undefined} before
 * @param {any[] | undefined} after
 * @param {(key: string) => string} name
 */
const gcDelta = (before, after, name) => {
  if (!after) return null;
  /** @param {any} row */
  const keyOf = row =>
    JSON.stringify([row.direction, row.kind, row.from, row.cause, row.to]);
  const old = new Map((before ?? []).map(row => [keyOf(row), row]));
  /** @type {Map<string, any>} */
  const out = new Map();
  for (const row of after) {
    const prior = old.get(keyOf(row));
    const frames = row.frames - (prior?.frames ?? 0);
    const positions = row.positions - (prior?.positions ?? 0);
    if (frames !== 0 || positions !== 0) {
      const named =
        row.direction === 'in'
          ? { direction: 'in', kind: row.kind, from: name(row.from) }
          : {
              direction: 'out',
              kind: row.kind,
              cause: name(row.cause),
              to: name(row.to),
            };
      const k = JSON.stringify(named);
      const sum = out.get(k) ?? { ...named, frames: 0, positions: 0 };
      sum.frames += frames;
      sum.positions += positions;
      out.set(k, sum);
    }
  }
  return [...out.values()].sort((a, b) => b.frames - a.frames);
};

await runPerf('gc', async ({ root }) => {
  const template = await sliceTemplate();
  await burst(template, root);
  await restarts(template, `${root}r`);
  emit({
    metric: 'gc.summary',
    ...(await runIdentity()),
    crankBudget,
    loadAvg: loadAvg(),
  });
});

/**
 * Phase 1.
 * @param {any} template
 * @param {string} root
 */
async function burst(template, root) {
  const served = await startFromTemplate(template, {
    root,
    idleSleepMs: 3_600_000,
    snapshotEveryDeliveries: 256,
  });
  try {
    const slice = await makeSlice(served);
    const label = `perf-gc-${process.pid}`;
    const made = await slice.makeBackend(harden(perfScript), { label });
    const log = () => made.log().filter(l => l.label === label);
    const session = await slice.createSession(made.backend, 'gc');
    const sub = await slice.subscribe(session);
    const row = async () => slice.sessionWorker('s1');
    const workerId = (await row()).workerId;
    const status = async () => served.client.call('status');

    const turn = async () => {
      const mark = sub.deliveries.length;
      const before = await row();
      const engineBefore = (await status()).timings;
      await slice.submit(session, perfInputs.start);
      const i = await sub.until(e => e.type === 'turn-start', 60_000, mark);
      const { turnId, at } = sub.deliveries[i].event;
      await sub.until(
        e => (e.type === 'end' || e.type === 'abort') && e.turnId === turnId,
        120_000,
        i,
      );
      // The lease answer and late GC frames: until the journal settles.
      let after = await row();
      for (let k = 0; k < 20; k += 1) {
        await delay(50);
        const again = await row();
        if (journaled(again) === journaled(after)) break;
        after = again;
      }
      const engineAfter = (await status()).timings;
      const n = journaled(after) - journaled(before);
      const kinds = journalTail(served.root, workerId, n);
      const cranks =
        after.cranks === undefined
          ? n
          : Number(after.cranks) - Number(before.cranks);
      return {
        turnId,
        at,
        frames: n,
        gcFrames: kinds.filter(k => k.startsWith('gc-')).length,
        kinds,
        cranks,
        daemonDeliveries:
          engineAfter.delivery.count - engineBefore.delivery.count,
      };
    };

    for (let i = 0; i < 3; i += 1) await turn();
    const gcBefore = (await status()).gc;
    const t0 = performance.now();
    const burstWindow = await runWindow(async () => turn(), {
      ms: GC_WINDOW_MS,
    });
    const turns = burstWindow.results;
    const GC_TURNS = turns.length;
    const burstFields = windowFields(burstWindow);
    const wallMs = round1(performance.now() - t0);
    const after = await status();
    const name = namer(after.workers);
    const requestAt = new Map(
      log()
        .filter(l => l.kind === 'request' && l.round === 0)
        .map(l => [l.turnId, l.at]),
    );
    const startMs = turns.map(t => Number(requestAt.get(t.turnId)) - t.at);
    if (startMs.some(v => !Number.isFinite(v)))
      throw Error('a turn has no paired request line');
    await stats('gc.burst.turnStart', startMs, {
      budget: { median: 350 },
      extra: {
        from: 'Composer stamp (adapter clock)',
        to: 'request log line',
        turns: GC_TURNS,
        ...burstFields,
        wallMs,
      },
    });
    /** @type {Record<string, number>} */
    const kindTotals = {};
    for (const t of turns)
      for (const k of t.kinds) kindTotals[k] = (kindTotals[k] ?? 0) + 1;
    /** @type {Record<string, number>} */
    const histogram = {};
    for (const t of turns) {
      const bucket =
        t.gcFrames === 0
          ? '0'
          : t.gcFrames <= 2
            ? '1-2'
            : t.gcFrames <= 10
              ? '3-10'
              : t.gcFrames <= 50
                ? '11-50'
                : '51+';
      histogram[bucket] = (histogram[bucket] ?? 0) + 1;
    }
    const gcTotal = turns.reduce((s, t) => s + t.gcFrames, 0);
    emit({
      metric: 'gc.burst.frames',
      unit: 'frames',
      turns: GC_TURNS,
      ...burstFields,
      sessionFramesPerTurn: +(
        turns.reduce((s, t) => s + t.frames, 0) / GC_TURNS
      ).toFixed(2),
      sessionGcFramesPerTurn: +(gcTotal / GC_TURNS).toFixed(2),
      sessionCranksPerTurn: +(
        turns.reduce((s, t) => s + t.cranks, 0) / GC_TURNS
      ).toFixed(2),
      sessionCranksMedian: median(turns.map(t => t.cranks)),
      daemonDeliveriesPerTurn: +(
        turns.reduce((s, t) => s + t.daemonDeliveries, 0) / GC_TURNS
      ).toFixed(2),
      kinds: kindTotals,
      gcFramesPerTurnHistogram: histogram,
      largestGcWindows: turns
        .map((t, k) => ({
          turnId: t.turnId,
          gcFrames: t.gcFrames,
          cranks: t.cranks,
          startMs: startMs[k],
        }))
        .sort((a, b) => b.gcFrames - a.gcFrames)
        .slice(0, 5),
      crankCounter: after.workers.some(w => w.cranks !== undefined)
        ? 'worker row cranks'
        : 'one per journaled frame',
      commit: (await runIdentity()).commit,
      crankBudget,
      loadAvg: loadAvg(),
    });
    emit({
      metric: 'gc.burst.hub',
      unit: 'frames',
      turns: GC_TURNS,
      ...burstFields,
      counts: gcDelta(gcBefore, after.gc, name),
      reported: after.gc !== undefined,
      commit: (await runIdentity()).commit,
      crankBudget,
      loadAvg: loadAvg(),
    });
    await sub.stop();
  } finally {
    await served.cleanup();
  }
}

/**
 * Phase 2.
 * @param {any} template
 * @param {string} root
 */
async function restarts(template, root) {
  const served = await startFromTemplate(template, {
    root,
    maxDeliveryAttempts: 5,
  });
  try {
    const slice = await makeSlice(served);
    const made = await slice.makeBackend(harden(perfScript));
    const tSetup = performance.now();
    /** @type {string[]} */
    const keys = [];
    for (let i = 0; i < GC_SESSIONS; i += 1) {
      const session = await slice.createSession(made.backend, `g${i}`);
      const r = await slice.submit(session, inputs.hi);
      await E(r.turn).whenFinished();
      keys.push(`s${i + 1}`);
    }
    emit({
      metric: 'gc.restart.setup',
      sessions: keys.length,
      ms: round1(performance.now() - tSetup),
      loadAvg: loadAvg(),
    });
    const isIdle = (/** @type {any} */ w) =>
      keys.some(k => w.debugLabel === `session ${k}`);
    /** @type {any[]} */
    const runs = [];
    const restartWindow = await runWindow(
      async index => {
        const run = index + 1;
        await untilAsleep(slice.workers, isIdle);
        const before = new Map(
          (await slice.workers()).filter(isIdle).map(w => [w.debugLabel, w]),
        );
        await served.kill();
        await killStrays(served.root);
        const { servedMs } = await served.restart();
        // Late startup work (the hub's outbox, forgotten sessions' GC).
        await delay(3000);
        const status = await served.client.call('status');
        const name = namer(status.workers);
        const after = status.workers.filter(isIdle);
        const counted = after.some(
          (/** @type {any} */ w) => w.wakes !== undefined,
        );
        const woken = after
          .filter((/** @type {any} */ w) =>
            counted
              ? Number(w.wakes) > 0
              : journaled(w) > journaled(before.get(w.debugLabel)),
          )
          .map((/** @type {any} */ w) => w.debugLabel);
        /** @type {Record<string, Record<string, number>>} */
        const grown = {};
        for (const w of after) {
          const n = journaled(w) - journaled(before.get(w.debugLabel));
          if (n > 0) {
            /** @type {Record<string, number>} */
            const kinds = {};
            for (const k of journalTail(served.root, w.workerId, n))
              kinds[k] = (kinds[k] ?? 0) + 1;
            grown[w.debugLabel] = kinds;
          }
        }
        const gate = woken.length === 0;
        runs.push({ run, woken: woken.length, gate });
        await single('gc.restart.run', servedMs, {
          budget: { value: 10_000 },
          extra: {
            run,
            sessions: after.length,
            wokenSessions: woken,
            wokenBy: counted ? 'wakes' : 'journal grew',
            gate,
            journaledAcrossRestart: grown,
            heldFrames: Object.fromEntries(
              after
                .filter((/** @type {any} */ w) => Number(w.heldFrames ?? 0) > 0)
                .map((/** @type {any} */ w) => [w.debugLabel, w.heldFrames]),
            ),
            engineSinceStart: status.timings,
            hubGcSinceStart: gcDelta(undefined, status.gc, name),
            awakeWorkers: status.workers.filter(
              (/** @type {any} */ w) => w.awake,
            ).length,
          },
        });
        await slice.refresh();
      },
      { ms: GC_RESTART_WINDOW_MS, min: 2, few: 3 },
    );
    // A held GC frame goes with the next real delivery: the vat still works.
    const one = await E(slice.factory).findSession(keys[0]);
    const tTurn = performance.now();
    const r = await slice.submit(one, inputs.hi);
    await E(r.turn).whenFinished();
    const { state } = await E(r.turn).getStatus();
    const turnMs = round1(performance.now() - tTurn);
    const row = await slice.sessionWorker(keys[0]);
    emit({
      metric: 'gc.restart',
      runs,
      ...windowFields(restartWindow),
      gate: runs.every(r2 => r2.gate),
      gateWokenSessions: 0,
      idleSessions: GC_SESSIONS,
      after: {
        turn: state ?? 'finished',
        turnMs,
        failure: row?.failure ?? null,
        heldFrames: row?.heldFrames ?? null,
      },
      pass: runs.every(r2 => r2.gate) && !row?.failure,
      commit: (await runIdentity()).commit,
      crankBudget,
      loadAvg: loadAvg(),
    });
    if (!runs.every(r2 => r2.gate))
      throw Error(
        `woken idle session vats: ${runs.map(r2 => `run ${r2.run} ${r2.woken}`).join(', ')}`,
      );
  } finally {
    await served.cleanup();
  }
}
