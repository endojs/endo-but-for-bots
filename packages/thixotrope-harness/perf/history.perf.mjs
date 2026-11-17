// @ts-check
/**
 * Perf check "history" (milestones.md M1b perf table, W1b.6), on the m1b
 * template:
 *
 * - `history.page`: `Session.getHistoryPage()` of a session whose newest
 *   page holds 32 turns of about 8 records each (a tool round per turn), in
 *   a vat, from the control client (client -> hub -> session vat -> back).
 *   Budget median 300 ms (Node, J-9153: 0.77 ms after the structural
 *   guard). `history.page.records` reports the page's shape.
 * - `context.rebuild`: a HISTORY_TURNS-turn session (default 1,000; every
 *   round has a native context, staged; a tool round per turn), restarted
 *   cleanly; the next turn's round 0 `prepare()` in the adapter (the
 *   scripted provider's `context` line `ms`: session pages, manager
 *   resolves, file reads, projection), before the request is sent. Budget
 *   5 s. Bulk fixtures should come from `importState` (M2); until then the
 *   turns are run, which takes most of this script's time.
 *
 *   cd packages/thixotrope-harness && node perf/history.perf.mjs
 *
 * HISTORY_PAGE_N (default 30) page reads; HISTORY_TURNS (1,000).
 */
/* eslint-disable no-await-in-loop -- phases run in order */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { limits as harnessLimits } from '../config/defaults.js';

import {
  crankBudget,
  emit,
  loadAvg,
  runIdentity,
  runPerf,
  single,
  stats,
} from './_harness.mjs';

// After the harness module (it locks down first).
const { installGuestPrelude } = await import('../scripts/guest-prelude.js');
installGuestPrelude();
const { E } = await import('@endo/far');
const { makeSlice, waitFor, round1 } =
  await import('../test/integration/_m1a-slice.js');
const { execTemplate } = await import('../test/integration/_m1b-exec.js');
const { runTurn } = await import('../test/integration/_m1b.js');

/** Slots per engine page (`rust/engine/ironhorse-vm/src/value.rs`). */
const SLOTS_PER_PAGE = 256;
/** The served daemon's slot ceiling (scripts/serve.mjs, config/defaults.js). */
const SLOT_CEILING = Number(
  process.env.THIXOTROPE_SLOT_CEILING ?? harnessLimits.slotCeiling,
);

/**
 * A vat's heap at its latest snapshot (M1b QC, J-0392): slot capacity, a
 * high-water mark that includes the largest crank since the vat was made
 * (the engine collects only between cranks), against the slot ceiling.
 * Read from the snapshot's SQLite file; `undefined` without one.
 * @param {string} root
 * @param {RegExp} label the worker's debug label
 */
const vatHeap = (root, label) => {
  const workers = path.join(root, 'workers');
  const metas = readdirSync(workers)
    .map(id => path.join(workers, id, 'meta.json'))
    .filter(metaPath => existsSync(metaPath))
    .map(metaPath => JSON.parse(readFileSync(metaPath, 'utf8')));
  const meta = metas.find(
    m => label.test(m.debugLabel ?? '') && m.snapshot?.ref !== undefined,
  );
  if (meta !== undefined) {
    const file = path.join(
      root,
      'heaps',
      'snapshots',
      `${meta.snapshot.ref}.sqlite`,
    );
    if (!existsSync(file)) return undefined;
    const pages = Number(
      execFileSync('sqlite3', [file, 'select count(*) from slot_pages'])
        .toString()
        .trim(),
    );
    const slots = pages * SLOTS_PER_PAGE;
    return {
      label: meta.debugLabel,
      cut: meta.snapshot.cut,
      slots,
      ofCeiling: Math.round((slots / SLOT_CEILING) * 1000) / 1000,
    };
  }
  return undefined;
};

const PAGE_N = Number(process.env.HISTORY_PAGE_N ?? 30);
const TURNS = Number(process.env.HISTORY_TURNS ?? 1000);

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};

const script = harden({
  turns: [
    {
      rounds: [
        {
          chunks: [{ text: 'a reply that calls a tool ' }],
          toolCalls: [{ name: 'echo', args: JSON.stringify({ text: 'ok' }) }],
          nativeContext: `native ${'n'.repeat(200)}`,
          usage,
        },
        {
          chunks: [{ text: 'and the closing text of the turn' }],
          nativeContext: `native after ${'m'.repeat(200)}`,
          usage,
        },
      ],
    },
  ],
});

await runPerf('history', async ({ provision }) => {
  const template = await execTemplate();
  const state = await provision({ template });
  const slice = await makeSlice(state);
  const made = await slice.makeBackend(script);
  const session = await slice.createSession(made.backend, 'history');
  const { key } = await E(session).getInfo();
  // The one session of this state: pooled (`spare session n`) or cold.
  const sessionLabel = /^(spare session \d+|session s\d+)$/;
  const busySessionLabel = async () => {
    const rows = await slice.workers();
    const row = rows.find(
      (/** @type {any} */ w) =>
        sessionLabel.test(w.debugLabel) && w.journalLength > 40,
    );
    return row ? RegExp(`^${row.debugLabel}$`) : sessionLabel;
  };
  let live = await slice.subscribe(session);

  // ---- 32 turns, then history.page
  const t0 = performance.now();
  for (let i = 0; i < 32; i += 1) await runTurn(slice, session, live, `h${i}`);
  const first32Ms = performance.now() - t0;
  const page = await E(session).getHistoryPage();
  const recordsPerTurn = page.turns.map(
    (/** @type {any} */ tp) => tp.records.length,
  );
  emit({
    metric: 'history.page.records',
    turns: page.turns.length,
    recordsPerTurn,
    bytes: Buffer.byteLength(JSON.stringify(page)),
    hasNext: page.next !== undefined,
    ...(await runIdentity()),
    crankBudget,
    loadAvg: loadAvg(),
  });
  /** @type {number[]} */
  const pageMs = [];
  const before = await state.counters();
  for (let i = 0; i < PAGE_N; i += 1) {
    const tp = performance.now();
    await E(session).getHistoryPage();
    pageMs.push(performance.now() - tp);
  }
  const after = await state.counters();
  await stats('history.page', pageMs, {
    budget: { median: 300 },
    before,
    after,
    ops: PAGE_N,
    extra: {
      turns: page.turns.length,
      what: 'getHistoryPage() round trip from the control client (hub, session vat crank, answer)',
    },
  });
  // A trivial session call for the round-trip floor.
  /** @type {number[]} */
  const floorMs = [];
  for (let i = 0; i < PAGE_N; i += 1) {
    const tp = performance.now();
    await E(session).getInfo();
    floorMs.push(performance.now() - tp);
  }
  await stats('history.page.floor', floorMs, {
    extra: { what: 'getInfo() round trip (the same path, a small answer)' },
  });

  // ---- context.rebuild: grow to TURNS turns, restart, next turn
  const tGrow = performance.now();
  for (let i = 32; i < TURNS; i += 1) {
    await runTurn(slice, session, live, `h${i}`, 120_000);
    if (i % 100 === 99)
      emit({
        metric: 'history.grow',
        turns: i + 1,
        ms: round1(performance.now() - tGrow),
        heap: vatHeap(state.root, await busySessionLabel()),
        loadAvg: loadAvg(),
      });
  }
  const growMs = performance.now() - tGrow;
  await live.stop();
  const label = await busySessionLabel();
  const { serveMs } = await state.restart('history');
  // A clean stop snapshots every awake vat: the heap after TURNS turns.
  emit({
    metric: 'history.heap',
    turns: TURNS,
    heap: vatHeap(state.root, label),
    ...(await runIdentity()),
    crankBudget,
    loadAvg: loadAvg(),
  });
  await slice.refresh();
  const found = await E(slice.factory).findSession(key);
  live = await slice.subscribe(found);
  const statusBefore = await state.client.call('status');
  /** @type {any} */
  let r;
  try {
    r = await runTurn(slice, found, live, 'after restart', 180_000);
  } catch (error) {
    // What the adapter and the vats did meanwhile, for the journal.
    const rows = (await slice.workers()).filter(
      (/** @type {any} */ w) => w.failure || /session/.test(w.debugLabel),
    );
    emit({
      metric: 'context.rebuild.diag',
      error: String(/** @type {Error} */ (error).message),
      logTail: made
        .log()
        .slice(-8)
        .map((/** @type {any} */ l) => ({
          kind: l.kind,
          turnId: l.turnId,
          round: l.round,
          ms: l.ms,
          error: l.error,
          timing: l.timing,
        })),
      rows: rows.map((/** @type {any} */ w) => ({
        label: w.debugLabel,
        failure: w.failure,
        awake: w.awake,
        journalLength: w.journalLength,
      })),
      events: live.events().slice(-6),
      ...(await runIdentity()),
      crankBudget,
      loadAvg: loadAvg(),
    });
    throw error;
  }
  const statusAfter = await state.client.call('status');
  const line = await waitFor(
    () =>
      made
        .log()
        .find(
          (/** @type {any} */ l) =>
            l.kind === 'context' && l.turnId === r.turnId && l.round === 0,
        ),
    10_000,
    'the context line',
  );
  await single('context.rebuild', Number(line.ms), {
    budget: { value: 5000 },
    extra: {
      turns: TURNS + 1,
      level: 'adapter prepare of the first round after a clean restart',
      timing: line.timing,
      transcriptRecords: line.records,
      transcriptBytes: line.bytes,
      status: r.end.status,
      serveMs: round1(serveMs),
      growMs: round1(growMs),
      first32Ms: round1(first32Ms),
      deliveriesInTurn:
        statusAfter.timings.delivery.count -
        statusBefore.timings.delivery.count,
    },
  });
  await live.stop();
});
