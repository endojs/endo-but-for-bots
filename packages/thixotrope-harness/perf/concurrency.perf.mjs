// @ts-check
/**
 * Perf check "concurrency" (milestones.md M1b perf table, `concurrency.10`;
 * W1b.6): 10 sessions streaming with tool rounds at once on one supervisor
 * thread, on the m1b template (default pool), idle sleep 1 h (vats stay
 * awake: steady state).
 *
 * Every turn: round 0 streams 20 deltas 50 ms apart and calls `echo` (100 ms
 * delay), round 1 streams 10 more; about 2 s of provider time per turn.
 *
 * - `concurrency.single.turnStart`: one session alone, turn start = the
 *   turn-start's `at` (the Composer stamp) to the provider's `request` log
 *   line, as `turn.start` (both adapter clock).
 * - `concurrency.10.turnStart`: the same per turn, with all 10 sessions
 *   submitting at once, round after round for CONC_WINDOW_MS. Budget: median <= 2 x the
 *   single median (computed; `budget.median` carries the number).
 * - `concurrency.10.crank`: per-delivery (crank) wall time in the
 *   supervisor during the concurrent phase, p95 from
 *   `status().deliveryHistogram` (bucket upper bound). Budget p95 <= 200 ms.
 * - `concurrency.10.rowPush`: a list subscriber's arrival of the session's
 *   settle row (activity back from `working`, reported in the settle crank)
 *   minus the arrival of the turn's `end` at its live subscriber (negative
 *   when the row came first). Budget median 500 ms (p95 recorded).
 * - `concurrency.10.gc`: GC frames per session per turn (`status().hub`
 *   gcOnly frames; recorded).
 * - `concurrency.10.turn`: submit to `end` per turn (recorded), against
 *   the single session's.
 *
 *   cd packages/thixotrope-harness && node perf/concurrency.perf.mjs
 *
 * CONC_SESSIONS (10), CONC_WINDOW_MS (60 s of concurrent rounds; it was
 * CONC_ROUNDS = 8), CONC_SINGLE_WINDOW_MS (30 s; it was CONC_SINGLE_N = 15).
 */
/* eslint-disable no-await-in-loop -- phases run in order */
import {
  crankBudget,
  emit,
  loadAvg,
  runIdentity,
  runPerf,
  stats,
  summarize,
} from './_harness.mjs';
import { runWindow, windowFields, windowMs } from './_window.mjs';

// After the harness module (it locks down first).
const { installGuestPrelude } = await import('../scripts/guest-prelude.js');
installGuestPrelude();
const { E } = await import('@endo/far');
const { collect, makeSlice } =
  await import('../test/integration/_m1a-slice.js');
const { execTemplate } = await import('../test/integration/_m1b-exec.js');
const { runTurn } = await import('../test/integration/_m1b.js');

const SESSIONS = Number(process.env.CONC_SESSIONS ?? 10);
/** Concurrent rounds back to back for this window (it was CONC_ROUNDS = 8). */
const CONC_WINDOW_MS = windowMs('CONC_WINDOW_MS', 60_000);
/** Single-session turns for this window (it was CONC_SINGLE_N = 15). */
const SINGLE_WINDOW_MS = windowMs('CONC_SINGLE_WINDOW_MS', 30_000);

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};

const script = harden({
  turns: [
    {
      rounds: [
        {
          chunks: Array.from({ length: 20 }, (_, i) => ({
            text: `streamed text ${i} of a reply with a tool call. `,
            delayMs: 50,
          })),
          toolCalls: [
            {
              name: 'echo',
              args: JSON.stringify({ text: 'tool', delayMs: 100 }),
            },
          ],
          usage,
        },
        {
          chunks: Array.from({ length: 10 }, (_, i) => ({
            text: `after the tool ${i}. `,
            delayMs: 50,
          })),
          usage,
        },
      ],
    },
  ],
});

/**
 * p-quantile of a histogram delta: the upper bound of the bucket holding it.
 * @param {number[]} bounds bucket upper bounds (ms); the last bucket is open
 * @param {number[]} counts
 * @param {number} p
 */
const histQuantile = (bounds, counts, p) => {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const want = Math.ceil(p * total);
  let seen = 0;
  for (let i = 0; i < counts.length; i += 1) {
    seen += counts[i];
    if (seen >= want) return i < bounds.length ? bounds[i] : Infinity;
  }
  return Infinity;
};

/**
 * Numeric fields of b minus a (one level of nesting).
 * @param {any} a
 * @param {any} b
 */
const numericDelta = (a, b) => {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, v] of Object.entries(b ?? {})) {
    if (typeof v === 'number') out[k] = +(v - (a?.[k] ?? 0)).toFixed(3);
    else if (v && typeof v === 'object' && !Array.isArray(v))
      out[k] = numericDelta(a?.[k], v);
  }
  return out;
};

await runPerf('concurrency', async ({ provision }) => {
  const template = await execTemplate();
  const state = await provision({ template });
  const slice = await makeSlice(state);
  const { harness } = slice;

  /** @type {{ session: any, live: any, key: string, made: any }[]} */
  const sessions = [];
  for (let i = 0; i < SESSIONS; i += 1) {
    const made = await slice.makeBackend(script, { label: `conc ${i}` });
    const session = await slice.createSession(made.backend, `conc ${i}`);
    const { key } = await E(session).getInfo();
    const live = await slice.subscribe(session);
    sessions.push({ session, live, key, made });
  }
  await E(harness).whenSettled();
  // One warm-up turn each (first turns open nothing, but warm the code).
  await Promise.all(
    sessions.map(s => runTurn(slice, s.session, s.live, 'warm', 120_000)),
  );

  /**
   * The turn start of a finished turn: turn-start `at` to the request line.
   * @param {(typeof sessions)[number]} s
   * @param {{ turnId: string, from: number }} r
   */
  const startOf = (s, r) => {
    const started = s.live.deliveries.find(
      (/** @type {any} */ d, /** @type {number} */ i) =>
        i >= r.from &&
        d.event.type === 'turn-start' &&
        d.event.turnId === r.turnId,
    );
    const request = s.made
      .log()
      .find(
        (/** @type {any} */ l) => l.kind === 'request' && l.turnId === r.turnId,
      );
    return Number(request?.at) - Number(started?.event.at);
  };

  // ---- single
  const single = sessions[0];
  /** @type {number[]} */
  const singleStart = [];
  /** @type {number[]} */
  const singleTurn = [];
  const hist0 = (await state.client.call('status')).deliveryHistogram;
  const singleWindow = await runWindow(
    async i => {
      const t0 = Date.now();
      const r = await runTurn(slice, single.session, single.live, `s${i}`);
      singleTurn.push(Date.now() - t0);
      singleStart.push(startOf(single, r));
    },
    { ms: SINGLE_WINDOW_MS },
  );
  const hist1 = (await state.client.call('status')).deliveryHistogram;
  const singleSummary = await stats(
    'concurrency.single.turnStart',
    singleStart,
    {
      extra: {
        from: 'turn-start at (Composer stamp)',
        to: 'request log line',
        ...windowFields(singleWindow),
        turnMedianMs: summarize(singleTurn).median,
      },
    },
  );

  // ---- concurrent
  const { rev } = await E(slice.factory).sessionListFeed();
  const list = collect(await E(slice.live).subscribeList(rev));
  const statusA = await state.client.call('status');
  /** @type {number[]} */
  const concStart = [];
  /** @type {number[]} */
  const concTurn = [];
  /** @type {number[]} */
  const rowPush = [];
  let rowMissing = 0;
  const concWindow = await runWindow(
    async round => {
      const results = await Promise.all(
        sessions.map(async s => {
          const t0 = Date.now();
          const r = await runTurn(
            slice,
            s.session,
            s.live,
            `c${round}`,
            180_000,
          );
          return { s, r, ms: Date.now() - t0 };
        }),
      );
      for (const { s, r, ms } of results) {
        concTurn.push(ms);
        concStart.push(startOf(s, r));
      }
      // Row pushes: the first row of each session after its end arrived.
      await new Promise(resolve => setTimeout(resolve, 1500));
      for (const { s, r } of results) {
        const end = s.live.deliveries.find(
          (/** @type {any} */ d) =>
            d.event.type === 'end' && d.event.turnId === r.turnId,
        );
        const started = s.live.deliveries.find(
          (/** @type {any} */ d) =>
            d.event.type === 'turn-start' && d.event.turnId === r.turnId,
        );
        // The settle row (activity back to passive) is reported in the
        // settle crank, as `end` is published: it may arrive first.
        const row = list.deliveries.find(
          d =>
            d.event.type === 'row' &&
            d.event.row.key === s.key &&
            d.arrivedAt >= started.arrivedAt &&
            d.event.row.activity !== 'working',
        );
        if (row) rowPush.push(row.arrivedAt - end.arrivedAt);
        else rowMissing += 1;
      }
    },
    { ms: CONC_WINDOW_MS, few: 3 },
  );
  const ROUNDS = concWindow.samples.length;
  const concFields = {
    ...windowFields(concWindow),
    samples: concStart.length,
    rounds: ROUNDS,
  };
  const statusB = await state.client.call('status');
  await list.stop();
  const singleMedian = singleSummary.median;
  await stats('concurrency.10.turnStart', concStart, {
    budget: { median: 2 * Number(singleMedian) },
    extra: {
      sessions: SESSIONS,
      ...concFields,
      singleMedianMs: singleMedian,
      ratioMedian: +(
        summarize(concStart).median / Number(singleMedian)
      ).toFixed(2),
      note: 'budget = 2 x the single median; the 1.25 slack applies on top',
    },
  });
  await stats('concurrency.10.turn', concTurn, {
    extra: {
      singleTurnMedianMs: summarize(singleTurn).median,
      ...concFields,
      what: 'submit to end at the live subscriber',
    },
  });
  if (rowPush.length)
    await stats('concurrency.10.rowPush', rowPush, {
      budget: { median: 500 },
      extra: { missing: rowMissing, ...concFields },
    });
  else
    emit({
      metric: 'concurrency.10.rowPush',
      pass: false,
      missing: rowMissing,
      ...(await runIdentity()),
      crankBudget,
      loadAvg: loadAvg(),
    });
  const turns = SESSIONS * ROUNDS;
  const hubDelta = numericDelta(statusA.hub, statusB.hub);
  emit({
    metric: 'concurrency.10.gc',
    hubDelta,
    gcDelta: numericDelta(statusA.gc, statusB.gc),
    turns,
    gcFramesPerSessionTurn:
      typeof hubDelta?.gcOnly?.frames === 'number'
        ? +(hubDelta.gcOnly.frames / turns).toFixed(2)
        : null,
    engine: numericDelta(statusA.timings, statusB.timings),
    ...(await runIdentity()),
    crankBudget,
    loadAvg: loadAvg(),
  });
  // Crank time distribution.
  const hA = statusA.deliveryHistogram;
  const hB = statusB.deliveryHistogram;
  if (hA && hB) {
    const counts = hB.counts.map(
      (/** @type {number} */ c, /** @type {number} */ i) => c - hA.counts[i],
    );
    const singleCounts = hist1.counts.map(
      (/** @type {number} */ c, /** @type {number} */ i) => c - hist0.counts[i],
    );
    const p95 = histQuantile(hB.bounds, counts, 0.95);
    const p99 = histQuantile(hB.bounds, counts, 0.99);
    const median = histQuantile(hB.bounds, counts, 0.5);
    const pass = p95 !== null && p95 <= 200 * 1.25;
    emit({
      metric: 'concurrency.10.crank',
      unit: 'ms',
      median,
      p95,
      p99,
      max: hB.maxMs,
      budget: { p95: 200 },
      pass,
      bounds: hB.bounds,
      counts,
      single: {
        p95: histQuantile(hB.bounds, singleCounts, 0.95),
        counts: singleCounts,
      },
      note: 'p values are bucket upper bounds; max is the process-lifetime max',
      ...(await runIdentity()),
      crankBudget,
      loadAvg: loadAvg(),
    });
    if (!pass) process.exitCode = 1;
  } else
    emit({
      metric: 'concurrency.10.crank',
      pass: null,
      measured: false,
      why: 'status() has no deliveryHistogram',
    });
  for (const s of sessions) await s.live.stop();
});
