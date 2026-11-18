// @ts-check
/**
 * Perf check "journal" (milestones.md M2 perf rows `journal.snapshot`,
 * `session.heap` and `checkpoint.stall`; W2.9; fixed windows M2-P1). The
 * milestone names 1,000, 10,000 and 30,000 turns. A 10,000-turn template
 * takes about 14 minutes to import and a 30,000-turn one 42 (J-9410), over
 * the 10-minute box, so this check measures the largest points that fit,
 * 1,000 and 5,000 turns (plain turns; each a cached template built by
 * `node perf/_long-template.mjs journal`, its own boxed step), and states
 * the slope per 1,000 turns between them with the values it projects at
 * 10,000 and 30,000 (`journal.slope.*`, `projected: true`).
 *
 * Per point P (`perf/_long-session.mjs`): a 60 s window of turns with the
 * long-session script, then a clean stop:
 *
 * - `journal.snapshot.atP`: the engine's snapshot timing over the window
 *   (all vats; the busy session vat dominates); `journal.snapshot.budget.atP`
 *   checks it (500 ms at 1,000; at 5,000 recorded).
 * - `journal.heap.atP` (`session.heap`): the session vat's slot capacity and
 *   snapshot file after the stop, against the ceiling.
 * - `journal.stall.atP` (`checkpoint.stall`): p99 of per-turn wall time over
 *   the window while the vat snapshots every SNAP_EVERY deliveries (default
 *   256; JOURNAL_SNAP_EVERY overrides it here). Budget p99 <= 1 s. The row
 *   lists the slowest turns with their turn index and what they did.
 * - and the window rows of `_long-session.mjs` under the `journal.` prefix.
 *
 * Then `journal.slope.<measure>` (snapshot ms, snapshot bytes, slots, ms per
 * turn): per 1,000 turns from 1,000 to 5,000, and the projection at 10,000
 * and 30,000; `journal.snapshot.budget.at10000` checks the projection
 * against 1 s and says so.
 *
 *   cd packages/thixotrope-harness && node perf/journal.perf.mjs
 *
 * JOURNAL_POINTS (default 1000,5000), JOURNAL_SHAPE (plain),
 * JOURNAL_WINDOW_MS (60,000). About 4 minutes.
 */
import { emit, runPerf } from './_harness.mjs';

if (process.env.JOURNAL_SNAP_EVERY)
  process.env.SNAP_EVERY = process.env.JOURNAL_SNAP_EVERY;

const { runLongSession } = await import('./_long-session.mjs');
const { shapeOf, specsFor } = await import('./_long-template.mjs');

const points = specsFor('journal').map(spec => spec.turns);

/** journal.snapshot budgets (milestones.md M2). @type {Record<number, number>} */
const SNAPSHOT_BUDGET = { 1000: 500, 10_000: 1000 };
/** The milestone's points that no longer fit a box. */
const PROJECTED = [10_000, 30_000];

/**
 * @param {number} budget
 * @param {number | null | undefined} value
 */
const verdict = (budget, value) =>
  budget === undefined || value === null || value === undefined
    ? undefined
    : value <= budget * 1.25;

await runPerf('journal', async ({ provision, root }) => {
  const summaries = await runLongSession({
    feature: 'journal',
    points,
    shape: shapeOf(process.env.JOURNAL_SHAPE),
    windowMs: Number(process.env.JOURNAL_WINDOW_MS ?? 60_000),
    after: 'heap',
    provision,
    root,
  });
  for (const s of summaries) {
    const budget = SNAPSHOT_BUDGET[s.point];
    const pass = verdict(budget, s.snapshotMsEach);
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
  // The slope between the two largest points, and its projection.
  if (summaries.length < 2) return;
  const a = summaries[summaries.length - 2];
  const b = summaries[summaries.length - 1];
  const per1000 = (b.point - a.point) / 1000;
  /** @type {Record<string, number | null>} */
  const projectedSnapshot = {};
  for (const [name, field] of /** @type {const} */ ([
    ['snapshot', 'snapshotMsEach'],
    ['snapshotBytes', 'snapshotBytes'],
    ['slots', 'slots'],
    ['turn', 'msPerTurn'],
  ])) {
    const x = a[field];
    const y = b[field];
    const slope =
      typeof x === 'number' && typeof y === 'number'
        ? Math.round(((y - x) / per1000) * 1000) / 1000
        : null;
    /** @type {Record<string, number | null>} */
    const at = {};
    for (const target of PROJECTED)
      at[`at${target}`] =
        slope === null
          ? null
          : Math.round((y + (slope * (target - b.point)) / 1000) * 10) / 10;
    if (name === 'snapshot') Object.assign(projectedSnapshot, at);
    emit({
      metric: `journal.slope.${name}`,
      field,
      from: a.point,
      to: b.point,
      [`at${a.point}`]: x ?? null,
      [`at${b.point}`]: y ?? null,
      perThousandTurns: slope,
      ...at,
      projected: true,
      what: `the milestone's ${PROJECTED.join(' and ')}-turn points do not fit the 10-minute box (their imports take 14 and 42 minutes, J-9410): linear from the two largest measured points`,
    });
  }
  for (const target of PROJECTED) {
    const value = projectedSnapshot[`at${target}`];
    const budget = SNAPSHOT_BUDGET[target];
    const pass = verdict(budget, value);
    if (pass === false) process.exitCode = 1;
    emit({
      metric: `journal.snapshot.budget.at${target}`,
      unit: 'ms',
      msEach: value ?? null,
      projected: true,
      basis: `slope from ${a.point} and ${b.point} turns`,
      budget: budget === undefined ? 'recorded' : { value: budget },
      pass,
    });
  }
});
