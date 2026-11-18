// @ts-check
/**
 * Perf check "history" (milestones.md M2 perf table; W2.9): the long-session
 * table of J-9383 at 50, 200, 1,000 and 5,000 turns, each session built by
 * `importState` (`perf/_long-session.mjs` says how), with the record archive
 * (D-M2-1). Rows per point P: `history.turn.atP` (wall per turn, per
 * delivery, hub time), `history.turn.start.atP`, `history.snapshot.atP`,
 * `history.stall.atP`, `history.seal.atP`, `history.history.page.atP`
 * (newest page, vat) and `.archived` (`History`), `history.hub.row.atP`,
 * `history.archive.atP` (`archive.disk`), `history.walk.atP` (1,000 and
 * 5,000: newest turn back to turn 1, every turn once), `history.heap.atP`
 * (`session.heap`), `history.context.rebuild.atP` (with `sameContext`: the
 * provider got the same per-turn digests as before the restart).
 *
 * Then the flatness rows of acceptance 15 and the M2 table (`archive.flat.*`,
 * 1,000 and 5,000 against 200 turns, <= 1.25 x each): wall time per turn,
 * `turn.start` (also <= 350 ms), snapshot bytes and ms, slot capacity, hub
 * row characters and entries.
 *
 * The M1b version of this script (one 1,000-turn session grown by running
 * turns) is in git history before W2.9; `perf/archive.perf.mjs` (W2.5) grows
 * by running every turn.
 *
 *   cd packages/thixotrope-harness && node perf/history.perf.mjs
 *
 * HISTORY_POINTS (default 50,200,1000,5000), HISTORY_SHAPE (tool),
 * HISTORY_PAGE_N (30). About 25-30 minutes.
 */
import { runPerf } from './_harness.mjs';

const { runLongSession, flatnessRows } = await import('./_long-session.mjs');

const points = String(process.env.HISTORY_POINTS ?? '50,200,1000,5000')
  .split(',')
  .map(Number)
  .filter(n => Number.isSafeInteger(n) && n > 0)
  .sort((a, b) => a - b);

await runPerf('history', async ({ provision, root }) => {
  const summaries = await runLongSession({
    feature: 'history',
    points,
    shape: process.env.HISTORY_SHAPE === 'plain' ? 'plain' : 'tool',
    pageN: Number(process.env.HISTORY_PAGE_N ?? 30),
    walk: point => point >= 1000,
    provision,
    root,
  });
  for (const point of points.filter(p => p > 200))
    flatnessRows('archive.flat', summaries, 200, point);
});
