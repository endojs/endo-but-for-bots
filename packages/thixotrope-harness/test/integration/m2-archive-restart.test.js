// @ts-check
/**
 * M2 acceptance 16 (milestones.md M2; m2-interfaces.md 4.5; W2.5): SIGKILL
 * of the supervisor during a seal of the record archive, in real vats from
 * the m1a state template, on the scripted backend. One session seals at its
 * 160th settle and every 32 settles after (8 after a failed seal); the
 * supervisor is SIGKILLed at four points, in turn:
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
 *
 *   THIX_HARNESS_INTEGRATION=1 node scripts/run-lock.mjs --label m2-archive -- \
 *     corepack yarn test test/integration/m2-archive-restart.test.js
 */
/* eslint-disable no-await-in-loop -- turns run in order */
import '../unit/_m1a-prelude.js';

import { watch } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import test from 'ava';

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
import {
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import { makeSlice, round1, sliceTemplate, waitFor } from './_m1a-slice.js';
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

takeIntegrationLock(test, 'm2 archive restart test');

const run = integrationEnabled ? test.serial : test.skip;

const POINTS = /** @type {const} */ (['S', 'A2', 'A3', 'Z']);

/**
 * Segments the session reports (0 before its first seal).
 * @param {any} session
 * @returns {Promise<number>}
 */
const segmentsOf = async session =>
  Number((await archiveOf(session))?.segments ?? 0);

run('16: SIGKILL during a seal at S, A2, A3 and Z', async t => {
  t.timeout(15 * 60_000);
  const template = await sliceTemplate();
  const state = await startFromTemplate(template, { t });
  const slice = await makeSlice(state);
  const made = await slice.makeBackend(harden(archiveScript));
  let session = await slice.createSession(made.backend, 'archive');
  const { key } = await E(session).getInfo();
  let history = await E(slice.admin).history();
  const identity = {
    ...(await runIdentity()),
    crankBudget,
  };

  /** Turns started so far; the last one that completed. */
  let n = 0;
  let completed = 0;
  /** Settles since the last failed seal (a retry waits 8). */
  const sealDue = async () => {
    const archive = await archiveOf(session);
    const sealed = archive?.sealedTurns ?? 0;
    // The next settle keeps one more settled turn.
    return (
      completed + 1 - Number(sealed) >=
      limits.archiveKeepTurns + limits.archiveSegmentTurns
    );
  };
  const turn = async () => {
    n += 1;
    const { status } = await runTurnN(session, n);
    completed = n;
    return status;
  };
  const t0 = performance.now();
  while (n < limits.archiveKeepTurns + limits.archiveSegmentTurns - 1) {
    t.is((await turn()).state, 'completed');
  }
  emit({
    metric: 'm2.archive.grow',
    turns: n,
    msPerTurn: round1((performance.now() - t0) / n),
    ...identity,
    loadAvg: loadAvg(),
  });

  for (const point of POINTS) {
    const before = (await archiveOf(session)) ?? {
      segments: 0,
      sealedTurns: 0,
    };
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
      } else if (due && point === 'Z') {
        const sealed = await waitFor(
          async () => (await segmentsOf(session)) > Number(before.segments),
          10_000,
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
    const filesAtKill = archiveFiles(state.root);
    const restartAt = performance.now();
    const restarted = await state.restart();
    await slice.refresh();
    session = await E(slice.factory).findSession(key);
    history = await E(slice.admin).history();
    const after = (await archiveOf(session)) ?? { segments: 0, sealedTurns: 0 };

    // Every turn exactly once, newest first.
    const total = await E(session)
      .getHistoryPage()
      .then(p => p.turns[0]);
    const newest = Number(String(total.turnId).slice(1));
    const { seen } = await walkHistory(session, history);
    t.deepEqual(seen, newestFirst(newest), `${point}: every turn once`);

    // The next request: the same per-turn digests for the turns before.
    const reference = [...made.log()]
      .reverse()
      .find((/** @type {any} */ l) => l.kind === 'context' && l.round === 0);
    const status = await turn();
    const nextId = `t${n}`;
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

    // The next seal succeeds.
    const target = after.segments + 1;
    for (let i = 0; i < 2 * limits.archiveSegmentTurns; i += 1) {
      if ((await segmentsOf(session)) >= Number(target)) break;
      await turn();
    }
    await waitFor(
      async () => (await segmentsOf(session)) >= Number(target),
      30_000,
      `${point}: the next seal`,
    );
    const { seen: again } = await walkHistory(session, history);
    t.is(new Set(again).size, again.length);
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
      servedMs: restarted.servedMs,
      turns: n,
      ...identity,
      loadAvg: loadAvg(),
    };
    emit(row);
    t.log(row);
  }
});
