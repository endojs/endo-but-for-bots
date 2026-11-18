// @ts-check
/**
 * The long-session table (J-9383 form) built with `importState` (M2 W2.9;
 * milestones.md M2 perf rows `archive.flat.*`, `context.rebuild` and
 * `history.page` at length, `session.heap`, `journal.snapshot`,
 * `checkpoint.stall`, `hub.row`, `archive.seal`, `archive.disk`; acceptance
 * 15). Used by `perf/history.perf.mjs` (50 / 200 / 1,000 / 5,000 turns) and
 * `perf/journal.perf.mjs` (1,000 / 10,000 / 30,000 turns).
 *
 * Per point P, in a fresh state from the exec template (as J-9383 and
 * J-0461):
 *
 * 1. A session of `P - W` synthetic turns (W = min(WINDOW, P)) is written
 *    by `writeSyntheticExport` (shape `tool`: 8 records a turn, one echo
 *    call; or `plain`: 4 records) and imported by `scripts/export.mjs`
 *    `importState`, which seals as a grown session does. The session is
 *    bound to a scripted backend running J-9383's long-session script (a
 *    tool round and a closing round per turn, two staged native contexts).
 * 2. Warm-up turns (`startTurn`) until the import's sealing backlog is
 *    drained (kept turns at most keep + segment), so the window measures a
 *    settled session.
 * 3. The window: W turns, the last `START_WINDOW` through the Composer
 *    (`turn.start` = the Composer's stamp to the provider's request line),
 *    the others with `Session.startTurn`. The scripted provider's `context`
 *    line carries no digests during the window (`<logPath>.nodigest`,
 *    m2-interfaces.md 4.13: the digest of the whole transcript per round is
 *    test machinery that grows with the session). Rows: `<f>.turn.at<P>`
 *    (wall per turn, per delivery, hub time), `<f>.turn.start.at<P>`,
 *    `<f>.snapshot.at<P>` (engine snapshot timing in the window, all vats),
 *    `<f>.stall.at<P>` (`checkpoint.stall`: p99 of per-turn wall time and
 *    the turns whose window held a snapshot), `<f>.seal.at<P>` (turns whose
 *    settle sealed a segment against the others).
 * 4. At P: `<f>.history.page.at<P>` (the vat's newest page, PAGE_N reads)
 *    and `.archived` (an archived page through `History`), the hub row,
 *    the archive state and disk (`archive.disk` bytes per archived turn),
 *    and, when `walk` is set, history from the newest turn back to turn 1
 *    with every turn exactly once (acceptance 15).
 * 5. One more Composer turn with digests on (the reference context), a
 *    clean restart, the session vat's slot capacity and snapshot file
 *    (`<f>.heap.at<P>`), then the next turn: `<f>.context.rebuild.at<P>`
 *    (its round 0 `prepare()`, budget 5 s) and whether the provider got the
 *    same per-turn context digests as before (acceptance 15).
 */
/* eslint-disable no-await-in-loop -- turns and phases run in order */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { limits as harnessLimits } from '../config/defaults.js';

import {
  crankBudget,
  delta,
  emit,
  loadAvg,
  runIdentity,
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
const { writeSyntheticExport } =
  await import('../test/integration/_m2-lifecycle.js');
const { walkHistory } = await import('../test/integration/_m2-w25.js');
const { importState } = await import('../scripts/export.mjs');
// eslint-disable-next-line import/no-relative-packages -- guest/ is its own private package
const { limits } = await import('../guest/lib/limits.js');

/** Slots per engine page (`rust/engine/ironhorse-vm/src/value.rs`). */
const SLOTS_PER_PAGE = 256;
const SLOT_CEILING = Number(
  process.env.THIXOTROPE_SLOT_CEILING ?? harnessLimits.slotCeiling,
);
/** How long the first turn after a restart may take. */
const REBUILD_WAIT_MS = 10 * 60_000;

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};

/** The script of `perf/crank.perf.mjs` (J-9383's long-session table). */
export const longSessionScript = harden({
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

/**
 * The workers of a state: id and meta (debug label, newest snapshot).
 * @param {string} root
 */
export const workerMetas = root => {
  const dir = path.join(root, 'workers');
  return readdirSync(dir)
    .map(id => ({ id, file: path.join(dir, id, 'meta.json') }))
    .filter(({ file }) => existsSync(file))
    .map(({ id, file }) => ({ id, ...JSON.parse(readFileSync(file, 'utf8')) }));
};

/**
 * A vat's heap at its newest snapshot: slot capacity and file bytes.
 * @param {string} root
 * @param {string} workerId
 */
export const vatImage = (root, workerId) => {
  const meta = workerMetas(root).find(m => m.id === workerId);
  if (meta?.snapshot?.ref === undefined) return undefined;
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
  return {
    label: meta.debugLabel,
    cut: meta.snapshot.cut,
    slots: pages * SLOTS_PER_PAGE,
    ofCeiling:
      Math.round(((pages * SLOTS_PER_PAGE) / SLOT_CEILING) * 1000) / 1000,
    snapshotBytes: statSync(file).size,
  };
};

/**
 * One hub session row as the log store holds it now.
 * @param {string} root
 * @param {string} key the vat's worker id
 */
export const hubRow = (root, key) => {
  const dir = existsSync(path.join(root, 'heaps', 'hub-image.json'))
    ? path.join(root, 'heaps')
    : root;
  const image = JSON.parse(
    readFileSync(path.join(dir, 'hub-image.json'), 'utf8'),
  );
  let row = image.state?.sessions?.[key];
  const logFile = path.join(dir, 'hub-log.jsonl');
  if (existsSync(logFile)) {
    for (const line of readFileSync(logFile, 'utf8').split('\n')) {
      if (line.includes(key)) {
        try {
          const entry = JSON.parse(line);
          if (entry.seq > (image.through ?? -1)) {
            if (entry.drop?.sessions?.includes?.(key)) row = undefined;
            if (entry.put?.sessions?.[key] !== undefined)
              row = entry.put.sessions[key];
          }
        } catch {
          // A torn last line.
        }
      }
    }
  }
  if (row === undefined) return undefined;
  return {
    chars: JSON.stringify(row).length,
    ourExports: Object.keys(row.ourExports ?? {}).length,
    answersOwed: Object.keys(row.answersOwed ?? {}).length,
  };
};

/**
 * Bytes of the archive directories by kind.
 * @param {string} root
 */
export const archiveBytes = root => {
  const base = path.join(root, 'agent-host', 'archive');
  /** @type {Record<string, number>} */
  const out = { segments: 0, context: 0, manifest: 0, mirror: 0, files: 0 };
  if (!existsSync(base)) return out;
  for (const key of readdirSync(base)) {
    for (const name of readdirSync(path.join(base, key))) {
      const { size } = statSync(path.join(base, key, name));
      out.files += 1;
      if (name.startsWith('seg-')) out.segments += size;
      else if (name.startsWith('context')) out.context += size;
      else if (name.startsWith('manifest')) out.manifest += size;
      else if (name.startsWith('mirror')) out.mirror += size;
    }
  }
  return out;
};

/** Segment files under the archive root. @param {string} root */
const segmentCount = root => {
  const base = path.join(root, 'agent-host', 'archive');
  if (!existsSync(base)) return 0;
  let n = 0;
  for (const key of readdirSync(base))
    for (const name of readdirSync(path.join(base, key)))
      if (name.startsWith('seg-') && !name.endsWith('.part')) n += 1;
  return n;
};

/**
 * The hub's process-local delivery counters summed.
 * @param {any} hub
 */
export const hubTotals = hub => {
  /** @type {Record<string, number>} */
  const out = {
    deliveries: 0,
    ms: 0,
    persists: 0,
    persistMs: 0,
    persistChars: 0,
  };
  for (const name of ['other', 'gcOnly', 'outside']) {
    const bucket = hub?.[name];
    if (bucket !== null && typeof bucket === 'object') {
      for (const key of Object.keys(out)) {
        const value = bucket[key];
        if (typeof value === 'number') out[key] += value;
      }
    }
  }
  return out;
};

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

/**
 * @param {object} options
 * @param {string} options.feature row prefix
 * @param {number[]} options.points session lengths, ascending
 * @param {'tool' | 'plain'} options.shape synthetic turn shape
 * @param {number} [options.window] turns in the per-turn window (100)
 * @param {number} [options.startWindow] Composer turns at its end (50)
 * @param {number} [options.pageN] page reads per point (30)
 * @param {boolean | ((point: number) => boolean)} [options.walk] walk
 *   history back to turn 1
 * @param {(o: any) => Promise<any>} options.provision runPerf's
 * @param {string} options.root runPerf's root
 */
export const runLongSession = async ({
  feature,
  points,
  shape,
  window = 100,
  startWindow = 50,
  pageN = 30,
  walk = false,
  provision,
  root,
}) => {
  const template = await execTemplate();
  /** @type {Record<string, any>[]} per point, for the flatness rows */
  const summaries = [];
  const identity = async () => ({
    ...(await runIdentity()),
    crankBudget,
    loadAvg: loadAvg(),
  });
  for (const [index, point] of points.entries()) {
    const stateRoot = `${root}${String.fromCharCode(97 + index)}`;
    const state = await provision({ template, root: stateRoot });
    const slice = await makeSlice(state);
    const made = await slice.makeBackend(longSessionScript, {
      label: 'Scripted',
    });
    const quiet = `${made.logPath}.nodigest`;
    const W = Math.min(window, point);
    const imported = point - W;
    /** @type {any} */
    let session;
    if (imported > 0) {
      const file = path.join(
        path.dirname(root),
        `${path.basename(root)}-${feature}-${point}.jsonl`,
      );
      const written = await writeSyntheticExport(file, [
        {
          title: `${feature} ${point}`,
          turns: imported,
          backendLabel: 'Scripted',
          shape,
        },
      ]);
      const result = await importState({
        client: state.client,
        file,
        backends: [made.backend],
      });
      rmSync(file, { force: true });
      [session] = result.sessions;
      emit({
        metric: `${feature}.import.at${point}`,
        unit: 'turns/s',
        turns: result.turns,
        records: result.records,
        fileBytes: written.bytes,
        ms: Math.round(result.ms),
        turnsPerSecond: round1((result.turns * 1000) / result.ms),
        sealWaits: result.waits,
        sealWaitMs: Math.round(result.waitMs),
        shape,
        ...(await identity()),
      });
    } else {
      session = await slice.createSession(made.backend, `${feature} ${point}`);
    }
    const { key } = await E(session).getInfo();
    let live = await slice.subscribe(session);
    let history = await E(slice.admin).history();

    /** @type {string | undefined} */
    let lastTurnId;
    let n = imported;
    /** A turn through `startTurn`, awaited through the live stream. */
    const directTurn = async (/** @type {number} */ ms = 120_000) => {
      n += 1;
      const from = live.deliveries.length;
      const started = await E(session).startTurn(
        harden({ text: `c${n}` }),
        Date.now(),
      );
      const { turnId } = await E(started).getStatus();
      const at = await waitFor(
        () =>
          live.deliveries.find(
            (/** @type {any} */ d, /** @type {number} */ i) =>
              i >= from &&
              (d.event.type === 'end' || d.event.type === 'abort') &&
              d.event.turnId === turnId,
          ),
        ms,
        `turn c${n}: end`,
        10,
      );
      if (at.event.type === 'abort')
        throw Error(`turn c${n} failed: ${at.event.reason}`);
      lastTurnId = turnId;
      return { turnId };
    };
    /** A turn through the Composer; its `turn.start`. */
    const composerTurn = async (/** @type {number} */ ms = 120_000) => {
      n += 1;
      const r = await runTurn(slice, session, live, `c${n}`, ms);
      if (r.end.status === 'failed')
        throw Error(`turn c${n} failed: ${r.end.reason}`);
      lastTurnId = r.turnId;
      const started = live.deliveries
        .slice(r.from)
        .find(
          (/** @type {any} */ d) =>
            d.event.type === 'turn-start' && d.event.turnId === r.turnId,
        );
      const request = made
        .log()
        .find(
          (/** @type {any} */ l) =>
            l.kind === 'request' && l.turnId === r.turnId && l.round === 0,
        );
      return started && request
        ? Number(request.at) - Number(started.event.at)
        : undefined;
    };
    const keptBound = limits.archiveKeepTurns + limits.archiveSegmentTurns;
    const archiveNow = async () => (await E(session).getHistoryPage()).archive;

    // 2. Warm-up: drain the import's sealing backlog.
    writeFileSync(quiet, '');
    let warmups = 0;
    for (;;) {
      const archive = await archiveNow();
      if (n - (archive?.sealedTurns ?? 0) <= keptBound || warmups >= 16) break;
      await directTurn();
      warmups += 1;
    }

    // 3. The window.
    const mark = {
      n,
      at: performance.now(),
      status: await state.client.call('status'),
    };
    /** @type {number[]} */
    const wall = [];
    /** @type {number[]} */
    const starts = [];
    /** @type {{ ms: number, sealed: boolean, snapshotted: boolean }[]} */
    const perTurn = [];
    let segments = segmentCount(state.root);
    let snapshotsSeen =
      (mark.status.timings?.snapshot ?? mark.status.timings?.snapshots)
        ?.count ?? 0;
    for (let i = 1; i <= W; i += 1) {
      const t0 = performance.now();
      if (i > W - startWindow) {
        const start = await composerTurn();
        if (start !== undefined) starts.push(start);
      } else {
        await directTurn();
      }
      const ms = performance.now() - t0;
      wall.push(ms);
      const nowSegments = segmentCount(state.root);
      // A snapshot count per turn would cost a status call; every 10th.
      let snapshotted = false;
      if (i % 10 === 0) {
        const st = await state.client.call('status');
        const count =
          (st.timings?.snapshot ?? st.timings?.snapshots)?.count ?? 0;
        snapshotted = count > snapshotsSeen;
        snapshotsSeen = count;
      }
      perTurn.push({ ms, sealed: nowSegments > segments, snapshotted });
      segments = nowSegments;
    }
    const now = performance.now();
    const status = await state.client.call('status');
    const engine = delta(mark.status.timings ?? {}, status.timings);
    const hubThen = hubTotals(mark.status.hub);
    const hubNow = hubTotals(status.hub);
    const deliveries = engine.delivery ?? { count: 0, ms: 0 };
    const snapshots = engine.snapshot ?? engine.snapshots;
    /** @type {Record<string, any>} */
    const summary = { point };
    summaries.push(summary);
    const turnRow = emit({
      metric: `${feature}.turn.at${point}`,
      unit: 'ms',
      turns: W,
      msPerTurn: round1((now - mark.at) / W),
      perDeliveryMs: deliveries.count
        ? round1(deliveries.ms / deliveries.count)
        : null,
      deliveriesPerTurn: round1(deliveries.count / W),
      hubMsPerTurn: round1((hubNow.ms - hubThen.ms) / W),
      hubCharsPerPersist:
        hubNow.persists > hubThen.persists
          ? Math.round(
              (hubNow.persistChars - hubThen.persistChars) /
                (hubNow.persists - hubThen.persists),
            )
          : null,
      imported,
      warmups,
      sessionTurns: n,
      engine,
      ...(await identity()),
    });
    summary.msPerTurn = turnRow.msPerTurn;
    summary.perDeliveryMs = turnRow.perDeliveryMs;
    summary.hubMsPerTurn = turnRow.hubMsPerTurn;
    summary.snapshotMsEach = snapshots?.count
      ? round1(snapshots.ms / snapshots.count)
      : null;
    emit({
      metric: `${feature}.snapshot.at${point}`,
      unit: 'ms',
      count: snapshots?.count ?? 0,
      msEach: snapshots?.count ? round1(snapshots.ms / snapshots.count) : null,
      what: 'engine snapshot timing over the window, all vats',
      sessionTurns: n,
      ...(await identity()),
    });
    // checkpoint.stall: turn latency while a busy session vat snapshots.
    await single(`${feature}.stall.at${point}`, quantile(wall, 0.99) ?? 0, {
      budget: { value: 1000 },
      extra: {
        what: 'p99 of per-turn wall time over the window (snapshots every SNAP_EVERY deliveries)',
        median: quantile(wall, 0.5),
        max: quantile(wall, 1),
        snapshots: snapshots?.count ?? 0,
        snapshottedTurnsMax: quantile(
          perTurn.filter(p => p.snapshotted).map(p => p.ms),
          1,
        ),
        sessionTurns: n,
      },
    });
    const sealedTurns = perTurn.filter(p => p.sealed).map(p => p.ms);
    const otherTurns = perTurn.filter(p => !p.sealed).map(p => p.ms);
    emit({
      metric: `${feature}.seal.at${point}`,
      unit: 'ms',
      seals: sealedTurns.length,
      sealTurnMedian: quantile(sealedTurns, 0.5),
      otherTurnMedian: quantile(otherTurns, 0.5),
      what: 'per-turn wall time of the turns whose settle sealed a segment, against the others',
      sessionTurns: n,
    });
    if (starts.length)
      summary.turnStart = (
        await stats(`${feature}.turn.start.at${point}`, starts, {
          budget: { median: 350 },
          extra: { turns: `${n - starts.length + 1}..${n}` },
        })
      ).median;

    // 4. History pages, hub row, archive.
    const newest = await E(session).getHistoryPage();
    const archive = newest.archive;
    /** @type {number[]} */
    const vatMs = [];
    /** @type {number[]} */
    const archivedMs = [];
    for (let i = 0; i < pageN; i += 1) {
      let at = performance.now();
      await E(session).getHistoryPage();
      vatMs.push(performance.now() - at);
      if (archive !== undefined) {
        at = performance.now();
        await E(history).page(session, `h${archive.sealedTurns}`);
        archivedMs.push(performance.now() - at);
      }
    }
    summary.historyPage = (
      await stats(`${feature}.history.page.at${point}`, vatMs, {
        budget: { median: 300 },
        extra: {
          turns: newest.turns.length,
          records: newest.turns.reduce(
            (/** @type {number} */ k, /** @type {any} */ p) =>
              k + p.records.length,
            0,
          ),
          sessionTurns: n,
        },
      })
    ).median;
    if (archivedMs.length)
      summary.archivedPage = (
        await stats(`${feature}.history.page.archived.at${point}`, archivedMs, {
          budget: { median: 300 },
          extra: { sessionTurns: n, cursor: `h${archive.sealedTurns}` },
        })
      ).median;
    // The session's worker: the busiest session vat (pooled or cold).
    const rows = await slice.workers();
    const busiest = rows
      .filter((/** @type {any} */ w) =>
        /^(spare session \d+|session s\d+)$/.test(w.debugLabel),
      )
      .sort(
        (/** @type {any} */ a, /** @type {any} */ b) =>
          b.journalLength - a.journalLength,
      )[0];
    const sessionWorker = workerMetas(state.root).find(
      m => m.debugLabel === busiest?.debugLabel,
    );
    const workerId = sessionWorker?.id;
    const row =
      workerId === undefined ? undefined : hubRow(state.root, workerId);
    summary.hubChars = row?.chars;
    summary.hubEntries = row?.ourExports;
    emit({
      metric: `${feature}.hub.row.at${point}`,
      row: row ?? null,
      worker: sessionWorker?.debugLabel ?? null,
      sessionTurns: n,
      ...(await identity()),
    });
    const disk = archiveBytes(state.root);
    const archivedTurns = archive?.sealedTurns ?? 0;
    emit({
      metric: `${feature}.archive.at${point}`,
      archive: archive ?? null,
      keptTurns: n - archivedTurns,
      disk,
      bytesPerArchivedTurn: archivedTurns
        ? {
            segments: Math.round(disk.segments / archivedTurns),
            context: Math.round(disk.context / archivedTurns),
          }
        : null,
      sessionTurns: n,
    });
    if (walk === true || (typeof walk === 'function' && walk(point))) {
      const t0 = performance.now();
      const { seen, pages } = await walkHistory(session, history);
      const unique = new Set(seen);
      const expected = Array.from({ length: n }, (_, i) => `t${n - i}`);
      const pass =
        seen.length === n &&
        unique.size === n &&
        seen.every((id, i) => id === expected[i]);
      emit({
        metric: `${feature}.walk.at${point}`,
        unit: 'ms',
        ms: round1(performance.now() - t0),
        turnsSeen: seen.length,
        unique: unique.size,
        pages: pages.length,
        largestPageBytes: Math.max(...pages.map(p => p.bytes)),
        overFrame: pages.filter(p => p.bytes > limits.frameBytes).length,
        pass,
        sessionTurns: n,
      });
      if (!pass) process.exitCode = 1;
    }

    // 5. The reference context, a clean restart, the rebuild.
    rmSync(quiet, { force: true });
    await composerTurn();
    const reference = await waitFor(
      () =>
        made
          .log()
          .find(
            (/** @type {any} */ l) =>
              l.kind === 'context' && l.turnId === lastTurnId && l.round === 0,
          ),
      30_000,
      'the reference context line',
    );
    await live.stop();
    const restarted = await state.restart(`${feature}${point}`);
    const image =
      workerId === undefined ? undefined : vatImage(state.root, workerId);
    summary.slots = image?.slots;
    summary.snapshotBytes = image?.snapshotBytes;
    await single(`${feature}.heap.at${point}`, image?.slots ?? 0, {
      extra: {
        heap: image ?? null,
        hubRowAfterRestart:
          workerId === undefined ? null : hubRow(state.root, workerId),
        sessionTurns: n,
      },
    });
    await slice.refresh();
    session = await E(slice.factory).findSession(key);
    history = await E(slice.admin).history();
    live = await slice.subscribe(session);
    const t0 = performance.now();
    await composerTurn(REBUILD_WAIT_MS);
    const turnMs = performance.now() - t0;
    const line = await waitFor(
      () =>
        made
          .log()
          .find(
            (/** @type {any} */ l) =>
              l.kind === 'context' && l.turnId === lastTurnId && l.round === 0,
          ),
      30_000,
      'the context line',
    );
    const before = String(reference.turnDigests).split(' ');
    const after = String(line.turnDigests).split(' ');
    // The reference turn was then at round 0; it is complete now.
    const common = before.length - 1;
    const sameContext =
      after.length === before.length + 1 &&
      before.slice(0, common).every((d, i) => d === after[i]);
    await single(`${feature}.context.rebuild.at${point}`, Number(line.ms), {
      budget: { value: 5000 },
      extra: {
        turns: n,
        timing: line.timing,
        turnMs: round1(turnMs),
        serveMs: round1(restarted.serveMs),
        sameContext,
        contextTurns: [before.length, after.length],
      },
    });
    summary.rebuildMs = Number(line.ms);
    summary.sameContext = sameContext;
    if (!sameContext) process.exitCode = 1;
    await live.stop();
    await state.close();
    if (!process.env.KEEP_STATE)
      rmSync(stateRoot, { recursive: true, force: true });
  }
  return summaries;
};

/**
 * The flatness rows (D-M2-1, acceptance 15): each measure at `point`
 * against `base`, pass at <= 1.25 x.
 * @param {string} prefix
 * @param {Record<string, any>[]} summaries
 * @param {number} base
 * @param {number} point
 */
export const flatnessRows = (prefix, summaries, base, point) => {
  const a = summaries.find(s => s.point === base);
  const b = summaries.find(s => s.point === point);
  if (a === undefined || b === undefined) return;
  for (const [name, field, extra] of /** @type {const} */ ([
    ['turn', 'msPerTurn', {}],
    ['turnStart', 'turnStart', { alsoAtMost: 350 }],
    ['snapshot', 'snapshotBytes', {}],
    ['snapshotMs', 'snapshotMsEach', {}],
    ['slots', 'slots', {}],
    ['hubRow', 'hubChars', {}],
    ['hubRowEntries', 'hubEntries', {}],
  ])) {
    const x = a[field];
    const y = b[field];
    const ratio =
      typeof x === 'number' && typeof y === 'number' && x > 0
        ? Math.round((y / x) * 1000) / 1000
        : null;
    const pass =
      ratio !== null &&
      ratio <= 1.25 &&
      (extra.alsoAtMost === undefined || y <= extra.alsoAtMost);
    if (!pass) process.exitCode = 1;
    emit({
      metric: `${prefix}.${name}.at${point}`,
      base,
      point,
      [`at${base}`]: x ?? null,
      [`at${point}`]: y ?? null,
      ratio,
      budget: { ratio: 1.25, ...extra },
      pass,
    });
  }
};
