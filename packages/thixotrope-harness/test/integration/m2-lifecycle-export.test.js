// @ts-check
/**
 * M2 acceptance 14 (milestones.md M2; m2-interfaces.md 7; W2.7), split from
 * m2-lifecycle.test.js for the 5-minute file budget (J-9493), through the
 * daemon from the m1a state template:
 *
 * 14. `exportState` then `importState` into a fresh state directory yields
 *     the same sessions, history and queues (presets are M5); an export cut
 *     before a session's `end` fails the import and leaves no half-imported
 *     session (J-9493).
 *
 * Also (C-VERIFY, J-10125, J-10126): an import of short turns, whose record
 * chunks encode to about 38-40 KB though their strings fit `frameBytes`,
 * completes under the harness's vat frame ceiling (`vatFrameBytes`; core
 * CC-027's default of 32,768 refuses them).
 *
 * Runs only with THIX_HARNESS_INTEGRATION=1, under the run lock:
 *
 *   THIX_HARNESS_INTEGRATION=1 node scripts/run-lock.mjs --label m2-lifecycle-export -- \
 *     corepack yarn test test/integration/m2-lifecycle-export.test.js
 */
import '../unit/_m1a-prelude.js';

import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { limits } from '../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */
import { emit } from '../../perf/_harness.mjs';
import { exportState, importState } from '../../scripts/export.mjs';
import { inputs, sliceScript } from '../fixtures/scripts/m1a-slice.js';
import {
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
  tmpRoot,
  shortName,
} from '../template/index.js';
import { makeSlice, sliceTemplate, waitFor } from './_m1a-slice.js';
import { writeSyntheticExport } from './_m2-lifecycle.js';

takeIntegrationLock(test, 'm2 lifecycle export test');

/** Export files this file wrote (removed at the end). */
/** @type {string[]} */
const files = [];
test.after.always(() =>
  Promise.all(files.map(file => rm(file, { force: true }))),
);

const run = integrationEnabled ? test.serial : test.skip;

/** @type {Awaited<ReturnType<typeof sliceTemplate>> | undefined} */
let template;
/** @param {import('ava').ExecutionContext} t */
const open = async t => {
  template ??= await sliceTemplate();
  const state = await startFromTemplate(template, { t });
  const slice = await makeSlice(state);
  const made = await slice.makeBackend(harden(sliceScript));
  return { state, slice, ...made };
};

/** @param {any} slice */
const listedKeys = async slice =>
  (await E(slice.factory).listSessions()).rows.map(
    (/** @type {any} */ row) => row.key,
  );

/**
 * Import synthetic sessions into a served state.
 * @param {any} state
 * @param {any} backend
 * @param {import('./_m2-lifecycle.js').SyntheticSession[]} sessions
 */
const importSynthetic = async (state, backend, sessions) => {
  const file = path.join(tmpRoot, `${shortName('x')}.jsonl`);
  files.push(file);
  const written = await writeSyntheticExport(file, sessions);
  const result = await importState({
    client: state.client,
    file,
    backends: [backend],
  });
  return { ...result, file, fileBytes: written.bytes };
};

/**
 * Every turn id of a session, newest first, through the vat and History.
 * @param {any} slice
 * @param {any} s
 */
const allTurnIds = async (slice, s) => {
  const history = await E(slice.admin).history();
  /** @type {string[]} */
  const ids = [];
  /** @type {any} */
  let page = await E(history).page(s);
  for (;;) {
    for (const turn of page.turns) ids.push(turn.turnId);
    if (page.next === undefined) break;
    // eslint-disable-next-line no-await-in-loop
    page = await E(history).page(s, page.next);
  }
  return ids;
};

/**
 * The export of a state as text lines with the keys a state assigns
 * itself left out (backend presences, staged previews are equal anyway).
 * @param {string} file
 */
const exportLines = async file =>
  (await readFile(file, 'utf8')).trim().split('\n');

run(
  '14: export then import into a fresh state yields the same sessions, history and queues',
  async t => {
    t.timeout(4 * 60_000);
    const source = await open(t);
    const { slice, backend } = source;
    // s1: turns run normally, then a restart holds two waiting messages.
    const chat = await slice.createSession(backend, 'chat');
    await slice.submit(chat, inputs.hi);
    await slice.submit(chat, inputs.echoOne);
    await slice.submit(chat, inputs.stall);
    await slice.submit(chat, 'later one');
    await slice.submit(chat, 'later two');
    await source.state.kill();
    await source.state.restart();
    await slice.refresh();
    const s1 = await E(slice.factory).findSession('s1');
    const held = await waitFor(
      async () => {
        const pending = await E(s1).listPending();
        return pending.hold === undefined ? undefined : pending;
      },
      30_000,
      'the restart hold',
    );
    // Whatever had not started at the kill waits, in order.
    const heldPreviews = held.entries.map((/** @type {any} */ e) => e.preview);
    t.deepEqual(heldPreviews.slice(-2), ['later one', 'later two']);
    // s2: an archived session (sealed segments are read through History).
    // The backend presence died with the client the kill closed: a new
    // scripted backend with the same label.
    const again = await slice.makeBackend(harden(sliceScript));
    await importSynthetic(source.state, again.backend, [
      { title: 'archived', turns: 170, backendLabel: 'Scripted' },
    ]);
    const s2 = await E(slice.factory).findSession('s2');
    t.truthy((await E(s2).getHistoryPage()).archive);

    t.log('stage: source history', new Date().toISOString());
    const sourceHistory = (await E(s1).getHistoryPage()).turns.map(
      (/** @type {any} */ p) => [p.turnId, p.state, p.records.length],
    );
    const file1 = path.join(tmpRoot, `${shortName('e')}.jsonl`);
    files.push(file1);
    t.log('stage: export source', new Date().toISOString());
    const exported = await exportState({
      client: source.state.client,
      file: file1,
    });
    t.is(exported.sessions, 2);
    t.true(exported.archivedTurns >= 32);
    t.log('stage: cleanup source', new Date().toISOString());
    await source.state.cleanup();

    // A fresh state: the same backend label, then the import.
    t.log('stage: open target', new Date().toISOString());
    const target = await open(t);
    t.log('stage: import target', new Date().toISOString());
    const imported = await importState({
      client: target.state.client,
      file: file1,
      backends: [target.backend],
    });
    t.is(imported.sessions.length, exported.sessions);
    const file2 = path.join(tmpRoot, `${shortName('e')}.jsonl`);
    files.push(file2);
    t.log('stage: export target', new Date().toISOString());
    await exportState({ client: target.state.client, file: file2 });
    const [one, two] = await Promise.all([
      exportLines(file1),
      exportLines(file2),
    ]);
    t.is(two.length, one.length);
    for (let i = 0; i < one.length; i += 1) {
      t.deepEqual(JSON.parse(two[i]), JSON.parse(one[i]), `line ${i + 1}`);
    }
    // The queue and its hold, the history pages, through the objects.
    t.log('stage: compare', new Date().toISOString());
    const t1 = await E(target.slice.factory).findSession('s1');
    const pending = await E(t1).listPending();
    t.deepEqual(
      pending.entries.map((/** @type {any} */ e) => e.preview),
      heldPreviews,
    );
    t.is(pending.hold?.reason, 'restart');
    const shown = (/** @type {any} */ page) =>
      page.turns.map((/** @type {any} */ p) => [
        p.turnId,
        p.state,
        p.records.length,
      ]);
    t.deepEqual(shown(await E(t1).getHistoryPage()), sourceHistory);
    const t2 = await E(target.slice.factory).findSession('s2');
    t.log('stage: walk', new Date().toISOString());
    const ids = await allTurnIds(target.slice, t2);
    t.is(ids.length, 170);
    emit({
      metric: 'm2.lifecycle.exportImport',
      exportMs: exported.ms,
      importMs: imported.ms,
      records: imported.records,
      lines: one.length,
      limits: {
        keep: limits.archiveKeepTurns,
        segment: limits.archiveSegmentTurns,
      },
      by: 'W2.7',
    });

    // J-9493: an export cut before its last session's `end` fails the
    // import, which deletes that half-imported session (the earlier, whole
    // session of the file stays imported).
    const endAt = one.findLastIndex(line => JSON.parse(line).type === 'end');
    const file3 = path.join(tmpRoot, `${shortName('e')}.jsonl`);
    files.push(file3);
    await writeFile(file3, `${one.slice(0, endAt).join('\n')}\n`);
    const keysBefore = await listedKeys(target.slice);
    await t.throwsAsync(
      () =>
        importState({
          client: target.state.client,
          file: file3,
          backends: [target.backend],
        }),
      { message: /ends inside session 2; that session was not imported/ },
    );
    // The file's first session was whole and is imported (s3); the cut
    // second one is deleted and never listed.
    const keysAfter = await listedKeys(target.slice);
    t.deepEqual(keysAfter, [...keysBefore, 's3']);
    const status = await E(target.slice.harness).status();
    t.is(status.sessions, keysAfter.length, 'no half-imported session');
  },
);

run(
  'an import of short turns completes: its record chunks encode over 32,768 bytes, under the harness ceiling',
  async t => {
    t.timeout(3 * 60_000);
    const { state, slice, backend } = await open(t);
    // 8 records a turn with 1-byte texts: a chunk is 279 records and about
    // 38.5 KB encoded (J-10125).
    const turns = 40;
    const result = await importSynthetic(state, backend, [
      {
        title: 'short turns',
        turns,
        backendLabel: 'Scripted',
        inputBytes: 1,
        answerBytes: 1,
      },
    ]);
    t.is(result.sessions.length, 1);
    t.is(result.records, turns * 8);
    const s1 = await E(slice.factory).findSession('s1');
    t.is((await allTurnIds(slice, s1)).length, turns);
    await state.cleanup();
  },
);
