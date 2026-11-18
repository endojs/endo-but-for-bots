// @ts-check
/**
 * Perf check "crank" (core candidates C-7 and C-21), early part: what one
 * delivery costs a vat, split into its parts, on a fresh boot and on a new
 * session vat, and the harness rows of a session's first window of turns.
 * The rows at 500 and 1,000 turns are `perf/crank.mid.perf.mjs` and
 * `perf/crank.late.perf.mjs`; the shared parts and the worker rows are
 * `perf/_crank.mjs`. Every point is a fixed window (designs/process.md
 * section 3); each file runs inside the 10-minute box.
 *
 * Rows (exec template, one session, scripted provider, a tool round per
 * turn as in `perf/history.perf.mjs`):
 * - `crank.worker.boot[.alloc]`: the worker run directly on a fresh boot.
 * - `crank.ping`: `getInfo()` round trips from the control client to a new
 *   session vat (client -> hub -> session vat crank -> back) for
 *   CRANK_PING_WINDOW_MS (default 20 s): the ping floor of a real vat.
 * - `crank.heap` (turns 0) and `crank.worker.session0[.alloc]`: the new
 *   session vat after the pings, from a clean restart.
 * - `crank.turn.start.early`: `turn.start` (Composer stamp to the scripted
 *   provider's request line, budget median 350 ms) over turns 4 to the end
 *   of a CRANK_WINDOW_MS (default 60 s) window of turns from the session's
 *   first; `crank.grow` at the window's end (wall per 100 turns from its
 *   rate, engine and hub deltas).
 * - `crank.history.page`: `getHistoryPage()` for CRANK_PAGE_WINDOW_MS
 *   (default 10 s), budget median 300 ms.
 * - At the window's end (about 50-90 turns; it was 50 turns by count): a
 *   clean restart, `crank.heap` and `crank.worker.session<n>`, and
 *   `crank.context.rebuild.at<n>` (the next turn's round 0 `prepare()`).
 *
 *   cd packages/thixotrope-harness && node perf/crank.perf.mjs
 *
 * CRANK_WINDOW_MS, CRANK_WORKER_WINDOW_MS (10 s per worker row),
 * CRANK_PING_WINDOW_MS, CRANK_PAGE_WINDOW_MS, CRANK_GC_POLICIES. About 4
 * minutes.
 */
import { performance } from 'node:perf_hooks';

import { emit, runPerf, stats } from './_harness.mjs';
import {
  identity,
  makeCrankSession,
  PING_WINDOW_MS,
  script,
  stateRuntime,
  vatImage,
  workerRows,
  workerScratch,
} from './_crank.mjs';
import { runWindow, windowFields } from './_window.mjs';

const { E } = await import('@endo/far');
const { makeSlice } = await import('../test/integration/_m1a-slice.js');
const { execTemplate } = await import('../test/integration/_m1b-exec.js');

await runPerf('crank', async ({ provision }) => {
  const scratch = workerScratch();
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

  // ---- ping floor through the hub, on a new session vat
  const before = await state.counters();
  const ping = await runWindow(async () => E(session).getInfo(), {
    ms: PING_WINDOW_MS,
  });
  const after = await state.counters();
  await stats('crank.ping', ping.samples, {
    before,
    after,
    ops: ping.samples.length,
    extra: {
      what: 'getInfo() round trip, control client to a new session vat',
      ...windowFields(ping),
    },
  });

  // ---- the new session vat (after the pings)
  const rows = await slice.workers();
  const busy = rows.find((/** @type {any} */ w) =>
    /^(spare session \d+|session s\d+)$/.test(w.debugLabel),
  );
  const label = busy
    ? RegExp(`^${busy.debugLabel}$`)
    : /^(spare session \d+|session s\d+)$/;
  const { key } = await E(session).getInfo();
  await state.restart('crank0');
  const at0 = vatImage(state.root, label);
  emit({
    metric: 'crank.heap',
    turns: 0,
    heap: at0 && { ...at0, file: undefined },
    ...(await identity()),
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
  const found = await E(slice.factory).findSession(key);

  // ---- the early window: turns from the first, turn.start from turn 4
  const crank = await makeCrankSession({
    state,
    slice,
    made,
    session: found,
    turns: 0,
    runtime,
  });
  const t0 = performance.now();
  await crank.window('crank.turn.start.early', {
    firstCounted: 4,
    extra: { built: 'grown' },
  });
  await crank.pageRow('crank.history.page');

  // ---- the session vat at the window's end, and the context rebuild
  await crank.restartAndRebuild({
    rebuildMetric: `crank.context.rebuild.at${crank.n}`,
    scratch,
    extra: { built: 'grown', growMs: Math.round(performance.now() - t0) },
  });
  await crank.stop();
});
