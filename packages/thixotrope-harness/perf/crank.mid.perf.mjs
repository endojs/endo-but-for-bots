// @ts-check
/**
 * Perf check "crank", middle part (perf/_crank.mjs): a session of
 * CRANK_MID_TURNS (default 500) turns built by `importState`, then one
 * CRANK_WINDOW_MS (default 60 s) window of Composer turns:
 * `crank.turn.start.mid` (it was turns 450-500 of a grown session) and
 * `crank.grow` at that length. With `perf/crank.late.perf.mjs` it gives the
 * slope per 500 turns.
 *
 *   cd packages/thixotrope-harness && node perf/crank.mid.perf.mjs
 *
 * About 3 minutes.
 */
import { runPerf } from './_harness.mjs';
import { crankAtLength } from './_crank.mjs';

const TURNS = Number(process.env.CRANK_MID_TURNS ?? 500);

await runPerf('crank', async ({ provision, root }) =>
  crankAtLength({ phase: 'mid', turns: TURNS, provision, root }),
);
