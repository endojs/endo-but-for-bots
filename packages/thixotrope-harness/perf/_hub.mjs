// @ts-check
/**
 * Shared parts of the "hub" perf checks (core candidates C-20 and C-2;
 * journal J-9127, J-9195): `perf/hub.perf.mjs` (the GC burst),
 * `perf/hub.growth.perf.mjs` (a session of GROWTH_TURNS turns) and
 * `perf/hub.sessions.perf.mjs` (10 and 50 sessions). They were one file of
 * 10-20 minutes; each part now runs inside the 10-minute box with fixed
 * windows (designs/process.md section 3).
 *
 * All read the hub's own process-local cost counters (`status().hub`): per
 * inbound delivery (one `deliver` or `deliverBatch` call into the hub)
 * whether it carried only GC frames (`gcOnly`) or anything else (`other`),
 * its frames, its whole synchronous time, and inside it the `persist()`
 * calls (serialization and the store's write) and the sends (toward a
 * durable worker, the journal append with its fsync).
 *
 * Growth rows (both growth files):
 * - `hub.persist`: one row per window: persists, characters written and
 *   milliseconds per inbound non-GC delivery and per turn, the hub state's
 *   size on disk, the store's counters.
 * - `hub.growth`: the hub's persisted bytes and its milliseconds per inbound
 *   non-GC delivery at each point of the file. Budget: bytes <= 2 MB, ms per
 *   delivery <= 1.25 x the file's fresh window (computed here, not with the
 *   harness slack). The two files' rows together are the old single row.
 * The size on disk is `hub.json` for the whole-file store, and the image
 * plus the log (`hub-image.json`, `hub-log.jsonl`) for the log store.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  crankBudget,
  emit,
  hubJsonBytes,
  loadAvg,
  runIdentity,
} from './_harness.mjs';
import { runWindow, windowFields, windowMs } from './_window.mjs';

// After the harness module (it locks down first).
const { installGuestPrelude } = await import('../scripts/guest-prelude.js');
installGuestPrelude();
const { E } = await import('@endo/far');
const { perfInputs, perfScript } =
  await import('../test/fixtures/scripts/m1a-slice.js');
const { startFromTemplate } = await import('../test/template/index.js');
const { makeSlice } = await import('../test/integration/_m1a-slice.js');
// eslint-disable-next-line import/no-relative-packages -- guest/ is its own private package
const { limits } = await import('../guest/lib/limits.js');

export { perfInputs };

/** One growth window of turns on the measured session. */
export const GROWTH_WINDOW_MS = windowMs('GROWTH_WINDOW_MS', 30_000);

/** @typedef {{ deliveries: number, frames: number, ms: number, persists: number, persistMs: number, persistChars: number, serializeMs: number, sends: number, sendMs: number }} Bucket */
/** @typedef {{ gcOnly: Bucket, other: Bucket, outside: Bucket, store?: Record<string, any>, persistRuns?: Record<string, any> }} HubStats */

const BUCKET_KEYS = /** @type {const} */ ([
  'deliveries',
  'frames',
  'ms',
  'persists',
  'persistMs',
  'persistChars',
  'serializeMs',
  'sends',
  'sendMs',
]);

/**
 * @param {Bucket} before
 * @param {Bucket} after
 * @returns {Bucket}
 */
const bucketDelta = (before, after) =>
  /** @type {Bucket} */ (
    // persistChars is absent before the core counted it (a71e5272b5).
    Object.fromEntries(
      BUCKET_KEYS.map(k => [k, (after[k] ?? 0) - (before[k] ?? 0)]),
    )
  );

/**
 * The numeric fields of the store's counters, after minus before; the rest
 * as after has them.
 * @param {Record<string, any> | undefined} before
 * @param {Record<string, any> | undefined} after
 */
export const storeDelta = (before, after) =>
  after &&
  Object.fromEntries(
    Object.entries(after).map(([k, v]) => [
      k,
      // High-water marks (max, imageChars, logChars, seq...) are not deltas
      // in a meaningful sense; counts are. Both are numbers, so the caller
      // reads a mark from the after side: here every number is a delta
      // except `max`, kept as after has it.
      k !== 'max' && typeof v === 'number' && typeof before?.[k] === 'number'
        ? +(v - before[k]).toFixed(3)
        : v,
    ]),
  );

/**
 * The hub state's size on disk under a state directory (the whole-file
 * store's `hub.json`, or the log store's image and log), or null before
 * there is any.
 * @param {string} root
 */
export const hubDiskBytes = async root => {
  for (const dir of [path.join(root, 'heaps'), root]) {
    /** @type {Record<string, number>} */
    const sizes = {};
    for (const name of ['hub.json', 'hub-image.json', 'hub-log.jsonl']) {
      const info = await stat(path.join(dir, name)).catch(() => undefined);
      if (info?.isFile()) sizes[name] = info.size;
    }
    if (Object.keys(sizes).length > 0) {
      const logged =
        sizes['hub-image.json'] !== undefined ||
        sizes['hub-log.jsonl'] !== undefined;
      return {
        bytes: logged
          ? (sizes['hub-image.json'] ?? 0) + (sizes['hub-log.jsonl'] ?? 0)
          : (sizes['hub.json'] ?? 0),
        files: sizes,
      };
    }
  }
  return null;
};

/**
 * @param {HubStats} before
 * @param {HubStats} after
 * @returns {HubStats}
 */
const hubDelta = (before, after) => ({
  gcOnly: bucketDelta(before.gcOnly, after.gcOnly),
  other: bucketDelta(before.other, after.other),
  outside: bucketDelta(before.outside, after.outside),
  store: storeDelta(before.store, after.store),
});

/**
 * @param {Bucket[]} buckets
 * @returns {Bucket}
 */
export const sum = buckets =>
  /** @type {Bucket} */ (
    Object.fromEntries(
      BUCKET_KEYS.map(k => [k, buckets.reduce((s, b) => s + b[k], 0)]),
    )
  );

/**
 * @param {number} n
 * @param {number} d
 */
export const per = (n, d) => (d ? +(n / d).toFixed(3) : null);

/**
 * Per-frame reading of a bucket.
 * @param {Bucket} b
 */
export const perFrame = b => ({
  frames: b.frames,
  deliveries: b.deliveries,
  msPerFrame: per(b.ms, b.frames),
  persistMsPerFrame: per(b.persistMs, b.frames),
  persistCharsPerFrame: per(b.persistChars, b.frames),
  serializeMsPerFrame: per(b.serializeMs, b.frames),
  sendMsPerFrame: per(b.sendMs, b.frames),
  persistsPerFrame: per(b.persists, b.frames),
  sendsPerFrame: per(b.sends, b.frames),
  framesPerDelivery: per(b.frames, b.deliveries),
  msPerPersist: per(b.persistMs, b.persists),
  msPerSend: per(b.sendMs, b.sends),
});

/**
 * One served slice with a scripted backend and a turn runner per session
 * that reads the hub counters around each turn.
 * @param {any} template
 * @param {string} root
 */
export const openSlice = async (template, root) => {
  const served = await startFromTemplate(template, {
    root,
    idleSleepMs: 3_600_000,
    snapshotEveryDeliveries: 256,
  });
  const slice = await makeSlice(served);
  const label = `perf-hub-${process.pid}`;
  const made = await slice.makeBackend(harden(perfScript), { label });
  const log = () => made.log().filter(l => l.label === label);
  const status = async () => served.client.call('status');
  /** @returns {Promise<HubStats>} */
  const hubStats = async () => {
    const s = await status();
    if (!s.hub) throw Error('status() has no hub counters (C-20 core)');
    return s.hub;
  };
  /** @param {any} session */
  const open = async session => {
    const sub = await slice.subscribe(session);
    const turn = async () => {
      const mark = sub.deliveries.length;
      const before = await hubStats();
      await slice.submit(session, perfInputs.start);
      const i = await sub.until(e => e.type === 'turn-start', 60_000, mark);
      const { turnId, at } = sub.deliveries[i].event;
      await sub.until(
        e => (e.type === 'end' || e.type === 'abort') && e.turnId === turnId,
        120_000,
        i,
      );
      // Late GC frames: until the hub's GC frame count settles.
      let after = await hubStats();
      for (let k = 0; k < 20; k += 1) {
        await delay(50);
        const again = await hubStats();
        if (again.gcOnly.frames === after.gcOnly.frames) break;
        after = again;
      }
      return { turnId, at, hub: hubDelta(before, after) };
    };
    /**
     * Turns until the session's sealing backlog is drained (kept turns at
     * most keep + segment; at most 16 turns): an imported session seals
     * after the import returns.
     * @param {number} turns the session's length now
     */
    const settle = async turns => {
      const keptBound = limits.archiveKeepTurns + limits.archiveSegmentTurns;
      let n = turns;
      let warmups = 0;
      for (;;) {
        const { archive } = await E(session).getHistoryPage();
        if (n - (archive?.sealedTurns ?? 0) <= keptBound || warmups >= 16)
          break;
        await turn();
        n += 1;
        warmups += 1;
      }
      return warmups;
    };
    return { sub, turn, settle };
  };
  return { served, slice, made, label, log, status, hubStats, open };
};

/** @param {number} value */
const round1 = value => +value.toFixed(1);

/**
 * One growth window: turns on the measured session for GROWTH_WINDOW_MS,
 * then a `hub.persist` row; returns the point for `hub.growth`.
 * @param {Awaited<ReturnType<typeof openSlice>>} run
 * @param {() => Promise<{ hub: HubStats }>} turn
 * @param {string} at
 * @param {number} sessions
 * @param {Record<string, unknown>} [extra]
 */
export const growthWindow = async (run, turn, at, sessions, extra = {}) => {
  const statsBefore = await run.hubStats();
  const w = await runWindow(async () => turn(), { ms: GROWTH_WINDOW_MS });
  const statsAfter = await run.hubStats();
  const turns = w.samples.length;
  const o = sum(w.results.map(t => t.hub.other));
  const a = sum(
    w.results.flatMap(t => [t.hub.other, t.hub.gcOnly, t.hub.outside]),
  );
  const disk = await hubDiskBytes(run.served.root);
  const { commit, workerSha256 } = await runIdentity();
  emit({
    metric: 'hub.persist',
    unit: 'ms per inbound non-GC delivery',
    value: per(o.ms, o.deliveries),
    at,
    sessions,
    ...windowFields(w),
    perDelivery: {
      deliveries: o.deliveries,
      persists: per(o.persists, o.deliveries),
      persistChars: per(o.persistChars, o.deliveries),
      persistMs: per(o.persistMs, o.deliveries),
      sendMs: per(o.sendMs, o.deliveries),
    },
    perTurn: {
      persists: per(a.persists, turns),
      persistChars: per(a.persistChars, turns),
      persistMs: per(a.persistMs, turns),
      hubMs: per(a.ms, turns),
    },
    turnMs: { median: median(w.samples) },
    msPerPersist: per(a.persistMs, a.persists),
    charsPerPersist: per(a.persistChars, a.persists),
    serializeMsPerPersist: per(a.serializeMs, a.persists),
    diskBytes: disk?.bytes ?? null,
    diskFiles: disk?.files ?? null,
    store: storeDelta(statsBefore.store, statsAfter.store) ?? null,
    // Persists with no microtask checkpoint between them (core
    // a71e5272b5+): persists - bursts is what one commit per burst saves.
    persistRuns:
      storeDelta(statsBefore.persistRuns, statsAfter.persistRuns) ?? null,
    ...extra,
    pass: null,
    commit,
    workerSha256,
    crankBudget,
    loadAvg: loadAvg(),
  });
  return {
    at,
    sessions,
    samples: turns,
    hubJsonBytes: disk?.bytes ?? (await hubJsonBytes(run.served.root)),
    msPerDelivery: per(o.ms, o.deliveries),
    msPerFrame: per(o.ms, o.frames),
    msPerPersist: per(a.persistMs, a.persists),
    serializeMsPerPersist: per(a.serializeMs, a.persists),
    persistsPerTurn: per(a.persists, turns),
    charsPerTurn: per(a.persistChars, turns),
  };
};

/** @param {number[]} values */
const median = values => {
  const s = [...values].sort((x, y) => x - y);
  return round1(s[Math.floor(s.length / 2)]);
};

/**
 * The `hub.growth` row over a file's points (the first is fresh); sets the
 * exit code on a miss.
 * @param {Awaited<ReturnType<typeof growthWindow>>[]} points
 * @param {Record<string, unknown>} extra
 */
export const growthRow = async (points, extra) => {
  const fresh = points[0];
  const maxBytes = Math.max(...points.map(p => p.hubJsonBytes ?? 0));
  const ratios = points.map(p =>
    fresh.msPerDelivery && p.msPerDelivery
      ? +(p.msPerDelivery / fresh.msPerDelivery).toFixed(3)
      : null,
  );
  const maxRatio = Math.max(...ratios.map(r => r ?? 0));
  const exceeded = [
    ...(maxBytes > 2_000_000 ? [`bytes: ${maxBytes} > 2_000_000`] : []),
    ...(maxRatio > 1.25 ? [`msPerDelivery: ${maxRatio} x fresh > 1.25`] : []),
  ];
  if (exceeded.length) process.exitCode = 1;
  const { commit, workerSha256 } = await runIdentity();
  emit({
    metric: 'hub.growth',
    unit: 'bytes',
    value: maxBytes,
    points: points.map((p, k) => ({ ...p, msPerDeliveryVsFresh: ratios[k] })),
    window: { ms: GROWTH_WINDOW_MS },
    samples: points.reduce((s, p) => s + p.samples, 0),
    ...extra,
    budget: { bytes: 2_000_000, msPerDeliveryVsFresh: 1.25 },
    pass: exceeded.length === 0,
    ...(exceeded.length ? { exceeded } : {}),
    commit,
    workerSha256,
    crankBudget,
    loadAvg: loadAvg(),
  });
};
