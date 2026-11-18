// @ts-check
/**
 * Import rate (M2 W2.7; fixed windows M2-P1): how fast `scripts/export.mjs`
 * `importState` builds a long session, the fixture builder of acceptance
 * 15 and the long-session templates (m2-interfaces.md 2.5, 7.3;
 * `perf/_long-template.mjs`).
 *
 * The W2.7 version imported whole sessions of 5,000 turns (652 s) and
 * 30,000 (39 minutes) and reported the rate per 1,000 turns. The rate is
 * flat with length (7.0-7.9 turns/s per 1,000 at 5,000 tool turns, 13.3 ->
 * 12.7 at 30,000 plain, J-0485), so this check measures it over a fixed
 * window instead:
 *
 * 1. `import.rate`: a fresh state from the m1a template (the real session
 *    program, the scripted backend); a synthetic export of IMPORT_TURNS
 *    (5,000) turns is imported for IMPORT_WINDOW_MS (60 s), then the import
 *    is abandoned (the state is discarded). Turns, records and chunks per
 *    second over the window; per chunk (one `importState` crank of up to
 *    `pageRecords` records, with the seal waits that follow it) median and
 *    p99 ms; `samples` = chunks. `import.rate.stretch`: the same per
 *    IMPORT_STRETCH_MS (15 s) of the window, to show it stays flat.
 * 2. `import.walk`: a complete import of IMPORT_WALK_TURNS (300) turns in
 *    the same state (its sealing included), then every turn id read back
 *    through `History` (archived) and the vat (kept), newest to oldest, with
 *    the time it took; `pass` when every turn came back once.
 *
 * The synthetic turns are the one-tool-call turns of
 * `test/integration/_m2-lifecycle.js` (8 records, about 1.6 KB of record
 * text a turn, nothing staged), or 4-record turns with IMPORT_SHAPE=plain.
 * The importer waits while more than `archiveKeepTurns + 3 *
 * archiveSegmentTurns` imported turns are unsealed. No budget: the
 * milestone asks for the rate.
 *
 *   node perf/import.perf.mjs     # about 2.5 minutes
 */
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { emit, loadAvg, runIdentity, runPerf } from './_harness.mjs';

// After the harness module (it locks down first).
const { installGuestPrelude } = await import('../scripts/guest-prelude.js');
installGuestPrelude();
const { E } = await import('@endo/far');
const { makeSlice, round1, sliceTemplate } =
  await import('../test/integration/_m1a-slice.js');
const { writeSyntheticExport, diskOf } =
  await import('../test/integration/_m2-lifecycle.js');
const { importState } = await import('../scripts/export.mjs');
const { sliceScript } = await import('../test/fixtures/scripts/m1a-slice.js');

const TURNS = Number(process.env.IMPORT_TURNS ?? 5000);
const WINDOW_MS = Number(process.env.IMPORT_WINDOW_MS ?? 60_000);
const STRETCH_MS = Number(process.env.IMPORT_STRETCH_MS ?? 15_000);
const WALK_TURNS = Number(process.env.IMPORT_WALK_TURNS ?? 300);
const SHAPE = process.env.IMPORT_SHAPE === 'plain' ? 'plain' : 'tool';

/**
 * @param {number[]} values
 * @param {number} q
 */
const quantile = (values, q) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return round1(
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))],
  );
};

/** Thrown from `onProgress` to end the import at the window's end. */
const windowEnd = harden(Error('the import window ended'));

await runPerf('import', async ({ provision, root }) => {
  const template = await sliceTemplate();
  const state = await provision({ template, root: `${root}a` });
  const slice = await makeSlice(state);
  const made = await slice.makeBackend(harden(sliceScript));
  const identity = await runIdentity();

  // ---- 1. the rate over a fixed window
  const file = path.join(
    path.dirname(root),
    `${path.basename(root)}-rate.jsonl`,
  );
  const written = await writeSyntheticExport(file, [
    {
      title: `imported ${TURNS}`,
      turns: TURNS,
      backendLabel: 'Scripted',
      shape: SHAPE,
    },
  ]);
  const disk0 = await diskOf(state.root);
  /** @type {{ ms: number, turns: number, records: number }[]} */
  const marks = [];
  const t0 = performance.now();
  await importState({
    client: state.client,
    file,
    backends: [made.backend],
    onProgress: progress => {
      marks.push({
        ms: performance.now() - t0,
        turns: progress.turns,
        records: progress.records,
      });
      if (performance.now() - t0 >= WINDOW_MS) throw windowEnd;
    },
  }).catch(error => {
    if (error !== windowEnd) throw error;
  });
  const disk1 = await diskOf(state.root);
  await rm(file, { force: true });
  const last = marks.at(-1) ?? { ms: 0, turns: 0, records: 0 };
  const chunkMs = marks.map((m, i) => m.ms - (i ? marks[i - 1].ms : 0));
  emit({
    metric: 'import.rate',
    unit: 'turns/s',
    length: TURNS,
    shape: SHAPE,
    window: WINDOW_MS,
    windowMs: round1(last.ms),
    samples: marks.length,
    turns: last.turns,
    records: last.records,
    turnsPerSecond: round1((last.turns * 1000) / last.ms),
    recordsPerSecond: round1((last.records * 1000) / last.ms),
    chunksPerSecond: round1((marks.length * 1000) / last.ms),
    chunkMsMedian: quantile(chunkMs, 0.5),
    chunkMsP99: quantile(chunkMs, 0.99),
    fileBytes: written.bytes,
    addedBytes: disk1.total - disk0.total,
    archiveBytes: disk1.archive - disk0.archive,
    what: 'importState of one session over a fixed window, then abandoned; a chunk is one importState crank plus the seal waits after it',
    by: 'M2-P1',
    ...identity,
    loadAvg: loadAvg(),
  });
  for (let from = 0; from < last.ms; from += STRETCH_MS) {
    const inside = marks.filter(m => m.ms > from && m.ms <= from + STRETCH_MS);
    const before = marks.filter(m => m.ms <= from).at(-1) ?? {
      ms: 0,
      turns: 0,
      records: 0,
    };
    const end = inside.at(-1);
    if (end !== undefined) {
      const ms = end.ms - before.ms;
      emit({
        metric: 'import.rate.stretch',
        unit: 'turns/s',
        length: TURNS,
        fromMs: Math.round(from),
        fromTurn: before.turns,
        toTurn: end.turns,
        ms: Math.round(ms),
        samples: inside.length,
        turnsPerSecond: round1(((end.turns - before.turns) * 1000) / ms),
        msPerChunk: round1(ms / inside.length),
        by: 'M2-P1',
      });
    }
  }

  // ---- 2. a complete small import, then the walk
  const walkFile = path.join(
    path.dirname(root),
    `${path.basename(root)}-walk.jsonl`,
  );
  await writeSyntheticExport(walkFile, [
    {
      title: `imported ${WALK_TURNS}`,
      turns: WALK_TURNS,
      backendLabel: 'Scripted',
      shape: SHAPE,
    },
  ]);
  const result = await importState({
    client: state.client,
    file: walkFile,
    backends: [made.backend],
  });
  await rm(walkFile, { force: true });
  const [session] = result.sessions;
  const w0 = performance.now();
  const history = await E(slice.admin).history();
  const seen = new Set();
  let pages = 0;
  /** @type {any} */
  let page = await E(history).page(session);
  for (;;) {
    pages += 1;
    for (const turn of page.turns) seen.add(turn.turnId);
    if (page.next === undefined) break;
    page = await E(history).page(session, page.next);
  }
  const head = await E(session).getHistoryPage();
  const walkMs = performance.now() - w0;
  emit({
    metric: 'import.walk',
    unit: 'ms',
    length: WALK_TURNS,
    importMs: result.ms,
    importTurnsPerSecond: round1((result.turns * 1000) / result.ms),
    sealWaits: result.waits,
    sealWaitMs: result.waitMs,
    turnsSeen: seen.size,
    pages,
    ms: round1(walkMs),
    msPerPage: round1(walkMs / pages),
    archive: head.archive,
    pass: seen.size === WALK_TURNS,
    by: 'M2-P1',
    loadAvg: loadAvg(),
  });
  if (seen.size !== WALK_TURNS) process.exitCode = 1;
  await state.close();
});
