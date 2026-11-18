// @ts-check
/**
 * Helpers for M2 acceptance 16 (m2-interfaces.md 4.5; W2.5), split over
 * `m2-archive-restart.test.js` (S, A3) and `m2-archive-restart-2.test.js`
 * (A2, Z) by M2-T1 so each file stays well inside its time box.
 *
 * `startNearSeal` starts a state from the m1a template and imports one
 * session of `archiveKeepTurns + archiveSegmentTurns - 1` (159) plain
 * turns with `importState` (process.md 3: large states are built by
 * import), so the first live settle starts a seal. Before M2-T1 the file
 * grew that session by running 159 live turns. A grown session cannot be
 * cached as a state template here: the scripted backend's spec holds an
 * absolute `logPath` into the state directory it was made in, so a copy
 * would write its log into the build directory (J-9481).
 *
 * `killAt` SIGKILLs the supervisor at one point of a seal, as before:
 *
 * - S: as soon as the settle crank that starts a seal has answered the
 *   turn's `whenFinished` (the crank and its `seal` frame are committed; the
 *   adapter's A1-A3 may or may not have started);
 * - A2: when a `seg-*.jsonl.part` file appears in the archive directory
 *   (the segment written, not renamed);
 * - A3: when the archive's `manifest.json` is replaced (the segment durable,
 *   the answer about to go or gone);
 * - Z: once the session reports the new segment (the answer crank ran).
 *
 * The watcher sees file events after the fact, so each kill lands at or
 * shortly after its point; which row of the 4.5 table it hit is read back
 * (was the segment acknowledged by the vat; was a `.part` or an orphan left)
 * and recorded as `archive.kill.<point>`. After each restart: history from
 * the newest turn back to turn 1 shows every turn exactly once; no `.part`
 * file remains once the adapter started; the provider's next request
 * carries the same per-turn digests as before for every turn before the
 * kill (M1b 9.1); and the next seal succeeds.
 */
/* eslint-disable no-await-in-loop -- turns run in order */
import { watch } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { limits } from '../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */
import {
  crankBudget,
  emit,
  loadAvg,
  runIdentity,
} from '../../perf/_harness.mjs';
import { importState } from '../../scripts/export.mjs';
import { shortName, startFromTemplate, tmpRoot } from '../template/index.js';
import { makeSlice, round1, sliceTemplate, waitFor } from './_m1a-slice.js';
import { writeSyntheticExport } from './_m2-lifecycle.js';
import {
  archiveFiles,
  archiveOf,
  archiveRoot,
  archiveScript,
  contextOf,
  newestFirst,
  runTurnN,
  walkHistory,
} from './_m2-w25.js';

/** Settled turns that make the next settle start a seal (159). */
export const NEAR_SEAL =
  limits.archiveKeepTurns + limits.archiveSegmentTurns - 1;

/**
 * Segments the session reports (0 before its first seal).
 * @param {any} session
 * @returns {Promise<number>}
 */
const segmentsOf = async session =>
  Number((await archiveOf(session))?.segments ?? 0);

/**
 * A served state with one session of NEAR_SEAL imported turns on a
 * scripted backend whose log is in this state's directory.
 * @param {import('ava').ExecutionContext} t
 */
export const startNearSeal = async t => {
  const t0 = performance.now();
  const template = await sliceTemplate();
  const state = await startFromTemplate(template, { t });
  const started = performance.now();
  const slice = await makeSlice(state);
  const made = await slice.makeBackend(harden(archiveScript));
  const file = path.join(tmpRoot, `${shortName('x')}.jsonl`);
  t.teardown(() => rm(file, { force: true }));
  await writeSyntheticExport(file, [
    {
      title: 'archive',
      turns: NEAR_SEAL,
      backendLabel: 'Scripted',
      shape: 'plain',
    },
  ]);
  const imported = await importState({
    client: state.client,
    file,
    backends: [made.backend],
  });
  const [session] = imported.sessions;
  const { key } = await E(session).getInfo();
  const identity = { ...(await runIdentity()), crankBudget };
  emit({
    metric: 'm2.archive.import',
    turns: imported.turns,
    records: imported.records,
    importMs: round1(imported.ms),
    startMs: round1(started - t0),
    ...identity,
    loadAvg: loadAvg(),
  });
  return {
    state,
    slice,
    made,
    key,
    identity,
    /** @type {any} */
    session,
    /** @type {any} */
    history: await E(slice.admin).history(),
    /** Turns so far (imported and live); every one completed. */
    n: imported.turns,
  };
};

/** @typedef {Awaited<ReturnType<typeof startNearSeal>>} NearSeal */

/**
 * SIGKILL the supervisor at one point of a seal, restart, check, and emit
 * the `archive.kill.<point>` row.
 * @param {import('ava').ExecutionContext} t
 * @param {NearSeal} ctx
 * @param {'S' | 'A2' | 'A3' | 'Z'} point
 * @param {object} [options]
 * @param {boolean} [options.nextSeal] run turns until the next seal
 *   succeeds (default true). False leaves that check to the next `killAt`
 *   of the same session, whose kill lands on this point's next seal (the
 *   retry 8 settles later; M2-T1, J-9481): its row's `sealedByVat` says
 *   whether that seal was acknowledged, and its own next-seal check then
 *   shows a seal succeeding after both restarts.
 */
export const killAt = async (t, ctx, point, { nextSeal = true } = {}) => {
  const { state, slice, made, key, identity } = ctx;
  const turn = async () => {
    ctx.n += 1;
    const { status } = await runTurnN(ctx.session, ctx.n);
    return status;
  };
  /** The next settle starts a seal (a retry waits 8 settles). */
  const sealDue = async () => {
    const archive = await archiveOf(ctx.session);
    const sealed = archive?.sealedTurns ?? 0;
    return (
      ctx.n + 1 - Number(sealed) >=
      limits.archiveKeepTurns + limits.archiveSegmentTurns
    );
  };
  const pointAt = performance.now();
  const before = (await archiveOf(ctx.session)) ?? {
    segments: 0,
    sealedTurns: 0,
  };
  const turnsBefore = ctx.n;
  /** @type {string | undefined} */
  let killedOn;
  /** @type {Promise<void> | undefined} */
  let killing;
  const kill = (/** @type {string} */ why) => {
    if (killing === undefined) {
      killedOn = why;
      killing = state.kill();
    }
    return killing;
  };
  const watcher =
    point === 'A2' || point === 'A3'
      ? watch(archiveRoot(state.root), { recursive: true }, (_e, name) => {
          const file = String(name ?? '');
          if (point === 'A2' && file.endsWith('.part') && /seg-/.test(file)) {
            void kill(`created ${file}`);
          }
          if (point === 'A3' && /manifest\.json$/.test(file)) {
            void kill(`replaced ${file}`);
          }
        })
      : undefined;
  // Turns until the kill; a seal is due at most 32 settles away.
  for (
    let i = 0;
    i < 2 * limits.archiveSegmentTurns && killing === undefined;
    i += 1
  ) {
    const due = await sealDue();
    try {
      await turn();
    } catch {
      break;
    }
    if (due && point === 'S') {
      await kill('the settle crank answered');
    } else if (point === 'Z') {
      // `sealDue` cannot see a retry's 8-settle wait, so after a failed
      // seal every turn looks due: wait briefly, and look again after the
      // next turn (a kill one turn after Z is still after Z). It waited
      // 10 s a turn before M2-T1 (J-9481).
      const sealed = await waitFor(
        async () => (await segmentsOf(ctx.session)) > Number(before.segments),
        due ? 3_000 : 1,
        'the seal answer',
      ).then(
        () => true,
        () => false,
      );
      if (sealed) await kill('the session reports the segment');
    } else if (due) {
      // Let the watcher see the seal's files before the next turn.
      await delay(1000);
    }
  }
  watcher?.close();
  t.truthy(killing, `${point}: killed`);
  await killing;
  const turnsToKill = ctx.n - turnsBefore;
  const filesAtKill = archiveFiles(state.root);
  const restartAt = performance.now();
  const restarted = await state.restart();
  await slice.refresh();
  ctx.session = await E(slice.factory).findSession(key);
  ctx.history = await E(slice.admin).history();
  const after = (await archiveOf(ctx.session)) ?? {
    segments: 0,
    sealedTurns: 0,
  };

  // Every turn exactly once, newest first.
  const total = await E(ctx.session)
    .getHistoryPage()
    .then((/** @type {any} */ p) => p.turns[0]);
  const newest = Number(String(total.turnId).slice(1));
  const { seen } = await walkHistory(ctx.session, ctx.history);
  t.deepEqual(seen, newestFirst(newest), `${point}: every turn once`);

  // The next request: the same per-turn digests for the turns before.
  const reference = [...made.log()]
    .reverse()
    .find((/** @type {any} */ l) => l.kind === 'context' && l.round === 0);
  const status = await turn();
  const firstTurnMs = round1(performance.now() - restartAt);
  const nextId = `t${ctx.n}`;
  const line = await waitFor(
    () => contextOf(made.log(), nextId)[0],
    30_000,
    'the context line after the restart',
  );
  const priorBefore = String(reference.turnDigests).split(' ');
  const priorAfter = String(line.turnDigests).split(' ');
  const common = priorBefore.length - 1;
  t.deepEqual(
    priorAfter.slice(0, common),
    priorBefore.slice(0, common),
    `${point}: the same context as before`,
  );
  t.is(
    archiveFiles(state.root).filter(f => f.endsWith('.part')).length,
    0,
    `${point}: no half-written segment left`,
  );

  // The next seal succeeds (or the next point's kill lands on it).
  const target = after.segments + 1;
  const turnsAtRestart = ctx.n;
  if (nextSeal) {
    for (let i = 0; i < 2 * limits.archiveSegmentTurns; i += 1) {
      if ((await segmentsOf(ctx.session)) >= Number(target)) break;
      await turn();
    }
    await waitFor(
      async () => (await segmentsOf(ctx.session)) >= Number(target),
      30_000,
      `${point}: the next seal`,
    );
    const { seen: again } = await walkHistory(ctx.session, ctx.history);
    t.is(new Set(again).size, again.length);
  }
  const row = {
    metric: `archive.kill.${point}`,
    killedOn,
    sealedByVat: Number(after.segments) > Number(before.segments),
    partAtKill: filesAtKill.filter(f => f.endsWith('.part')).length,
    segmentFilesAtKill: filesAtKill.filter(f => /\/seg-.*\.jsonl$/.test(f))
      .length,
    vatSegments: { before: before.segments, after: after.segments },
    firstTurnAfter: status.state,
    contextTurnsCompared: common,
    restartMs: round1(performance.now() - restartAt),
    firstTurnMs,
    servedMs: restarted.servedMs,
    turnsToKill,
    turnsToNextSeal: nextSeal ? ctx.n - turnsAtRestart : 'next point',
    pointMs: round1(performance.now() - pointAt),
    turns: ctx.n,
    ...identity,
    loadAvg: loadAvg(),
  };
  emit(row);
  t.log(row);
  return row;
};
