// @ts-check
/**
 * The long-session table (J-9383 form) over fixed time windows (M2 W2.9;
 * fixed windows and cached templates M2-P1, process.md section 3;
 * milestones.md M2 perf rows `archive.flat.*`, `context.rebuild` and
 * `history.page` at length, `session.heap`, `journal.snapshot`,
 * `checkpoint.stall`, `hub.row`, `archive.seal`, `archive.disk`; acceptance
 * 15). Used by `perf/history.perf.mjs` and `perf/history.restart.perf.mjs`
 * (200 / 1,000 / 5,000 turns), `perf/journal.perf.mjs` (1,000 / 5,000 turns
 * and a slope) and `perf/archive.perf.mjs` (a session grown to 200 turns).
 *
 * Per point P, in a fresh state:
 *
 * 1. The state is a copy of the cached template of P imported turns
 *    (`perf/_long-template.mjs`: `importState` of P synthetic turns of shape
 *    `plain` (4 records) or `tool` (8), drained of its sealing backlog,
 *    stopped cleanly; built in its own boxed step, never here), whose
 *    session is bound to a scripted backend running J-9383's long-session
 *    script (a tool round and a closing round per turn, two staged native
 *    contexts). With `grow`, a fresh session in a copy of the exec template
 *    runs `startTurn` turns until it holds P turns instead (`<f>.grow.at<P>`).
 * 2. Wake: `wakeTurns` `startTurn` turns (the first wakes the session vat
 *    from its snapshot: `<f>.wake.at<P>`), more while the sealing backlog is
 *    above keep + segment (at most 16).
 * 3. The window: turns back to back for `windowMs` (default 60 s), through
 *    `Session.startTurn` for the first `1 - startShare` of the time and
 *    through the Composer for the rest (`turn.start` = the Composer's stamp
 *    to the provider's request line). The scripted provider's `context` line
 *    carries no digests during the window (`<logPath>.nodigest`,
 *    m2-interfaces.md 4.13). After every turn (outside its timing) a
 *    `status()` gives the engine's and the hub's deltas for that turn. Rows,
 *    each with `window` (ms asked), `windowMs` (ms taken) and `samples`:
 *    `<f>.turn.at<P>` (per-turn median, p99, mean `msPerTurn`, turns per
 *    minute, per delivery, hub time), `<f>.turn.start.at<P>`,
 *    `<f>.snapshot.at<P>` (engine snapshot timing, all vats),
 *    `<f>.stall.at<P>` (`checkpoint.stall`: p99 of per-turn wall time, and
 *    the `slowest` turns with their session turn index, how they were
 *    started, whether they sealed a segment, and their engine and hub
 *    deltas), `<f>.seal.at<P>` (turns that sealed a segment against the
 *    others).
 * 4. At P: `<f>.history.page.at<P>` (the vat's newest page) and `.archived`
 *    (an archived page through `History`), each read back to back for
 *    `pageWindowMs`; the hub row, the archive state and disk (`archive.disk`
 *    bytes per archived turn), and, when `walk` is set, history from the
 *    newest turn back to turn 1 with every turn exactly once (acceptance
 *    15).
 * 5. `after: 'rebuild'`: one more Composer turn with digests on (the
 *    reference context), a clean restart, the session vat's slot capacity
 *    and snapshot file (`<f>.heap.at<P>`), then the next turn:
 *    `<f>.context.rebuild.at<P>` (its round 0 `prepare()`, budget 5 s) and
 *    whether the provider got the same per-turn context digests as before
 *    (acceptance 15). `after: 'heap'`: a clean stop and `<f>.heap.at<P>`
 *    only.
 */
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
import { setTimeout as delay } from 'node:timers/promises';

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
import { longSessionScript, useTemplate } from './_long-template.mjs';

// After the harness module (it locks down first).
const { installGuestPrelude } = await import('../scripts/guest-prelude.js');
installGuestPrelude();
const { E } = await import('@endo/far');
const { makeSlice, readLog, waitFor, round1 } =
  await import('../test/integration/_m1a-slice.js');
const { execTemplate } = await import('../test/integration/_m1b-exec.js');
const { runTurn } = await import('../test/integration/_m1b.js');
const { walkHistory } = await import('../test/integration/_m2-w25.js');
// eslint-disable-next-line import/no-relative-packages -- guest/ is its own private package
const { limits } = await import('../guest/lib/limits.js');

export { longSessionScript };

/** Slots per engine page (`rust/engine/ironhorse-vm/src/value.rs`). */
const SLOTS_PER_PAGE = 256;
const SLOT_CEILING = Number(
  process.env.THIXOTROPE_SLOT_CEILING ?? harnessLimits.slotCeiling,
);
/** How long the first turn after a restart may take. */
const REBUILD_WAIT_MS = 5 * 60_000;

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

/** How long `quiescentHubRow` waits for a row with no answer owed. */
const QUIESCENT_WAIT_MS = 10_000;

/**
 * The hub row read at a quiescent point (J-9496, M2 close-out proposal): a
 * row read with a call in flight carries its owed answer, and the 1,000-turn
 * read of acceptance 15 caught one. Polls the row until it owes no answer,
 * for at most `QUIESCENT_WAIT_MS`; answers that row, the first read and how
 * long it waited (`quiescent: false` when the wait ran out).
 * @param {string} root
 * @param {string} key the vat's worker id
 */
export const quiescentHubRow = async (root, key) => {
  const t0 = performance.now();
  const first = hubRow(root, key);
  let row = first;
  while (
    row !== undefined &&
    row.answersOwed > 0 &&
    performance.now() - t0 < QUIESCENT_WAIT_MS
  ) {
    // eslint-disable-next-line no-await-in-loop
    await delay(100);
    row = hubRow(root, key);
  }
  return {
    row,
    first,
    waitedMs: Math.round(performance.now() - t0),
    quiescent: row === undefined || row.answersOwed === 0,
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
 * Engine deltas with nothing in them left out.
 * @param {Record<string, { count: number, ms: number }>} engine
 */
const compact = engine =>
  Object.fromEntries(
    Object.entries(engine).filter(([, v]) => v.count !== 0 || v.ms !== 0),
  );

/**
 * Run `op` back to back for `windowMs` (at least once); its latencies.
 * @param {number} windowMs
 * @param {() => Promise<unknown>} op
 */
export const overWindow = async (windowMs, op) => {
  /** @type {number[]} */
  const samples = [];
  const t0 = performance.now();
  do {
    const a = performance.now();
    await op();
    samples.push(performance.now() - a);
  } while (performance.now() - t0 < windowMs);
  return { samples, windowMs: round1(performance.now() - t0) };
};

/**
 * @param {object} options
 * @param {string} options.feature row prefix
 * @param {number[]} options.points session lengths, ascending
 * @param {'tool' | 'plain'} options.shape synthetic turn shape
 * @param {number} [options.windowMs] the turn window per point (60 s; 0:
 *   no turn window)
 * @param {number} [options.startShare] share of the window's time run
 *   through the Composer, at its end (0.5)
 * @param {number} [options.pageWindowMs] history page reads per kind (vat,
 *   archived) per point (0: none)
 * @param {boolean | ((point: number) => boolean)} [options.walk] walk
 *   history back to turn 1
 * @param {'rebuild' | 'heap' | 'none'} [options.after] what follows the
 *   window (see the file comment)
 * @param {boolean} [options.grow] run turns up to the point instead of
 *   copying a template
 * @param {number} [options.wakeTurns] (3)
 * @param {number} [options.slowest] slow turns listed in the stall row (5)
 * @param {string} [options.archiveRow] name of the archive row
 *   (`<f>.<archiveRow>.at<P>`, default `archive`)
 * @param {(o: any) => Promise<any>} options.provision runPerf's
 * @param {string} options.root runPerf's root
 */
export const runLongSession = async ({
  feature,
  points,
  shape,
  windowMs = 60_000,
  startShare = 0.5,
  pageWindowMs = 0,
  walk = false,
  after = 'rebuild',
  grow = false,
  wakeTurns = 3,
  slowest = 5,
  archiveRow = 'archive',
  provision,
  root,
}) => {
  /** @type {Record<string, any>[]} per point, for the flatness rows */
  const summaries = [];
  const identity = async () => ({
    ...(await runIdentity()),
    crankBudget,
    loadAvg: loadAvg(),
  });
  for (const [index, point] of points.entries()) {
    const stateRoot = `${root}${String.fromCharCode(97 + index)}`;
    /** @type {Awaited<ReturnType<typeof useTemplate>> | undefined} */
    let used;
    /** @type {any} */
    let state;
    try {
      /** @type {any} */
      let slice;
      /** @type {any} */
      let session;
      /** @type {{ logPath: string, log: () => any[] }} */
      let made;
      let n = 0;
      if (grow) {
        state = await provision({
          template: await execTemplate(),
          root: stateRoot,
        });
        slice = await makeSlice(state);
        made = await slice.makeBackend(longSessionScript, {
          label: 'Scripted',
        });
        session = await slice.createSession(
          /** @type {any} */ (made).backend,
          `${feature} ${point}`,
        );
      } else {
        used = await useTemplate({ kind: 'long', turns: point, shape });
        state = await provision({ template: used.dir, root: stateRoot });
        slice = await makeSlice(state);
        const [logPath] = used.logPaths;
        made = { logPath, log: () => readLog(logPath) };
        session = await E(slice.factory).findSession(used.sessionKeys[0]);
        n = used.turns;
        emit({
          metric: `${feature}.template.at${point}`,
          key: used.key,
          shape,
          imported: used.imported,
          drainTurns: used.warmups,
          sessionTurns: used.turns,
          import: used.import,
          buildMs: used.buildMs,
          builtAt: used.builtAt,
          builtBy: used.commit,
        });
      }
      const { key } = await E(session).getInfo();
      let live = await slice.subscribe(session);
      let history = await E(slice.admin).history();

      /** @type {string | undefined} */
      let lastTurnId;
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
      const archiveNow = async () =>
        (await E(session).getHistoryPage()).archive;
      const quiet = `${made.logPath}.nodigest`;
      writeFileSync(quiet, '');

      // 1b. Grow (no template).
      if (grow) {
        const g0 = performance.now();
        while (n < point) await directTurn();
        const ms = performance.now() - g0;
        emit({
          metric: `${feature}.grow.at${point}`,
          unit: 'turns/min',
          turns: n,
          ms: Math.round(ms),
          turnsPerMinute: round1((n * 60_000) / ms),
          via: 'startTurn',
        });
      }

      // 2. Wake and drain.
      /** @type {number[]} */
      const wakeMs = [];
      for (;;) {
        const archive = await archiveNow();
        const backlog = n - (archive?.sealedTurns ?? 0) > keptBound;
        if (
          (wakeMs.length >= wakeTurns && !backlog) ||
          wakeMs.length >= wakeTurns + 16
        )
          break;
        const a = performance.now();
        await directTurn();
        wakeMs.push(performance.now() - a);
      }
      emit({
        metric: `${feature}.wake.at${point}`,
        unit: 'ms',
        firstTurnMs: wakeMs.length ? round1(wakeMs[0]) : null,
        laterMedian: quantile(wakeMs.slice(1), 0.5),
        turns: wakeMs.length,
        what: 'turns before the window; the first wakes the session vat from its snapshot',
        sessionTurns: n,
      });

      /** @type {Record<string, any>} */
      const summary = { point };
      summaries.push(summary);

      // 3. The window.
      if (windowMs > 0) {
        let previous = await state.client.call('status');
        const mark = { n, at: performance.now(), status: previous };
        /** @type {number[]} */
        const starts = [];
        /**
         * @type {{ index: number, turn: number, via: string, ms: number,
         *   sealed: boolean, snapshots: number, snapshotMs: number,
         *   deliveries: number, deliveryMs: number, hubMs: number,
         *   engine: Record<string, any> }[]}
         */
        const perTurn = [];
        let segments = segmentCount(state.root);
        const composerFrom = mark.at + windowMs * (1 - startShare);
        const end = mark.at + windowMs;
        let statusMs = 0;
        let composerTurns = 0;
        while (performance.now() < end) {
          const viaComposer = performance.now() >= composerFrom;
          const a = performance.now();
          if (viaComposer) {
            const start = await composerTurn();
            if (start !== undefined) starts.push(start);
          } else {
            await directTurn();
          }
          const ms = performance.now() - a;
          const s0 = performance.now();
          const st = await state.client.call('status');
          statusMs += performance.now() - s0;
          const engine = delta(previous.timings ?? {}, st.timings ?? {});
          const hubMs = hubTotals(st.hub).ms - hubTotals(previous.hub).ms;
          previous = st;
          const nowSegments = segmentCount(state.root);
          const snaps = engine.snapshot ?? engine.snapshots;
          let via = 'startTurn';
          if (viaComposer) {
            via = composerTurns === 0 ? 'composer (first)' : 'composer';
            composerTurns += 1;
          }
          perTurn.push({
            index: perTurn.length + 1,
            turn: n,
            via,
            ms,
            sealed: nowSegments > segments,
            snapshots: snaps?.count ?? 0,
            snapshotMs: snaps?.ms ?? 0,
            deliveries: engine.delivery?.count ?? 0,
            deliveryMs: engine.delivery?.ms ?? 0,
            hubMs: round1(hubMs),
            engine: compact(engine),
          });
          segments = nowSegments;
        }
        const elapsed = performance.now() - mark.at;
        const status = previous;
        const engine = delta(mark.status.timings ?? {}, status.timings ?? {});
        const hubThen = hubTotals(mark.status.hub);
        const hubNow = hubTotals(status.hub);
        const deliveries = engine.delivery ?? { count: 0, ms: 0 };
        const snapshots = engine.snapshot ?? engine.snapshots;
        const wall = perTurn.map(p => p.ms);
        const W = wall.length;
        const windowFields = {
          window: windowMs,
          windowMs: round1(elapsed),
          samples: W,
        };
        const turnRow = emit({
          metric: `${feature}.turn.at${point}`,
          unit: 'ms',
          ...windowFields,
          turns: W,
          msPerTurn: round1(wall.reduce((x, y) => x + y, 0) / W),
          median: quantile(wall, 0.5),
          p99: quantile(wall, 0.99),
          turnsPerMinute: round1((W * 60_000) / elapsed),
          statusMsPerTurn: round1(statusMs / W),
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
          source: grow ? 'grown' : 'template',
          shape: grow ? null : shape,
          imported: used?.imported ?? 0,
          warmups: (used?.warmups ?? 0) + wakeMs.length,
          fromTurn: mark.n + 1,
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
          ...windowFields,
          count: snapshots?.count ?? 0,
          msEach: summary.snapshotMsEach,
          what: 'engine snapshot timing over the window, all vats',
          sessionTurns: n,
          ...(await identity()),
        });
        // checkpoint.stall: turn latency while a busy session vat snapshots.
        const slow = [...perTurn]
          .sort((a, b) => b.ms - a.ms)
          .slice(0, slowest)
          .map(p => ({ ...p, ms: round1(p.ms) }));
        await single(`${feature}.stall.at${point}`, quantile(wall, 0.99) ?? 0, {
          budget: { value: 1000 },
          extra: {
            what: 'p99 of per-turn wall time over the window (snapshots every SNAP_EVERY deliveries); slowest: the slowest turns with what they did',
            ...windowFields,
            median: quantile(wall, 0.5),
            max: quantile(wall, 1),
            snapshots: snapshots?.count ?? 0,
            snapshottedTurnsMax: quantile(
              perTurn.filter(p => p.snapshots > 0).map(p => p.ms),
              1,
            ),
            slowest: slow,
            sessionTurns: n,
          },
        });
        const sealedTurns = perTurn.filter(p => p.sealed).map(p => p.ms);
        const otherTurns = perTurn.filter(p => !p.sealed).map(p => p.ms);
        emit({
          metric: `${feature}.seal.at${point}`,
          unit: 'ms',
          ...windowFields,
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
              extra: {
                ...windowFields,
                samples: starts.length,
                window: Math.round(windowMs * startShare),
                turns: `${n - starts.length + 1}..${n}`,
              },
            })
          ).median;
      }

      // 4. History pages, hub row, archive.
      const newest = await E(session).getHistoryPage();
      const archive = newest.archive;
      if (pageWindowMs > 0) {
        const vat = await overWindow(pageWindowMs, () =>
          E(session).getHistoryPage(),
        );
        summary.historyPage = (
          await stats(`${feature}.history.page.at${point}`, vat.samples, {
            budget: { median: 300 },
            extra: {
              window: pageWindowMs,
              windowMs: vat.windowMs,
              samples: vat.samples.length,
              perSecond: round1((vat.samples.length * 1000) / vat.windowMs),
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
        if (archive !== undefined) {
          const archived = await overWindow(pageWindowMs, () =>
            E(history).page(session, `h${archive.sealedTurns}`),
          );
          summary.archivedPage = (
            await stats(
              `${feature}.history.page.archived.at${point}`,
              archived.samples,
              {
                budget: { median: 300 },
                extra: {
                  window: pageWindowMs,
                  windowMs: archived.windowMs,
                  samples: archived.samples.length,
                  perSecond: round1(
                    (archived.samples.length * 1000) / archived.windowMs,
                  ),
                  sessionTurns: n,
                  cursor: `h${archive.sealedTurns}`,
                },
              },
            )
          ).median;
        }
      }
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
      const read =
        workerId === undefined
          ? undefined
          : await quiescentHubRow(state.root, workerId);
      const row = read?.row;
      summary.hubChars = row?.chars;
      summary.hubEntries = row?.ourExports;
      emit({
        metric: `${feature}.hub.row.at${point}`,
        row: row ?? null,
        firstRead: read?.first ?? null,
        waitedMs: read?.waitedMs ?? null,
        quiescent: read?.quiescent ?? null,
        worker: sessionWorker?.debugLabel ?? null,
        sessionTurns: n,
        ...(await identity()),
      });
      const disk = archiveBytes(state.root);
      const archivedTurns = archive?.sealedTurns ?? 0;
      emit({
        metric: `${feature}.${archiveRow}.at${point}`,
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
        const ms = performance.now() - t0;
        emit({
          metric: `${feature}.walk.at${point}`,
          unit: 'ms',
          ms: round1(ms),
          turnsSeen: seen.length,
          unique: unique.size,
          pages: pages.length,
          msPerPage: round1(ms / pages.length),
          largestPageBytes: Math.max(...pages.map(p => p.bytes)),
          overFrame: pages.filter(p => p.bytes > limits.frameBytes).length,
          pass,
          sessionTurns: n,
        });
        if (!pass) process.exitCode = 1;
      }

      // 5. What follows.
      if (after === 'rebuild') {
        rmSync(quiet, { force: true });
        await composerTurn();
        const reference = await waitFor(
          () =>
            made
              .log()
              .find(
                (/** @type {any} */ l) =>
                  l.kind === 'context' &&
                  l.turnId === lastTurnId &&
                  l.round === 0,
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
                  l.kind === 'context' &&
                  l.turnId === lastTurnId &&
                  l.round === 0,
              ),
          30_000,
          'the context line',
        );
        const before = String(reference.turnDigests).split(' ');
        const afterDigests = String(line.turnDigests).split(' ');
        // The reference turn was then at round 0; it is complete now.
        const common = before.length - 1;
        const sameContext =
          afterDigests.length === before.length + 1 &&
          before.slice(0, common).every((d, i) => d === afterDigests[i]);
        await single(`${feature}.context.rebuild.at${point}`, Number(line.ms), {
          budget: { value: 5000 },
          extra: {
            turns: n,
            timing: line.timing,
            turnMs: round1(turnMs),
            serveMs: round1(restarted.serveMs),
            sameContext,
            contextTurns: [before.length, afterDigests.length],
          },
        });
        summary.rebuildMs = Number(line.ms);
        summary.sameContext = sameContext;
        if (!sameContext) process.exitCode = 1;
        await live.stop();
        await state.close();
      } else {
        await live.stop();
        const c0 = performance.now();
        await state.close();
        const closeMs = performance.now() - c0;
        if (after === 'heap') {
          const image =
            workerId === undefined ? undefined : vatImage(state.root, workerId);
          summary.slots = image?.slots;
          summary.snapshotBytes = image?.snapshotBytes;
          await single(`${feature}.heap.at${point}`, image?.slots ?? 0, {
            extra: {
              heap: image ?? null,
              hubRowAfterStop:
                workerId === undefined ? null : hubRow(state.root, workerId),
              closeMs: round1(closeMs),
              what: 'after a clean stop (no restart)',
              sessionTurns: n,
            },
          });
        }
      }
    } finally {
      // Closed already unless something failed (closing twice is harmless).
      await state?.close().catch(() => {});
      await used?.release();
      if (!process.env.KEEP_STATE)
        rmSync(stateRoot, { recursive: true, force: true });
    }
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
