// @ts-check
/**
 * Node benchmark of the record archive's adapter side (M2 W2.8; D-M2-1;
 * designs/m2-interfaces.md 4.7-4.9, 4.13) at 1,000, 5,000 and 30,000
 * turns. A fake session vat (test/adapter/_m2-archive-vat.js: the vat's
 * side of the protocol, real limits: 128 kept turns, 32 per segment) grows
 * the session; every RoundRequest goes through the real context cache (so
 * the mirror is fed and acknowledgments happen as in a daemon) and every
 * settle seals when due through the real ArchivePort; staged fields are
 * real fsynced blob files over a fake manager sink. No vat, no Ironhorse
 * workload: no run lock. Rows (JSON lines, `perf/_harness.mjs` `emit`):
 *
 * - `archive.grow`: wall time per turn, early and late (adapter work per
 *   turn: prepare, mirror, seal, acknowledgment), and seal cost.
 * - `context.rebuild.adapter`: `prepare()` of the next round 0 on a fresh
 *   incarnation (validation, `context.jsonl`, its blob files, the mirror,
 *   one gap page, projection). `vatEstimateMs` adds what a daemon pays and
 *   this bench does not: a page crank per page (95 ms floor + 3 ms per
 *   record marshalled, J-0370, J-9387) and a manager crank per resolve
 *   batch (75 ms). Target 5 s end to end.
 * - `history.page.adapter`: a sealed page (`h<n>` at the newest sealed
 *   turn and deep at `h100`) on a fresh incarnation (cold: its first call
 *   validates after one vat newest-page crank, estimated 245 ms) and warm;
 *   target 300 ms end to end.
 * - `history.turnContent.adapter`: one archived turn's full records.
 * - `archive.disk`: bytes of segments, `context.jsonl`, mirror, manifest
 *   and blob files.
 *
 *   node test/adapter/m2-archive.bench.mjs
 *   ARCHIVE_TURNS=1000,5000,30000 ARCHIVE_SAMPLES=3 node ...
 */
import '../../scripts/_init.mjs';

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const { installGuestPrelude } = await import('../../scripts/guest-prelude.js');
installGuestPrelude();

const { stats, single, emit, runIdentity, loadAvg } =
  await import('../../perf/_harness.mjs');
const { makeFakeVat } = await import('./_m2-archive-vat.js');
const { makeFakeSink, makeIncarnation, makeStateDir } =
  await import('./_m2-archive.js');

/* eslint-disable import/no-relative-packages */
const { messageBytes } = await import('../../guest/lib/bounded.js');
/* eslint-enable import/no-relative-packages */

const { E } = /** @type {any} */ (globalThis);

const TURNS = (process.env.ARCHIVE_TURNS ?? '1000,5000,30000')
  .split(',')
  .map(Number);
const SAMPLES = Number(process.env.ARCHIVE_SAMPLES ?? 3);
/** A session page crank: floor plus marshalling per record (J-0370, J-9387). */
const PAGE_FLOOR_MS = 95;
const PAGE_RECORD_MS = 3;
/** A manager crank answering a batch of 64 resolves. */
const MANAGER_CRANK_MS = 75;
/** A session crank answering its newest history page (m2-interfaces 4.13). */
const VAT_PAGE_MS = 245;

/** @param {string} dir */
const bytesIn = dir => {
  /** @type {Record<string, number>} */
  const out = {};
  for (const name of readdirSync(dir)) {
    const kind = name.startsWith('seg-')
      ? 'segments'
      : name.replace(/\.(jsonl|json)$/, '');
    out[kind] = (out[kind] ?? 0) + statSync(path.join(dir, name)).size;
  }
  return out;
};

/** @param {string} dir */
const dirBytes = dir => {
  let total = 0;
  for (const name of readdirSync(dir)) {
    total += statSync(path.join(dir, name)).size;
  }
  return total;
};

/** @param {number} n */
const round1 = n => Math.round(n * 10) / 10;

/** @param {number} turns */
const measure = async turns => {
  const dirs = await makeStateDir('w28b');
  try {
    const { sink, keyOf, blobCounts } = makeFakeSink();
    const inc = makeIncarnation(dirs, sink);
    const vat = makeFakeVat({
      seed: turns,
      store: inc.blobs,
      stagedChance: 0.05,
      textUnits: 300,
      fallbackChance: 0,
    });
    const key = keyOf(vat.session);
    const port = inc.archive.portFor({ session: vat.session, key });
    /** @type {number[]} */
    const turnMs = [];
    /** @type {number[]} */
    const sealMs = [];
    /** @type {number[]} */
    const prepareMs = [];
    const grown = performance.now();
    for (let n = 1; n <= turns; n += 1) {
      const t0 = performance.now();
      // eslint-disable-next-line no-await-in-loop
      await vat.turn(async (/** @type {any} */ req) => {
        const p0 = performance.now();
        await inc.cache.prepare(vat.session, req, { key });
        prepareMs.push(performance.now() - p0);
      });
      const s0 = performance.now();
      // eslint-disable-next-line no-await-in-loop
      const answer = await vat.maybeSeal(port);
      if (answer !== undefined) sealMs.push(performance.now() - s0);
      turnMs.push(performance.now() - t0);
    }
    const growSeconds = (performance.now() - grown) / 1000;
    const window = Math.min(200, Math.floor(turns / 5));
    const early = turnMs.slice(0, window);
    const late = turnMs.slice(-window);
    const median = (/** @type {number[]} */ xs) =>
      [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    await single('archive.grow', growSeconds * 1000, {
      extra: {
        turns,
        records: vat.all.length,
        segments: vat.entries.length,
        sealedTurns: vat.sealedTurns(),
        keptRecords: vat.kept().length,
        turnMsEarlyMedian: round1(median(early)),
        turnMsLateMedian: round1(median(late)),
        prepareMsEarlyMedian: round1(median(prepareMs.slice(0, window))),
        prepareMsLateMedian: round1(median(prepareMs.slice(-window))),
        sealMsMedian: round1(median(sealMs)),
        sealMsMax: round1(Math.max(...sealMs)),
        stagedBlobs: inc.blobs.stats().staged,
        cache: inc.cache.stats(),
        archive: inc.archive.stats(),
      },
    });
    // Let the mirror's queued writes land.
    await inc.archive.tail(vat.session, key, { from: 0, until: 0 });

    // context.rebuild: a fresh incarnation per sample.
    /** @type {number[]} */
    const rebuild = [];
    /** @type {any} */
    let detail;
    for (let i = 0; i < SAMPLES; i += 1) {
      const fresh = makeIncarnation(dirs, sink);
      const pagesBefore = vat.counts.pages;
      const resolvesBefore = blobCounts.resolves;
      const req = vat.request(`t-r${i}`, 0);
      const t0 = performance.now();
      // eslint-disable-next-line no-await-in-loop
      const projection = await fresh.cache.prepare(vat.session, req, { key });
      const ms = performance.now() - t0;
      rebuild.push(ms);
      const cacheStats = fresh.cache.stats();
      const pages = vat.counts.pages - pagesBefore;
      const resolves = blobCounts.resolves - resolvesBefore;
      detail = {
        transcriptRecords: projection.transcript.length,
        timing: Object.fromEntries(
          Object.entries(projection.timing ?? {}).map(([k, v]) => [
            k,
            round1(Number(v)),
          ]),
        ),
        pages,
        pagedRecords: cacheStats.pagedRecords,
        resolveCalls: resolves,
        mirrorTails: cacheStats.mirrorTails,
        vatEstimateMs: Math.round(
          pages * PAGE_FLOOR_MS +
            cacheStats.pagedRecords * PAGE_RECORD_MS +
            resolves * MANAGER_CRANK_MS,
        ),
      };
    }
    await stats('context.rebuild.adapter', rebuild, {
      extra: {
        turns,
        ...detail,
        estimatedEndToEndMs: Math.round(
          Math.max(...rebuild) + detail.vatEstimateMs,
        ),
        targetMs: 5000,
      },
    });

    // history.page: sealed pages, cold (fresh incarnation) and warm.
    const newest = `h${vat.sealedTurns()}`;
    const deep = `h${Math.min(100, vat.sealedTurns())}`;
    /** @type {Record<string, number[]>} */
    const pageMs = { cold: [], warmNewest: [], warmDeep: [], content: [] };
    let turnsShown = 0;
    let pageBytes = 0;
    for (let i = 0; i < SAMPLES; i += 1) {
      const fresh = makeIncarnation(dirs, sink);
      let t0 = performance.now();
      // eslint-disable-next-line no-await-in-loop
      const first = await E(fresh.history).page(vat.session, newest);
      pageMs.cold.push(performance.now() - t0);
      turnsShown = first.turns.length;
      pageBytes = messageBytes(first);
      t0 = performance.now();
      // eslint-disable-next-line no-await-in-loop
      await E(fresh.history).page(vat.session, newest);
      pageMs.warmNewest.push(performance.now() - t0);
      t0 = performance.now();
      // eslint-disable-next-line no-await-in-loop
      await E(fresh.history).page(vat.session, deep);
      pageMs.warmDeep.push(performance.now() - t0);
      t0 = performance.now();
      // eslint-disable-next-line no-await-in-loop
      await E(fresh.history).turnContent(vat.session, 't50');
      pageMs.content.push(performance.now() - t0);
    }
    await stats('history.page.adapter.cold', pageMs.cold, {
      extra: {
        turns,
        cursor: newest,
        turnsShown,
        pageMessageBytes: pageBytes,
        note: 'includes validation and one vat newest-page call (in-process here)',
        estimatedEndToEndMs: Math.round(Math.max(...pageMs.cold) + VAT_PAGE_MS),
        targetMs: 300,
      },
    });
    await stats('history.page.adapter.warm', pageMs.warmNewest, {
      extra: { turns, cursor: newest, targetMs: 300 },
    });
    await stats('history.page.adapter.deep', pageMs.warmDeep, {
      extra: { turns, cursor: deep, targetMs: 300 },
    });
    await stats('history.turnContent.adapter', pageMs.content, {
      extra: { turns, turnId: 't50' },
    });
    emit({
      metric: 'archive.disk',
      unit: 'bytes',
      turns,
      archive: bytesIn(path.join(dirs.archiveDir, key)),
      blobs: dirBytes(dirs.blobDir),
      ...(await runIdentity()),
      loadAvg: loadAvg(),
    });
  } finally {
    await dirs.cleanup();
  }
};

for (const turns of TURNS) {
  // eslint-disable-next-line no-await-in-loop
  await measure(turns);
}
