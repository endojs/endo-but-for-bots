// @ts-check
/**
 * M2 acceptance 9 (milestones.md M2; m2-interfaces.md 4.9, 6; W2.5), in
 * real vats from the m1a state template, on the scripted backend:
 *
 * 9. After 300 turns, history pages load back to turn 1 (across the record
 *    archive: by then 160 turns are sealed), every page message is at most
 *    `frameBytes`, and no turn is missing or shown twice.
 *
 * Also: the session vat seals at its 160th settle (32 turns per segment,
 * 128 kept) and keeps 128-159 settled turns; a Turn handle of an archived
 * turn keeps its status and answers `getContent` with `texts.turnSealed`;
 * `History.turnContent` reads an archived turn; every vat page holds at
 * most `historyPageRecords` records. Emits `history.page.at300` (the
 * newest page, vat) and `history.page.archived.at300` (an archived page,
 * `History`) for the record (the 1,000 / 5,000-turn rows are
 * `perf/archive.perf.mjs`).
 *
 *   THIX_HARNESS_INTEGRATION=1 node scripts/run-lock.mjs --label m2-history -- \
 *     corepack yarn test test/integration/m2-history.test.js
 */
/* eslint-disable no-await-in-loop -- turns run in order */
import '../unit/_m1a-prelude.js';

import { performance } from 'node:perf_hooks';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { texts } from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */
import {
  crankBudget,
  emit,
  loadAvg,
  runIdentity,
  stats,
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
  archiveScript,
  newestFirst,
  runTurnN,
  walkHistory,
} from './_m2-w25.js';

takeIntegrationLock(test, 'm2 history test');

const run = integrationEnabled ? test.serial : test.skip;

const TURNS = 300;

run(
  '9: after 300 turns, pages load back to turn 1 across the archive',
  async t => {
    t.timeout(10 * 60_000);
    const template = await sliceTemplate();
    const state = await startFromTemplate(template, { t });
    const slice = await makeSlice(state);
    const made = await slice.makeBackend(harden(archiveScript));
    const session = await slice.createSession(made.backend, 'history');
    const history = await E(slice.admin).history();

    const t0 = performance.now();
    /** @type {any} */
    let first;
    /** @type {number[]} */
    const kept = [];
    for (let n = 1; n <= TURNS; n += 1) {
      const { turn, status } = await runTurnN(session, n);
      if (n === 1) first = turn;
      t.is(status.state, 'completed', `turn ${n}`);
      if (n === 159) t.is(await archiveOf(session), undefined, 'no seal yet');
      if (n === 160) {
        // The seal's answer (crank Z) comes after the settle crank answered.
        const archive = await waitFor(
          () => archiveOf(session),
          10_000,
          'the first seal',
        ).catch(() => undefined);
        t.like(archive, { sealedTurns: 32, segments: 1 }, 'sealed at 160');
      }
      if (n > 160 && n % 10 === 0) {
        const archive = await archiveOf(session);
        kept.push(n - archive.sealedTurns);
      }
    }
    const turnsMs = round1(performance.now() - t0);
    const archive = await archiveOf(session);
    t.like(archive, { sealedTurns: 160, segments: 5 });
    t.true(
      kept.every(k => k >= limits.archiveKeepTurns && k < 160),
      `kept turns ${kept.join(',')}`,
    );

    // Pages from the newest turn back to turn 1, every turn once.
    const { seen, pages } = await walkHistory(session, history);
    t.deepEqual(seen, newestFirst(TURNS));
    for (const page of pages) {
      t.true(page.bytes <= limits.frameBytes, JSON.stringify(page));
      if (page.where === 'vat') {
        t.true(page.records <= limits.historyPageRecords);
      }
    }

    // An archived turn: its handle keeps its status; its content is read
    // through History.
    t.is((await E(first).getStatus()).state, 'completed');
    await t.throwsAsync(() => E(first).getContent(), {
      message: texts.turnSealed,
    });
    const content = await E(history).turnContent(session, 't1');
    t.is(content.records[0].kind, 'turn-started');
    t.is(content.records[0].input, 'message 1');

    // Timings of the newest page (vat) and an archived page (History).
    /** @type {number[]} */
    const vatMs = [];
    /** @type {number[]} */
    const archivedMs = [];
    for (let i = 0; i < 20; i += 1) {
      let at = performance.now();
      await E(session).getHistoryPage();
      vatMs.push(performance.now() - at);
      at = performance.now();
      await E(history).page(session, `h${archive.sealedTurns}`);
      archivedMs.push(performance.now() - at);
    }
    const identity = {
      ...(await runIdentity()),
      crankBudget,
      loadAvg: loadAvg(),
    };
    await stats('history.page.at300', vatMs, {
      budget: { median: 300 },
      extra: { turns: TURNS, where: 'session vat, newest page', ...identity },
    });
    await stats('history.page.archived.at300', archivedMs, {
      budget: { median: 300 },
      extra: { turns: TURNS, where: 'History, archived page', ...identity },
    });
    const files = archiveFiles(state.root);
    emit({
      metric: 'm2.history.grow',
      turns: TURNS,
      msPerTurn: round1(turnsMs / TURNS),
      pages: pages.length,
      pageBytesMax: Math.max(...pages.map(p => p.bytes)),
      segmentFiles: files.filter(f => /\/seg-/.test(f)).length,
      partFiles: files.filter(f => f.endsWith('.part')).length,
      ...identity,
    });
    t.is(files.filter(f => f.endsWith('.part')).length, 0);
  },
);
