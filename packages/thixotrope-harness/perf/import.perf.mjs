// @ts-check
/**
 * Import rate (M2 W2.7): how fast `scripts/export.mjs` `importState` builds
 * a long session, the fixture builder of acceptance 15 and the 5,000- and
 * 30,000-turn perf rows (m2-interfaces.md 2.5, 7.3; W2.9 uses it).
 *
 *   node perf/import.perf.mjs            # 5,000 turns
 *   IMPORT_TURNS=5000,30000 node perf/import.perf.mjs
 *   IMPORT_SHAPE=plain ...   # 4-record turns without a tool call
 *
 * Each length gets a fresh state from the m1a template (the real session
 * program, the scripted backend). The synthetic turns are the one-tool-call
 * turns of `test/integration/_m2-lifecycle.js` (8 records, about 1.6 KB of
 * record text a turn, nothing staged). The session seals as it imports;
 * the importer waits while more than `archiveKeepTurns + 3 *
 * archiveSegmentTurns` imported turns are unsealed.
 *
 * Rows: `import.rate` per 1,000 turns (turns/s and record chunks/s of that
 * stretch) and for the whole import (also the waits for seals); and
 * `import.walk`: every turn id read back through `History` (archived) and
 * the vat (kept), newest to oldest, with the time it took. No budget: the
 * milestone asks for the rate.
 */
/* eslint-disable no-await-in-loop -- lengths run in order */
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

const lengths = String(process.env.IMPORT_TURNS ?? '5000')
  .split(',')
  .map(Number)
  .filter(n => Number.isSafeInteger(n) && n > 0);

await runPerf('import', async ({ provision, root }) => {
  const template = await sliceTemplate();
  for (const [index, turns] of lengths.entries()) {
    // One state per length, beside runPerf's root (short socket paths).
    const stateRoot = `${root}${String.fromCharCode(97 + index)}`;
    const state = await provision({ template, root: stateRoot });
    const slice = await makeSlice(state);
    const made = await slice.makeBackend(harden(sliceScript));
    const file = path.join(
      path.dirname(root),
      `${path.basename(root)}-${turns}.jsonl`,
    );
    const written = await writeSyntheticExport(file, [
      {
        title: `imported ${turns}`,
        turns,
        backendLabel: 'Scripted',
        shape: process.env.IMPORT_SHAPE === 'plain' ? 'plain' : 'tool',
      },
    ]);
    const disk0 = await diskOf(state.root);
    let mark = { turns: 0, ms: 0, chunks: 0 };
    let chunks = 0;
    const identity = await runIdentity();
    const result = await importState({
      client: state.client,
      file,
      backends: [made.backend],
      onProgress: progress => {
        chunks += 1;
        if (progress.turns - mark.turns >= 1000 || progress.turns === turns) {
          const ms = progress.ms - mark.ms;
          emit({
            metric: 'import.rate.stretch',
            unit: 'turns/s',
            length: turns,
            fromTurn: mark.turns,
            toTurn: progress.turns,
            ms,
            turnsPerSecond: round1(((progress.turns - mark.turns) * 1000) / ms),
            chunks: chunks - mark.chunks,
            msPerChunk: round1(ms / Math.max(1, chunks - mark.chunks)),
            by: 'W2.7',
          });
          mark = { turns: progress.turns, ms: progress.ms, chunks };
        }
      },
    });
    const [session] = result.sessions;
    const disk1 = await diskOf(state.root);
    emit({
      metric: 'import.rate',
      unit: 'turns/s',
      length: turns,
      shape: process.env.IMPORT_SHAPE === 'plain' ? 'plain' : 'tool',
      turns: result.turns,
      records: result.records,
      chunks: result.chunks,
      ms: result.ms,
      turnsPerSecond: round1((result.turns * 1000) / result.ms),
      recordsPerSecond: round1((result.records * 1000) / result.ms),
      fileMBPerSecond: round1(written.bytes / 1e3 / result.ms),
      fileBytes: written.bytes,
      sealWaits: result.waits,
      sealWaitMs: result.waitMs,
      addedBytes: disk1.total - disk0.total,
      archiveBytes: disk1.archive - disk0.archive,
      by: 'W2.7',
      ...identity,
      loadAvg: loadAvg(),
    });
    // Read every turn id back, newest first, across the archive.
    const t0 = performance.now();
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
    emit({
      metric: 'import.walk',
      unit: 'ms',
      length: turns,
      turnsSeen: seen.size,
      pages,
      ms: round1(performance.now() - t0),
      archive: head.archive,
      pass: seen.size === turns,
      by: 'W2.7',
      loadAvg: loadAvg(),
    });
    await state.close();
    if (!process.env.KEEP_STATE) {
      await rm(stateRoot, { recursive: true, force: true });
      await rm(file, { force: true });
    }
  }
});
