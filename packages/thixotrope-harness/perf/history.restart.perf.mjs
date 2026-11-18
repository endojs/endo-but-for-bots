// @ts-check
/**
 * Perf check "history", second part (acceptance 15 and the M2 rows
 * `history.page` and `context.rebuild` at length; fixed windows M2-P1): at
 * 200, 1,000 and 5,000 turns, each a copy of the same cached templates as
 * `perf/history.perf.mjs` (`node perf/_long-template.mjs history` builds
 * them, each in its own boxed step), with no turn window:
 *
 * - `history.history.page.atP`: the session vat's newest page, read back to
 *   back for HISTORY_PAGE_WINDOW_MS (15 s); `.archived`: an archived page
 *   through `History`, the same (median, p99, reads per second, samples);
 * - `history.walk.atP` (1,000 and 5,000): from the newest turn back to turn
 *   1, every turn exactly once;
 * - a reference turn, a clean restart, `history.heap.atP`, then
 *   `history.context.rebuild.atP` (budget 5 s) with `sameContext` (the
 *   provider got the same per-turn context digests as before the restart).
 *
 *   cd packages/thixotrope-harness && node perf/history.restart.perf.mjs
 *
 * HISTORY_POINTS (200,1000,5000), HISTORY_SHAPE (plain),
 * HISTORY_PAGE_WINDOW_MS (15,000). About 5 minutes.
 */
import { runPerf } from './_harness.mjs';
import { windowMs } from './_window.mjs';

const { runLongSession } = await import('./_long-session.mjs');
const { shapeOf, specsFor } = await import('./_long-template.mjs');

const points = specsFor('history').map(spec => spec.turns);

await runPerf('history', async ({ provision, root }) => {
  await runLongSession({
    feature: 'history',
    points,
    shape: shapeOf(process.env.HISTORY_SHAPE),
    windowMs: 0,
    pageWindowMs: windowMs('HISTORY_PAGE_WINDOW_MS', 15_000),
    walk: point => point >= 1000,
    after: 'rebuild',
    provision,
    root,
  });
});
