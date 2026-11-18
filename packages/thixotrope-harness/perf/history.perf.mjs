// @ts-check
/**
 * Perf check "history" (milestones.md M2 perf table; W2.9; fixed windows
 * M2-P1): acceptance 15's flatness, at 200, 1,000 and 5,000 turns. Each
 * point is a copy of a cached template of that many imported turns
 * (`perf/_long-template.mjs`; build them first, each in its own boxed step:
 * `node perf/_long-template.mjs history`), then a 60 s window of turns
 * (`perf/_long-session.mjs` says how), then a clean stop for the session
 * vat's heap. Rows per point P: `history.template.atP` (the template used),
 * `history.wake.atP`, `history.turn.atP` (per-turn median, p99, mean, turns
 * per minute, per delivery, hub time), `history.turn.start.atP`,
 * `history.snapshot.atP`, `history.stall.atP` (`checkpoint.stall`, with the
 * slowest turns and what they did), `history.seal.atP`,
 * `history.hub.row.atP`, `history.archive.atP` (`archive.disk`),
 * `history.heap.atP` (`session.heap`).
 *
 * Then the flatness rows of acceptance 15 and the M2 table (`archive.flat.*`,
 * 1,000 and 5,000 against 200 turns, <= 1.25 x each): wall time per turn,
 * `turn.start` (also <= 350 ms), snapshot bytes and ms, slot capacity, hub
 * row characters and entries.
 *
 * The rest of acceptance 15 at the same points (history pages, the walk back
 * to turn 1, the context rebuild after a restart) is
 * `perf/history.restart.perf.mjs`.
 *
 * The sessions are of `plain` turns (4 records) by default: a template of
 * 5,000 `tool` turns takes about 11 minutes to import (J-0485), over the
 * 10-minute box; HISTORY_SHAPE=tool builds and uses tool templates where
 * they fit.
 *
 *   cd packages/thixotrope-harness && node perf/history.perf.mjs
 *
 * HISTORY_POINTS (default 200,1000,5000; 200 is the flatness base),
 * HISTORY_SHAPE (plain), HISTORY_WINDOW_MS (60,000). About 6 minutes.
 */
import { runPerf } from './_harness.mjs';
import { windowMs } from './_window.mjs';

const { runLongSession, flatnessRows } = await import('./_long-session.mjs');
const { shapeOf, specsFor } = await import('./_long-template.mjs');

const points = specsFor('history').map(spec => spec.turns);

await runPerf('history', async ({ provision, root }) => {
  const summaries = await runLongSession({
    feature: 'history',
    points,
    shape: shapeOf(process.env.HISTORY_SHAPE),
    windowMs: windowMs('HISTORY_WINDOW_MS', 60_000),
    after: 'heap',
    provision,
    root,
  });
  for (const point of points.filter(p => p > 200))
    flatnessRows('archive.flat', summaries, 200, point);
});
