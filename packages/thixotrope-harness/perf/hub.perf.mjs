// @ts-check
/**
 * Perf check "hub" (core candidates C-20 and C-2; journal J-9127, J-9195):
 * what the supervisor's OCapN hub costs per incoming GC frame, and how its
 * persisted state and per-delivery cost grow.
 *
 *   cd packages/thixotrope-harness && node perf/hub.perf.mjs
 *
 * Both phases read the hub's own process-local cost counters
 * (`status().hub`, Thixotrope `7efa7fb3e4`): per inbound delivery (one
 * `deliver` or `deliverBatch` call into the hub) whether it carried only GC
 * frames (`gcOnly`) or anything else (`other`), its frames, its whole
 * synchronous time, and inside it the `persist()` calls (`hub.json`
 * serialization and atomic replacement) and the sends (toward a durable
 * worker, the journal append with its fsync).
 *
 * Phase 1, the burst (one served copy of the m1a template, idle sleep 1 h):
 * one session of the real program on the scripted backend with a Live
 * subscriber in this process, 3 warm-up turns and HUB_TURNS (default 150)
 * one-chunk turns, as `gc.perf.mjs` runs them. Rows:
 * - `hub.gcBurst`: host time per incoming GC frame (`value`), split into
 *   persist (and its serialization) and send (journal append) time per
 *   frame, persists and sends per frame, frames per delivery (batching),
 *   the same per-frame numbers for all other inbound frames, and the turns
 *   with the most GC frames with their hub time and start latency.
 *   Recorded; it decides C-20.
 * - `hub.gcBurst.turnStart`: turn start latency of the same turns (budget
 *   median 350 ms as `turn.start`; p99 recorded, target 1 s).
 *
 * Phase 2, growth (a second copy; HUB_GROWTH=0 skips it): one session with
 * a subscriber; a window of GROWTH_WINDOW (default 30) turns is measured
 * fresh, after GROWTH_TURNS (default 1,000) more turns, and after more
 * sessions have each run one turn: GROWTH_STEPS (default "10,50") are the
 * session counts, the measured session included, at which a window runs
 * (the last is GROWTH_SESSIONS, default 50, when that is set).
 * - `hub.growth`: the hub's persisted bytes and the hub's milliseconds per
 *   inbound non-GC delivery and per persist at each point. Budget: bytes
 *   <= 2 MB, ms per delivery <= 1.25 x fresh (computed here, not with the
 *   harness slack).
 * - `hub.persist` (C-2, journal J-9330..): one row per window: persists,
 *   characters written (`persistChars`, the store's own count; ASCII JSON,
 *   so bytes) and milliseconds, per inbound non-GC delivery and per turn,
 *   the hub state's size on disk, and the store's counters (`status().hub.
 *   store`: whole-file writes, or the log's appends and compactions).
 * - `hub.size`: the hub state's size on disk every GROWTH_SAMPLE (default
 *   100) turns of the GROWTH_TURNS.
 * The size on disk is `hub.json` for the whole-file store, and the image
 * plus the log (`hub-image.json`, `hub-log.jsonl`) for the log store.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import {
  crankBudget,
  emit,
  hubJsonBytes,
  loadAvg,
  runIdentity,
  runPerf,
  stats,
} from './_harness.mjs';

// After the harness module (it locks down first).
const { installGuestPrelude } = await import('../scripts/guest-prelude.js');
installGuestPrelude();
const { perfInputs, perfScript } =
  await import('../test/fixtures/scripts/m1a-slice.js');
const { startFromTemplate } = await import('../test/template/index.js');
const { makeSlice, round1, sliceTemplate } =
  await import('../test/integration/_m1a-slice.js');

const HUB_TURNS = Number(process.env.HUB_TURNS ?? 150);
const HUB_GROWTH = process.env.HUB_GROWTH !== '0';
const GROWTH_WINDOW = Number(process.env.GROWTH_WINDOW ?? 30);
const GROWTH_TURNS = Number(process.env.GROWTH_TURNS ?? 1000);
const GROWTH_SESSIONS = Number(process.env.GROWTH_SESSIONS ?? 50);
const GROWTH_STEPS = (process.env.GROWTH_STEPS ?? `10,${GROWTH_SESSIONS}`)
  .split(',')
  .map(Number)
  .filter(n => n > 1);
const GROWTH_SAMPLE = Number(process.env.GROWTH_SAMPLE ?? 100);

/** @typedef {{ deliveries: number, frames: number, ms: number, persists: number, persistMs: number, persistChars: number, serializeMs: number, sends: number, sendMs: number }} Bucket */
/** @typedef {{ gcOnly: Bucket, other: Bucket, outside: Bucket, store?: Record<string, any> }} HubStats */

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
const storeDelta = (before, after) =>
  after &&
  Object.fromEntries(
    Object.entries(after).map(([k, v]) => [
      k,
      typeof v === 'number' && typeof before?.[k] === 'number'
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
const hubDiskBytes = async root => {
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
const sum = buckets =>
  /** @type {Bucket} */ (
    Object.fromEntries(
      BUCKET_KEYS.map(k => [k, buckets.reduce((s, b) => s + b[k], 0)]),
    )
  );

/**
 * @param {number} n
 * @param {number} d
 */
const per = (n, d) => (d ? +(n / d).toFixed(3) : null);

/**
 * Per-frame reading of a bucket.
 * @param {Bucket} b
 */
const perFrame = b => ({
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
 * One served slice with a session, a subscriber and a turn runner that
 * reads the hub counters around each turn.
 * @param {any} template
 * @param {string} root
 */
const openSlice = async (template, root) => {
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
    return { sub, turn };
  };
  return { served, slice, made, log, status, hubStats, open };
};

await runPerf('hub', async ({ root }) => {
  const template = await sliceTemplate();
  await burst(template, root);
  if (HUB_GROWTH) await growth(template, `${root}g`);
});

/**
 * Phase 1.
 * @param {any} template
 * @param {string} root
 */
async function burst(template, root) {
  const run = await openSlice(template, root);
  try {
    const session = await run.slice.createSession(run.made.backend, 'hub');
    const { sub, turn } = await run.open(session);
    for (let i = 0; i < 3; i += 1) await turn();
    const t0 = performance.now();
    /** @type {Awaited<ReturnType<typeof turn>>[]} */
    const turns = [];
    for (let i = 0; i < HUB_TURNS; i += 1) turns.push(await turn());
    const wallMs = round1(performance.now() - t0);
    const requestAt = new Map(
      run
        .log()
        .filter(l => l.kind === 'request' && l.round === 0)
        .map(l => [l.turnId, l.at]),
    );
    const startMs = turns.map(t => Number(requestAt.get(t.turnId)) - t.at);
    if (startMs.some(v => !Number.isFinite(v)))
      throw Error('a turn has no paired request line');
    const gc = sum(turns.map(t => t.hub.gcOnly));
    const other = sum(turns.map(t => t.hub.other));
    const outside = sum(turns.map(t => t.hub.outside));
    const { commit, workerSha256 } = await runIdentity();
    emit({
      metric: 'hub.gcBurst',
      unit: 'ms per incoming GC frame',
      value: per(gc.ms, gc.frames),
      turns: HUB_TURNS,
      gcFramesPerTurn: per(gc.frames, HUB_TURNS),
      gc: perFrame(gc),
      other: perFrame(other),
      outside: {
        persists: outside.persists,
        persistMs: round1(outside.persistMs),
        sends: outside.sends,
        sendMs: round1(outside.sendMs),
      },
      largestBursts: turns
        .map((t, k) => ({
          turnId: t.turnId,
          gcFrames: t.hub.gcOnly.frames,
          gcDeliveries: t.hub.gcOnly.deliveries,
          gcMs: round1(t.hub.gcOnly.ms),
          persistMs: round1(t.hub.gcOnly.persistMs),
          sendMs: round1(t.hub.gcOnly.sendMs),
          startMs: startMs[k],
        }))
        .sort((a, b) => b.gcFrames - a.gcFrames)
        .slice(0, 5),
      hubJsonBytes: await hubJsonBytes(run.served.root),
      hubDisk: await hubDiskBytes(run.served.root),
      wallMs,
      clock: 'supervisor monotonic clock, synchronous hub work only',
      pass: null,
      commit,
      workerSha256,
      crankBudget,
      loadAvg: loadAvg(),
    });
    await stats('hub.gcBurst.turnStart', startMs, {
      budget: { median: 350 },
      extra: {
        from: 'Composer stamp (adapter clock)',
        to: 'request log line',
        turns: HUB_TURNS,
        p99Target: 1000,
      },
    });
    await sub.stop();
  } finally {
    await run.served.cleanup();
  }
}

/**
 * Phase 2.
 * @param {any} template
 * @param {string} root
 */
async function growth(template, root) {
  const run = await openSlice(template, root);
  try {
    const session = await run.slice.createSession(run.made.backend, 'grow');
    const { sub, turn } = await run.open(session);
    for (let i = 0; i < 3; i += 1) await turn();
    const { commit, workerSha256 } = await runIdentity();
    /**
     * @param {string} at
     * @param {number} sessions
     */
    const window = async (at, sessions) => {
      /** @type {Bucket[]} */
      const other = [];
      /** @type {Bucket[]} */
      const all = [];
      const storeBefore = (await run.hubStats()).store;
      for (let i = 0; i < GROWTH_WINDOW; i += 1) {
        const t = await turn();
        other.push(t.hub.other);
        all.push(t.hub.other, t.hub.gcOnly, t.hub.outside);
      }
      const storeAfter = (await run.hubStats()).store;
      const o = sum(other);
      const a = sum(all);
      const disk = await hubDiskBytes(run.served.root);
      emit({
        metric: 'hub.persist',
        unit: 'ms per inbound non-GC delivery',
        value: per(o.ms, o.deliveries),
        at,
        sessions,
        window: GROWTH_WINDOW,
        perDelivery: {
          deliveries: o.deliveries,
          persists: per(o.persists, o.deliveries),
          persistChars: per(o.persistChars, o.deliveries),
          persistMs: per(o.persistMs, o.deliveries),
          sendMs: per(o.sendMs, o.deliveries),
        },
        perTurn: {
          persists: per(a.persists, GROWTH_WINDOW),
          persistChars: per(a.persistChars, GROWTH_WINDOW),
          persistMs: per(a.persistMs, GROWTH_WINDOW),
          hubMs: per(a.ms, GROWTH_WINDOW),
        },
        msPerPersist: per(a.persistMs, a.persists),
        charsPerPersist: per(a.persistChars, a.persists),
        serializeMsPerPersist: per(a.serializeMs, a.persists),
        diskBytes: disk?.bytes ?? null,
        diskFiles: disk?.files ?? null,
        store: storeDelta(storeBefore, storeAfter) ?? null,
        pass: null,
        commit,
        workerSha256,
        crankBudget,
        loadAvg: loadAvg(),
      });
      return {
        at,
        sessions,
        hubJsonBytes: disk?.bytes ?? (await hubJsonBytes(run.served.root)),
        msPerDelivery: per(o.ms, o.deliveries),
        msPerFrame: per(o.ms, o.frames),
        msPerPersist: per(a.persistMs, a.persists),
        serializeMsPerPersist: per(a.serializeMs, a.persists),
        persistsPerTurn: per(a.persists, GROWTH_WINDOW),
        charsPerTurn: per(a.persistChars, GROWTH_WINDOW),
      };
    };
    const points = [await window('fresh', 1)];
    const t0 = performance.now();
    /** @type {Array<{ turns: number, bytes: number | null, files: Record<string, number> | null }>} */
    const sizes = [];
    for (let i = 0; i < GROWTH_TURNS; i += 1) {
      await turn();
      if ((i + 1) % GROWTH_SAMPLE === 0) {
        const disk = await hubDiskBytes(run.served.root);
        sizes.push({
          turns: i + 1,
          bytes: disk?.bytes ?? null,
          files: disk?.files ?? null,
        });
      }
    }
    const turnsMs = round1(performance.now() - t0);
    emit({
      metric: 'hub.size',
      unit: 'bytes',
      value: Math.max(...sizes.map(p => p.bytes ?? 0)),
      every: GROWTH_SAMPLE,
      turns: GROWTH_TURNS,
      samples: sizes,
      pass: null,
      commit,
      workerSha256,
      crankBudget,
      loadAvg: loadAvg(),
    });
    points.push(await window(`after ${GROWTH_TURNS} turns`, 1));
    const t1 = performance.now();
    let made = 1;
    for (const target of GROWTH_STEPS) {
      for (; made < target; made += 1) {
        const other = await run.slice.createSession(
          run.made.backend,
          `g${made}`,
        );
        await run.slice.submit(other, perfInputs.start);
      }
      // The last sessions' turns settle before the window.
      await delay(2000);
      points.push(await window(`at ${target} sessions`, target));
    }
    const sessionsMs = round1(performance.now() - t1);
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
    emit({
      metric: 'hub.growth',
      unit: 'bytes',
      value: maxBytes,
      points: points.map((p, k) => ({ ...p, msPerDeliveryVsFresh: ratios[k] })),
      turns: GROWTH_TURNS,
      sessions: made,
      window: GROWTH_WINDOW,
      turnsMs,
      sessionsMs,
      budget: { bytes: 2_000_000, msPerDeliveryVsFresh: 1.25 },
      pass: exceeded.length === 0,
      ...(exceeded.length ? { exceeded } : {}),
      commit,
      workerSha256,
      crankBudget,
      loadAvg: loadAvg(),
    });
    await sub.stop();
  } finally {
    await run.served.cleanup();
  }
}
