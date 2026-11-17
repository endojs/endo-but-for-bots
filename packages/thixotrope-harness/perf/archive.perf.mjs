// @ts-check
/**
 * Perf check "archive" (milestones.md M2 perf rows `archive.flat.*`,
 * `context.rebuild` and `history.page` at length; D-M2-1; W2.5): one
 * session of the long-session script of `perf/crank.perf.mjs` and J-9383
 * (per turn a tool round and a closing round, two staged native contexts),
 * grown by running turns (`Session.startTurn` outside the measured
 * windows, the Composer inside them, as CRANK_START=mixed), measured at
 * each of ARCHIVE_POINTS (default 200, 1,000, 5,000):
 *
 * - `archive.turn.at<n>`: wall time per turn over the turns since the
 *   previous point (at most 100 before n), with the engine's delivery
 *   timing over the same turns (`perDeliveryMs`: the worker round trip of
 *   every delivery to every vat) and the hub's time;
 * - `archive.turn.start.at<n>`: `turn.start` (the Composer's stamp to the
 *   scripted provider's request line) over the 50 turns before n;
 * - `archive.history.page.at<n>`: `getHistoryPage()` of the session vat (the
 *   newest page), 30 reads; `archive.history.page.archived.at<n>`: an
 *   archived page through the agent host's `History`;
 * - `archive.hub.row.at<n>`: the session vat's hub row (its `ourExports`
 *   and `answersOwed` entries and its JSON characters), read from the
 *   hub's image and log while the daemon runs;
 * - a clean restart, then `archive.heap.at<n>`: the session vat's slot
 *   capacity (pages x 256 at its latest snapshot) and its snapshot file's
 *   bytes; `archive.snapshot.at<n>`: the engine's snapshot timing over the
 *   turns before the point (all vats; the session vat dominates);
 * - `archive.context.rebuild.at<n>`: the next turn's round 0 `prepare()`
 *   after the restart (budget 5 s);
 * - `archive.state.at<n>`: the session's ArchiveState, kept turns, and the
 *   archive directory's bytes (segments, context.jsonl, manifest, mirror).
 *
 *   cd packages/thixotrope-harness && node perf/archive.perf.mjs
 *
 * ARCHIVE_POINTS (comma-separated, ascending), ARCHIVE_PAGE_N (30). About
 * 0.6-0.8 s per turn.
 */
/* eslint-disable no-await-in-loop -- turns and phases run in order */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { limits as harnessLimits } from '../config/defaults.js';

import {
  crankBudget,
  delta,
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

const POINTS = (process.env.ARCHIVE_POINTS ?? '200,1000,5000')
  .split(',')
  .filter(Boolean)
  .map(Number);
const TURNS = Math.max(...POINTS);
const PAGE_N = Number(process.env.ARCHIVE_PAGE_N ?? 30);
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

/**
 * Turn n goes through the Composer when it is in a measured window (the
 * 50 turns up to a point and the one after it).
 * @param {number} n
 */
const composerTurn = n => n <= 51 || POINTS.some(p => n > p - 50 && n <= p + 1);

/**
 * The workers of a state by debug label: id and newest snapshot.
 * @param {string} root
 */
const workerMetas = root => {
  const dir = path.join(root, 'workers');
  return readdirSync(dir)
    .map(id => ({ id, file: path.join(dir, id, 'meta.json') }))
    .filter(({ file }) => existsSync(file))
    .map(({ id, file }) => ({ id, ...JSON.parse(readFileSync(file, 'utf8')) }));
};

/**
 * The session vat's heap at its newest snapshot: slot capacity and file.
 * @param {string} root
 * @param {string} workerId
 */
const vatImage = (root, workerId) => {
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
 * One hub session row as the log store holds it now: the image's row,
 * replaced by the newest `put` of it in the log after the image.
 * @param {string} root
 * @param {string} key the vat's worker id
 */
const hubRow = (root, key) => {
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
 * Bytes of a session's archive directory by kind.
 * @param {string} root
 */
const archiveBytes = root => {
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

/**
 * The hub's process-local delivery counters summed (as crank.perf.mjs).
 * @param {any} hub
 */
const hubTotals = hub => {
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

await runPerf('archive', async ({ provision }) => {
  const template = await execTemplate();
  const state = await provision({ template });
  const slice = await makeSlice(state);
  const made = await slice.makeBackend(script);
  let session = await slice.createSession(made.backend, 'archive');
  const { key } = await E(session).getInfo();
  const identity = async () => ({
    ...(await runIdentity()),
    crankBudget,
    loadAvg: loadAvg(),
  });
  // The session's worker: the busy session vat (pooled or cold).
  const sessionWorker = async () => {
    const rows = await slice.workers();
    const row = rows
      .filter((/** @type {any} */ w) =>
        /^(spare session \d+|session s\d+)$/.test(w.debugLabel),
      )
      .sort(
        (/** @type {any} */ a, /** @type {any} */ b) =>
          b.journalLength - a.journalLength,
      )[0];
    const meta = workerMetas(state.root).find(
      m => m.debugLabel === row?.debugLabel,
    );
    return meta?.id;
  };
  let live = await slice.subscribe(session);
  let history = await E(slice.admin).history();

  /**
   * @param {string} input
   * @param {number} ms
   */
  const directTurn = async (input, ms) => {
    const from = live.deliveries.length;
    const started = await E(session).startTurn(
      harden({ text: input }),
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
      `turn "${input}": end`,
      10,
    );
    if (at.event.type === 'abort')
      throw Error(`turn ${input} failed: ${at.event.reason}`);
    return { turnId, from };
  };
  /** @type {Map<number, number>} */
  const startByTurn = new Map();
  /** @type {string | undefined} */
  let lastTurnId;
  /**
   * @param {number} n
   * @param {number} [ms]
   */
  const turn = async (n, ms = 120_000) => {
    const r = composerTurn(n)
      ? await runTurn(slice, session, live, `c${n}`, ms)
      : await directTurn(`c${n}`, ms);
    if (composerTurn(n)) {
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
      if (started && request)
        startByTurn.set(n, Number(request.at) - Number(started.event.at));
    }
    lastTurnId = r.turnId;
  };

  let workerId = await sessionWorker();
  let mark = {
    n: 0,
    at: performance.now(),
    status: await state.client.call('status'),
  };
  let n = 0;
  for (const point of POINTS) {
    // Grow to the point; the last 100 turns are the per-turn window.
    while (n < point) {
      n += 1;
      if (point - n === 99 || (n === 1 && point < 100)) {
        mark = {
          n: n - 1,
          at: performance.now(),
          status: await state.client.call('status'),
        };
      }
      await turn(n);
    }
    const now = performance.now();
    const status = await state.client.call('status');
    const engine = delta(mark.status.timings ?? {}, status.timings);
    const hubThen = hubTotals(mark.status.hub);
    const hubNow = hubTotals(status.hub);
    const turns = n - mark.n;
    const deliveries = engine.delivery ?? { count: 0, ms: 0 };
    const snapshots = engine.snapshot ?? engine.snapshots;
    emit({
      metric: `archive.turn.at${point}`,
      unit: 'ms',
      turns,
      msPerTurn: round1((now - mark.at) / turns),
      perDeliveryMs: deliveries.count
        ? round1(deliveries.ms / deliveries.count)
        : null,
      deliveriesPerTurn: round1(deliveries.count / turns),
      hubMsPerTurn: round1((hubNow.ms - hubThen.ms) / turns),
      hubCharsPerPersist:
        hubNow.persists > hubThen.persists
          ? Math.round(
              (hubNow.persistChars - hubThen.persistChars) /
                (hubNow.persists - hubThen.persists),
            )
          : null,
      engine,
      sessionTurns: n,
      ...(await identity()),
    });
    if (snapshots !== undefined)
      emit({
        metric: `archive.snapshot.at${point}`,
        unit: 'ms',
        count: snapshots.count,
        msEach: snapshots.count ? round1(snapshots.ms / snapshots.count) : null,
        turns,
        what: 'engine snapshot timing over the window, all vats',
        ...(await identity()),
      });
    const starts = [...startByTurn]
      .filter(([k]) => k > point - 50 && k <= point)
      .map(([, v]) => v);
    if (starts.length)
      await stats(`archive.turn.start.at${point}`, starts, {
        budget: { median: 350 },
        extra: { turns: `${point - 49}..${point}` },
      });
    // History pages: the newest (vat) and an archived one (History).
    const newest = await E(session).getHistoryPage();
    const archive = newest.archive;
    /** @type {number[]} */
    const vatMs = [];
    /** @type {number[]} */
    const archivedMs = [];
    for (let i = 0; i < PAGE_N; i += 1) {
      let at = performance.now();
      await E(session).getHistoryPage();
      vatMs.push(performance.now() - at);
      if (archive !== undefined) {
        at = performance.now();
        await E(history).page(session, `h${archive.sealedTurns}`);
        archivedMs.push(performance.now() - at);
      }
    }
    await stats(`archive.history.page.at${point}`, vatMs, {
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
    });
    if (archivedMs.length)
      await stats(`archive.history.page.archived.at${point}`, archivedMs, {
        budget: { median: 300 },
        extra: { sessionTurns: n, cursor: `h${archive.sealedTurns}` },
      });
    workerId = (await sessionWorker()) ?? workerId;
    emit({
      metric: `archive.hub.row.at${point}`,
      row: workerId === undefined ? null : hubRow(state.root, workerId),
      sessionTurns: n,
      ...(await identity()),
    });
    emit({
      metric: `archive.state.at${point}`,
      archive: archive ?? null,
      keptTurns: n - (archive?.sealedTurns ?? 0),
      disk: archiveBytes(state.root),
      sessionTurns: n,
    });
    // A clean restart: the heap at the snapshot, then the context rebuild.
    await live.stop();
    const restarted = await state.restart(`archive${point}`);
    const image =
      workerId === undefined ? undefined : vatImage(state.root, workerId);
    emit({
      metric: `archive.heap.at${point}`,
      heap: image ?? null,
      sessionTurns: n,
      ...(await identity()),
    });
    await slice.refresh();
    session = await E(slice.factory).findSession(key);
    history = await E(slice.admin).history();
    live = await slice.subscribe(session);
    if (point === TURNS) {
      emit({
        metric: 'archive.hub.row.afterRestart',
        row: workerId === undefined ? null : hubRow(state.root, workerId),
      });
    }
    n += 1;
    const t0 = performance.now();
    await turn(n, REBUILD_WAIT_MS);
    const turnMs = performance.now() - t0;
    startByTurn.delete(n);
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
    await single(`archive.context.rebuild.at${point}`, Number(line.ms), {
      budget: { value: 5000 },
      extra: {
        turns: n,
        timing: line.timing,
        turnMs: round1(turnMs),
        serveMs: round1(restarted.serveMs),
      },
    });
    mark = {
      n,
      at: performance.now(),
      status: await state.client.call('status'),
    };
  }
  await live.stop();
});
