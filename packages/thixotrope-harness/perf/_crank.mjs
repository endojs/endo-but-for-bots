// @ts-check
/**
 * Shared parts of the "crank" perf checks (core candidates C-7 and C-21),
 * split by session length so each runs inside the 10-minute box
 * (designs/process.md section 3):
 *
 * - `perf/crank.perf.mjs`: the worker rows on a fresh boot and on a new
 *   session vat, `crank.ping`, and the early window of a grown session
 *   (turns 4 to the window's end) with its restart.
 * - `perf/crank.mid.perf.mjs`: `crank.turn.start.mid` and `crank.grow` on a
 *   session of CRANK_MID_TURNS (default 500) built by `importState`.
 * - `perf/crank.late.perf.mjs`: the late rows on a session of CRANK_TURNS
 *   (default 1,000) built by `importState`: `crank.turn.start.late`,
 *   `crank.grow`, `crank.history.page.late`, the restart with `crank.heap`
 *   and the worker rows, `crank.context.rebuild`.
 *
 * Every measured point is a fixed window (perf/_window.mjs), not a count:
 * CRANK_WINDOW_MS (default 60 s) of turns, CRANK_WORKER_WINDOW_MS (10 s)
 * per worker row, CRANK_PING_WINDOW_MS (20 s), CRANK_PAGE_WINDOW_MS (10 s).
 *
 * Worker rows, `crank.worker.<heap>[.alloc][.<policy>]`: the worker binary
 * under test is run directly, as the engine runs it, on a private copy of a
 * heap (a fresh boot, or a session vat's snapshot from a clean restart). It
 * gets `deliver` requests of a trivial dispatch (`void 0`: the ping floor)
 * for one window, then of a dispatch that leaves 5,000 objects of garbage
 * (`.alloc`) for another. The row is the round trip of one request from
 * this process; a worker that answers `timing: true` requests also splits
 * it into compile, run, collection, finalization notification and outbound
 * extraction, with how many requests collected and its slot and chunk
 * high-water marks. The worker runs under the state's persisted limits,
 * and again under each policy in CRANK_GC_POLICIES (comma-separated,
 * `every-crank` or `allocation`), as rows suffixed with the policy's name.
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import readline from 'node:readline';

import { limits as harnessLimits } from '../config/defaults.js';

import {
  crankBudget,
  delta,
  emit,
  harnessRoot,
  loadAvg,
  runIdentity,
  single,
  stats,
  summarize,
  workerBinary,
} from './_harness.mjs';
import { runWindow, windowFields, windowMs } from './_window.mjs';

// After the harness module (it locks down first).
const { installGuestPrelude } = await import('../scripts/guest-prelude.js');
installGuestPrelude();
const { E } = await import('@endo/far');
const { makeSlice, waitFor, round1 } =
  await import('../test/integration/_m1a-slice.js');
const { execTemplate } = await import('../test/integration/_m1b-exec.js');
const { runTurn } = await import('../test/integration/_m1b.js');
const { writeSyntheticExport } =
  await import('../test/integration/_m2-lifecycle.js');
const { importState } = await import('../scripts/export.mjs');
// eslint-disable-next-line import/no-relative-packages -- guest/ is its own private package
const { limits } = await import('../guest/lib/limits.js');

/** Turns per measured point. */
export const TURN_WINDOW_MS = windowMs('CRANK_WINDOW_MS', 60_000);
/** Per worker row (`void 0`, then `.alloc`). */
export const WORKER_WINDOW_MS = windowMs('CRANK_WORKER_WINDOW_MS', 10_000);
export const PING_WINDOW_MS = windowMs('CRANK_PING_WINDOW_MS', 20_000);
export const PAGE_WINDOW_MS = windowMs('CRANK_PAGE_WINDOW_MS', 10_000);
/** Extra collection policies to run the worker rows under, besides the state's own. */
const EXTRA_POLICIES = (process.env.CRANK_GC_POLICIES ?? '')
  .split(',')
  .filter(Boolean);
/** How long the first turn after a restart may take (its context rebuild). */
const REBUILD_WAIT_MS = 5 * 60_000;
/** Slots per engine page (`rust/engine/ironhorse-vm/src/value.rs`). */
const SLOTS_PER_PAGE = 256;
const SLOT_CEILING = Number(
  process.env.THIXOTROPE_SLOT_CEILING ?? harnessLimits.slotCeiling,
);
const SESSION_LABEL = /^(spare session \d+|session s\d+)$/;

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};

/**
 * The long-session script of `perf/history.perf.mjs` (J-9383): a tool round,
 * then a closing one.
 */
export const script = harden({
  turns: [
    {
      rounds: [
        {
          chunks: [{ text: 'a reply that calls a tool ' }],
          toolCalls: [{ name: 'echo', args: JSON.stringify({ text: 'ok' }) }],
          nativeContext: `native ${'n'.repeat(200)}`,
          usage,
        },
        {
          chunks: [{ text: 'and the closing text of the turn' }],
          nativeContext: `native after ${'m'.repeat(200)}`,
          usage,
        },
      ],
    },
  ],
});

/**
 * The hub's process-local cost counters (`status().hub`, CC-018, CC-024)
 * summed over its delivery buckets: deliveries, ms, persists, persistMs,
 * persistChars.
 * @param {any} hub
 * @returns {Record<string, number>}
 */
const hubTotals = hub => {
  /** @type {Record<string, number>} */
  const out = {
    deliveries: 0,
    ms: 0,
    persists: 0,
    persistMs: 0,
    persistChars: 0,
  };
  // The delivery buckets only (not `store` or `persistRuns`).
  for (const name of ['other', 'gcOnly', 'outside']) {
    const bucket = hub?.[name];
    if (bucket !== null && typeof bucket === 'object') {
      for (const key of Object.keys(out)) {
        const value = bucket[key];
        if (typeof value === 'number') out[key] += value;
      }
    }
  }
  return out;
};

/** @param {number[]} values */
const median = values => (values.length ? summarize(values).median : null);

/** Identity fields for rows emitted directly. */
export const identity = async () => ({
  ...(await runIdentity()),
  crankBudget,
  loadAvg: loadAvg(),
});

/**
 * The runtime a state directory pinned: its profile (the heap signature),
 * its boot bundles and its persisted execution limits.
 * @param {string} root
 */
export const stateRuntime = root => {
  const [profile] = readdirSync(path.join(root, 'runtime'));
  const dir = path.join(root, 'runtime', profile);
  const bootPaths = readdirSync(dir)
    .filter(name => /^[0-9]+$/.test(name) && name !== '0')
    .sort((a, b) => Number(a) - Number(b))
    .map(name => path.join(dir, name));
  const manifest = JSON.parse(
    readFileSync(path.join(root, 'runtime.json'), 'utf8'),
  );
  return { profile, bootPaths, limits: manifest.limits };
};

/**
 * A worker's newest snapshot image, by debug label.
 * @param {string} root
 * @param {RegExp} label
 */
export const vatImage = (root, label) => {
  const workers = path.join(root, 'workers');
  const metas = readdirSync(workers)
    .map(id => path.join(workers, id, 'meta.json'))
    .filter(metaPath => existsSync(metaPath))
    .map(metaPath => JSON.parse(readFileSync(metaPath, 'utf8')))
    .filter(m => label.test(m.debugLabel ?? '') && m.snapshot?.ref);
  metas.sort((a, b) => b.snapshot.cut - a.snapshot.cut);
  const meta = metas[0];
  if (meta === undefined) return undefined;
  const file = path.join(
    root,
    'heaps',
    'snapshots',
    `${meta.snapshot.ref}.sqlite`,
  );
  const pages = Number(
    execFileSync('sqlite3', [file, 'select count(*) from slot_pages'])
      .toString()
      .trim(),
  );
  return {
    file,
    label: meta.debugLabel,
    cut: meta.snapshot.cut,
    slots: pages * SLOTS_PER_PAGE,
    ofCeiling:
      Math.round(((pages * SLOTS_PER_PAGE) / SLOT_CEILING) * 1000) / 1000,
  };
};

/**
 * @typedef {object} WorkerOptions
 * @property {string} name row name part
 * @property {string} scratch private directory (created, then removed)
 * @property {string} profile heap signature
 * @property {string[]} bootPaths boot bundles (used by a fresh heap)
 * @property {Record<string, any>} limits
 * @property {string} [image] heap to copy; none boots a fresh vat
 * @property {Record<string, unknown>} [extra] fields every row carries
 */

/**
 * Run the worker under test directly on a private heap and time deliveries,
 * under the state's policy and each of CRANK_GC_POLICIES.
 * @param {WorkerOptions} options
 */
export const workerRows = async options => {
  await workerRowsUnder(options);
  for (const policy of EXTRA_POLICIES) {
    await workerRowsUnder({
      ...options,
      name: `${options.name}.${policy}`,
      limits: { ...options.limits, gcPolicy: policy },
    });
  }
};

/** @param {WorkerOptions} options */
const workerRowsUnder = async ({
  name,
  scratch,
  profile,
  bootPaths,
  limits: stateLimits,
  image,
  extra = {},
}) => {
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  const heap = path.join(scratch, 'heap.sqlite');
  if (image) copyFileSync(image, heap);
  const workerLimits = {
    crankBudget: String(stateLimits.crankBudget),
    bootstrapBudget: String(stateLimits.bootstrapBudget),
    slotCeiling: stateLimits.slotCeiling,
    chunkCeiling: stateLimits.chunkCeiling,
    ...Object.fromEntries(
      ['gcPolicy', 'gcSlotAllowance', 'gcChunkAllowance']
        .filter(key => stateLimits[key] !== undefined)
        .map(key => [key, stateLimits[key]]),
    ),
  };
  const tSpawn = performance.now();
  const child = spawn(
    workerBinary,
    [
      heap,
      profile,
      path.join(scratch, 'lease.lock'),
      JSON.stringify(workerLimits),
      ...bootPaths,
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  );
  const lines = readline
    .createInterface({ input: child.stdout })
    [Symbol.asyncIterator]();
  const next = async () => {
    const { value, done } = await lines.next();
    if (done) throw Error(`worker ${name} ended`);
    return JSON.parse(value);
  };
  /** @param {Record<string, unknown>} request */
  const ask = async request => {
    child.stdin.write(`${JSON.stringify(request)}\n`);
    const reply = await next();
    if (reply.op !== 'result')
      throw Error(`worker ${name}: ${JSON.stringify(reply).slice(0, 300)}`);
    return reply;
  };
  try {
    const ready = await next();
    if (ready.op !== 'ready') throw Error(`worker ${name} did not start`);
    const startMs = performance.now() - tSpawn;
    for (const [suffix, source] of [
      ['', 'void 0'],
      ['.alloc', 'void Array.from({ length: 5000 }, (_, i) => ({ i }))'],
    ]) {
      const w = await runWindow(
        async () =>
          ask({
            op: 'deliver',
            source,
            budget: String(stateLimits.crankBudget),
            drainBudget: String(stateLimits.crankBudget),
            timing: true,
          }),
        { ms: WORKER_WINDOW_MS },
      );
      /** @type {any[]} */
      const timings = w.results.map(reply => reply.timing).filter(Boolean);
      /** @param {string} key */
      const part = key => median(timings.map(x => x[key] / 1000));
      /** @param {string} key */
      const most = key =>
        timings.length ? Math.max(...timings.map(x => x[key])) : null;
      await stats(`crank.worker.${name}${suffix}`, w.samples, {
        extra: {
          what: `deliver(${source}) round trip to the worker, ${image ? 'a session vat image' : 'a fresh boot'}`,
          gcPolicy: stateLimits.gcPolicy ?? 'worker default',
          startMs: round1(startMs),
          ...windowFields(w),
          ...extra,
          ...(timings.length
            ? {
                splitMedianMs: {
                  compile: part('compileUs'),
                  run: part('runUs'),
                  collect: part('collectUs'),
                  notify: part('notifyUs'),
                  extract: part('extractUs'),
                  worker: part('totalUs'),
                },
                collectMs: summarize(
                  timings
                    .filter(x => x.collections > 0)
                    .map(x => x.collectUs / 1000)
                    .concat(timings.some(x => x.collections > 0) ? [] : [0]),
                ),
                collections: timings.reduce((a, x) => a + x.collections, 0),
                policy: timings[0].policy,
                liveSlots: {
                  first: timings[0].liveSlots,
                  last: timings[timings.length - 1].liveSlots,
                  max: most('liveSlots'),
                },
                slotCapacityMax: most('slotCapacity'),
                chunkBytesMax: most('chunkBytes'),
                slotCeiling: stateLimits.slotCeiling,
              }
            : { split: 'not reported by this worker' }),
        },
      });
    }
  } finally {
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
    rmSync(scratch, { recursive: true, force: true });
  }
};

/** A scratch directory for the worker rows of this process. */
export const workerScratch = () =>
  path.join(harnessRoot, 'tmp', `cw${process.pid}`);

/**
 * One crank session and its turn machinery: turns through the Composer
 * (`turn.start` per turn) or `Session.startTurn`, rows for a stretch of
 * turns, history pages, the restart with its heap and worker rows, and the
 * context rebuild after it.
 * @param {object} options
 * @param {any} options.state a Provisioned state (perf/_harness.mjs)
 * @param {any} options.slice
 * @param {any} options.made the scripted backend
 * @param {any} options.session
 * @param {number} options.turns turns the session already holds
 * @param {ReturnType<typeof stateRuntime>} options.runtime
 */
export const makeCrankSession = async ({
  state,
  slice,
  made,
  session,
  turns,
  runtime,
}) => {
  const { key } = await E(session).getInfo();
  let found = session;
  let live = await slice.subscribe(found);
  let n = turns;
  /** @type {Map<number, number>} turn number -> turn.start ms */
  const startByTurn = new Map();
  /** @type {unknown} */
  let lastTurnId;
  const busySessionLabel = async () => {
    const rows = await slice.workers();
    const row = rows
      .filter((/** @type {any} */ w) => SESSION_LABEL.test(w.debugLabel))
      .sort(
        (/** @type {any} */ a, /** @type {any} */ b) =>
          b.journalLength - a.journalLength,
      )[0];
    return row ? RegExp(`^${row.debugLabel}$`) : SESSION_LABEL;
  };
  /** A turn through `startTurn` (no Composer receipt). */
  const directTurn = async (/** @type {number} */ ms = 120_000) => {
    n += 1;
    const from = live.deliveries.length;
    const started = await E(found).startTurn(
      harden({ text: `c${n}` }),
      Date.now(),
    );
    const { turnId } = await E(started).getStatus();
    const at = await waitFor(
      () =>
        live.deliveries.find(
          (/** @type {any} */ d, /** @type {number} */ i) =>
            i >= from &&
            (d.event.type === 'end' || d.event.type === 'abort') &&
            d.event.turnId === turnId,
        ),
      ms,
      `turn c${n}: end`,
      10,
    );
    if (at.event.type === 'abort')
      throw Error(`turn c${n} failed: ${at.event.reason}`);
    lastTurnId = turnId;
  };
  /** A turn through the Composer, with its `turn.start`. */
  const turn = async (/** @type {number} */ ms = 120_000) => {
    n += 1;
    const r = await runTurn(slice, found, live, `c${n}`, ms);
    if (r.end.status === 'failed')
      throw Error(`turn c${n} failed: ${r.end.reason}`);
    const started = live.deliveries
      .slice(r.from)
      .find(
        (/** @type {any} */ d) =>
          d.event.type === 'turn-start' && d.event.turnId === r.turnId,
      );
    const request = made
      .log()
      .find(
        (/** @type {any} */ l) =>
          l.kind === 'request' && l.turnId === r.turnId && l.round === 0,
      );
    if (started && request)
      startByTurn.set(n, Number(request.at) - Number(started.event.at));
    lastTurnId = r.turnId;
    return n;
  };

  const self = {
    get n() {
      return n;
    },
    get session() {
      return found;
    },
    turn,
    directTurn,
    /**
     * Drain the import's sealing backlog (kept turns at most keep +
     * segment, at most 16 turns), as perf/_long-session.mjs does.
     */
    settle: async () => {
      const keptBound = limits.archiveKeepTurns + limits.archiveSegmentTurns;
      let warmups = 0;
      for (;;) {
        const { archive } = await E(found).getHistoryPage();
        if (n - (archive?.sealedTurns ?? 0) <= keptBound || warmups >= 16)
          break;
        await directTurn();
        warmups += 1;
      }
      return warmups;
    },
    /**
     * Composer turns for one window: `<metric>` (turn.start of the window's
     * turns from `firstCounted` on) and `crank.grow` (wall time per 100
     * turns from the window's rate, with the engine and hub deltas).
     * @param {string} metric
     * @param {{ firstCounted?: number, extra?: Record<string, unknown> }} [options]
     */
    window: async (metric, { firstCounted = 0, extra = {} } = {}) => {
      const from = n + 1;
      const statusBefore = await state.client.call('status');
      const w = await runWindow(async () => turn(), { ms: TURN_WINDOW_MS });
      const statusAfter = await state.client.call('status');
      const to = n;
      const lo = Math.max(from, firstCounted);
      const samples = [...startByTurn]
        .filter(([k]) => k >= lo && k <= to)
        .map(([, v]) => v);
      const fields = windowFields(w);
      if (samples.length)
        await stats(metric, samples, {
          budget: { median: 350 },
          extra: {
            turns: `${lo}..${to}`,
            ...fields,
            samples: samples.length,
            ...extra,
          },
        });
      const hubThen = hubTotals(statusBefore.hub);
      const hubNow = hubTotals(statusAfter.hub);
      emit({
        metric: 'crank.grow',
        turns: to,
        msPer100: round1((w.elapsedMs / w.samples.length) * 100),
        what: 'wall time per 100 turns, from the turn rate over the window',
        engine: delta(statusBefore.timings ?? {}, statusAfter.timings),
        hub: Object.fromEntries(
          Object.entries(hubNow).map(([k, v]) => [k, round1(v - hubThen[k])]),
        ),
        ...fields,
        ...extra,
        ...(await identity()),
      });
      return w;
    },
    /**
     * `getHistoryPage()` reads over one window.
     * @param {string} metric
     */
    pageRow: async metric => {
      const page = await E(found).getHistoryPage();
      const b = await state.counters();
      const w = await runWindow(async () => E(found).getHistoryPage(), {
        ms: PAGE_WINDOW_MS,
      });
      const a = await state.counters();
      await stats(metric, w.samples, {
        budget: { median: 300 },
        before: b,
        after: a,
        ops: w.samples.length,
        extra: {
          turns: page.turns.length,
          sessionTurns: n,
          ...windowFields(w),
        },
      });
    },
    /**
     * A clean restart: the session vat's heap and worker rows at the
     * session's length, then the next turn's context rebuild (its round 0
     * `prepare()` after the restart).
     * @param {object} options
     * @param {string} options.rebuildMetric
     * @param {string} options.scratch
     * @param {Record<string, unknown>} [options.extra]
     */
    restartAndRebuild: async ({ rebuildMetric, scratch, extra = {} }) => {
      await live.stop();
      const label = await busySessionLabel();
      const atTurns = n;
      const restarted = await state.restart(`crank${atTurns}`);
      const image = vatImage(state.root, label);
      emit({
        metric: 'crank.heap',
        turns: atTurns,
        heap: image && { ...image, file: undefined },
        ...extra,
        ...(await identity()),
      });
      if (image)
        await workerRows({
          name: `session${atTurns}`,
          scratch,
          profile: runtime.profile,
          bootPaths: runtime.bootPaths,
          limits: runtime.limits,
          image: image.file,
          extra: { sessionTurns: atTurns, ...extra },
        });
      await slice.refresh();
      found = await E(slice.factory).findSession(key);
      live = await slice.subscribe(found);
      const b = await state.counters();
      const t0 = performance.now();
      const turnNumber = await turn(REBUILD_WAIT_MS);
      const turnMs = performance.now() - t0;
      const a = await state.counters();
      startByTurn.delete(turnNumber);
      const line = await waitFor(
        () =>
          made
            .log()
            .find(
              (/** @type {any} */ l) =>
                l.kind === 'context' &&
                l.turnId === lastTurnId &&
                l.round === 0,
            ),
        10_000,
        'the context line',
      );
      await single(rebuildMetric, Number(line.ms), {
        budget: { value: 5000 },
        extra: {
          turns: turnNumber,
          timing: line.timing,
          serveMs: round1(restarted.serveMs),
          turnMs: round1(turnMs),
          deliveriesInTurn: a.delivery.count - b.delivery.count,
          ...extra,
        },
      });
    },
    stop: async () => live.stop(),
  };
  return self;
};

/**
 * The crank session at a length built by `importState` (tool turns, the
 * long-session script's shape): import `turns - 50`, drain the sealing
 * backlog, then one window of Composer turns (`crank.turn.start.<phase>`,
 * `crank.grow`); for `late` also `crank.history.page.late`, the restart
 * with `crank.heap` and the worker rows, and `crank.context.rebuild`.
 *
 * The scripted provider's per-round digest of the whole transcript is off
 * while the session settles and during the window (`<logPath>.nodigest`,
 * m2-interfaces.md 4.13, as perf/_long-session.mjs): it is test machinery
 * that grows with the session. The grown session of the old file had it on.
 * An imported session's heap high-water is larger than a grown one's
 * (J-9405): the `crank.heap` and worker rows say `built: 'importState'`.
 * @param {object} options
 * @param {'mid' | 'late'} options.phase
 * @param {number} options.turns session length before the window
 * @param {(o?: any) => Promise<any>} options.provision runPerf's
 * @param {string} options.root runPerf's root
 */
export const crankAtLength = async ({ phase, turns, provision, root }) => {
  const template = await execTemplate();
  const state = await provision({ template });
  const runtime = stateRuntime(state.root);
  const slice = await makeSlice(state);
  const made = await slice.makeBackend(script, { label: 'Scripted' });
  const quiet = `${made.logPath}.nodigest`;
  const imported = Math.max(0, turns - 50);
  const file = path.join(
    path.dirname(root),
    `${path.basename(root)}-crank-${turns}.jsonl`,
  );
  const written = await writeSyntheticExport(file, [
    {
      title: `crank ${turns}`,
      turns: imported,
      backendLabel: 'Scripted',
      shape: 'tool',
    },
  ]);
  const result = await importState({
    client: state.client,
    file,
    backends: [made.backend],
  });
  rmSync(file, { force: true });
  emit({
    metric: `crank.import.at${turns}`,
    unit: 'turns/s',
    turns: result.turns,
    records: result.records,
    fileBytes: written.bytes,
    ms: Math.round(result.ms),
    turnsPerSecond: round1((result.turns * 1000) / result.ms),
    sealWaits: result.waits,
    sealWaitMs: Math.round(result.waitMs),
    shape: 'tool',
    ...(await identity()),
  });
  const built = {
    built: 'importState',
    imported: result.turns,
    digests: 'off while settling and in the window',
  };
  writeFileSync(quiet, '');
  const crank = await makeCrankSession({
    state,
    slice,
    made,
    session: result.sessions[0],
    turns: result.turns,
    runtime,
  });
  const warmups = await crank.settle();
  await crank.window(`crank.turn.start.${phase}`, {
    extra: { ...built, warmups },
  });
  if (phase === 'late') {
    await crank.pageRow('crank.history.page.late');
    rmSync(quiet, { force: true });
    await crank.restartAndRebuild({
      rebuildMetric: 'crank.context.rebuild',
      scratch: workerScratch(),
      extra: built,
    });
  }
  await crank.stop();
};
