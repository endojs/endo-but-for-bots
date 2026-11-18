// @ts-check
/**
 * Perf check "journal" (milestones.md M2 perf rows `journal.snapshot`,
 * `session.heap` and `checkpoint.stall`; W2.9): sessions of 1,000, 10,000
 * and 30,000 turns built by `importState` (plain turns by default: the
 * import rate of tool turns makes 30,000 take over an hour, J-0485), each
 * then run for a window of turns with the long-session script
 * (`perf/_long-session.mjs`). Rows per point P:
 *
 * - `journal.snapshot.atP`: the engine's snapshot timing over the window
 *   (all vats; the busy session vat dominates). Budget: 500 ms at 1,000
 *   turns, 1 s at 10,000, recorded at 30,000 (`journal.snapshot.budget.atP`
 *   checks it).
 * - `journal.heap.atP` (`session.heap`): the session vat's slot capacity
 *   and snapshot file after a clean restart, against the ceiling.
 * - `journal.stall.atP` (`checkpoint.stall`): p99 of per-turn wall time over
 *   the window while the vat snapshots every SNAP_EVERY deliveries (default
 *   256; JOURNAL_SNAP_EVERY overrides it here). Budget p99 <= 1 s.
 * - and every row of `_long-session.mjs` under the `journal.` prefix.
 *
 *   cd packages/thixotrope-harness && node perf/journal.perf.mjs
 *
 * JOURNAL_POINTS (default 1000,10000,30000), JOURNAL_SHAPE (plain),
 * JOURNAL_WINDOW (100). About 1-1.5 hours.
 */
import { emit, runPerf } from './_harness.mjs';

if (process.env.JOURNAL_SNAP_EVERY)
  process.env.SNAP_EVERY = process.env.JOURNAL_SNAP_EVERY;

const { runLongSession } = await import('./_long-session.mjs');

const points = String(process.env.JOURNAL_POINTS ?? '1000,10000,30000')
  .split(',')
  .map(Number)
  .filter(n => Number.isSafeInteger(n) && n > 0)
  .sort((a, b) => a - b);

/** journal.snapshot budgets (milestones.md M2). @type {Record<number, number>} */
const SNAPSHOT_BUDGET = { 1000: 500, 10_000: 1000 };

await runPerf('journal', async ({ provision, root }) => {
  const summaries = await runLongSession({
    feature: 'journal',
    points,
    shape: process.env.JOURNAL_SHAPE === 'tool' ? 'tool' : 'plain',
    window: Number(process.env.JOURNAL_WINDOW ?? 100),
    walk: false,
    provision,
    root,
  });
  for (const s of summaries) {
    const budget = SNAPSHOT_BUDGET[s.point];
    const pass =
      budget === undefined || s.snapshotMsEach === null
        ? undefined
        : s.snapshotMsEach <= budget * 1.25;
    if (pass === false) process.exitCode = 1;
    emit({
      metric: `journal.snapshot.budget.at${s.point}`,
      unit: 'ms',
      msEach: s.snapshotMsEach,
      snapshotBytes: s.snapshotBytes ?? null,
      slots: s.slots ?? null,
      budget: budget === undefined ? 'recorded' : { value: budget },
      pass,
    });
  }
});
