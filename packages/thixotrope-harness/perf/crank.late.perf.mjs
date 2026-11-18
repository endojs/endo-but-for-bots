// @ts-check
/**
 * Perf check "crank", late part (perf/_crank.mjs): a session of CRANK_TURNS
 * (default 1,000) turns built by `importState`, then one CRANK_WINDOW_MS
 * (default 60 s) window of Composer turns: `crank.turn.start.late`,
 * `crank.grow`, `crank.history.page.late` (CRANK_PAGE_WINDOW_MS), a clean
 * restart with `crank.heap` and `crank.worker.session<n>[.alloc]`, and
 * `crank.context.rebuild` (the next turn's round 0 `prepare()`, budget 5 s).
 *
 *   cd packages/thixotrope-harness && node perf/crank.late.perf.mjs
 *
 * The long-session table of the old file (5,000 turns grown, points at 200,
 * 1,000 and 4,000; about 2.5 h, J-9383) does not fit the box: an import of
 * 4,000 tool turns alone takes about 9 minutes (7.3 turns/s, J-9404). This
 * file's 1,000 turns is the largest point kept; with
 * `perf/crank.mid.perf.mjs` (500) it gives a slope per 500 turns. A point is
 * re-run alone with `CRANK_TURNS=200 node perf/crank.late.perf.mjs`; the
 * session-length table to 5,000 turns is `perf/history.perf.mjs`. About 5-6
 * minutes.
 */
import { runPerf } from './_harness.mjs';
import { crankAtLength } from './_crank.mjs';

const TURNS = Number(process.env.CRANK_TURNS ?? 1000);

await runPerf('crank', async ({ provision, root }) =>
  crankAtLength({ phase: 'late', turns: TURNS, provision, root }),
);
