// @ts-check
/**
 * Perf check "archive" (milestones.md M2 perf rows `archive.flat.*`,
 * `context.rebuild` and `history.page` at length; D-M2-1; W2.5; fixed
 * windows M2-P1): the record archive in a session **grown by running
 * turns** (not imported), the reference against which the imported
 * templates of `perf/history.perf.mjs` are read (an imported session keeps a
 * larger heap high-water than a grown one, J-9405).
 *
 * The W2.5 version grew one session to 200, 1,000 and 5,000 turns by
 * running every turn (about 0.65 s each: an hour, J-0461). Running thousands
 * of turns is not allowed (process.md section 3), so this check grows to
 * 200 turns only (about 2.5 minutes of `startTurn` turns), and the 1,000-
 * and 5,000-turn rows come from imported templates in
 * `perf/history.perf.mjs` and `perf/history.restart.perf.mjs`.
 *
 * At the point (`perf/_long-session.mjs`, `grow`): `archive.grow.at200`
 * (turns per minute while growing), a 60 s window of turns (half through
 * `Session.startTurn`, half through the Composer): `archive.turn.at200`,
 * `archive.turn.start.at200`, `archive.snapshot.at200`, `archive.stall.at200`
 * (with the slowest turns), `archive.seal.at200`; then
 * `archive.history.page.at200` and `.archived` (15 s of back-to-back reads
 * each), `archive.hub.row.at200`, `archive.state.at200` (ArchiveState, kept
 * turns, archive bytes), a clean restart, `archive.heap.at200` and
 * `archive.context.rebuild.at200` (budget 5 s; `sameContext`).
 *
 *   cd packages/thixotrope-harness && node perf/archive.perf.mjs
 *
 * ARCHIVE_POINTS (comma-separated, ascending; default 200; each point grows
 * a fresh session, so keep their sum small), ARCHIVE_WINDOW_MS (60,000),
 * ARCHIVE_PAGE_WINDOW_MS (15,000). About 5 minutes.
 */
import { runPerf } from './_harness.mjs';
import { windowMs } from './_window.mjs';

const { runLongSession } = await import('./_long-session.mjs');

const points = String(process.env.ARCHIVE_POINTS ?? '200')
  .split(',')
  .map(Number)
  .filter(n => Number.isSafeInteger(n) && n > 0)
  .sort((a, b) => a - b);

await runPerf('archive', async ({ provision, root }) => {
  await runLongSession({
    feature: 'archive',
    points,
    shape: 'tool',
    grow: true,
    windowMs: windowMs('ARCHIVE_WINDOW_MS', 60_000),
    pageWindowMs: windowMs('ARCHIVE_PAGE_WINDOW_MS', 15_000),
    after: 'rebuild',
    archiveRow: 'state',
    provision,
    root,
  });
});
