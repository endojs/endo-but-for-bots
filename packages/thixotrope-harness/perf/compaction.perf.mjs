// @ts-check
/**
 * Perf check "compaction" (`designs/m8-interfaces.md` 13): the adapter's
 * plan, and compacting turns of the real session program on the scripted
 * backend (D-M8-13: the scripted summary takes no time of its own), from
 * the m1a state template.
 *
 *   cd packages/thixotrope-harness && node perf/compaction.perf.mjs
 *
 * Rows:
 * - `compaction.plan` (Node, no vat): `planCompaction` + `summaryRequest`
 *   over a 400-turn kept history of about 600 KB of transcript (built with
 *   the real record log); budget median 50 ms.
 * - `compaction.overhead`: per compacting turn, the scripted provider's
 *   `round-start` line (the adapter took crank X's `startRound`) to its
 *   `request` line (the real round about to stream), minus the same gap of
 *   a plain turn of the same session (median of a plain window): the
 *   prepare with plan input, the plan, the scripted summary, staging, the
 *   answered `compacted` (crank Y) and the re-prepare. Budget median
 *   300 ms.
 * - `compaction.record` (gate, a count): frames into the session vat per
 *   compacting turn minus per plain turn (journal length over each
 *   window), and the `compacted` deliveries counted in the journal per
 *   compaction; both exactly 1 (D-M8-1: crank Y is the only new delivery).
 * - `compaction.replyToRequest` (recorded, no budget): the `compaction`
 *   line (just before `compacted` is sent) to the `request` line: crank Y's
 *   round trip and the re-prepare. The contract's `compaction.prepareAfter`
 *   (the prepare alone, budget 15 ms, 0 vat pages) has no log line of its
 *   own in the scripted provider; this row bounds it from above.
 * - `compaction.rebuild`: a 300-turn imported session, compacted, then
 *   restart-and-turn cycles over the window: the first prepare after each
 *   restart (the scripted `context` line's `ms`, a rebuild that reconciles
 *   the archive manifest from the vat's base). Budget median 359 ms, M2's
 *   200-turn rebuild (`history.context.rebuild` 85-359 ms, J-9404, J-0461),
 *   so the 1.25 x slack is the contract's bound.
 *
 * Not here: `compaction.flat` (5,000 turns against 200 after one
 * compaction) needs the 5,000-turn long-session template, rebuilt after
 * every guest-bundle change (about 8 minutes in a shared slot,
 * process.md 3.2); see the journal.
 *
 * Windows: COMPACTION_WINDOW_MS (60 s) of compacting turns,
 * COMPACTION_PLAIN_WINDOW_MS (20 s) of plain turns, COMPACTION_PLAN_WINDOW_MS
 * (20 s) of plans, COMPACTION_REBUILD_WINDOW_MS (60 s) of restarts; all
 * scaled by PERF_WINDOW_SCALE. About 5 minutes.
 */
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { emit, runPerf, single, stats } from './_harness.mjs';
import { runWindow, windowFields, windowMs } from './_window.mjs';

// After the harness module (it locks down first).
const { installGuestPrelude } = await import('../scripts/guest-prelude.js');
installGuestPrelude();
const { E } = await import('@endo/far');
const { planCompaction, summaryRequest } =
  await import('../resources/agent-host/impl/providers/compaction.js');
const { askOf, makeTurnLog } =
  await import('../test/adapter/_compaction-records.js');
const { journalTail, makeSlice, sliceTemplate, waitFor } =
  await import('../test/integration/_m1a-slice.js');
const { writeSyntheticExport } =
  await import('../test/integration/_m2-lifecycle.js');
const { contentOf, filler, runTurn } =
  await import('../test/integration/_compaction.js');
const { importState } = await import('../scripts/export.mjs');
const { shortName, tmpRoot } = await import('../test/template/index.js');

const PLAN_WINDOW_MS = windowMs('COMPACTION_PLAN_WINDOW_MS', 20_000);
const WINDOW_MS = windowMs('COMPACTION_WINDOW_MS', 60_000);
const PLAIN_WINDOW_MS = windowMs('COMPACTION_PLAIN_WINDOW_MS', 20_000);
const REBUILD_WINDOW_MS = windowMs('COMPACTION_REBUILD_WINDOW_MS', 60_000);

/**
 * Journal frames by kind, per turn.
 * @param {string[]} kinds
 * @param {number} turns
 */
const perTurnKinds = (kinds, turns) => {
  /** @type {Record<string, number>} */
  const out = {};
  for (const kind of kinds) out[kind] = (out[kind] ?? 0) + 1;
  for (const kind of Object.keys(out))
    out[kind] = +(out[kind] / turns).toFixed(2);
  return out;
};

/** @param {number[]} values */
const median = values => {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const counts = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};
/** @param {number} usedTokens */
const usage = usedTokens => ({
  ...counts,
  context: { usedTokens, windowTokens: 100 },
});

/**
 * `compact`: every turn reads 80 of 100 and replies 6 KB, so each next
 * turn compacts the one before; `plain` turns reply the same 6 KB and read
 * 10 of 100 (the same frames but for the compaction).
 */
const script = harden({
  turns: [
    {
      input: 'plain',
      rounds: [{ chunks: [{ text: filler('plain', 6000) }], usage: usage(10) }],
    },
    {
      rounds: [{ chunks: [{ text: filler('reply', 6000) }], usage: usage(80) }],
    },
  ],
});

/** The plan over a 400-turn kept history (about 600 KB of transcript). */
const measurePlan = async () => {
  const log = makeTurnLog();
  const reply = filler('history', 1400);
  for (let i = 0; i < 400; i += 1) {
    log.turn({
      input: `request ${i}`,
      rounds: [
        { text: reply, calls: [{ result: `result ${i}` }] },
        { text: 'done' },
      ],
    });
  }
  const current = log.turn({ input: 'the current request', status: null });
  const input = log.planInput();
  const ask = askOf({
    askedAt: log.records.count(),
    startIndex: current.startIndex,
    usedTokens: 150_000,
    windowTokens: 200_000,
  });
  const system = 'system prompt '.repeat(300);
  let bytes = 0;
  const w = await runWindow(
    async () => {
      const plan = planCompaction({ input, ask, system, tools: [] });
      const request = summaryRequest(plan);
      if ('refuse' in request) throw Error(`refused: ${request.refuse}`);
      bytes = /** @type {any} */ (plan).originalBytes;
      // Nothing kept (runWindow keeps what the op answers).
    },
    { ms: PLAN_WINDOW_MS },
  );
  await stats('compaction.plan', w.samples, {
    budget: { median: 50 },
    extra: { ...windowFields(w), turns: 400, originalBytes: bytes },
  });
};

await runPerf('compaction', async ({ provision }) => {
  await measurePlan();
  const template = await sliceTemplate();
  // No snapshot inside the windows: the journal tail holds every frame.
  const run = await provision({ template, snapshotEveryDeliveries: 1_000_000 });
  const slice = await makeSlice(run);
  const label = `perf-compaction-${process.pid}`;
  const made = await slice.makeBackend(script, { label });
  const log = () => made.log().filter(l => l.label === label);
  const session = await slice.createSession(made.backend, 'perf');
  const { key } = await E(session).getInfo();
  let live = await slice.subscribe(session);
  const frames = async () =>
    Number((await slice.sessionWorker(key))?.journalLength ?? NaN);

  /**
   * The round-start to request gap of round 0 of one turn.
   * @param {string} turnId
   */
  const gapOf = turnId => {
    const lines = log().filter(l => l.turnId === turnId && l.round === 0);
    const start = lines.find(l => l.kind === 'round-start');
    const request = lines.find(l => l.kind === 'request');
    const compacted = lines.find(
      l => l.kind === 'compaction' && l.outcome === 'done',
    );
    return {
      gap: request.at - start.at,
      replyToRequest:
        compacted === undefined ? undefined : request.at - compacted.at,
      compacted: compacted !== undefined,
    };
  };

  // Plain turns: the baseline gap and frames per turn.
  let n = 0;
  const plainFrames0 = await frames();
  const plain = await runWindow(
    async () => {
      const { turnId } = await runTurn(slice, session, live, 'plain');
      return gapOf(turnId).gap;
    },
    { ms: PLAIN_WINDOW_MS, min: 3 },
  );
  const plainFrames = (await frames()) - plainFrames0;
  const plainWorker = await slice.sessionWorker(key);
  const plainKinds = journalTail(run.root, plainWorker.workerId, plainFrames);
  const plainPerTurn = plainFrames / plain.samples.length;
  const plainGap = median(plain.results);

  // Compacting turns: each compacts the 6 KB turn before it. The first
  // turn only reads over the threshold.
  await runTurn(slice, session, live, `compact ${(n += 1)}`);
  const compactFrames0 = await frames();
  /** @type {string[]} */
  const turnIds = [];
  const compacting = await runWindow(
    async () => {
      const { turnId } = await runTurn(
        slice,
        session,
        live,
        `compact ${(n += 1)}`,
      );
      turnIds.push(turnId);
      return gapOf(turnId);
    },
    { ms: WINDOW_MS, min: 3 },
  );
  const compactFrames = (await frames()) - compactFrames0;
  const done = compacting.results.filter(r => r.compacted);
  // The compacted deliveries the journal holds for these turns.
  const worker = await slice.sessionWorker(key);
  const tail = journalTail(run.root, worker.workerId, compactFrames);
  const compactedFrames = tail.filter(kind => kind === 'deliver compacted');
  await stats(
    'compaction.overhead',
    done.map(r => r.gap - plainGap),
    {
      budget: { median: 300 },
      extra: {
        ...windowFields(compacting),
        compactions: done.length,
        turns: compacting.samples.length,
        plainGapMs: plainGap,
        plainSamples: plain.samples.length,
      },
    },
  );
  const extraPerCompaction =
    compactFrames / compacting.samples.length - plainPerTurn;
  // The gate: `compacted` deliveries per compaction, compared exactly
  // (deliveriesPerOp has no slack); a window without a compaction fails.
  const perCompaction =
    done.length === 0 ? Infinity : compactedFrames.length / done.length;
  await single('compaction.record', perCompaction, {
    budget: { deliveriesPerOp: 1 },
    extra: {
      unit: 'deliveries',
      deliveries: { perOp: perCompaction },
      extraFramesPerCompactingTurn: +extraPerCompaction.toFixed(3),
      framesPerCompactingTurn: compactFrames / compacting.samples.length,
      framesPerPlainTurn: plainPerTurn,
      compactedDeliveries: compactedFrames.length,
      journalFramesRead: tail.length,
      compactions: done.length,
      framesByKindPerTurn: {
        compacting: perTurnKinds(tail, compacting.samples.length),
        plain: perTurnKinds(plainKinds, plain.samples.length),
      },
    },
  });
  await stats(
    'compaction.replyToRequest',
    done.map(r => /** @type {number} */ (r.replyToRequest)),
    { extra: { ...windowFields(compacting) } },
  );
  // Every compacting turn's records: one ask, one compaction.
  const last = await contentOf(
    (await E(session).getHistoryPage()).turns[0].turn,
  );
  emit({
    metric: 'compaction.records',
    lastTurnKinds: last.map((/** @type {any} */ r) => r.kind),
  });
  await live.stop();

  // ---- the rebuild of a compacted 300-turn session after a restart.
  const file = path.join(tmpRoot, `${shortName('x')}.jsonl`);
  try {
    await writeSyntheticExport(file, [
      { title: 'long', turns: 300, backendLabel: label, shape: 'plain' },
    ]);
    const imported = await importState({
      client: run.client,
      file,
      backends: [made.backend],
    });
    const [long] = imported.sessions;
    const longKey = (await E(long).getInfo()).key;
    live = await slice.subscribe(long);
    await runTurn(slice, long, live, `compact ${(n += 1)}`);
    const compactTurn = await runTurn(slice, long, live, `compact ${(n += 1)}`);
    const compactedLong = (await contentOf(compactTurn.turn)).some(
      (/** @type {any} */ r) => r.kind === 'compaction',
    );
    if (!compactedLong) throw Error('the imported session did not compact');
    // The high usage on the compacting turn requests another compaction.
    // Finish it before timing the first cold prepare in each restart.
    await runTurn(slice, long, live, 'plain');
    await live.stop();
    const rebuild = await runWindow(
      async () => {
        await run.restart('compaction.rebuild');
        await slice.refresh();
        const again = await E(slice.factory).findSession(longKey);
        const sub = await slice.subscribe(again);
        const { turnId } = await runTurn(slice, again, sub, 'plain');
        await sub.stop();
        const line = await waitFor(
          () =>
            log().find(
              l => l.kind === 'context' && l.turnId === turnId && l.round === 0,
            ),
          10_000,
          'the context line',
        );
        return { ms: line.ms, timing: line.timing };
      },
      { ms: REBUILD_WINDOW_MS, min: 3 },
    );
    await stats(
      'compaction.rebuild',
      rebuild.results.map(r => r.ms),
      {
        budget: { median: 359 },
        extra: {
          ...windowFields(rebuild),
          turns: 300,
          compacted: compactedLong,
          restartAndTurnMs: rebuild.samples,
          prepareTimings: rebuild.results.map(r => r.timing),
        },
      },
    );
  } finally {
    await rm(file, { force: true });
  }
});
