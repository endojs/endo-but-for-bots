// @ts-check
/**
 * Perf check "crank" (core candidates C-7 and C-21): what one delivery costs
 * a vat, split into its parts, at three live-heap sizes, and the harness
 * rows the worker's collection schedule moves.
 *
 * Worker rows, `crank.worker.<heap>[.alloc]`: the worker binary under test
 * (`THIXOTROPE_IRONHORSE_WORKER` or `target/release`) is run directly, as
 * the engine runs it, on a private copy of a heap: `boot` (a fresh vat:
 * the boot bundles only, smaller than any vat the harness runs), `session0`
 * (a new session vat after the pings below), `session50` and `session1000`
 * (the session vat after 50 and after CRANK_TURNS turns); each image is the
 * vat's snapshot from a clean restart.
 * Each sends CRANK_WORKER_N `deliver` requests of a trivial dispatch
 * (`void 0`: the ping floor of the worker), then as many of a dispatch that
 * leaves 5,000 objects of garbage (`.alloc`). The row is the round trip of
 * one request from this process; a worker that answers `timing: true`
 * requests (since the C-7 change) also splits it into compile, run (the
 * dispatch with its promise jobs: the engine drains them inside one run),
 * collection, finalization notification and outbound extraction, and
 * reports how many requests collected and its slot and chunk high-water
 * marks. The worker runs under the state's persisted limits (its
 * collection policy and allowances included; an older worker and state have
 * none), and again under each policy in CRANK_GC_POLICIES (comma-separated,
 * `every-crank` or `allocation`), as rows suffixed with the policy's name.
 *
 * Harness rows (exec template, one session, scripted provider, a tool round
 * per turn as in `perf/history.perf.mjs`):
 * - `crank.ping`: 200 `getInfo()` round trips from the control client to a
 *   new session vat (client -> hub -> session vat crank -> back): the
 *   200-delivery ping floor of a real vat.
 * - `crank.turn.start.early` / `.mid` / `.late`: `turn.start` (Composer
 *   stamp to the scripted provider's request line, budget median 350 ms)
 *   over turns 4-50, 450-500 and the last 50 turns.
 * - `crank.history.page` (at 50 turns) and `crank.history.page.late` (at
 *   CRANK_TURNS turns): `getHistoryPage()`, budget median 300 ms.
 * - `crank.context.rebuild`: the first round's `prepare()` after a clean
 *   restart at CRANK_TURNS turns (budget 5 s), as `history.perf.mjs`.
 * - `crank.grow`: wall time per 100 turns, with the engine timing and hub
 *   cost deltas of those turns; `crank.heap`: the session vat's
 *   slot capacity (pages x 256, a high-water mark) at each snapshot.
 *
 *   cd packages/thixotrope-harness && node perf/crank.perf.mjs
 *
 * - With CRANK_POINTS (session lengths between 50 and CRANK_TURNS), at each
 *   point: `crank.turn.start.at<n>` (the 50 turns before), `crank.history.page.at<n>`,
 *   a clean restart with `crank.heap` and the `session<n>` worker rows, and
 *   `crank.context.rebuild.at<n>` (the next turn's round 0 `prepare()`);
 *   `crank.context.rebuild.at50` likewise after the restart at 50 turns.
 *   The long-session table: `CRANK_TURNS=5000 CRANK_POINTS=200,1000,4000
 *   CRANK_START=mixed` (`startTurn` outside the measured windows: the
 *   Composer refuses a session's 4,097th submission within 24 h).
 *
 * CRANK_TURNS (default 1,000), CRANK_WORKER_N (default 200),
 * CRANK_GC_POLICIES, CRANK_POINTS, CRANK_START. About 30-40 minutes at 1,000 turns.
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
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
  runPerf,
  single,
  stats,
  summarize,
  workerBinary,
} from './_harness.mjs';

// After the harness module (it locks down first).
const { installGuestPrelude } = await import('../scripts/guest-prelude.js');
installGuestPrelude();
const { E } = await import('@endo/far');
const { makeSlice, waitFor, round1 } =
  await import('../test/integration/_m1a-slice.js');
const { execTemplate } = await import('../test/integration/_m1b-exec.js');
const { runTurn } = await import('../test/integration/_m1b.js');

const TURNS = Number(process.env.CRANK_TURNS ?? 1000);
const WORKER_N = Number(process.env.CRANK_WORKER_N ?? 200);
/** Extra collection policies to run the worker rows under, besides the state's own. */
const EXTRA_POLICIES = (process.env.CRANK_GC_POLICIES ?? '')
  .split(',')
  .filter(Boolean);
/**
 * Session lengths between 50 and CRANK_TURNS at which the session is also
 * measured (CRANK_POINTS, comma-separated, default none): `turn.start` over
 * the 50 turns before, `history.page`, a clean restart with the heap and
 * worker rows, and the next turn's context rebuild.
 */
const POINTS = (process.env.CRANK_POINTS ?? '')
  .split(',')
  .filter(Boolean)
  .map(Number)
  .filter(n => n > 50 && n < TURNS);
/**
 * How turns start: `composer` (default, every turn through the Composer)
 * or `mixed` (the Composer inside the measured windows, `startTurn`
 * elsewhere: a session takes at most 4,096 Composer submissions in 24 h).
 */
const START = process.env.CRANK_START ?? 'composer';
/**
 * Whether turn `n` goes through the Composer: always, or under `mixed`
 * when it is in a measured window (turns 1-50, the 50 turns up to and the
 * one after each point, the last 50).
 * @param {number} n
 */
const composerTurn = n =>
  START !== 'mixed' ||
  n <= 51 ||
  n > TURNS - 50 ||
  POINTS.some(p => n > p - 50 && n <= p + 1);
/** How long the first turn after a restart may take (its context rebuild). */
const REBUILD_WAIT_MS = 30 * 60_000;
const PING_N = 200;
/** Slots per engine page (`rust/engine/ironhorse-vm/src/value.rs`). */
const SLOTS_PER_PAGE = 256;
const SLOT_CEILING = Number(
  process.env.THIXOTROPE_SLOT_CEILING ?? harnessLimits.slotCeiling,
);

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};

/** The script of `perf/history.perf.mjs`: a tool round, then a closing one. */
const script = harden({
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
 * summed over its delivery buckets: deliveries, ms, persists, persistMs, persistChars.
 * @param {any} hub
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
        const value = /** @type {any} */ (bucket)[key];
        if (typeof value === 'number') out[key] += value;
      }
    }
  }
  return out;
};

/** @param {number[]} values */
const median = values => (values.length ? summarize(values).median : null);

/**
 * The runtime a state directory pinned: its profile (the heap signature),
 * its boot bundles and its persisted execution limits.
 * @param {string} root
 */
const stateRuntime = root => {
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
const vatImage = (root, label) => {
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
 * Run the worker under test directly on a private heap and time deliveries.
 * @param {object} options
 * @param {string} options.name row name part
 * @param {string} options.scratch private directory (created, then removed)
 * @param {string} options.profile heap signature
 * @param {string[]} options.bootPaths boot bundles (used by a fresh heap)
 * @param {Record<string, unknown>} options.limits
 * @param {string} [options.image] heap to copy; none boots a fresh vat
 */
const workerRows = async options => {
  await workerRowsUnder(options);
  for (const policy of EXTRA_POLICIES) {
    await workerRowsUnder({
      ...options,
      name: `${options.name}.${policy}`,
      limits: { ...options.limits, gcPolicy: policy },
    });
  }
};

/** @param {Parameters<typeof workerRows>[0]} options */
const workerRowsUnder = async ({
  name,
  scratch,
  profile,
  bootPaths,
  limits,
  image,
}) => {
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  const heap = path.join(scratch, 'heap.sqlite');
  if (image) copyFileSync(image, heap);
  const workerLimits = {
    crankBudget: String(limits.crankBudget),
    bootstrapBudget: String(limits.bootstrapBudget),
    slotCeiling: limits.slotCeiling,
    chunkCeiling: limits.chunkCeiling,
    ...Object.fromEntries(
      ['gcPolicy', 'gcSlotAllowance', 'gcChunkAllowance']
        .filter(key => limits[key] !== undefined)
        .map(key => [key, limits[key]]),
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
      /** @type {number[]} */
      const ms = [];
      /** @type {any[]} */
      const timings = [];
      for (let i = 0; i < WORKER_N; i += 1) {
        const t = performance.now();
        const reply = await ask({
          op: 'deliver',
          source,
          budget: String(limits.crankBudget),
          drainBudget: String(limits.crankBudget),
          timing: true,
        });
        ms.push(performance.now() - t);
        if (reply.timing) timings.push(reply.timing);
      }
      /** @param {string} key */
      const part = key => median(timings.map(x => x[key] / 1000));
      /** @param {string} key */
      const most = key =>
        timings.length ? Math.max(...timings.map(x => x[key])) : null;
      await stats(`crank.worker.${name}${suffix}`, ms, {
        extra: {
          what: `deliver(${source}) round trip to the worker, ${image ? 'a session vat image' : 'a fresh boot'}`,
          gcPolicy: limits.gcPolicy ?? 'worker default',
          startMs: round1(startMs),
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
                slotCeiling: limits.slotCeiling,
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

await runPerf('crank', async ({ provision }) => {
  const scratch = path.join(harnessRoot, 'tmp', `cw${process.pid}`);
  const template = await execTemplate();
  const state = await provision({ template });
  const runtime = stateRuntime(state.root);
  // A fresh vat: the boot bundles alone, as a new worker starts.
  await workerRows({
    name: 'boot',
    scratch,
    profile: 'crank-perf-fresh',
    bootPaths: runtime.bootPaths,
    limits: runtime.limits,
  });

  const slice = await makeSlice(state);
  const made = await slice.makeBackend(script);
  const session = await slice.createSession(made.backend, 'crank');
  const { key } = await E(session).getInfo();
  const sessionLabel = /^(spare session \d+|session s\d+)$/;
  const busySessionLabel = async () => {
    const rows = await slice.workers();
    const row = rows.find(
      (/** @type {any} */ w) =>
        sessionLabel.test(w.debugLabel) && w.journalLength > 40,
    );
    return row ? RegExp(`^${row.debugLabel}$`) : sessionLabel;
  };

  // ---- ping floor through the hub, on a new session vat
  /** @type {number[]} */
  const pingMs = [];
  let before = await state.counters();
  for (let i = 0; i < PING_N; i += 1) {
    const t = performance.now();
    await E(session).getInfo();
    pingMs.push(performance.now() - t);
  }
  let after = await state.counters();
  await stats('crank.ping', pingMs, {
    before,
    after,
    ops: PING_N,
    extra: {
      what: 'getInfo() round trip, control client to a new session vat',
    },
  });

  // ---- the new session vat (after the pings)
  let label = await busySessionLabel();
  await state.restart('crank0');
  const at0 = vatImage(state.root, label);
  emit({
    metric: 'crank.heap',
    turns: 0,
    heap: at0 && { ...at0, file: undefined },
    ...(await runIdentity()),
    crankBudget,
    loadAvg: loadAvg(),
  });
  if (at0)
    await workerRows({
      name: 'session0',
      scratch,
      profile: runtime.profile,
      bootPaths: runtime.bootPaths,
      limits: runtime.limits,
      image: at0.file,
    });
  await slice.refresh();
  let found = await E(slice.factory).findSession(key);
  let live = await slice.subscribe(found);
  /**
   * A turn started with `Session.startTurn` (inline text, the caller's
   * clock) instead of the Composer: the same turn path without a
   * submission receipt. The Composer keeps at most 4,096 receipts per
   * session for 24 h (`maxReceipts`), so a long session is grown this way
   * outside the measured windows (CRANK_START=mixed, J-9383).
   * @param {any} target
   * @param {string} input
   * @param {number} ms
   */
  const directTurn = async (target, input, ms) => {
    const from = live.deliveries.length;
    const started = await E(target).startTurn(
      harden({ text: input }),
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
      `turn "${input}": end`,
      10,
    );
    if (at.event.type === 'abort')
      throw Error(`turn ${input} failed: ${at.event.reason}`);
    return { turn: started, turnId, end: at.event, from };
  };
  /** @type {Map<number, number>} turn number -> turn.start ms */
  const startByTurn = new Map();
  /** @type {unknown} the last turn's id */
  let lastTurnId;
  /**
   * @param {any} target the session (reopened after each restart)
   * @param {number} n turn number (1-based)
   * @param {number} [ms] how long to wait for its end
   */
  const turn = async (target, n, ms = 120_000) => {
    const r = composerTurn(n)
      ? await runTurn(slice, target, live, `c${n}`, ms)
      : await directTurn(target, `c${n}`, ms);
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
  };
  /**
   * @param {string} metric
   * @param {number} from first turn number
   * @param {number} to last turn number
   */
  const startRow = async (metric, from, to) => {
    const samples = [...startByTurn]
      .filter(([n]) => n >= from && n <= to)
      .map(([, v]) => v);
    if (samples.length)
      await stats(metric, samples, {
        budget: { median: 350 },
        extra: { turns: `${from}..${to}` },
      });
  };
  /**
   * @param {any} target
   * @param {string} metric
   */
  const pageRow = async (target, metric) => {
    const page = await E(target).getHistoryPage();
    /** @type {number[]} */
    const pageMs = [];
    const b = await state.counters();
    for (let i = 0; i < 30; i += 1) {
      const t = performance.now();
      await E(target).getHistoryPage();
      pageMs.push(performance.now() - t);
    }
    const a = await state.counters();
    await stats(metric, pageMs, {
      budget: { median: 300 },
      before: b,
      after: a,
      ops: 30,
      extra: { turns: page.turns.length, sessionTurns: startByTurn.size },
    });
  };

  const tGrow = performance.now();
  let tHundred = tGrow;
  /** @type {any} */
  let lastStatus;
  /** @type {Record<string, number> | undefined} */
  let lastHub;
  for (let n = 1; n <= 50; n += 1) await turn(found, n);
  await startRow('crank.turn.start.early', 4, 50);
  await pageRow(found, 'crank.history.page');

  // ---- the session vat at 50 turns
  await live.stop();
  label = await busySessionLabel();
  await state.restart('crank50');
  const at50 = vatImage(state.root, label);
  emit({
    metric: 'crank.heap',
    turns: 50,
    heap: at50 && { ...at50, file: undefined },
    ...(await runIdentity()),
    crankBudget,
    loadAvg: loadAvg(),
  });
  if (at50)
    await workerRows({
      name: 'session50',
      scratch,
      profile: runtime.profile,
      bootPaths: runtime.bootPaths,
      limits: runtime.limits,
      image: at50.file,
    });
  await slice.refresh();
  found = await E(slice.factory).findSession(key);
  live = await slice.subscribe(found);
  /**
   * A clean restart: the session vat's heap and worker rows at `n` turns,
   * then the next turn's context rebuild (its round 0 `prepare()` after the
   * restart; that turn's `turn.start` is left out of the windows).
   * @param {number} n
   */
  const point = async n => {
    await startRow(`crank.turn.start.at${n}`, Math.max(4, n - 49), n);
    await pageRow(found, `crank.history.page.at${n}`);
    await live.stop();
    label = await busySessionLabel();
    const restarted = await state.restart(`crank${n}`);
    const image = vatImage(state.root, label);
    emit({
      metric: 'crank.heap',
      turns: n,
      heap: image && { ...image, file: undefined },
      ...(await runIdentity()),
      crankBudget,
      loadAvg: loadAvg(),
    });
    if (image)
      await workerRows({
        name: `session${n}`,
        scratch,
        profile: runtime.profile,
        bootPaths: runtime.bootPaths,
        limits: runtime.limits,
        image: image.file,
      });
    await slice.refresh();
    found = await E(slice.factory).findSession(key);
    live = await slice.subscribe(found);
    const b = await state.counters();
    const rebuiltAt = performance.now();
    // The first turn after a restart rebuilds the context cache: its page
    // cranks are linear in the session's length (over 120 s at 4,000 turns).
    await turn(found, n + 1, REBUILD_WAIT_MS);
    const turnMs = performance.now() - rebuiltAt;
    const a = await state.counters();
    await rebuildRow(`crank.context.rebuild.at${n}`, n + 1, {
      serveMs: round1(restarted.serveMs),
      turnMs: round1(turnMs),
      deliveriesInTurn: a.delivery.count - b.delivery.count,
    });
  };
  /**
   * The context rebuild of the turn just run, the first after a restart.
   * @param {string} metric
   * @param {number} n its turn number
   * @param {Record<string, unknown>} extra
   */
  const rebuildRow = async (metric, n, extra) => {
    startByTurn.delete(n);
    const line = made
      .log()
      .find(
        (/** @type {any} */ l) =>
          l.kind === 'context' && l.turnId === lastTurnId && l.round === 0,
      );
    if (line)
      await single(metric, Number(line.ms), {
        budget: { value: 5000 },
        extra: { turns: n, timing: line.timing, ...extra },
      });
  };
  for (let n = 51; n <= TURNS; n += 1) {
    // Turn n ran inside point(n - 1).
    if (!POINTS.includes(n - 1)) await turn(found, n);
    if (n === 51) await rebuildRow('crank.context.rebuild.at50', n, {});
    if (POINTS.includes(n)) await point(n);
    if (n % 100 === 0) {
      const now = performance.now();
      const status = await state.client.call('status');
      // Where the 100 turns' time went: engine timings (deliveries,
      // snapshots, wakes) and the hub's own synchronous time and persists,
      // as deltas since the last row (a restart in between resets the hub's
      // process-local counters: then the row has no hub delta).
      const hubNow = hubTotals(status.hub);
      emit({
        metric: 'crank.grow',
        turns: n,
        msPer100: round1(now - tHundred),
        engine: delta(lastStatus?.timings ?? {}, status.timings),
        hub:
          lastHub && hubNow.ms >= lastHub.ms
            ? Object.fromEntries(
                Object.entries(hubNow).map(([k, v]) => [
                  k,
                  round1(v - (lastHub?.[k] ?? 0)),
                ]),
              )
            : undefined,
        loadAvg: loadAvg(),
      });
      lastStatus = status;
      lastHub = hubNow;
      tHundred = now;
    }
  }
  const growMs = performance.now() - tGrow;
  if (TURNS >= 500) await startRow('crank.turn.start.mid', 450, 500);
  await startRow('crank.turn.start.late', Math.max(51, TURNS - 49), TURNS);
  await pageRow(found, 'crank.history.page.late');

  // ---- the session vat at TURNS turns, and the context rebuild
  await live.stop();
  label = await busySessionLabel();
  const { serveMs } = await state.restart('crank-late');
  const late = vatImage(state.root, label);
  emit({
    metric: 'crank.heap',
    turns: TURNS,
    heap: late && { ...late, file: undefined },
    ...(await runIdentity()),
    crankBudget,
    loadAvg: loadAvg(),
  });
  if (late)
    await workerRows({
      name: `session${TURNS}`,
      scratch,
      profile: runtime.profile,
      bootPaths: runtime.bootPaths,
      limits: runtime.limits,
      image: late.file,
    });
  await slice.refresh();
  found = await E(slice.factory).findSession(key);
  live = await slice.subscribe(found);
  before = await state.counters();
  const r = await runTurn(slice, found, live, 'after restart', REBUILD_WAIT_MS);
  after = await state.counters();
  const line = await waitFor(
    () =>
      made
        .log()
        .find(
          (/** @type {any} */ l) =>
            l.kind === 'context' && l.turnId === r.turnId && l.round === 0,
        ),
    10_000,
    'the context line',
  );
  await single('crank.context.rebuild', Number(line.ms), {
    budget: { value: 5000 },
    extra: {
      turns: TURNS + 1,
      timing: line.timing,
      status: r.end.status,
      serveMs: round1(serveMs),
      growMs: round1(growMs),
      deliveriesInTurn: after.delivery.count - before.delivery.count,
    },
  });
  await live.stop();
});
